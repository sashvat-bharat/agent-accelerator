import type { ToolDefinition } from "../types/tool.ts";
import type { SubAgentStep } from "../types/response.ts";
import type { AgentConfig } from "../types/agent.ts";
import type { Agent } from "./agent.ts";
import { normalizeToolName } from "../tools/executor.ts";
import { escapeXml } from "../utils/serialization.ts";
import { getModel, getSubModel } from "../utils/env.ts";
import { resolveModel } from "../providers/registry.ts";

export { escapeXml };

/** Minimal live-trace shape shared by fixed + dynamic workers (structural subset of `SubAgentTrace`). */
export interface LiveWorkerTrace {
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
// Shared identity helpers (single home for Agent / SubAgent / Dynamic workers)
// ---------------------------------------------------------------------------

/** Sanitizes a worker name into an XML tag (`UPPER-KEBAB`, 64 chars). */
export function sanitizeXmlTag(raw: string): string {
  let s = raw.toUpperCase().replace(/[^A-Z0-9.-]/g, "-");
  if (!/^[A-Z]/.test(s)) s = `AGENT-${s}`;
  s = s.replace(/[.]/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 64) || "SUBAGENT";
}

/** Sanitizes a worker name into a tool name (`lower-kebab`, 64 chars). */
export function sanitizeToolName(raw: string): string {
  const tag = sanitizeXmlTag(raw);
  return tag.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-{2,}/g, "-").slice(0, 64) || "sub-agent";
}

/** Stable worker ids: `{sanitizedName}-{32hex}` display id + raw tracking id. */
export function makeWorkerIds(sanitizedName: string, trackingId: string): { trackingId: string; displayId: string } {
  return { trackingId, displayId: `${sanitizedName}-${trackingId}` };
}

// ---------------------------------------------------------------------------
// Shared Agent / SubAgent config normalization (behavior-preserving)
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
  modelStringOrSpec: string | Record<string, unknown> | undefined;
  rawModel: unknown;
} {
  const rawModel = unwrapModelInput(configModel) as
    | { model?: unknown; id?: unknown; provider?: unknown }
    | string
    | undefined;
  let modelStringOrSpec: string | Record<string, unknown> | undefined;
  if (rawModel && typeof rawModel === "object" && "model" in (rawModel as Record<string, unknown>)) {
    modelStringOrSpec = (rawModel as { model: string }).model as string;
  } else if (
    rawModel &&
    typeof rawModel === "object" &&
    "id" in (rawModel as Record<string, unknown>) &&
    "provider" in (rawModel as Record<string, unknown>)
  ) {
    modelStringOrSpec = rawModel as Record<string, unknown>;
  } else {
    modelStringOrSpec = (rawModel as string | undefined) || getModel();
  }
  return { modelStringOrSpec: modelStringOrSpec as string | Record<string, unknown> | undefined, rawModel };
}

/**
 * Resolves the dynamic worker model exactly like `Agent` ctor:
 * `dynamicSubagents.model ?? subagentModel ?? SUB_AGENT_MODEL`.
 * Unwraps `ModelProviderInstance` / `ModelSpec` the same way.
 */
export function resolveDynamicWorkerModel(
  dynModelRawInput: unknown,
  subagentModelInput: unknown
): string | Record<string, unknown> | undefined {
  const dynModelRaw = dynModelRawInput as
    | { model?: unknown; id?: unknown; provider?: unknown }
    | string
    | undefined;
  let dynModel: string | Record<string, unknown> | undefined;
  if (dynModelRaw && typeof dynModelRaw === "object" && "model" in (dynModelRaw as Record<string, unknown>)) {
    dynModel = (dynModelRaw as { model: string }).model as unknown as string | Record<string, unknown>;
  } else if (
    dynModelRaw &&
    typeof dynModelRaw === "object" &&
    "id" in (dynModelRaw as Record<string, unknown>) &&
    "provider" in (dynModelRaw as Record<string, unknown>)
  ) {
    dynModel = dynModelRaw as Record<string, unknown>;
  } else {
    dynModel = (dynModelRaw as string | undefined) || getSubModel() as string | undefined;
  }
  void subagentModelInput;
  return dynModel;
}

/**
 * Resolves the combined dynamic worker model input
 * (`dynamicSubagents.model ?? subagentModel`) exactly like `Agent` ctor,
 * including the `SUB_AGENT_MODEL` fallback.
 */
