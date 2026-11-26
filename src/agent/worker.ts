import type { ToolDefinition } from "../types/tool.ts";
import { isModelSpec } from "../utils/session.ts";
import type { StreamEvent } from "../types/response.ts";
import type { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import type { SubAgentStep } from "../types/response.ts";
import type { AgentConfig, SubAgentSpec } from "../types/agent.ts";
import type { ModelSpec } from "../types/model.ts";
import type { Agent } from "./agent.ts";
import { normalizeToolName } from "../tools/executor.ts";
import { chosenModel, chosenSubAgentModel } from "../config/models.ts";
import { resolveModelUnchecked } from "../providers/registry.ts";
import { ConfigError } from "../types/errors.ts";
import { isRecord } from "../utils/guards.ts";

/** Minimal live-trace shape shared by fixed + dynamic workers (structural subset of `SubAgentTrace`). */
interface LiveWorkerTrace {
  trackingId: string;
  name: string;
  sessionId: string;
  parentSessionId: string;
  status: "running" | "done" | "error";
  task: string;
  role?: string;
  turns: number;
  steps: SubAgentStep[];
  text?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Shared identity helpers (single home for Agent / dynamic workers)
// ---------------------------------------------------------------------------

/** Sanitizes a worker name into an XML tag (`UPPER-KEBAB`, 64 chars). */
function sanitizeXmlTag(raw: string): string {
  let s = raw.toUpperCase().replace(/[^A-Z0-9.-]/g, "-");
  if (!/^[A-Z]/.test(s)) s = `AGENT-${s}`;
  s = s
    .replace(/[.]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 64) || "SUBAGENT";
}

/** Sanitizes a worker name into a tool name (`lower-kebab`, 64 chars). */
export function sanitizeToolName(raw: string): string {
  const tag = sanitizeXmlTag(raw);
  return (
    tag
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-{2,}/g, "-")
      .slice(0, 64) || "sub-agent"
  );
}

// ---------------------------------------------------------------------------
// Shared Agent / worker config normalization (behavior-preserving)
// ---------------------------------------------------------------------------

/**
 * Unwraps `config.model` exactly like `Agent` ctor:
 * `ModelProviderInstance ({model})` -> inner `{model,apiKey,...}`,
 * otherwise the value as-is.
 */
function unwrapModelInput(configModel: unknown): unknown {
  const raw = configModel as { model?: unknown } | null | undefined;
  if (raw && typeof raw === "object" && "model" in (raw as Record<string, unknown>)) {
    return raw;
  }
  return configModel;
}

/**
 * Resolves the main model exactly like `Agent` ctor.
 * Returns both the stored `modelStringOrSpec` and the `rawModel` used for
 * `apiKey` / `baseUrl` / `thinkingLevel` inheritance.
 */
export function resolveMainModel(configModel: AgentConfig["model"]): {
  modelStringOrSpec: string | ModelSpec | undefined;
  rawModel: unknown;
} {
  const rawModel = unwrapModelInput(configModel) as
    | { model?: unknown; id?: unknown; provider?: unknown }
    | string
    | undefined;
  let modelStringOrSpec: string | ModelSpec | undefined;
  if (rawModel && typeof rawModel === "object" && "model" in (rawModel as Record<string, unknown>)) {
    modelStringOrSpec = (rawModel as { model: string }).model as string;
  } else if (isModelSpec(rawModel)) {
    modelStringOrSpec = rawModel;
  } else {
    modelStringOrSpec = (rawModel as string | undefined) || chosenModel();
  }
  return { modelStringOrSpec, rawModel };
}

/**
 * Resolves the dynamic worker model exactly like `Agent` ctor:
 * `dynamicSubagents.model ?? subagentModel ?? the saved or default worker model`.
 * Unwraps `ModelProviderInstance` / `ModelSpec` the same way.
 */
function resolveDynamicWorkerModel(dynModelRawInput: unknown): string | ModelSpec | undefined {
  const dynModelRaw = dynModelRawInput as { model?: unknown; id?: unknown; provider?: unknown } | string | undefined;
  let dynModel: string | ModelSpec | undefined;
  if (dynModelRaw && typeof dynModelRaw === "object" && "model" in (dynModelRaw as Record<string, unknown>)) {
    dynModel = (dynModelRaw as { model: string }).model;
  } else if (isModelSpec(dynModelRaw)) {
    dynModel = dynModelRaw;
  } else {
    dynModel = (dynModelRaw as string | undefined) || chosenSubAgentModel();
  }
  return dynModel;
}

/**
 * Resolves the combined dynamic worker model input
 * (`dynamicSubagents.model ?? subagentModel`) exactly like `Agent` ctor,
 * including the saved / default worker model fallback.
 */
export function resolveDynamicModelInput(
  dynamicSubagents: unknown,
  subagentModel: unknown
): string | ModelSpec | undefined {
  const dynModelRaw = (dynamicSubagents as { model?: unknown } | undefined)?.model ?? subagentModel;
  return resolveDynamicWorkerModel(dynModelRaw);
}

/**
 * Normalizes a `tools` record|array into a record with `name` defaults,
 * exactly like `Agent` ctor (both main tools and dynamic pool).
 */
export function normalizeToolMap(
  rawTools: Record<string, ToolDefinition> | ToolDefinition[] | undefined
): Record<string, ToolDefinition> {
  const out: Record<string, ToolDefinition> = {};
  if (!rawTools) return out;
  if (Array.isArray(rawTools)) {
    for (const t of rawTools) {
      const tName = (t as { name?: string })?.name || `tool_${Object.keys(out).length}`;
      out[tName] = { ...(t as ToolDefinition), name: tName } as ToolDefinition;
    }
  } else {
    for (const [key, def] of Object.entries(rawTools)) {
      out[key] = { ...(def as ToolDefinition), name: (def as { name?: string })?.name || key } as ToolDefinition;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared dynamic-worker helpers (pure, no store access)
// ---------------------------------------------------------------------------

// The time limit of one scheduled run in ms, 0 = none: the action's own `timeoutMs`, never above the developer's `workerTimeoutMs` (Infinity = none), which is also the limit when the action sets none; in: Agent.dynamicSubagents.workerTimeoutMs + the saved action, out: Scheduler.attempt.
export function scheduledRunTimeoutMs(cap: number, taskTimeoutMs: number | undefined): number {
  const own = typeof taskTimeoutMs === "number" && taskTimeoutMs > 0 ? Math.floor(taskTimeoutMs) : Infinity;
  const ms = Math.min(own, cap);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Grants ONLY the Main Agent-selected subset from the developer pool.
 * Unknown names are dropped. Matching is case/format-insensitive.
 */
export function grantWorkerTools(
  toolPool: Record<string, ToolDefinition>,
  requested: unknown
): Record<string, ToolDefinition> {
  const poolByNormalized = new Map<string, ToolDefinition>();
  for (const [key, def] of Object.entries(toolPool)) {
    poolByNormalized.set(normalizeToolName(key), def);
    const declared = (def as ToolDefinition)?.name;
    if (declared) poolByNormalized.set(normalizeToolName(declared), def);
  }
  const grantedTools: Record<string, ToolDefinition> = {};
  for (const toolName of (requested as string[] | undefined) ?? []) {
    const pooled =
      (toolPool as Record<string, ToolDefinition>)[toolName] ??
      poolByNormalized.get(normalizeToolName(String(toolName)));
    if (pooled) grantedTools[(pooled as ToolDefinition).name || toolName] = pooled;
  }
  return grantedTools;
}

/** The provider a model goes to, only when the model names it: a `ModelSpec` by its own `provider`, a string or model helper by its `provider/` prefix (`gemini/` and `google/` both give "google"). A bare id is found through the catalog, which can change before the run, so it gives undefined, as does a model that cannot be resolved; in: `Agent.fromConfig` and the worker builders, out: their same-provider checks. */
export function namedProviderOf(model: unknown): string | undefined {
  try {
    if (isModelSpec(model)) return resolveModelUnchecked(model).provider.id;
    const named = typeof model === "string" ? model : (model as { model?: unknown } | null | undefined)?.model;
    if (typeof named !== "string" || !named.includes("/")) return undefined;
    return resolveModelUnchecked(named).provider.id;
  } catch {
    return undefined;
  }
}

// The parent's key, base URL and headers for a worker, only when both models name the same provider (otherwise none, and the worker's provider reads its own environment variable); in: the parent Agent and the worker's model, out: buildDynamicWorkerConfig, buildSubAgentConfig.
function resolveWorkerCredentials(
  parentAgent: {
    modelStringOrSpec?: unknown;
    apiKey?: string;
    baseUrl?: string;
    customHeaders?: Record<string, string>;
  },
  workerModel: unknown
): { apiKey?: string; baseUrl?: string; headers?: Record<string, string> } {
  const parentProvider = namedProviderOf(parentAgent.modelStringOrSpec);
  if (parentProvider === undefined || parentProvider !== namedProviderOf(workerModel)) return {};
  return { apiKey: parentAgent.apiKey, baseUrl: parentAgent.baseUrl, headers: parentAgent.customHeaders };
}

// Configs built by `buildDynamicWorkerConfig`: the Agent constructor checks it so SDK-built workers never take the spending-cap settings.
const workerConfigs = new WeakSet<object>();

/** True for a config made by `buildDynamicWorkerConfig` (a chat worker or a scheduled run), not by the developer. */
export function isWorkerConfig(config: object): boolean {
  return workerConfigs.has(config);
}

/** How many levels of workers may exist below an agent unless `dynamicSubagents.maxDepth` says otherwise: unlimited. */
export const DEFAULT_MAX_DEPTH: number = Infinity;

/**
 * Config of a dynamic worker (scheduled actions, the worker registry): the developer's fixed worker
 * model, level and limits, never the LLM's choice. Credentials carry over only when the providers match, and
 * `inheritableConfig()` keeps the worker no less constrained than its parent. Stateless one-shot by default;
 * `persistent` makes a multi-turn worker that keeps its history (saved under `persistent.dir` when given, and
 * continued by `resume()` after a crash, never automatically). A persistent worker with levels left below it
 * (`maxDepth` of the parent, minus one for itself) gets its own `subagents` tool; its children can only be granted
 * the tools it was granted. One-shot workers never spawn. `dynamicSubagents.workerBudget` becomes each chat worker's own
 * per-run `budget` (and is passed to its children).
 */
export function buildDynamicWorkerConfig(
  parent: Agent,
  worker: {
    name: string;
    role?: string;
    instructions: string;
    sessionId: string;
    tools: Record<string, ToolDefinition>;
    persistent?: { dir?: string };
  }
): AgentConfig {
  const model = parent.subagentModel;
  const credentials = resolveWorkerCredentials(parent, model);
  const dyn = parent.dynamicSubagents;
  const levelsBelow = (dyn?.maxDepth ?? DEFAULT_MAX_DEPTH) - 1;
  const config: AgentConfig = {
    name: worker.name,
    description: worker.role || `Sub-agent ${worker.name}`,
    instructions: worker.instructions,
    model,
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
    thinkingLevel: parent.dynamicSubagents?.thinkingLevel ?? parent.thinkingConfig?.level,
    sessionId: worker.sessionId,
    tools: worker.tools,
    // A chat worker (persistent) is capped by `workerBudget`; a one-shot scheduled run only by `scheduledActionBudget`.
    ...(() => {
      const cap = worker.persistent ? dyn?.workerBudget : dyn?.scheduledActionBudget;
      return cap ? { budget: { ...cap } } : {};
    })(),
    stateless: !worker.persistent,
    ...(worker.persistent?.dir ? { persist: { dir: worker.persistent.dir }, resume: "explicit" as const } : {}),
    ...(worker.persistent && levelsBelow >= 1
      ? {
          dynamicSubagents: {
            enabled: true,
            model,
            ...(dyn?.maxSpawn !== undefined ? { maxSpawn: dyn.maxSpawn } : {}),
            ...(dyn?.thinkingLevel ? { thinkingLevel: dyn.thinkingLevel } : {}),
            tools: worker.tools,
            ...(dyn?.workerBudget ? { workerBudget: dyn.workerBudget } : {}),
            maxDepth: levelsBelow,
          },
        }
      : {}),
    serviceTier: parent.serviceTier,
    headers: credentials.headers,
    maxTurns: parent.maxTurns,
    ...parent.inheritableConfig(),
  };
  workerConfigs.add(config);
  return config;
}

// The keys a sub-agent written as data may carry; anything else belongs on a real `Agent`.
const SUB_AGENT_SPEC_KEYS: readonly string[] = ["name", "description", "instructions", "model", "tools"];

// A ConfigError for the `subagents` entry at `position`; in: buildSubAgentConfig, out: the error to throw.
function badSpec(position: number, problem: string): ConfigError {
  return new ConfigError(`[Agent Accelerator] subagents[${position}] ${problem}`);
}

/** Config of a fixed sub-agent written as data: its own model, else the parent's worker model (never the main one), the parent's limits, hooks and file policy, and credentials only for the parent's own provider; in: the Agent constructor, out: the config of a plain `Agent`. */
export function buildSubAgentConfig(parent: Agent, spec: SubAgentSpec, position: number): AgentConfig {
  if (!isRecord(spec)) {
    throw badSpec(position, "must be an Agent, { name, description, agent } or { name, description, instructions }.");
  }
  const unknownKeys = Object.keys(spec).filter((key) => !SUB_AGENT_SPEC_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw badSpec(
      position,
      `has unknown key ${unknownKeys.map((key) => `"${key}"`).join(", ")}: a sub-agent written as data takes name, description, instructions, model and tools. Build an Agent for anything else.`
    );
  }
  for (const key of ["name", "description", "instructions"] as const) {
    const value = spec[key];
    if (typeof value !== "string" || !value.trim()) throw badSpec(position, `needs a non-empty ${key}.`);
  }
  if (typeof spec.model === "string" && !spec.model.trim()) {
    throw badSpec(position, `("${spec.name}") has an empty model: leave it out to use the worker model.`);
  }
  const model = spec.model ?? parent.subagentModel;
  if (!model) {
    throw badSpec(
      position,
      `("${spec.name}") has no model and no worker model is set. Give it a model, pass dynamicSubagents.model, or set a default worker model with setModels() or setSubAgentModel().`
    );
  }
  const credentials = resolveWorkerCredentials(parent, model);
  const config: AgentConfig = {
    name: spec.name,
    description: spec.description,
    instructions: spec.instructions,
    model,
    ...(spec.tools ? { tools: spec.tools } : {}),
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
    ...parent.inheritableConfig(),
  };
  workerConfigs.add(config); // SDK-built: never takes the spending-cap settings, like every other SDK-built worker
  return config;
}

// ---------------------------------------------------------------------------
// Shared live worker state machine (single home for fixed + dynamic workers)
// ---------------------------------------------------------------------------

/** Turn summary fed into the live worker trace (mirrors `AgentRunOptions.onTurn`). */
interface LiveWorkerTurn {
  turns: number;
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ name: string }>;
  toolResults?: Array<{ name: string; isError?: boolean }>;
}

/** Deltas forwarded to the parent stream via `onSubagentEvent`. */
interface LiveWorkerEvent {
  trackingId: string;
  delta?: string;
  thinkingDelta?: string;
  partialText?: string;
  partialThinking?: string;
}

/** Hooks owned by the trace store (`delegation.ts`); worker core stays pure. */
interface LiveWorkerHooks {
  trim?: (trace: LiveWorkerTrace) => void;
  touch?: (trackingId: string) => void;
  notify?: (trackingId: string) => void;
  persist?: () => void;
  emit?: (event: LiveWorkerEvent) => void;
}

/**
 * Single live worker state machine shared by fixed (`agentToTool`) and
 * registry workers. Owns `liveTurn` / `partialText` /
 * `partialThinking`, finalizes partial streaming entries on `onTurn`, and
 * forwards deltas to the parent stream. The trace object is mutated in place;
 * trimming / touching / notifying / persisting are delegated to hooks so this
 * module never touches the trace store directly.
 */
export function createLiveWorker(
  trace: LiveWorkerTrace,
  trackingId: string,
  displayId: string,
  hooks: LiveWorkerHooks = {}
): {
  onWorkerTurn: (turn: LiveWorkerTurn) => void;
  attachToStream: (workerStream: Pick<AssistantMessageEventStream, "on" | "off">) => () => void;
} {
  let liveTurn = 1;
  let partialText = "";
  let partialThinking = "";

  const findPartial = (turn: number): SubAgentStep | undefined => {
    for (let i = trace.steps.length - 1; i >= 0; i--) {
      const s = trace.steps[i]!;
      if (s.turn === turn && s.partial) return s;
    }
    return undefined;
  };

  const onWorkerTurn = (turn: LiveWorkerTurn): void => {
    try {
      liveTurn = turn.turns;
      const timestamp = Date.now();
      const partialEntry = findPartial(liveTurn);
      if (partialEntry) {
        if (turn.text) partialEntry.text = turn.text;
        if (turn.thinking) partialEntry.thinking = turn.thinking;
        delete (partialEntry as { partial?: boolean }).partial;
      } else if (turn.text) {
        trace.steps.push({ turn: turn.turns, type: "assistant", text: turn.text.slice(0, 2000), timestamp });
      }
      for (const tc of turn.toolCalls ?? []) {
        trace.steps.push({ turn: turn.turns, type: "tool_call", name: tc.name, timestamp });
      }
      for (const tr of turn.toolResults ?? []) {
        trace.steps.push({ turn: turn.turns, type: "tool_result", name: tr.name, isError: tr.isError, timestamp });
      }
      trace.turns = Math.max(trace.turns, turn.turns);
      try {
        hooks.trim?.(trace);
      } catch {
        // why: a callback or listener of yours must never break the run.
      }
      try {
        hooks.touch?.(trace.trackingId);
      } catch {
        // why: a callback or listener of yours must never break the run.
      }
      try {
        hooks.notify?.(trackingId);
      } catch {
        // why: a callback or listener of yours must never break the run.
      }
      try {
        hooks.persist?.();
      } catch {
        // why: a callback or listener of yours must never break the run.
      }
    } catch {
      // why: a callback or listener of yours must never break the run.
    }
  };

  const onWorkerDelta = (delta?: string, thinkingDelta?: string): void => {
    try {
      if (delta) {
        partialText = (partialText + delta).slice(-10000);
        let entry = findPartial(liveTurn);
        if (!entry) {
          entry = { turn: liveTurn, type: "assistant", text: "", partial: true, timestamp: Date.now() };
          trace.steps.push(entry);
        }
        entry.text = partialText;
        entry.timestamp = Date.now();
      }
      if (thinkingDelta) {
        partialThinking = (partialThinking + thinkingDelta).slice(-10000);
        let entry = findPartial(liveTurn);
        if (!entry) {
          entry = { turn: liveTurn, type: "assistant", text: "", partial: true, timestamp: Date.now() };
          trace.steps.push(entry);
        }
        entry.thinking = partialThinking;
        entry.timestamp = Date.now();
      }
      try {
        hooks.trim?.(trace);
      } catch {
        // why: a callback or listener of yours must never break the run.
      }
      try {
        hooks.notify?.(trackingId);
      } catch {
        // why: a callback or listener of yours must never break the run.
      }
      try {
        hooks.emit?.({
          trackingId: displayId,
          delta,
          thinkingDelta,
          partialText: partialText || undefined,
          partialThinking: partialThinking || undefined,
        });
      } catch {
        // why: a callback or listener of yours must never break the run.
      }
    } catch {
      // why: a callback or listener of yours must never break the run.
    }
  };

  const attachToStream = (workerStream: Pick<AssistantMessageEventStream, "on" | "off">): (() => void) => {
    const textListener = (e: StreamEvent): void => onWorkerDelta(e.delta, undefined);
    const thinkingListener = (e: StreamEvent): void => onWorkerDelta(undefined, e.thinkingDelta);
    try {
      workerStream.on("text_delta", textListener);
    } catch {
      // why: cancelling or releasing something that is already closed is harmless.
    }
    try {
      workerStream.on("thinking_delta", thinkingListener);
    } catch {
      // why: cancelling or releasing something that is already closed is harmless.
    }
    return () => {
      try {
        workerStream.off("text_delta", textListener);
      } catch {
        // why: cancelling or releasing something that is already closed is harmless.
      }
      try {
        workerStream.off("thinking_delta", thinkingListener);
      } catch {
        // why: cancelling or releasing something that is already closed is harmless.
      }
    };
  };

  return { onWorkerTurn, attachToStream };
}