export function resolveDynamicModelInput(
  dynamicSubagents: unknown,
  subagentModel: unknown
): string | Record<string, unknown> | undefined {
  const dynModelRaw = (dynamicSubagents as { model?: unknown } | undefined)?.model ?? subagentModel;
  return resolveDynamicWorkerModel(dynModelRaw, subagentModel);
}

/**
 * Resolves a `SubAgent` model exactly like `SubAgent` ctor:
 * `config.model ?? SUB_AGENT_MODEL ?? MODEL`, throwing with the same message
 * when nothing resolves. Kept here so `Agent` / `SubAgent` share one chain.
 */
export function resolveSubAgentModel(config: { name?: string; model?: AgentConfig["model"] }): NonNullable<AgentConfig["model"]> {
  const resolvedModel = config.model ?? getSubModel() ?? getModel();
  if (!resolvedModel) {
    throw new Error(
      `[Agent Accelerator] SubAgent '${config.name || "subagent"}' requires a model. ` +
        `Specify 'model' in SubAgent config, or set SUB_AGENT_MODEL or MODEL in environment variables.`
    );
  }
  return resolvedModel as NonNullable<AgentConfig["model"]>;
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

/** Resolves per-worker timeout: `>0` fixed, `0` unlimited, `-1` per-task. */
export function normalizeWorkerTimeoutValue(cfgTimeout: number, taskTimeoutMs: unknown): number {
  return cfgTimeout > 0 ? cfgTimeout : cfgTimeout === -1 && (taskTimeoutMs as number) > 0 ? Math.floor(taskTimeoutMs as number) : 0;
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
  for (const toolName of ((requested as string[] | undefined) ?? [])) {
    const pooled = (toolPool as Record<string, ToolDefinition>)[toolName] ?? poolByNormalized.get(normalizeToolName(String(toolName)));
    if (pooled) grantedTools[(pooled as ToolDefinition).name || toolName] = pooled;
  }
  return grantedTools;
}

/** Resolves a provider id for credential reuse / error metadata (shared). */
export function providerOfWorkerModel(modelStr: string | unknown | undefined): string | undefined {
  return providerOf(modelStr);
}

function providerOf(modelStr: string | unknown | undefined): string | undefined {
  if (!modelStr) return undefined;
  try {
    const m =
      typeof modelStr === "string"
        ? modelStr
        : (modelStr as { model?: unknown; id?: unknown })?.model ??
          (modelStr as { id?: unknown })?.id ??
          String(modelStr);
    return resolveModel(m as string).provider.id;
  } catch {
    return undefined;
  }
}

/**
 * Resolves worker credentials: reuses parent `apiKey`/`baseUrl` ONLY when the
 * worker provider matches the parent provider (otherwise env resolves).
 */
export function resolveWorkerCredentials(
  parentAgent: { modelStringOrSpec?: unknown; apiKey?: string; baseUrl?: string },
  chosenModel: unknown
): { apiKeyToUse: string | undefined; baseUrlToUse: string | undefined; attemptedProvider: string | undefined } {
  const chosenModelStrForProvider =
    typeof chosenModel === "string"
      ? chosenModel
      : (chosenModel as { model?: unknown; id?: unknown })?.model ??
        (chosenModel as { id?: unknown })?.id ??
        String(chosenModel);
  const attemptedProvider = providerOf(chosenModelStrForProvider);
  const parentProvider = providerOf(parentAgent.modelStringOrSpec as string);
  const targetProviderFinal = providerOf(chosenModelStrForProvider);
  if (targetProviderFinal === parentProvider) {
    return { apiKeyToUse: parentAgent.apiKey, baseUrlToUse: parentAgent.baseUrl, attemptedProvider };
  }
  return { apiKeyToUse: undefined, baseUrlToUse: undefined, attemptedProvider };
}

/**
 * Config of a stateless dynamic worker (`spawn_subagents` and scheduled
 * actions): the developer's fixed worker model, level and limits, never the
 * LLM's choice. Credentials carry over only when the providers match, and
 * `inheritableConfig()` keeps the worker no less constrained than its parent.
 */
export function buildDynamicWorkerConfig(
  parent: Agent,
  worker: { name: string; role?: string; instructions: string; sessionId: string; tools: Record<string, ToolDefinition> }
): AgentConfig {
  const model = parent.subagentModel;
  const { apiKeyToUse, baseUrlToUse } = resolveWorkerCredentials(parent, model);
  return {
    name: worker.name,
    description: worker.role || `Sub-agent ${worker.name}`,
    instructions: worker.instructions,
    model,
    apiKey: apiKeyToUse,
    baseUrl: baseUrlToUse,
    thinkingLevel: parent.dynamicSubagents?.thinkingLevel ?? parent.thinkingConfig?.level,
    sessionId: worker.sessionId,
    tools: worker.tools,
    // Stateless by design: one task in, one result out, then shut down. No history, no recursion.
    stateless: true,
    serviceTier: parent.serviceTier,
    headers: parent.customHeaders,
    maxTurns: parent.maxTurns,
    ...parent.inheritableConfig(),
  };
}

/** Builds one `<NAME>...text...</NAME>` block inside `<SUB-AGENTS-RESPONSE>`. */
export function buildWorkerXmlBlock(name: string, text: string): string {
  const escaped = escapeXml(text);
  const indentedText = escaped.split("\n").map((line) => `        ${line}`).join("\n");
  return `    <${name}>\n${indentedText}\n    </${name}>`;
}

/** Builds the `<SUB-AGENTS-RESPONSE>` envelope for dynamic workers. */
export function buildSubagentsXml(results: Array<{ name: string; text: string }>): string {
  return `<SUB-AGENTS-RESPONSE>\n${results.map((r) => buildWorkerXmlBlock(r.name, r.text)).join("\n")}\n</SUB-AGENTS-RESPONSE>`;
}

// ---------------------------------------------------------------------------
// Shared live worker state machine (single home for fixed + dynamic workers)
// ---------------------------------------------------------------------------

/** Turn summary fed into the live worker trace (mirrors `AgentRunOptions.onTurn`). */
export interface LiveWorkerTurn {
  turns: number;
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ name: string }>;
  toolResults?: Array<{ name: string; isError?: boolean }>;
}

/** Deltas forwarded to the parent stream via `onSubagentEvent`. */
export interface LiveWorkerEvent {
  trackingId: string;
  delta?: string;
  thinkingDelta?: string;
  partialText?: string;
  partialThinking?: string;
}

/** Hooks owned by the trace store (`delegation.ts`); worker core stays pure. */
export interface LiveWorkerHooks {
  trim?: (trace: LiveWorkerTrace) => void;
  touch?: (trackingId: string) => void;
  notify?: (trackingId: string) => void;
  persist?: () => void;
  emit?: (event: LiveWorkerEvent) => void;
}

/**
 * Single live worker state machine shared by fixed (`agentToTool`) and
 * dynamic (`spawn_subagents`) workers. Owns `liveTurn` / `partialText` /
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
  onWorkerDelta: (delta?: string, thinkingDelta?: string) => void;
  attachToStream: (workerStream: {
    on: (event: string, listener: (e: { delta?: string; thinkingDelta?: string }) => void) => void;
    off: (event: string, listener: (e: { delta?: string; thinkingDelta?: string }) => void) => void;
  }) => () => void;
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
      try { hooks.trim?.(trace); } catch {}
      try { hooks.touch?.(trace.trackingId); } catch {}
      try { hooks.notify?.(trackingId); } catch {}
      try { hooks.persist?.(); } catch {}
    } catch {}
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
      try { hooks.trim?.(trace); } catch {}
      try { hooks.notify?.(trackingId); } catch {}
      try {
        hooks.emit?.({
          trackingId: displayId,
          delta,
          thinkingDelta,
          partialText: partialText || undefined,
          partialThinking: partialThinking || undefined,
        });
      } catch {}
    } catch {}
  };

  const attachToStream = (workerStream: {
    on: (event: string, listener: (e: { delta?: string; thinkingDelta?: string }) => void) => void;
    off: (event: string, listener: (e: { delta?: string; thinkingDelta?: string }) => void) => void;
  }): (() => void) => {
    const textListener = (e: { delta?: string }): void => onWorkerDelta(e.delta, undefined);
    const thinkingListener = (e: { thinkingDelta?: string }): void => onWorkerDelta(undefined, e.thinkingDelta);
    try { workerStream.on("text_delta", textListener as (e: { delta?: string; thinkingDelta?: string }) => void); } catch {}
    try { workerStream.on("thinking_delta", thinkingListener as (e: { delta?: string; thinkingDelta?: string }) => void); } catch {}
    return () => {
      try { workerStream.off("text_delta", textListener as (e: { delta?: string; thinkingDelta?: string }) => void); } catch {}
      try { workerStream.off("thinking_delta", thinkingListener as (e: { delta?: string; thinkingDelta?: string }) => void); } catch {}
    };
  };

  return { onWorkerTurn, onWorkerDelta, attachToStream };
}
