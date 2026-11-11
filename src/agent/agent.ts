import type {
  AgentConfig,
  EditableAgentConfig,
  AgentRunOptions,
  MidSessionConfig,
  ToolChoiceOption,
  RetryPolicyConfig,
  Budget,
  BudgetState,
  InterruptedRun,
} from "../types/agent.ts";
import type { TokenUsage } from "../types/core.ts";
import type { ProviderRequestOptions } from "../types/model.ts";
import { normalizeThinkingV2, resolveWhenBusy } from "../tools/tool.ts";
import type { ToolDefinition, ToolResultRecord } from "../types/tool.ts";
import { isSubagentResult } from "../tools/subagent-result.ts";
import {
  CACHE_OPTIONS,
  type ThinkingLevel,
  type ThinkingConfig,
  type CacheOption,
  type ServiceTier,
} from "../types/core.ts";
import type { ContentPart } from "../types/message.ts";
import { AgentResponse, type StreamEvent } from "../types/response.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentContext } from "./context.ts";
import { resolveModel } from "../providers/registry.ts";
import { buildAgentTools } from "./delegation.ts";
import { createSubagentsTool } from "./subagents-tool.ts";
import { WorkerRegistry } from "./workers.ts";
import { DEFAULT_MAX_DEPTH, normalizeToolMap, resolveDynamicModelInput, resolveMainModel } from "./worker.ts";
import * as path from "node:path";
import { registerAgent } from "../scheduler/scheduler.ts";
import { resolveHome } from "../utils/home.ts";
import { persistTelemetry, registerSessionFolder, unregisterSessionFolder } from "../telemetry-file.ts";
import { lockFolder } from "../utils/durable.ts";
import { createScheduledActionsTool, getDatetimeTool } from "../scheduler/tool.ts";
import { fillPrompt, resolvePrompts, type Prompts } from "../prompts/prompts.ts";
import { applyEditable, assertModelAllowed, modelKey, toEditableConfig } from "./config-blocks.ts";
import { assertNoToolCollisions } from "../tools/executor.ts";
import {
  runAgentLoop,
  streamAgentLoop,
  unfinishedToolCalls,
  endsWithStop,
  accumulateUsage,
  type SteerEntry,
} from "./loop.ts";
import { isRetryableRun, readRetryAfterMs, sleep } from "../utils/retry.ts";
import { createSessionId, nowMs, newRunId, previewPrompt } from "../utils/session.ts";
import {
  chargeBudgetUsage,
  checkBudget,
  getSubAgentTraceForSessions,
  subscribeToSubAgentForSessions,
  listSubAgentTraceIdsForSessions,
  type SubAgentTrace,
} from "./delegation.ts";
import {
  addTurn,
  buildUsageReport,
  emptyUsage,
  mergeUsage,
  modelName,
  readUsage,
  type UsageNode,
  type UsageReport,
  type UsageTotals,
} from "../session/usage.ts";
import {
  saveSessionFile,
  sessionDirFor,
  loadSessionDir,
  findInvalidMessage,
  priceUsage,
  telemetryBus,
  type SessionRunMark,
  type SessionRunEnd,
  type SessionPending,
  type SessionToolRecord,
} from "../session/store.ts";
import { SessionJournal } from "../session/journal.ts";
import { ToolLogs, type ToolLogWriter } from "../session/tool-log.ts";
import { isLocalPathInput } from "../utils/safe-io.ts";
import { clearSessionRouting, normalizeStructuredOutput } from "../providers.ts";
import type { StructuredOutputSpec } from "../types/model.ts";
import { clearInteractionChains } from "../providers/google.ts";
import { validateModelThinking, ensureModelCatalogFresh } from "../models/catalog.ts";
import { buildSessionData, type PersistedAgentSession, type SessionTotals } from "../session/store.ts";
import { SessionTelemetry } from "../session/store.ts";

/**
 * Resolves a per-run thinking override without mutating agent config.
 */
export function resolveEffectiveThinking(base?: ThinkingConfig, overrideLevel?: string): ThinkingConfig | undefined {
  if (!overrideLevel) return base;
  if (overrideLevel === "none") return { enabled: false, level: "none", budgetTokens: 0 };
  if (overrideLevel === "dynamic") return { enabled: true, level: "dynamic", budgetTokens: -1 };
  return { enabled: true, level: overrideLevel as ThinkingConfig["level"] };
}

import { ConfigError, SessionLoadError, ValidationError, isAbortError } from "../types/errors.ts";

/**
 * Disposers for the manual user-signal forward listeners (fallback when
 * `AbortSignal.any` is unavailable). Keyed by run controller so no expando
 * properties are attached to AbortController instances.
 */
const mergeDisposers = new WeakMap<AbortController, () => void>();

/** Waits before run retry 1, 2, 3 ... (the last one repeats). Module-level so tests can shrink it; not public API. */
export const RUN_RETRY_DELAYS_MS: number[] = [5_000, 15_000, 45_000, 60_000];

/** Max named sessions kept per Agent (LRU). */
const SESSION_LRU_MAX = 100;
/** Idle TTL for named sessions. */
const SESSION_TTL_MS = 60 * 60 * 1000;

/** Normalized per-run limits. Sub-agents inherit these unless overridden. */
export interface AgentRunLimits {
  maxTurns?: number;
  deadlineMs?: number;
  maxToolCallsPerRun?: number;
  maxTotalTokens?: number;
  requestTimeoutMs: number;
  firstByteTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

/** Resolves `(config as any).limits` with defaults (timeouts tolerate reasoning). */
function resolveAgentLimits(config: { limits?: Record<string, unknown> }): AgentRunLimits {
  const raw = (config as { limits?: Record<string, unknown> }).limits ?? {};
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  // A network timeout: `0` or `Infinity` turns it off, any other number is milliseconds, anything else is unset (the default applies).
  const timeout = (v: unknown): number | undefined => (typeof v === "number" && !Number.isNaN(v) ? v : undefined);
  return {
    ...(num(raw.maxTurns) !== undefined ? { maxTurns: Math.max(1, Math.floor(num(raw.maxTurns)!)) } : {}),
    ...(num(raw.deadlineMs) !== undefined ? { deadlineMs: num(raw.deadlineMs)! } : {}),
    ...(num(raw.maxToolCallsPerRun) !== undefined
      ? { maxToolCallsPerRun: Math.max(1, Math.floor(num(raw.maxToolCallsPerRun)!)) }
      : {}),
    ...(num(raw.maxTotalTokens) !== undefined
      ? { maxTotalTokens: Math.max(1, Math.floor(num(raw.maxTotalTokens)!)) }
      : {}),
    requestTimeoutMs: timeout(raw.requestTimeoutMs) ?? 300_000,
    firstByteTimeoutMs: timeout(raw.firstByteTimeoutMs) ?? 120_000,
    streamIdleTimeoutMs: timeout(raw.streamIdleTimeoutMs) ?? 300_000,
  };
}

/** Thrown when dynamic sub-agent spawning is enabled without an explicit model. */
export class SubAgentModelError extends ConfigError {
  readonly parentModel?: string;

  /**
   * Creates a configuration error with the missing sub-agent model and a
   * concrete fix for the parent model setup.
   *
   * @param parentModel The parent model that attempted to enable delegation.
   */
  constructor(parentModel?: string) {
    const parentName = parentModel || "your main model";
    const formatted =
      `[Agent Accelerator] Missing Configuration: a sub-agent model is required when dynamic sub-agents are enabled. ` +
      `Main Agent Model: ${parentName}. ` +
      `Dynamic sub-agent delegation was enabled (dynamicSubagents.enabled), but no model was assigned for sub-agents. ` +
      `Fix: pass dynamicSubagents.model in Agent config or set SUB_AGENT_MODEL.`;

    super(formatted, { parentModel: parentName });
    this.name = "SubAgentModelError";
    this.parentModel = parentModel;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SubAgentModelError);
    }
  }
}

/**
 * Stateful, tool-capable LLM agent with unified provider routing.
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   model: "google/gemini-3.5-flash-lite",
 *   instructions: "Be concise and factual.",
 *   tools: { get_status },
 * });
 * const response = await agent.run("Check the status");
 * console.log(response.text);
 * ```
 */
export class Agent {
  /** Display name. */
  readonly name: string;
  /** Delegation/tool description. */
  readonly description: string;
  /** Stable system instructions. */
  instructions: string;
  /** The SDK prompts in use: the shipped defaults with `AgentConfig.prompts` applied. */
  readonly prompts: Prompts;
  /** Original model string or catalog spec used for resolution. */
  readonly modelStringOrSpec: string | any;
  /** Configured dynamic sub-agent model, if enabled. */
  readonly subagentModel?: string | any;
  /** Normalized dynamic sub-agent spawning policy. */
  readonly dynamicSubagents?: {
    enabled: boolean;
    model?: string | any;
    /** Open workers at once; `Infinity` (the default) = no limit. */
    maxSpawn: number;
    thinkingLevel?: ThinkingLevel;
    tools: Record<string, ToolDefinition>;
    /** Longest a scheduled run may take, in ms; `Infinity` (the default) = no limit. */
    workerTimeoutMs: number;
    /** Scheduled actions (`scheduled_actions` + `get_datetime` tools) are on. */
    allowScheduledActions: boolean;
    /** Levels of workers allowed below this agent; `Infinity` (the default) = no limit. */
    maxDepth: number;
    /** Per-run spending cap of each worker (unset = unlimited). */
    workerBudget?: { maxCostUsd?: number; maxTotalTokens?: number };
  };
  /** Home folder for everything written to disk (`sessions/`, `scheduled/`, `telemetry/`). */
  readonly home: string;
  /** Registered model-callable tools. */
  readonly tools: Record<string, ToolDefinition> = {};
  /** Normalized reasoning configuration. */
  readonly thinkingConfig?: ThinkingConfig;
  /** Canonical structured-output request (raw `AgentConfig.output`). */
  readonly output?: unknown;
  /** Normalized structured-output spec sent to providers. */
  readonly outputSpec?: StructuredOutputSpec;
  /** Prompt-cache lifetime (see `AgentConfig.cache`); unset = provider default. */
  readonly cache?: CacheOption;
  /** Provider service tier. */
  readonly serviceTier?: ServiceTier;
  /**
   * Local-file policy. `roots` set: every local-path media part must resolve
   * inside them (`[]` denies all paths). Unset: local paths are unrestricted.
   */
  readonly fileAccess?: { roots?: string[] };
  /** Failure policy for the conversation (see `AgentConfig.onFailure`). */
  readonly onFailure: "auto" | "rollback" | "keep";
  /** Wire-capture policy for `AgentResponse.raw` (default `"redacted"`: bodies replaced by a content-free summary). */
  readonly captureRaw?: false | "redacted" | true;
  /** Constructor config, kept so {@link Agent.fork} can build isolated copies. */
  private readonly forkConfig: AgentConfig;
  /** Opt-in per-run budget (tokens / cost / duration / sub-agent count), enforced by the loop. */
  readonly budget?: Budget;
  /** Live counters behind {@link Agent.budget}; reset at the start of every run. */
  budgetState?: BudgetState;
  /** Google chain-TTL tier (`free` 23h default / `paid` 54d). */
  readonly googleTier?: "free" | "paid";
  /** Per-call defaults forwarded to providers; per-run options override them. */
  private readonly callDefaults: {
    toolChoice?: ToolChoiceOption;
    maxOutputTokens?: number;
    retry?: RetryPolicyConfig;
    env?: Record<string, string>;
    fetch?: typeof fetch;
  };
  /** Maximum model/tool turns per run. */
  readonly maxTurns: number;
  /** Session ID used for history and cache affinity. */
  readonly sessionId: string;
  /** Explicit API key override. */
  readonly apiKey?: string;
  /** Explicit provider endpoint override. */
  readonly baseUrl?: string;
  /** Headers applied to requests. */
  readonly customHeaders?: Record<string, string>;
  /** Mutable conversation context. */
  readonly context: AgentContext;
  /** Whether history is cleared around each run. */
  readonly stateless: boolean;
  /** Durable persistence target: session file rewritten after every step. */
  readonly persistConfig?: { dir?: string; file?: string };
  /** Mid-session queue policy for new queries arriving while a run is active. */
  readonly midSessionConfig: Required<Pick<MidSessionConfig, "mode">> & MidSessionConfig & { maxSteers?: number };
  /** Max buffered steer entries per run (default 20). */
  readonly maxSteers: number;
  /**
   * Normalized run limits. Read from `(config as any).limits`;
   * sub-agents inherit these unless overridden. `maxTurns`/`deadlineMs`/
   * `maxToolCallsPerRun` default to unlimited; timeouts default to
   * request 300s / first-byte 120s / idle 300s (tolerate reasoning).
   */
  readonly runLimits: AgentRunLimits;
  private currentRun: {
    steerInbox: SteerEntry[];
    outerStream?: AssistantMessageEventStream;
    runPromise?: Promise<AgentResponse>;
    abortController: AbortController;
  } | null = null;
  private pendingQueue: Array<{
    prompt: string | ContentPart[];
    options?: AgentRunOptions;
    isStream: boolean;
    deferredStream?: AssistantMessageEventStream;
    resolve: (res: AgentResponse) => void;
    reject: (err: unknown) => void;
    /** Put here by `interrupt(message)`: runs before every other waiting prompt. */
    urgent?: boolean;
  }> = [];
  /** Named session contexts for `sessionId` runs (LRU 100 + TTL). */
  private sessions = new Map<string, { context: AgentContext; lastAccess: number }>();
  /** Coalesced persistence single-flight flag. */
  private persistScheduled = false;
  /** Step journal of the persisted session folder (dir mode only). */
  private journal?: SessionJournal;
  /** Log files of tool calls in the persisted session folder (dir mode only). */
  private toolLogs?: ToolLogs;
  private toolLogsDir?: string;
  /** Where each run of the default session began (saved with the session). @internal */
  readonly runMarks: SessionRunMark[] = [];
  /** Tool calls finished in the current run; saved the moment each finishes so a crash never repeats them. @internal */
  readonly toolRecords: SessionToolRecord[] = [];
  /** What this agent spent on its OWN model calls (workers keep their own); saved with the session. @internal */
  readonly usageTotals: UsageTotals = emptyUsage();
  /** The run in flight (its mark has no ending yet, but it is not "interrupted"). */
  private activeMark?: SessionRunMark;
  /** What to do with a cut-off run at construction (see `AgentConfig.resume`). */
  private readonly resumeMode: "automatic" | "explicit";
  /** How often a failed run is tried again (see `AgentConfig.runRetries`). */
  private readonly runRetries: number;
  /** The resume in flight, so a second `resume()` returns the same promise. */
  private resuming?: Promise<AgentResponse | undefined>;
  private workerRegistry?: WorkerRegistry;

  /**
   * Creates an agent and registers its model, tools, cache, and delegation settings.
   *
   * @param config Agent configuration. `model` may be a provider/model string,
   * a catalog spec, or a model-provider instance.
   *
   * @example
   * ```ts
   * const agent = new Agent({
   *   model: "google/gemini-3.5-flash-lite",
   *   instructions: "Be concise and factual.",
   *   thinkingLevel: "medium",
   *   tools: { get_status },
   * });
   *
   * const response = await agent.run("Check the status");
   * console.log(response.text);
   * ```
   */
  constructor(config: AgentConfig) {
    this.name = config.name || "Agent";
    this.description = config.description || "AI Agent powered by Agent Accelerator";
    // DX1: only instructions (no systemPrompt alias)
    this.instructions = config.instructions || "";
    this.prompts = resolvePrompts(config.prompts);
    // Unified model resolution (shared with SubAgent/workers): supports
    // ModelProviderInstance {model,apiKey,...} and ModelSpec {id,provider}.
    const { modelStringOrSpec, rawModel } = resolveMainModel(config.model);
    this.modelStringOrSpec = modelStringOrSpec as string | any;
    assertModelAllowed(config.allowedModels, modelKey(modelStringOrSpec));
    const dynRaw = config.dynamicSubagents;
    // Unified worker-model chain: dynamicSubagents.model > subagentModel > SUB_AGENT_MODEL.
    const dynModel = resolveDynamicModelInput(dynRaw, config.subagentModel);
    this.subagentModel = dynModel as string | any | undefined;
    const dynEnabled = dynRaw ? (dynRaw.enabled ?? true) : false;
    if (dynRaw) {
      const dynTools = normalizeToolMap(
        (dynRaw as { tools?: Record<string, ToolDefinition> | ToolDefinition[] }).tools
      );
      const rawDepth = (dynRaw as { maxDepth?: unknown }).maxDepth;
      // Depth is unlimited unless the developer sets a cap (a whole number >= 1; Infinity also means unlimited).
      if (
        rawDepth !== undefined &&
        rawDepth !== Infinity &&
        !(Number.isInteger(rawDepth) && (rawDepth as number) >= 1)
      ) {
        throw new ConfigError(
          `[Agent Accelerator] Invalid dynamicSubagents.maxDepth ${JSON.stringify(rawDepth)}: expected a whole number >= 1, or omit it for no limit; set dynamicSubagents.enabled: false to turn workers off.`
        );
      }
      const rawBudget = (dynRaw as { workerBudget?: { maxCostUsd?: unknown; maxTotalTokens?: unknown } }).workerBudget;
      for (const key of ["maxCostUsd", "maxTotalTokens"] as const) {
        const v = rawBudget?.[key];
        if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v > 0)) {
          throw new ConfigError(
            `[Agent Accelerator] Invalid dynamicSubagents.workerBudget.${key} ${JSON.stringify(v)}: expected a number greater than 0, or omit it for no limit.`
          );
        }
      }
      // Open workers are unlimited unless the developer sets a cap (a number >= 1; Infinity also means unlimited).
      const rawMax = (dynRaw as { maxSpawn?: unknown }).maxSpawn;
      if (rawMax !== undefined && (typeof rawMax !== "number" || Number.isNaN(rawMax))) {
        throw new ConfigError(
          `[Agent Accelerator] Invalid dynamicSubagents.maxSpawn ${JSON.stringify(rawMax)}: expected a whole number >= 1, or omit it for no limit.`
        );
      }
      const maxSpawn = rawMax === undefined || rawMax === Infinity ? Infinity : Math.max(1, Math.floor(rawMax));
      // Only scheduled actions are timed: no limit unless the developer sets one (0 and Infinity mean none).
      for (const removed of ["timeout", "modelMaySetTimeout"]) {
        if ((dynRaw as Record<string, unknown>)[removed] !== undefined) {
          throw new ConfigError(
            `[Agent Accelerator] dynamicSubagents.${removed} was removed: set dynamicSubagents.workerTimeoutMs (the longest a scheduled run may take, optional) and let each scheduled action carry its own timeoutMs.`
          );
        }
      }
      const rawTimeout = (dynRaw as { workerTimeoutMs?: unknown }).workerTimeoutMs;
      if (rawTimeout !== undefined && (typeof rawTimeout !== "number" || Number.isNaN(rawTimeout) || rawTimeout < 0)) {
        throw new ConfigError(
          `[Agent Accelerator] Invalid dynamicSubagents.workerTimeoutMs ${JSON.stringify(rawTimeout)}: expected a number of milliseconds > 0, or omit it (0 and Infinity mean no limit).`
        );
      }
      const workerTimeoutMs = !rawTimeout ? Infinity : Math.max(1, Math.floor(rawTimeout));
      this.dynamicSubagents = {
        enabled: dynEnabled,
        model: dynModel as string | any | undefined,
        maxSpawn,
        thinkingLevel: (dynRaw as any)?.thinkingLevel,
        tools: dynTools,
        workerTimeoutMs,
        allowScheduledActions: dynRaw.allowScheduledActions === true,
        maxDepth: (rawDepth as number | undefined) ?? DEFAULT_MAX_DEPTH,
        ...(rawBudget ? { workerBudget: { ...(rawBudget as { maxCostUsd?: number; maxTotalTokens?: number }) } } : {}),
      };
    }
    this.apiKey = (rawModel as any)?.apiKey || config.apiKey;
    this.baseUrl = (rawModel as any)?.baseUrl || config.baseUrl;
    this.customHeaders = config.headers;
    this.maxTurns =
      config.maxTurns === undefined || config.maxTurns === 0 || config.maxTurns === Infinity
        ? Infinity
        : Number.isFinite(config.maxTurns as number)
          ? Math.max(1, Math.floor(config.maxTurns as number))
          : Infinity;
    this.sessionId = config.sessionId || createSessionId();
    (this as any).subagentTraces = {};
    this.home = resolveHome(config.home);
    // `persist: {}` (neither dir nor file) means the default sessions folder under home.
    this.persistConfig =
      config.persist && !config.persist.dir && !config.persist.file
        ? { ...config.persist, dir: path.join(this.home, "sessions") }
        : config.persist;
    // `whenBusy` (canonical) wins over legacy `mode`; anything else is "auto".
    const normalizedMode = resolveWhenBusy(config.midSession);
    const rawMaxQueued = (config.midSession as any)?.maxQueued;
    const rawMaxSteers = (config.midSession as any)?.maxSteers;
    this.midSessionConfig = {
      mode: normalizedMode,
      ...(Number.isFinite(rawMaxQueued) && (rawMaxQueued as number) >= 0
        ? { maxQueued: Math.floor(rawMaxQueued as number) }
        : { maxQueued: 20 }),
      ...(Number.isFinite(rawMaxSteers) && (rawMaxSteers as number) >= 0
        ? { maxSteers: Math.floor(rawMaxSteers as number) }
        : { maxSteers: 20 }),
    };
    // Bound on buffered steer entries (default 20).
    this.maxSteers = this.midSessionConfig.maxSteers ?? 20;
    // Run limits (sub-agents inherit unless overridden).
    this.runLimits = resolveAgentLimits(config as unknown as { limits?: Record<string, unknown> });

    // DX4: single thinkingLevel flag — also inherit from ModelProviderInstance when omitted
    const mpThinking = (rawModel as any)?.thinkingLevel;
    this.thinkingConfig = normalizeThinking(config, mpThinking);

    // Structured outputs: validate early so invalid schemas fail fast at construction.
    if (config.output !== undefined && config.output !== null) {
      this.output = config.output;
      this.outputSpec = normalizeStructuredOutput(config.output);
    }

    if (config.cache !== undefined && !CACHE_OPTIONS.includes(config.cache)) {
      throw new ConfigError(
        `[Agent Accelerator] Invalid cache ${JSON.stringify(config.cache)}: expected one of ${CACHE_OPTIONS.map((v) => `"${v}"`).join(", ")}, or omit it for the provider default.`
      );
    }
    this.cache = config.cache;
    if (config.resume !== undefined && config.resume !== "automatic" && config.resume !== "explicit") {
      throw new ConfigError(
        `[Agent Accelerator] Invalid resume ${JSON.stringify(config.resume)}: expected "automatic" (default) or "explicit".`
      );
    }
    this.resumeMode = config.resume ?? "automatic";
    if (config.runRetries !== undefined && !(Number.isInteger(config.runRetries) && config.runRetries >= 0)) {
      throw new ConfigError(
        `[Agent Accelerator] Invalid runRetries ${JSON.stringify(config.runRetries)}: expected a whole number >= 0 (default 3, 0 turns it off).`
      );
    }
    this.runRetries = config.runRetries ?? 3;

    this.serviceTier = config.serviceTier;
    this.onFailure = config.onFailure === "rollback" || config.onFailure === "keep" ? config.onFailure : "auto";
    this.forkConfig = { ...config };
    this.captureRaw = config.captureRaw;
    this.budget = config.budget ? { ...config.budget } : undefined;
    for (const key of ["hooks", "contextManagement", "logger"] as const) {
      if (config[key] !== undefined) {
        // Declared for forward compatibility only: say so instead of silently ignoring.
        telemetryBus.emitWarning(
          "config.unsupported_option",
          `[Agent Accelerator] AgentConfig.${key} is accepted for forward compatibility but is not implemented yet; it has no effect. Attach to telemetryBus.onEvent for observability.`,
          { option: key }
        );
      }
    }
    if (config.telemetry?.persist) persistTelemetry(this.home);
    this.googleTier = config.googleTier === "paid" || config.googleTier === "free" ? config.googleTier : undefined;
    this.callDefaults = {
      toolChoice: config.toolChoice,
      maxOutputTokens: config.maxOutputTokens,
      retry: config.retry,
      env: config.env,
      fetch: config.fetch,
    };
    this.fileAccess = config.fileAccess
      ? { ...(config.fileAccess.roots ? { roots: [...config.fileAccess.roots] } : {}) }
      : undefined;
    this.stateless = config.stateless ?? false;
    // One process per session folder: fail fast here, before anything is written (another process may use other sessions of the same home).
    this.lockSessionFolder();

    // Tools registration (unified normalization shared with dynamic pool).
    if (config.tools) {
      Object.assign(this.tools, normalizeToolMap(config.tools));
    }

    if (Array.isArray(config.subagents)) {
      const subagentTools = buildAgentTools(config.subagents);
      for (const [toolName, toolDef] of Object.entries(subagentTools)) {
        this.tools[toolName] = toolDef;
      }
    }

    const dyn = this.dynamicSubagents;
    if ((dyn?.enabled === true || dyn?.allowScheduledActions) && !this.subagentModel) {
      throw new SubAgentModelError(
        typeof this.modelStringOrSpec === "string" ? this.modelStringOrSpec : (this.modelStringOrSpec as any)?.id
      );
    }
    if (dyn?.enabled === true) {
      const subagentsTool = createSubagentsTool(this);
      this.tools[subagentsTool.name || "subagents"] = subagentsTool;
    }
    if (dyn?.allowScheduledActions) {
      // Fixed by config, so the tool set (and the prompt cache) stays stable.
      const scheduleTool = createScheduledActionsTool(this);
      this.tools[scheduleTool.name || "scheduled_actions"] = scheduleTool;
      if (!this.tools["get_datetime"]) this.tools["get_datetime"] = getDatetimeTool;
    }

    // Ambiguous tool names would only blow up mid-run, after a paid model turn: fail at construction.
    assertNoToolCollisions(this.tools);

    this.context = new AgentContext(this.getFullInstructions());
    this.registerTelemetryFolder();
    if (dyn?.allowScheduledActions) registerAgent(this);
    if (this.recoverSession() && this.resumeMode === "automatic") {
      // Synchronously, so a run() issued right after construction queues BEHIND the resumed run.
      this.resume().catch((err) => this.reportResumeFailure(err));
    }
  }

  /** The persistent sub-agent workers of this agent: `spawn`, `message`, `close`, `list`, `turns` (see `WorkerRegistry`). */
  get workers(): WorkerRegistry {
    return (this.workerRegistry ??= new WorkerRegistry(this));
  }

  // Takes the one-process lock of the folder this Agent persists to: its own session folder, or the folder of a single `persist.file`; throws ConfigError when another live process holds it; in: the constructor and importSession (a new session id is a new folder), out: a `.lock` file there.
  private lockSessionFolder(): void {
    const cfg = this.persistConfig;
    if (!cfg || this.stateless) return;
    if (cfg.dir) {
      let dir: string;
      try {
        dir = sessionDirFor(cfg.dir, this.sessionId);
      } catch {
        return; // not a usable session id for a folder name, so nothing is saved under it either
      }
      lockFolder(dir);
    } else if (cfg.file) {
      lockFolder(path.dirname(path.resolve(cfg.file)));
    }
  }

  // Tells the telemetry sink where this Agent's session folder is (only for a session persisted to a folder), so its events are written next to its journal; in: the constructor and importSession, out: the telemetry routing map.
  private registerTelemetryFolder(): void {
    const root = this.persistConfig?.dir;
    if (!root || this.stateless) return;
    try {
      registerSessionFolder(this.sessionId, sessionDirFor(root, this.sessionId));
    } catch {
      // why: not a usable session id for a folder name, so nothing is saved under it either.
    }
  }

  // Loads a persisted session that a crash cut off (a run without an ending) or that still had waiting prompts, so it can be resumed; true when there is something to resume; in: the session folder of `persist.dir`, out: context, runMarks, toolRecords, pendingQueue.
  private recoverSession(): boolean {
    const root = this.persistConfig?.dir;
    if (!root || this.stateless) return false;
    let dir: string;
    try {
      dir = sessionDirFor(root, this.sessionId);
    } catch {
      return false; // not a usable session id for a folder name: nothing was ever saved under it
    }
    const session = loadSessionDir(dir)?.session; // a session over the load limits throws SessionLoadError: better than overwriting it
    if (!session) return false;
    const waiting = [...(session.pending?.steer ?? []), ...(session.pending?.queue ?? [])];
    if (!(session.runs ?? []).some((r) => !r.end) && waiting.length === 0) return false;
    this.context.messages = session.messages;
    this.runMarks.splice(0, this.runMarks.length, ...(session.runs ?? []));
    this.restoreUsage(session.usage);
    const open = new Set(unfinishedToolCalls(this.context.messages).map((c) => c.id));
    this.toolRecords.splice(0, this.toolRecords.length, ...(session.tools ?? []).filter((t) => open.has(t.id)));
    for (const w of waiting) {
      this.pendingQueue.push({
        prompt: w.prompt,
        options: w.additionalContext ? { additionalContext: w.additionalContext } : undefined,
        isStream: false,
        resolve: () => {},
        reject: (err) => this.reportResumeFailure(err),
      });
    }
    return true;
  }

  // Puts saved spending totals back after a restart or import (zeros when the file has none); in: a loaded session's `usage`, out: this.usageTotals.
  private restoreUsage(saved: unknown): void {
    Object.assign(this.usageTotals, readUsage(saved));
  }

  // Records one model call of THIS agent (priced per turn, with the service tier); in: the loop's onTurnUsage, out: this.usageTotals (saved by the next persist).
  private recordTurnUsage(usage: TokenUsage, spec: Parameters<typeof priceUsage>[1]): void {
    addTurn(
      this.usageTotals,
      usage,
      priceUsage(usage, spec, this.serviceTier ? { serviceTier: this.serviceTier } : undefined)
    );
  }

  /** Adds another agent's spending to this one (a fixed worker's per-call copy into its template). @internal */
  absorbUsage(other: UsageTotals): void {
    mergeUsage(this.usageTotals, other);
  }

  /**
   * What this agent and every worker below it spent: per agent and per worker (tokens, cache hits, thinking, exact
   * cost per turn) plus a whole-session total, with nothing counted twice. `agent` is this agent's own model calls;
   * workers (open, closed, nested, and rebuilt from disk after a restart) and fixed `subagents` workers are listed
   * below it. Spending of one-shot scheduled-action workers is in their run files, not here.
   */
  usageReport(): UsageReport {
    return buildUsageReport(
      { id: this.sessionId, name: this.name, model: modelName(this.modelStringOrSpec), totals: this.usageTotals },
      [...this.workers.usageNodes(), ...this.fixedWorkerNodes()]
    );
  }

  // The `subagents: [...]` workers as usage nodes (their per-call copies' spending is merged into them); in: the constructor config, out: usageReport.
  private fixedWorkerNodes(): UsageNode[] {
    const nodes: UsageNode[] = [];
    for (const entry of this.forkConfig.subagents ?? []) {
      const worker = "agent" in entry ? entry.agent : entry;
      const name = "agent" in entry ? entry.name : worker.name;
      nodes.push({
        id: name,
        name,
        model: modelName(worker.modelStringOrSpec),
        status: "fixed",
        totals: worker.usageTotals,
        workers: [],
      });
    }
    return nodes;
  }

  // Says on the telemetry bus that resuming (or a prompt that was waiting) failed; in: a rejected resume, out: telemetryBus.
  private reportResumeFailure(err: unknown): void {
    telemetryBus.emitWarning(
      "agent.resume_failed",
      `[Agent Accelerator] Resuming session ${this.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`,
      { sessionId: this.sessionId }
    );
  }

  /** Runs that a crash cut off (they began, never ended and are not running now), oldest first. Needs `persist: { dir }` and the same `sessionId` as before the restart. */
  interrupted(): InterruptedRun[] {
    const calls = unfinishedToolCalls(this.context.messages).map((c) => c.name);
    return this.runMarks
      .filter((m) => !m.end && m !== this.activeMark)
      .map((m) => ({
        runId: m.id,
        startedAt: m.at,
        prompt: previewPrompt((this.context.messages[m.i]?.content ?? "") as string | ContentPart[]),
        pendingToolCalls: calls,
      }));
  }

  /**
   * Continues the run a crash cut off, without a new prompt: tool calls that already have a saved result are NOT run
   * again (only calls with no result are), then the model carries on from the saved conversation, and prompts that
   * were waiting run afterwards. Resolves to that run's response, or `undefined` when nothing was cut off. Returns the
   * same promise while a resume is in flight. With `resume: "automatic"` (default) the constructor already did this.
   */
  resume(): Promise<AgentResponse | undefined> {
    if (this.resuming) return this.resuming;
    if (this.currentRun)
      throw new ValidationError("[Agent Accelerator] resume() needs an idle agent: a run is already active.");
    const mark = this.runMarks.filter((m) => !m.end && m !== this.activeMark).pop();
    const last = this.context.messages[this.context.messages.length - 1];
    const nothingOpen = unfinishedToolCalls(this.context.messages).length === 0;
    if (!mark || (nothingOpen && (last?.role === "assistant" || endsWithStop(this.context.messages)))) {
      // The answer was complete (or a tool had ended the run); only the note that it ended was lost.
      if (mark) this.endRun(mark, endsWithStop(this.context.messages) ? "stopped" : "done");
      this.pumpQueue();
      return Promise.resolve(undefined);
    }
    telemetryBus.emit({
      code: "agent.resumed",
      message: `[Agent Accelerator] resuming run ${mark.id} of session ${this.sessionId}`,
      data: {
        sessionId: this.sessionId,
        runId: mark.id,
        pendingToolCalls: unfinishedToolCalls(this.context.messages).map((c) => c.name),
      },
    });
    const run = this.startNonStreamingRun("", undefined, mark);
    const clear = (): void => {
      if (this.resuming === run) this.resuming = undefined;
    };
    this.resuming = run;
    run.then(clear, clear);
    return run;
  }

  // The finished tool calls of the current run as results the loop can reuse; in: toolRecords, out: loopConfig.resume.stored.
  private storedToolResults(): Map<string, ToolResultRecord> {
    return new Map(
      this.toolRecords.map((t) => [
        t.id,
        {
          id: t.id,
          name: t.name,
          result: t.result,
          ...(t.isError ? { isError: true } : {}),
          ...(t.stopped ? { stopped: true } : {}),
          ...(t.parts && t.parts.length > 0 ? { parts: t.parts } : {}),
        } as ToolResultRecord,
      ])
    );
  }

  // Closes a run's mark with how it ended and saves that at once (not on the next tick), so the disk is up to date when `await run()` returns; in: the run's promise handlers, out: runMarks + journal.
  private endRun(mark: SessionRunMark | undefined, status: SessionRunEnd): void {
    if (!mark) return;
    if (!mark.end) mark.end = status;
    if (this.activeMark === mark) this.activeMark = undefined;
    this.doPersist();
  }

  // Remembers a finished tool call and saves it at once (synchronously): the work is on disk before anything else can happen; in: the executor's per-call callback, out: toolRecords + journal.
  private recordTool(result: ToolResultRecord): void {
    this.toolRecords.push({
      id: result.id,
      name: result.name,
      result: isSubagentResult(result.result) ? result.result.xml : result.result,
      ...(result.isError ? { isError: true } : {}),
      ...(result.stopped ? { stopped: true } : {}),
      ...(result.parts && result.parts.length > 0 ? { parts: result.parts } : {}),
    });
    this.doPersist();
  }

  // Builds the system prompt: the developer's instructions plus, when thinking is on, the fixed Reasoning Directive; in: this.instructions + thinkingConfig, out: every AgentContext.systemPrompt.
  private getFullInstructions(): string | undefined {
    const base = this.instructions || "";
    let out = base;
    const isThinkingEnabled =
      this.thinkingConfig?.enabled !== false && this.thinkingConfig?.level && this.thinkingConfig?.level !== "none";
    const guidance = this.prompts.reasoningDirective;
    if (isThinkingEnabled && !out.includes(guidance)) {
      out = out ? `${out}\n\n${guidance}` : guidance;
    }
    return out || undefined;
  }

  /** Starts a fresh conversation: clears messages, signatures, run marks and the run's saved tool results, keeps config and spending totals. */
  reset(): void {
    const sid = this.sessionId;
    this.context.messages = [];
    this.context.thoughtSignatures = [];
    this.context.systemPrompt = this.getFullInstructions();
    this.runMarks.length = 0;
    this.toolRecords.length = 0; // a cleared conversation has no run to resume, so its finished tool results go too
    this.activeMark = undefined;
    // Reset also drops session-scoped provider chaining/routing.
    try {
      clearInteractionChains(sid);
    } catch {}
    try {
      clearSessionRouting(sid);
    } catch {}
  }

  /**
   * Returns a named session handle. `session()` creates an isolated
   * `AgentContext` bound to `id` (separate histories per id); `agent.run`
   * with `{ sessionId }` selects/creates the same entry. Sessions are
   * ephemeral in-memory (LRU 100 + 1h TTL). `agent.run`/`stream` without a
   * `sessionId` remain sugar over the default session for compat.
   */
  session(id?: string): { id: string; context: AgentContext; runController: AbortController | null } {
    const sid = id || this.sessionId;
    const ctx = this.getSessionContext(sid);
    return { id: sid, context: ctx, runController: null };
  }

  /** Drops one named session. No-op for unknown ids. */
  disposeSession(id: string): void {
    unregisterSessionFolder(id);
    try {
      this.sessions.delete(id);
    } catch {}
    try {
      clearInteractionChains(id);
    } catch {}
    try {
      clearSessionRouting(id);
    } catch {}
  }

  /** Drops all named sessions except the default context. */
  clearSessions(): void {
    try {
      for (const id of [...this.sessions.keys()]) {
        try {
          clearInteractionChains(id);
        } catch {}
        try {
          clearSessionRouting(id);
        } catch {}
      }
      this.sessions.clear();
    } catch {}
  }

  /** Resolves the context for a `sessionId` run (default session = `this.context`). */
  private getSessionContext(sessionId?: string): AgentContext {
    const sid = sessionId || this.sessionId;
    if (sid === this.sessionId) return this.context;
    const now = Date.now();
    // TTL eviction.
    try {
      for (const [key, entry] of [...this.sessions.entries()]) {
        if (now - entry.lastAccess > SESSION_TTL_MS) {
          this.sessions.delete(key);
          try {
            clearInteractionChains(key);
          } catch {}
          try {
            clearSessionRouting(key);
          } catch {}
        }
      }
    } catch {}
    const existing = this.sessions.get(sid);
    if (existing) {
      existing.lastAccess = now;
      return existing.context;
    }
    const fresh = new AgentContext(this.getFullInstructions());
    this.sessions.set(sid, { context: fresh, lastAccess: now });
    // LRU eviction (oldest lastAccess first).
    try {
      while (this.sessions.size > SESSION_LRU_MAX) {
        let oldest: string | undefined;
        let oldestTs = Infinity;
        for (const [key, entry] of this.sessions) {
          if (entry.lastAccess < oldestTs) {
            oldestTs = entry.lastAccess;
            oldest = key;
          }
        }
        if (!oldest) break;
        this.sessions.delete(oldest);
        try {
          clearInteractionChains(oldest);
        } catch {}
        try {
          clearSessionRouting(oldest);
        } catch {}
      }
    } catch {}
    return fresh;
  }

  /** Rejects + drops all queued follow-ups. Returns the cleared count. */
  clearQueue(): number {
    const n = this.pendingQueue.length;
    if (n === 0) return 0;
    const err = Object.assign(new Error("Queue cleared"), { name: "AbortError" });
    const pending = this.pendingQueue.splice(0);
    for (const entry of pending) {
      try {
        entry.reject(err);
      } catch {}
      try {
        entry.deferredStream?.fail(err instanceof Error ? err : new Error(String(err)));
      } catch {}
    }
    this.persistNow();
    return n;
  }

  /** Throws when the steer inbox is at its bound. */
  private assertSteerRoom(inbox: SteerEntry[]): void {
    const max = this.maxSteers ?? 20;
    if (inbox.length >= max) {
      throw new ValidationError(
        `[Agent Accelerator] Steer inbox is full (${inbox.length}/${max}). Wait for the active run to drain or increase midSession.maxSteers.`
      );
    }
  }

  /**
   * True while a `run()`/`stream()` turn is active on this agent.
   * Use with `steer()` (current-turn redirect) vs `queue()` (next-turn follow-up).
   */
  get isBusy(): boolean {
    return this.currentRun !== null;
  }

  /** Number of queued follow-up requests waiting for the active run to finish. */
  get pendingCount(): number {
    return this.pendingQueue.length;
  }

  /** Number of steer messages buffered for injection into the active turn. */
  get steerPendingCount(): number {
    return this.currentRun?.steerInbox.length ?? 0;
  }

  /** Effective mid-session policy (`steer` | `queue` | `auto`). */
  get midSessionMode(): "steer" | "queue" | "auto" {
    return this.midSessionConfig.mode;
  }

  // Picks steer or queue for a call that arrives while busy: the developer's enforced midSession mode wins over the per-call request; in: run()/stream() `enqueue`, out: their busy branch.
  private resolveEnqueueMode(requested?: "steer" | "queue"): "steer" | "queue" {
    const enforced = this.midSessionConfig.mode;
    if (enforced === "steer" || enforced === "queue") return enforced;
    return requested === "steer" ? "steer" : "queue";
  }

  // Throws synchronously on an empty content-part array so run() and stream() fail at the same moment; in: any prompt entry point, out: nothing.
  private assertPromptValid(prompt: string | ContentPart[]): void {
    if (Array.isArray(prompt) && prompt.length === 0) {
      throw new ValidationError(
        "[Agent Accelerator] Prompt cannot be empty: pass a non-empty string or at least one content part."
      );
    }
  }

  /**
   * Stops the active run now (STOP.) and, given a message, starts it next (STOP. Do this instead). The provider
   * request is aborted (connection closed, so the provider stops generating where it can), the stream is cancelled, and
   * running tools and workers get the abort signal; the interrupted run rejects with `AbortError` and keeps its partial
   * history. `interrupt()` and `interrupt(error)` only stop (no-op when idle) and return nothing. `interrupt(message)`
   * also runs `message` as the next run, ahead of queued follow-ups, in every `midSession` mode, and resolves with that
   * run's response; when idle it simply runs the message. For a stream use `stream(message, { enqueue: "interrupt" })`.
   */
  interrupt(reason?: Error): void;
  interrupt(message: string | ContentPart[], options?: AgentRunOptions): Promise<AgentResponse>;
  interrupt(arg?: Error | string | ContentPart[], options?: AgentRunOptions): void | Promise<AgentResponse> {
    if (typeof arg === "string" || Array.isArray(arg)) {
      if (options?.stream === true) {
        throw new ValidationError(
          '[Agent Accelerator] interrupt(message) is non-streaming. Use stream(prompt, { enqueue: "interrupt" }) for a streaming interrupt.'
        );
      }
      return this.run(arg, { ...options, enqueue: "interrupt" });
    }
    this.abortActive(arg instanceof Error ? arg : undefined);
  }

  // Aborts the active run (provider request, tools, workers, stream) through its own controller; no-op when idle; in: interrupt and queueUrgent, out: the run settles as AbortError.
  private abortActive(reason?: Error): void {
    const active = this.currentRun;
    if (!active) return;
    try {
      active.abortController.abort(reason ?? new Error("Agent interrupted"));
    } catch {}
    try {
      active.outerStream?.cancel(reason);
    } catch {}
  }

  // Puts a prompt ahead of everything waiting (behind earlier interrupts) and aborts the active run, so it starts as soon as that run has settled; ignores midSession mode and maxQueued; in: run()/stream() with enqueue "interrupt", out: pendingQueue + the abort.
  private queueUrgent(entry: Agent["pendingQueue"][number]): void {
    entry.urgent = true;
    const firstOrdinary = this.pendingQueue.findIndex((e) => !e.urgent);
    this.pendingQueue.splice(firstOrdinary < 0 ? this.pendingQueue.length : firstOrdinary, 0, entry);
    this.persistNow();
    this.abortActive();
  }

  /**
   * Steers the active turn (While you're doing that, change direction).
   * The current provider/tool work finishes first, then `prompt` is injected
   * as a user message into the SAME run — same `AgentResponse`, same
   * `maxTurns` budget. Resolves to the active run's final response.
   * When idle, behaves like `run(prompt, options)`.
   * Throws when the developer enforces `midSession: { mode: "queue" }`.
   * Note: `options` only honors `additionalContext` mid-turn (thinking level,
   * session, and streaming callbacks stay with the active run). For a
   * streaming follow-up use `stream(prompt, { enqueue: "steer" })`.
   */
  steer(prompt: string | ContentPart[], options?: AgentRunOptions): Promise<AgentResponse> {
    this.assertPromptValid(prompt);
    if (options?.stream === true) {
      throw new ValidationError(
        '[Agent Accelerator] steer() is non-streaming. Use stream(prompt, { enqueue: "steer" }) for a streaming steer.'
      );
    }
    if (this.midSessionConfig.mode === "queue") {
      throw new ConfigError(
        '[Agent Accelerator] steer() is disabled by midSession.mode "queue". Use queue() or set mode to "auto"/"steer".'
      );
    }
    const active = this.currentRun;
    if (!active) return this.run(prompt, options) as Promise<AgentResponse>;
    return this.steerInto(active, prompt, options);
  }

  /**
   * Buffers a steer prompt into the active run and returns a promise for ITS
   * reply: the active run's response when the prompt is injected, or (if the
   * run ends first and the prompt becomes a queued follow-up) the follow-up
   * run's response, so a late steer's answer is never lost.
   */
  private steerInto(
    active: NonNullable<Agent["currentRun"]>,
    prompt: string | ContentPart[],
    options?: AgentRunOptions
  ): Promise<AgentResponse> {
    this.assertSteerRoom(active.steerInbox);
    const runDone = active.runPromise ?? active.outerStream?.result();
    if (!runDone) return this.run(prompt, options) as Promise<AgentResponse>;
    const entry: SteerEntry = { prompt, options };
    const reply = new Promise<AgentResponse>((resolve, reject) => {
      entry.settle = { resolve, reject };
    });
    reply.catch(() => {}); // a fire-and-forget caller must not trigger an unhandled rejection
    active.steerInbox.push(entry);
    this.persistNow();
    runDone.then(
      (res) => {
        if (!entry.settle?.deferredToQueue) entry.settle?.resolve(res);
      },
      (err) => {
        if (!entry.settle?.deferredToQueue) entry.settle?.reject(err);
      }
    );
    return reply;
  }

  /**
   * Queues a follow-up for the next turn (When you're done, do this next).
   * The active run finishes completely first; this prompt then starts a new
   * run with its own turn budget and `AgentResponse`. Resolves to that next
   * turn's response. When idle, behaves like `run(prompt, options)`.
   * Throws when the developer enforces `midSession: { mode: "steer" }` or
   * when `maxQueued` is exceeded. For a streaming follow-up use
   * `stream(prompt, { enqueue: "queue" })`.
   */
  queue(prompt: string | ContentPart[], options?: AgentRunOptions): Promise<AgentResponse> {
    this.assertPromptValid(prompt);
    if (options?.stream === true) {
      throw new ValidationError(
        '[Agent Accelerator] queue() is non-streaming. Use stream(prompt, { enqueue: "queue" }) for a streaming follow-up.'
      );
    }
    if (this.midSessionConfig.mode === "steer") {
      throw new ConfigError(
        '[Agent Accelerator] queue() is disabled by midSession.mode "steer". Use steer() or set mode to "auto"/"queue".'
      );
    }
    if (!this.currentRun) return this.run(prompt, options) as Promise<AgentResponse>;
    const max = this.midSessionConfig.maxQueued ?? 20;
    if (this.pendingQueue.length >= max) {
      throw new ValidationError(
        `[Agent Accelerator] Queue is full (${this.pendingQueue.length}/${max}). Wait for the active run to finish or increase midSession.maxQueued.`
      );
    }
    return new Promise<AgentResponse>((resolve, reject) => {
      this.pendingQueue.push({ prompt, options, isStream: false, resolve, reject });
      this.persistNow();
      try {
        this.currentRun?.outerStream?.push({
          type: "queued",
          queuedPrompt: previewPrompt(prompt),
          queueLength: this.pendingQueue.length,
        } as any);
      } catch {}
    });
  }

  // Starts the next waiting prompt (urgent ones first, aborted ones rejected) as a streaming or non-streaming run once the agent is idle; in: finishCurrentRun and queue changes, out: a new run whose result settles the queued caller.
  private pumpQueue(): void {
    if (this.currentRun !== null) return;
    const next = this.pendingQueue.shift();
    if (!next) return;
    this.persistNow();
    // Reject queued items whose signal aborted before start.
    try {
      if ((next.options as { signal?: AbortSignal } | undefined)?.signal?.aborted) {
        const reason = ((next.options as { signal?: AbortSignal }).signal as unknown as { reason?: unknown })?.reason;
        const abortErr = Object.assign(
          reason instanceof Error ? reason : new Error("Queued run aborted before start"),
          { name: "AbortError" }
        );
        try {
          next.reject(abortErr);
        } catch {}
        try {
          next.deferredStream?.fail(abortErr instanceof Error ? abortErr : new Error(String(abortErr)));
        } catch {}
        queueMicrotask(() => this.pumpQueue());
        return;
      }
    } catch {}
    if (next.isStream && next.deferredStream) {
      const deferred = next.deferredStream;
      try {
        const real = this.startStreamingRun(next.prompt, next.options);
        try {
          (deferred as any).__piped = true;
        } catch {}
        const forward = (e: StreamEvent) => {
          try {
            deferred.push(e);
          } catch {}
        };
        real.on("*", forward as any);
        try {
          deferred.onCancel(() => {
            try {
              real.cancel();
            } catch {}
          });
        } catch {}
        real.result().then(
          (res) => {
            try {
              next.resolve(res);
            } catch {}
            try {
              deferred.end(res);
            } catch {}
          },
          (err) => {
            try {
              next.reject(err);
            } catch {}
            // Pipe failures into the deferred stream so for-await sees them.
            try {
              deferred.fail(err instanceof Error ? err : new Error(String(err)));
            } catch {}
          }
        );
      } catch (err) {
        try {
          next.reject(err);
        } catch {}
        try {
          deferred.fail(err instanceof Error ? err : new Error(String(err)));
        } catch {}
        // Keep draining even if starting failed.
        queueMicrotask(() => this.pumpQueue());
      }
      return;
    }
    this.startNonStreamingRun(next.prompt, next.options).then(next.resolve, next.reject);
  }

  // Ends the active run slot: leftover steers become follow-ups at the FRONT of the queue (behind urgent ones), then the queue is pumped; in: a settled run, out: pendingQueue + persistNow.
  private finishCurrentRun(): void {
    // Leftover steer entries become queued follow-ups instead of dropping.
    let leftover: SteerEntry[] = [];
    try {
      leftover = this.currentRun?.steerInbox?.splice(0) ?? [];
    } catch {
      leftover = [];
    }
    this.currentRun = null;
    if (leftover.length > 0) {
      try {
        const max = this.midSessionConfig.maxQueued ?? 20;
        // Late steers were typed BEFORE anything already queued: they go to the front, in the order they arrived.
        const lateSteers: Agent["pendingQueue"] = [];
        for (const entry of leftover) {
          try {
            if ((entry.options as { signal?: AbortSignal } | undefined)?.signal?.aborted) {
              entry.settle?.reject(
                Object.assign(new Error("Steer aborted before it could run"), { name: "AbortError" })
              );
              continue;
            }
          } catch {
            continue;
          }
          if (this.pendingQueue.length + lateSteers.length >= max) {
            entry.settle?.reject(
              new ValidationError("[Agent Accelerator] Steer dropped: the follow-up queue is full.")
            );
            continue;
          }
          // The steer was never injected: it now runs as a follow-up, and the
          // caller's promise resolves with that run's response.
          if (entry.settle) entry.settle.deferredToQueue = true;
          lateSteers.push({
            prompt: entry.prompt,
            options: entry.options,
            isStream: false,
            resolve: entry.settle?.resolve ?? (() => {}),
            reject: entry.settle?.reject ?? (() => {}),
          });
        }
        // ...but behind an interrupt(message), which is the newest and most urgent instruction.
        const firstOrdinary = this.pendingQueue.findIndex((e) => !e.urgent);
        this.pendingQueue.splice(firstOrdinary < 0 ? this.pendingQueue.length : firstOrdinary, 0, ...lateSteers);
      } catch {}
    }
    this.persistNow();
    // Defer pump so the completing run's .then handlers settle first.
    queueMicrotask(() => this.pumpQueue());
  }

  // Removes the abort listener a run's merged signal fallback installed; in: a settled run's controller, out: nothing.
  private cleanupMerge(runController: AbortController): void {
    try {
      const dispose = mergeDisposers.get(runController);
      if (dispose) {
        try {
          dispose();
        } catch {}
        mergeDisposers.delete(runController);
      }
    } catch {}
  }

  // Joins the caller's AbortSignal with the run's own controller (AbortSignal.any, else a manual forward) so both stop the run; in: AgentRunOptions.signal + the run controller, out: the signal handed to the loop.
  private mergeUserSignal(userSignal?: AbortSignal, runController?: AbortController): AbortSignal | undefined {
    if (!runController) return userSignal;
    if (!userSignal) return runController.signal;
    if (userSignal.aborted) {
      try {
        runController.abort((userSignal as any).reason);
      } catch {
        try {
          runController.abort();
        } catch {}
      }
      return runController.signal;
    }
    // Prefer AbortSignal.any (no expando, no listener leak).
    try {
      const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
      if (typeof anyFn === "function") {
        return anyFn.call(AbortSignal, [userSignal, runController.signal]);
      }
    } catch {}
    // Fallback: manual forward without expando (disposer in WeakMap).
    const forward = () => {
      try {
        runController.abort((userSignal as any).reason);
      } catch {
        try {
          runController.abort();
        } catch {}
      }
    };
    try {
      userSignal.addEventListener("abort", forward, { once: true });
    } catch {}
    try {
      mergeDisposers.set(runController, () => {
        try {
          userSignal.removeEventListener("abort", forward);
        } catch {}
      });
    } catch {}
    return runController.signal;
  }

  /**
   * Config a spawned dynamic worker must inherit so it is never less
   * constrained than its parent (run limits, retry policy, credentials/env,
   * fetch, Google tier, file-access policy).
   * @internal
   */
  inheritableConfig(): Partial<AgentConfig> {
    const d = this.callDefaults;
    return {
      limits: { ...this.runLimits },
      ...(this.forkConfig.prompts ? { prompts: { ...this.forkConfig.prompts } } : {}),
      ...(d.retry ? { retry: d.retry } : {}),
      ...(d.env ? { env: d.env } : {}),
      ...(d.fetch ? { fetch: d.fetch } : {}),
      ...(this.googleTier ? { googleTier: this.googleTier } : {}),
      ...(this.fileAccess ? { fileAccess: this.fileAccess } : {}),
      ...(this.captureRaw !== undefined ? { captureRaw: this.captureRaw } : {}),
    };
  }

  /**
   * Isolated, stateless copy of this agent for ONE delegated call. An `Agent`
   * runs one thing at a time (a second `stream()` while busy queues or steers
   * into the first), so delegation tools fork per call: parallel calls to the
   * same worker then truly run in parallel, each with its own context and
   * session id, and never see each other's answers. The copy keeps this
   * agent's model, instructions, tools and policies but not its persistence.
   * @internal
   */
  fork(sessionId: string, parentSessionId?: string): Agent {
    // A fork is a short-lived worker copy: it must not schedule, nor replace the
    // real agent in the scheduler's registry.
    const dyn = this.forkConfig.dynamicSubagents;
    const copy = new Agent({
      ...this.forkConfig,
      sessionId,
      stateless: true,
      persist: undefined,
      ...(dyn?.allowScheduledActions ? { dynamicSubagents: { ...dyn, allowScheduledActions: false } } : {}),
    });
    if (parentSessionId) (copy as unknown as { parentSessionId?: string }).parentSessionId = parentSessionId;
    return copy;
  }

  /**
   * The part of this agent that an agent may edit, as plain JSON: `{ model, instructions, tools }` (`model` is the
   * `provider/model` string, never a key; `tools` are the names of the tools you passed in `tools`). Store it, show it
   * to the model, and rebuild with {@link Agent.fromConfig}.
   */
  toConfig(): Required<EditableAgentConfig> {
    return toEditableConfig(this.modelStringOrSpec, this.instructions, this.forkConfig.tools);
  }

  /**
   * Builds an Agent from your full `base` config with an agent's edits applied. Only `model`, `instructions` and
   * `tools` of `editable` count (other keys are ignored with a `config.not_editable` warning); `tools` are names picked
   * from `base.tools`, an unknown name throws; `base.allowedModels` is enforced. Keys and limits always come from `base`.
   */
  static fromConfig(editable: EditableAgentConfig, base: AgentConfig): Agent {
    return new Agent(applyEditable(editable, base));
  }

  /** Budgets are per run: counters restart whenever a new run begins. */
  private resetBudgetState(): void {
    if (this.budget) this.budgetState = { spawned: 0, totalTokens: 0, totalCostUsd: 0, startedAtMs: nowMs() };
  }

  /** Loop hook: charge `usage` (when given) and throw `BudgetExceededError` once any cap is passed. */
  private enforceBudget(usage?: TokenUsage): void {
    if (!this.budget) return;
    if (usage) chargeBudgetUsage(this as unknown as Parameters<typeof chargeBudgetUsage>[0], usage);
    checkBudget(this.budget, this.budgetState);
  }

  /** Folds the canonical per-run `thinking` option into `thinkingLevel` so every downstream reader agrees. */
  private withResolvedThinking<T extends AgentRunOptions>(runOptions: T): T {
    const level = normalizeThinkingV2(runOptions.thinking, runOptions.thinkingLevel);
    return level ? { ...runOptions, thinkingLevel: level } : runOptions;
  }

  /**
   * Single place that turns agent config + per-run options into the options
   * every provider call receives. Per-run values override agent defaults
   * (objects such as `retry` and `env` merge key by key).
   */
  private buildProviderOptions(runOptions: AgentRunOptions | undefined): ProviderRequestOptions {
    const d = this.callDefaults;
    const sessionId = runOptions?.sessionId || this.sessionId;
    const toolChoice = normalizeToolChoiceOption(runOptions?.toolChoice ?? d.toolChoice);
    const retry = { ...d.retry, ...runOptions?.retry };
    const env = { ...d.env, ...runOptions?.env };
    const maxOutputTokens = runOptions?.maxOutputTokens ?? d.maxOutputTokens;
    const fetchImpl = runOptions?.fetch ?? d.fetch;
    return {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      headers: { ...(this.customHeaders ?? {}), ...(runOptions?.headers ?? {}) },
      thinking: resolveEffectiveThinking(this.thinkingConfig, runOptions?.thinkingLevel),
      ...(this.cache ? { cache: this.cache } : {}),
      serviceTier: this.serviceTier,
      sessionId,
      ...(this.outputSpec ? { output: this.outputSpec } : {}),
      prompts: { structuredOutput: this.prompts.structuredOutput, toolBridge: this.prompts.toolBridge },
      ...(this.googleTier ? { googleTier: this.googleTier } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...(retry.maxRetries !== undefined ? { maxRetries: retry.maxRetries } : {}),
      ...(retry.maxDelayMs !== undefined ? { maxRetryDelayMs: retry.maxDelayMs } : {}),
      ...(retry.baseDelayMs !== undefined ? { retryBaseDelayMs: retry.baseDelayMs } : {}),
      ...(retry.budgetMs !== undefined ? { retryBudgetMs: retry.budgetMs } : {}),
    };
  }

  // Runs one non-streaming run as a task: catalog refresh, model resolve, prompt/mark (or a resumed mark), loop with `runRetries` backoff, trace merge, run ending recorded; in: run()/queue/resume(), out: the AgentResponse promise.
  private startNonStreamingRun(
    prompt: string | ContentPart[],
    options?: AgentRunOptions,
    resumeMark?: SessionRunMark
  ): Promise<AgentResponse> {
    this.resetBudgetState();
    let mark: SessionRunMark | undefined;
    const runController = new AbortController();
    const steerInbox: SteerEntry[] = [];
    const mergedSignal = this.mergeUserSignal(options?.signal, runController);
    const runOptions = this.withResolvedThinking({ ...options, signal: mergedSignal });
    // Route to the named session context (default = this.context).
    const targetContext = this.getSessionContext(runOptions?.sessionId || this.sessionId);
    const task = (async (): Promise<AgentResponse> => {
      await ensureModelCatalogFresh();
      const resolved = resolveModel(this.modelStringOrSpec);
      const effectiveLevel = runOptions?.thinkingLevel || this.thinkingConfig?.level;
      if (effectiveLevel) {
        validateModelThinking(resolved.provider.id, resolved.modelId, effectiveLevel);
      }
      if (resumeMark) {
        // Continuing a cut-off run: no new prompt, the saved conversation is the input.
        mark = resumeMark;
        this.activeMark = mark;
        targetContext.systemPrompt = this.getFullInstructions();
      } else {
        mark = this.prepareTurn(prompt, runOptions, targetContext);
      }
      this.persistNow();

      const providerOptions = this.buildProviderOptions(runOptions);

      const loopConfig = {
        agentName: this.name,
        provider: resolved.provider,
        modelId: resolved.modelId,
        context: targetContext,
        tools: this.tools,
        options: providerOptions,
        runOptions,
        maxTurns: this.maxTurns,
        ...(this.fileAccess ? { fileAccess: this.fileAccess } : {}),
        onFailure: this.onFailure,
        ...(this.captureRaw !== undefined ? { captureRaw: this.captureRaw } : {}),
        ...(this.budget ? { enforceBudget: (u?: TokenUsage) => this.enforceBudget(u) } : {}),
        onProgress: () => this.persistNow(),
        onTurnUsage: (u: TokenUsage, spec: Parameters<typeof priceUsage>[1]) => this.recordTurnUsage(u, spec),
        onToolResult: (r: ToolResultRecord) => this.recordTool(r),
        openToolLog: (call: { name: string }, sid: string | undefined) => this.openToolLog(call, sid),
        ...(resumeMark ? { resume: { stored: this.storedToolResults() } } : {}),
        steerInbox,
        onSteerInjected: () => this.persistNow(),
        // Loop enforces these (plus local timeout races).
        limits: { ...this.runLimits },
        prompts: this.prompts,
        ...(this.output !== undefined ? { output: this.output } : {}),
      };

      // A run that failed for a transient reason is tried again from where it stopped (the prompt is already in history,
      // finished tool calls are kept), holding the agent busy meanwhile; anything else fails at once.
      let res: AgentResponse;
      const failedAttempts: FailedAttempt[] = [];
      for (let attempt = 0; ; attempt++) {
        try {
          res = await runAgentLoop(
            attempt === 0 ? loopConfig : { ...loopConfig, resume: { stored: this.storedToolResults() } }
          );
          break;
        } catch (err) {
          if (attempt >= this.runRetries || runOptions?.signal?.aborted || !isRetryableRun(err)) throw err;
          const partial = (err as { partial?: FailedAttempt }).partial;
          if (partial?.usage) failedAttempts.push(partial);
          const delayMs = Math.max(
            RUN_RETRY_DELAYS_MS[Math.min(attempt, RUN_RETRY_DELAYS_MS.length - 1)]!,
            readRetryAfterMs(err) ?? 0
          );
          telemetryBus.emitWarning(
            "agent.run_retry",
            `[Agent Accelerator] Run failed (${err instanceof Error ? err.message : String(err)}); retry ${attempt + 1} of ${this.runRetries} in ${delayMs} ms.`,
            { sessionId: this.sessionId, attempt: attempt + 1, of: this.runRetries, delayMs }
          );
          await sleep(delayMs, runOptions?.signal);
        }
      }
      if (failedAttempts.length > 0) res = withFailedAttempts(res, failedAttempts);
      this.mergeSubagentTraces(res.subagents as any);
      this.persistNow();
      if (this.stateless) {
        targetContext.messages = [];
        targetContext.thoughtSignatures = [];
      }
      return res;
    })();

    this.currentRun = { steerInbox, abortController: runController, runPromise: task };
    task.then(
      (res) => this.endRun(mark, res.finishReason === "stopped" ? "stopped" : "done"),
      (err) => this.endRun(mark, isAbortError(err) ? "aborted" : "failed")
    );
    const cleanup = () => {
      try {
        this.cleanupMerge(runController);
      } catch {}
      if (this.currentRun?.runPromise === task) this.finishCurrentRun();
    };
    task.then(cleanup, cleanup);
    return task;
  }

  // Starts one streaming run: validates the model and thinking level synchronously, adds the prompt, builds the loop config and returns the loop's event stream, recording the run ending when it settles; in: stream()/pumpQueue, out: an AssistantMessageEventStream.
  private startStreamingRun(prompt: string | ContentPart[], options?: AgentRunOptions): AssistantMessageEventStream {
    const resolved = resolveModel(this.modelStringOrSpec);
    const effectiveLevel = normalizeThinkingV2(options?.thinking, options?.thinkingLevel) || this.thinkingConfig?.level;
    if (effectiveLevel) {
      validateModelThinking(resolved.provider.id, resolved.modelId, effectiveLevel);
    }
    // Named session routing (default session for compat).
    const targetContext = this.getSessionContext(options?.sessionId || this.sessionId);
    const mark = this.prepareTurn(prompt, options, targetContext);
    this.persistNow();

    this.resetBudgetState();
    const runController = new AbortController();
    const mergedSignal = this.mergeUserSignal(options?.signal, runController);
    const runOptions = this.withResolvedThinking({ ...options, signal: mergedSignal });
    const steerInbox: SteerEntry[] = [];

    const providerOptions = this.buildProviderOptions(runOptions);

    const loopConfig = {
      agentName: this.name,
      provider: resolved.provider,
      modelId: resolved.modelId,
      context: targetContext,
      tools: this.tools,
      options: providerOptions,
      runOptions,
      maxTurns: this.maxTurns,
      ...(this.fileAccess ? { fileAccess: this.fileAccess } : {}),
      onFailure: this.onFailure,
      ...(this.captureRaw !== undefined ? { captureRaw: this.captureRaw } : {}),
      ...(this.budget ? { enforceBudget: (u?: TokenUsage) => this.enforceBudget(u) } : {}),
      onProgress: () => this.persistNow(),
      onTurnUsage: (u: TokenUsage, spec: Parameters<typeof priceUsage>[1]) => this.recordTurnUsage(u, spec),
      onToolResult: (r: ToolResultRecord) => this.recordTool(r),
      openToolLog: (call: { name: string }, sid: string | undefined) => this.openToolLog(call, sid),
      steerInbox,
      onSteerInjected: () => this.persistNow(),
      // Loop enforces these (plus local timeout races).
      limits: { ...this.runLimits },
      prompts: this.prompts,
      ...(this.output !== undefined ? { output: this.output } : {}),
    };

    const s = streamAgentLoop(loopConfig);
    this.currentRun = { steerInbox, outerStream: s, abortController: runController };
    s.result().then(
      (res) => {
        this.endRun(mark, res.finishReason === "stopped" ? "stopped" : "done");
        try {
          this.mergeSubagentTraces(res.subagents as any);
          this.persistNow();
        } catch {}
        try {
          this.cleanupMerge(runController);
        } catch {}
        if (this.stateless) {
          targetContext.messages = [];
          targetContext.thoughtSignatures = [];
        }
        if (this.currentRun?.outerStream === s) this.finishCurrentRun();
      },
      (err) => {
        this.endRun(mark, isAbortError(err) ? "aborted" : "failed");
        try {
          this.cleanupMerge(runController);
        } catch {}
        if (this.currentRun?.outerStream === s) this.finishCurrentRun();
      }
    );
    return s;
  }

  /**
   * Returns a snapshot of one sub-agent worker's trace by tracking id
   * (`SUBAGENT-NAME-{32hex}` or the raw 32-hex suffix). Sees live running
   * state: steps appear as the worker acts, not just after it finishes.
   *
   * @example `const trace = agent.track("RAM-RESEARCH-AGENT-9f2c…");`
   */
  track(trackingId: string): SubAgentTrace | undefined {
    if (!trackingId) return undefined;
    try {
      const own = (this as any).subagentTraces as Record<string, SubAgentTrace> | undefined;
      const hit = own?.[trackingId];
      if (hit) return { ...hit, steps: hit.steps.map((s) => ({ ...s })) };
    } catch {}
    // Process-wide store, filtered to sessions THIS agent owns: another
    // agent's workers (e.g. a different tenant) are never reachable.
    return getSubAgentTraceForSessions(trackingId, this.ownedSessionIds());
  }

  /** Session ids whose spawned workers this agent may inspect (default + named sessions). */
  private ownedSessionIds(): ReadonlySet<string> {
    return new Set<string>([this.sessionId, ...this.sessions.keys()]);
  }

  /** Lists TrackingIDs of worker traces visible to this agent (deduped). */
  listTrackedSubAgents(): string[] {
    const rawOf = (id: string): string => {
      const tail = id.split("-").pop() ?? "";
      return /^[0-9a-f]{32}$/.test(tail) ? tail : id;
    };
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [
      ...Object.keys((this as any).subagentTraces ?? {}),
      ...listSubAgentTraceIdsForSessions(this.ownedSessionIds()),
    ]) {
      const raw = rawOf(id);
      if (!seen.has(raw)) {
        seen.add(raw);
        out.push(raw);
      }
    }
    return out;
  }

  /**
   * Subscribes to live updates of one worker trace. The callback fires on
   * every logged step; returns an unsubscribe fn.
   *
   * @example `const off = agent.subscribeToSubAgent(id, (t) => render(t));`
   */
  subscribeToSubAgent(trackingId: string, fn: (trace: SubAgentTrace) => void): () => void {
    return subscribeToSubAgentForSessions(trackingId, this.ownedSessionIds(), fn);
  }

  /**
   * Rewrites the configured session file now (when `persist` is set).
   * Called automatically after every step during runs; safe to call
   * manually. Never throws (failures route to `onPersistError`).
   *
   * Stateless agents skip persistence unless
   * `(persist as any).allowStateless` is set. Calls in the same tick are
   * coalesced via a `queueMicrotask` single flight.
   */
  persistNow(): void {
    const cfg = this.persistConfig;
    if (!cfg || (!cfg.dir && !cfg.file)) return;
    // No stateless persist by default.
    try {
      if (this.stateless && !(cfg as unknown as { allowStateless?: unknown }).allowStateless) return;
    } catch {}
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    queueMicrotask(() => {
      this.persistScheduled = false;
      this.doPersist();
    });
  }

  // Opens the log file of one tool call when this Agent persists its default session to a folder, else nothing; in: the executor, once per call, out: a writer for `tool-logs/<n>-<tool>.ndjson`.
  private openToolLog(call: { name: string }, sessionId: string | undefined): ToolLogWriter | undefined {
    const root = this.persistConfig?.dir;
    if (!root || this.stateless || sessionId !== this.sessionId) return undefined;
    const dir = sessionDirFor(root, this.sessionId);
    if (this.toolLogsDir !== dir) {
      this.toolLogs = new ToolLogs(dir);
      this.toolLogsDir = dir;
    }
    return this.toolLogs!.open(call);
  }

  /** The step journal of this session's folder (recreated when `sessionId` changes). */
  private journalFor(root: string): SessionJournal {
    const dir = sessionDirFor(root, this.sessionId);
    if (this.journal?.dir !== dir) this.journal = new SessionJournal(dir);
    return this.journal;
  }

  /** Synchronous persistence write behind the coalesced `persistNow()` gate. */
  private doPersist(): void {
    const cfg = this.persistConfig;
    if (!cfg || (!cfg.dir && !cfg.file)) return;
    try {
      if (this.stateless && !(cfg as unknown as { allowStateless?: unknown }).allowStateless) return;
    } catch {}
    try {
      if (cfg.dir) this.journalFor(cfg.dir).sync(this as any);
      else if (cfg.file) saveSessionFile(cfg.file, this as any, null);
    } catch (err) {
      // Surface via hook instead of swallowing silently.
      try {
        (cfg as unknown as { onPersistError?: (e: unknown) => void }).onPersistError?.(err);
      } catch {}
    }
  }

  /** Merges completed worker metadata (incl. steps) into this agent's trace registry. */
  private mergeSubagentTraces(
    subagents: Array<{
      trackingId?: string;
      name: string;
      sessionId?: string;
      parentSessionId?: string;
      task: string;
      steps?: SubAgentTrace["steps"];
      [k: string]: unknown;
    }>
  ): void {
    if (!subagents || subagents.length === 0) return;
    const rawOf = (id?: string): string | undefined => {
      if (!id) return undefined;
      const tail = id.split("-").pop() ?? "";
      return /^[0-9a-f]{32}$/.test(tail) ? tail : id;
    };
    try {
      const registry = ((this as any).subagentTraces ??= {}) as Record<string, SubAgentTrace>;
      for (const s of subagents) {
        const raw = rawOf(s.trackingId);
        const key = raw || s.name;
        const existing = registry[key] ?? (raw ? registry[s.trackingId ?? ""] : undefined);
        if (existing) {
          existing.status = "done";
          if (s.steps && s.steps.length > 0 && existing.steps.length === 0) {
            existing.steps = s.steps.map((x) => ({ ...x }));
          }
          if (raw && !registry[raw]) registry[raw] = existing;
        } else if (raw) {
          registry[raw] = {
            trackingId: raw,
            name: s.name,
            sessionId: s.sessionId || "",
            parentSessionId: s.parentSessionId || this.sessionId,
            status: "done",
            task: s.task,
            turns: 0,
            steps: (s.steps ?? []).map((x) => ({ ...x })),
          };
        }
      }
    } catch {}
  }

  /**
   * Exports this agent's conversation + config as a storable session snapshot.
   * Pair with `importSession` / `loadSessionFile` / `saveSessionFile`.
   *
   * @example `saveSessionFile(".session.json", agent, telemetry)`
   */
  exportSession(telemetry?: SessionTelemetry | SessionTotals | null): PersistedAgentSession {
    return buildSessionData(this as any, telemetry);
  }

  /**
   * Restores conversation + config from `exportSession` / `loadSessionFile`.
   * Restores messages, system prompt, cached content id, sub-agent traces,
   * and (when present) session id, model, thinking level, instructions,
   * cache, and worker model. No-ops on nullish input.
   *
   * @example `const saved = loadSessionFile(".session.json"); if (saved) agent.importSession(saved);`
   */
  importSession(data?: PersistedAgentSession | null): void {
    if (!data) return;
    const badIndex = findInvalidMessage(data.messages ?? []);
    if (badIndex !== -1) {
      throw new SessionLoadError(
        `[Agent Accelerator] Cannot import session: messages[${badIndex}] is not a valid message (expected role system|user|assistant|tool and string or part-array content).`
      );
    }
    this.warnOnLocalMediaPaths(data.messages ?? []);
    const prevSid = this.sessionId;
    if (data.sessionId) (this as any).sessionId = data.sessionId;
    if (this.sessionId !== prevSid) {
      try {
        this.lockSessionFolder();
      } catch (err) {
        (this as any).sessionId = prevSid; // the session belongs to another process: keep ours untouched
        throw err;
      }
      unregisterSessionFolder(prevSid);
      this.registerTelemetryFolder();
    }
    if ((data as any).parentSessionId) (this as any).parentSessionId = (data as any).parentSessionId;
    if ((data as any).subagents && typeof (data as any).subagents === "object") {
      try {
        (this as any).subagentTraces = JSON.parse(JSON.stringify((data as any).subagents));
      } catch {
        (this as any).subagentTraces = { ...((data as any).subagents as object) };
      }
    }
    if (data.model) (this as any).modelStringOrSpec = data.model;
    if (data.thinkingLevel) {
      const lvl = String(data.thinkingLevel);
      (this as any).thinkingConfig =
        lvl === "none"
          ? { enabled: false, level: "none", budgetTokens: 0 }
          : lvl === "dynamic"
            ? { enabled: true, level: "dynamic", budgetTokens: -1 }
            : { enabled: true, level: lvl };
    }
    if (typeof data.instructions === "string") this.instructions = data.instructions;
    if (data.cache) (this as { cache?: CacheOption }).cache = data.cache;
    if (data.subagentModel) {
      (this as any).subagentModel = data.subagentModel;
      const dyn = (this as any).dynamicSubagents;
      if (dyn) dyn.model = data.subagentModel;
    }
    try {
      const g: any = globalThis as any;
      this.context.messages = Array.isArray(data.messages)
        ? typeof g.structuredClone === "function"
          ? g.structuredClone(data.messages)
          : JSON.parse(JSON.stringify(data.messages))
        : [];
    } catch {
      this.context.messages = Array.isArray(data.messages) ? [...data.messages] : [];
    }
    this.context.thoughtSignatures = [];
    this.runMarks.splice(
      0,
      this.runMarks.length,
      ...(data.runs ?? []).filter((r) => r.i < this.context.messages.length)
    );
    this.restoreUsage(data.usage);
    if (data.systemPrompt) {
      this.context.systemPrompt = data.systemPrompt;
    } else {
      this.context.systemPrompt = this.getFullInstructions();
    }
    // Importing a snapshot invalidates prior provider chaining/routing
    // for both the previous and the restored session.
    try {
      clearInteractionChains(prevSid);
    } catch {}
    try {
      clearSessionRouting(prevSid);
    } catch {}
    try {
      clearInteractionChains(this.sessionId);
    } catch {}
    try {
      clearSessionRouting(this.sessionId);
    } catch {}
  }

  /**
   * A loaded session may reference local files (`image: "/home/me/x.png"`)
   * that the next turn would read and upload. Without a `fileAccess.roots`
   * policy that is silent, so surface it once on the telemetry bus.
   */
  private warnOnLocalMediaPaths(messages: ReadonlyArray<{ content?: unknown }>): void {
    if (this.fileAccess?.roots) return; // enforced every turn by the loop
    const paths: string[] = [];
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content as Array<Record<string, unknown>>) {
        const key = ["image", "audio", "video", "file"].find((k) => k === part?.type);
        const value = key ? part[key] : undefined;
        if (isLocalPathInput(value) && !value.startsWith("media/")) paths.push(value);
      }
    }
    if (paths.length === 0) return;
    try {
      telemetryBus.emitWarning(
        "session.local_media_paths",
        `[Agent Accelerator] Imported session references ${paths.length} local file path(s) that will be read and sent to the provider on the next turn. Set fileAccess.roots to restrict them.`,
        { count: paths.length, examples: paths.slice(0, 3) }
      );
    } catch {}
  }

  // Adds the user prompt to the target context (fresh context when stateless, stable system prompt, additionalContext as a user prefix) and marks the run start for the default session; in: a run start, out: the new SessionRunMark.
  private prepareTurn(
    prompt: string | ContentPart[],
    options?: AgentRunOptions,
    target?: AgentContext
  ): SessionRunMark | undefined {
    // Prompt validation throws synchronously in both run() and
    // stream() (same timing; documented here).
    if (Array.isArray(prompt) && prompt.length === 0) {
      throw new ValidationError(
        "[Agent Accelerator] Prompt cannot be empty: pass a non-empty string or at least one content part."
      );
    }
    const ctx = target ?? this.getSessionContext(options?.sessionId || this.sessionId);
    if (this.stateless) {
      // Stateless runs use a fresh ephemeral context (never shared).
      ctx.messages = [];
      ctx.thoughtSignatures = [];
    }
    const fullInstructions = this.getFullInstructions();
    // C13: keep systemPrompt stable for Google implicit cache; additionalContext goes as user prefix, not system mutation
    if (options?.additionalContext) {
      // Preserve stable instructions as systemPrompt
      ctx.systemPrompt = fullInstructions;
      const prefix = `${fillPrompt(this.prompts.additionalContext, { context: options.additionalContext })}\n\n`;
      if (typeof prompt === "string") {
        prompt = prefix + prompt;
      } else if (Array.isArray(prompt)) {
        prompt = [{ type: "text", text: prefix } as ContentPart, ...prompt];
      }
    } else if (ctx.systemPrompt !== fullInstructions) {
      ctx.systemPrompt = fullInstructions;
    }
    const mark = ctx === this.context ? this.markRunStart(ctx.messages.length) : undefined;
    ctx.addUserMessage(prompt);
    return mark;
  }

  // Records where a run of the default session begins; in: prepareTurn, out: runMarks, saved by the session journal.
  private markRunStart(index: number): SessionRunMark {
    for (const old of this.runMarks) if (!old.end) old.end = "abandoned"; // a newer run replaces a cut-off one
    this.toolRecords.length = 0;
    const mark: SessionRunMark = { id: newRunId(), i: index, at: Date.now() };
    this.runMarks.push(mark);
    this.activeMark = mark;
    return mark;
  }

  /** Prompts still waiting (steers not yet injected, queued follow-ups), as the session journal saves them. @internal */
  pendingPrompts(): SessionPending {
    const pack = (e: { prompt: string | ContentPart[]; options?: AgentRunOptions }) => ({
      prompt: e.prompt,
      ...(e.options?.additionalContext ? { additionalContext: e.options.additionalContext } : {}),
    });
    return { steer: (this.currentRun?.steerInbox ?? []).map(pack), queue: this.pendingQueue.map(pack) };
  }

  /**
   * Runs one or more model/tool turns and resolves to a normalized AgentResponse.
   * @example `const response = await agent.run("Summarize this document");`
   */
  run(
    prompt: string | ContentPart[],
    options: AgentRunOptions & { stream: true } & (
        | { onDelta: NonNullable<AgentRunOptions["onDelta"]> }
        | { onThinkingDelta: NonNullable<AgentRunOptions["onThinkingDelta"]> }
        | { onEvent: NonNullable<AgentRunOptions["onEvent"]> }
      )
  ): Promise<AgentResponse> & AsyncIterable<StreamEvent>;
  run(prompt: string | ContentPart[], options: AgentRunOptions & { stream: true }): AssistantMessageEventStream;
  run(prompt: string | ContentPart[], options?: AgentRunOptions): Promise<AgentResponse>;
  run(prompt: string | ContentPart[], options?: AgentRunOptions): Promise<AgentResponse> | AssistantMessageEventStream {
    // Prompt validation throws synchronously in both run() and
    // stream() (same timing; async work starts only after validation).
    this.assertPromptValid(prompt);
    const isStream = options?.stream === true;
    if (isStream) {
      const hasCallbacks = !!(options?.onDelta || options?.onThinkingDelta || options?.onEvent);
      const s = this.stream(prompt, options) as any;
      if (hasCallbacks) {
        // Make `await agent.run(..., {stream:true, onDelta})` resolve to final response
        // while still streaming via callbacks. The returned value stays iterable/on-able.
        const resultPromise = s.result();
        const hybrid: any = resultPromise;
        hybrid[Symbol.asyncIterator] = s[Symbol.asyncIterator].bind(s);
        hybrid.on = s.on.bind(s);
        hybrid.off = s.off.bind(s);
        hybrid.result = s.result.bind(s);
        hybrid.cancel = s.cancel.bind(s);
        hybrid.onCancel = s.onCancel.bind(s);
        hybrid.isCancelled = s.isCancelled.bind(s);
        // also expose push/end/fail for compat, though not needed by caller
        return hybrid;
      }
      return s;
    }

    // Mid-session: busy agent serializes via steer (same turn) or queue (next turn), or stops the active run and starts this prompt (interrupt).
    if (this.currentRun) {
      if (options?.enqueue === "interrupt") {
        return new Promise<AgentResponse>((resolve, reject) =>
          this.queueUrgent({ prompt, options, isStream: false, resolve, reject })
        );
      }
      const enforced = this.midSessionConfig.mode;
      const requested = options?.enqueue;
      if (requested && (enforced === "steer" || enforced === "queue") && requested !== enforced) {
        throw new ConfigError(
          `[Agent Accelerator] enqueue "${requested}" is disabled by midSession.mode "${enforced}". Use ${enforced}() or set mode to "auto"/"${requested}".`
        );
      }
      const mode = this.resolveEnqueueMode(requested);
      if (mode === "steer") {
        this.assertPromptValid(prompt);
        return this.steerInto(this.currentRun, prompt, options);
      } else {
        if (this.midSessionConfig.mode === "steer") {
          throw new ConfigError(
            '[Agent Accelerator] enqueue "queue" is disabled by midSession.mode "steer". Use steer() or set mode to "auto"/"queue".'
          );
        }
        this.assertPromptValid(prompt);
        const max = this.midSessionConfig.maxQueued ?? 20;
        if (this.pendingQueue.length >= max) {
          throw new ValidationError(
            `[Agent Accelerator] Queue is full (${this.pendingQueue.length}/${max}). Wait for the active run to finish or increase midSession.maxQueued.`
          );
        }
        return new Promise<AgentResponse>((resolve, reject) => {
          this.pendingQueue.push({ prompt, options, isStream: false, resolve, reject });
          this.persistNow();
          try {
            this.currentRun?.outerStream?.push({
              type: "queued",
              queuedPrompt: previewPrompt(prompt),
              queueLength: this.pendingQueue.length,
            } as any);
          } catch {}
        });
      }
    }

    return this.startNonStreamingRun(prompt, options);
  }

  /**
   * Convenience API: non-streaming alias for run, or a text-delta async iterable when streaming.
   * @example `const response = await agent.ask("What is the answer?");`
   */
  ask(
    prompt: string | ContentPart[],
    optionsOrStream?: boolean | AgentRunOptions
  ): Promise<AgentResponse> & AsyncIterable<string | StreamEvent> {
    const isStream = typeof optionsOrStream === "boolean" ? optionsOrStream : optionsOrStream?.stream === true;

    const runOpts: AgentRunOptions = typeof optionsOrStream === "object" ? optionsOrStream : { stream: isStream };

    if (isStream) {
      const stream = this.stream(prompt, runOpts);
      // If callbacks are used, proxy them through string stream as well
      if (runOpts.onDelta || runOpts.onThinkingDelta || runOpts.onEvent) {
        if (runOpts.onEvent) stream.on("*", runOpts.onEvent as any);
        if (runOpts.onDelta) stream.on("text_delta", (e: any) => runOpts.onDelta!(e.delta!, e));
        if (runOpts.onThinkingDelta)
          stream.on("thinking_delta", (e: any) => runOpts.onThinkingDelta!(e.thinkingDelta!, e));
      }
      const stringStream: any = {
        [Symbol.asyncIterator]: async function* () {
          try {
            for await (const chunk of stream) {
              if (chunk.type === "text_delta" && chunk.delta) {
                yield chunk.delta;
              }
            }
          } finally {
            // Breaking out early must stop the underlying provider stream
            // instead of leaving the HTTP connection running in the background.
            stream.cancel();
          }
        },
        result: () => stream.result(),
        on: (evt: string, fn: any) => stream.on(evt, fn),
        cancel: () => stream.cancel(),
        onCancel: (fn: any) => stream.onCancel(fn),
        isCancelled: () => stream.isCancelled(),
      };
      // Make await work (resolves to AgentResponse)
      const resultPromise = stream.result();
      (stringStream as any).then = (res: any, rej: any) => resultPromise.then(res, rej);
      (stringStream as any).catch = (rej: any) => resultPromise.catch(rej);
      return stringStream;
    }

    return this.run(prompt, runOpts) as any;
  }

  /**
   * Starts a stream of text, thinking, tool, sub-agent, usage, and completion events.
   * @example
   * ```ts
   * for await (const event of agent.stream("Explain this")) {
   *   if (event.type === "text_delta") process.stdout.write(event.delta ?? "");
   * }
   * ```
   */
  stream(prompt: string | ContentPart[], options?: AgentRunOptions): AssistantMessageEventStream {
    // Same sync validation timing as run().
    this.assertPromptValid(prompt);
    // Mid-session: busy agent serializes via steer (same turn) or queue (next turn).
    if (this.currentRun) {
      const enforcedStream = this.midSessionConfig.mode;
      const urgent = options?.enqueue === "interrupt"; // stops the active run and goes first, in every mode and whatever the queue holds
      const requestedStream = options?.enqueue === "interrupt" ? undefined : options?.enqueue;
      if (
        requestedStream &&
        (enforcedStream === "steer" || enforcedStream === "queue") &&
        requestedStream !== enforcedStream
      ) {
        throw new ConfigError(
          `[Agent Accelerator] enqueue "${requestedStream}" is disabled by midSession.mode "${enforcedStream}". Use ${enforcedStream}() or set mode to "auto"/"${requestedStream}".`
        );
      }
      const mode = urgent ? "queue" : this.resolveEnqueueMode(requestedStream);
      if (mode === "steer") {
        this.assertPromptValid(prompt);
        this.assertSteerRoom(this.currentRun.steerInbox);
        this.currentRun.steerInbox.push({ prompt, options });
        this.persistNow();
        const activeStream = this.currentRun.outerStream;
        if (activeStream) {
          this.wireStreamCallbacks(activeStream, options);
          return activeStream;
        }
        // Active run is non-streaming: attach a lightweight stream that ends
        // with the same final response so streaming callers still get events.
        const stub = new AssistantMessageEventStream();
        this.wireStreamCallbacks(stub, options);
        const activePromise = this.currentRun.runPromise;
        if (activePromise) {
          activePromise.then(
            (res) => {
              try {
                stub.push({
                  type: "done",
                  delta: "",
                  usage: res.usage,
                  finishReason: res.finishReason,
                  responseId: res.responseId,
                } as any);
              } catch {}
              try {
                stub.end(res);
              } catch {}
            },
            (err) => {
              try {
                stub.fail(err instanceof Error ? err : new Error(String(err)));
              } catch {}
            }
          );
        } else {
          try {
            stub.fail(new ValidationError("[Agent Accelerator] No active run to steer."));
          } catch {}
        }
        return stub;
      }
      if (!urgent && this.midSessionConfig.mode === "steer") {
        throw new ConfigError(
          '[Agent Accelerator] enqueue "queue" is disabled by midSession.mode "steer". Use steer() or set mode to "auto"/"queue".'
        );
      }
      this.assertPromptValid(prompt);
      const max = this.midSessionConfig.maxQueued ?? 20;
      if (!urgent && this.pendingQueue.length >= max) {
        throw new ValidationError(
          `[Agent Accelerator] Queue is full (${this.pendingQueue.length}/${max}). Wait for the active run to finish or increase midSession.maxQueued.`
        );
      }
      const deferred = new AssistantMessageEventStream();
      this.wireStreamCallbacks(deferred, options);
      // Notify the active stream (if any) that a follow-up was queued.
      if (!urgent) {
        try {
          this.currentRun.outerStream?.push({
            type: "queued",
            queuedPrompt: previewPrompt(prompt),
            queueLength: this.pendingQueue.length + 1,
          } as any);
        } catch {}
      }
      const queuedEntry: {
        prompt: string | ContentPart[];
        options?: AgentRunOptions;
        isStream: boolean;
        deferredStream?: AssistantMessageEventStream;
        resolve: (res: AgentResponse) => void;
        reject: (err: unknown) => void;
      } = {
        prompt,
        options,
        isStream: true,
        deferredStream: deferred,
        resolve: () => {},
        reject: () => {},
      };
      const done = new Promise<AgentResponse>((resolve, reject) => {
        queuedEntry.resolve = resolve;
        queuedEntry.reject = reject;
      });
      // Keep result() in sync: deferred ends when the queued turn completes.
      done.then(
        () => {},
        () => {}
      );
      // Forward cancellation before start: drop from queue and fail.
      deferred.onCancel(() => {
        try {
          const idx = this.pendingQueue.indexOf(queuedEntry as any);
          if (idx >= 0) {
            this.pendingQueue.splice(idx, 1);
            queuedEntry.reject(Object.assign(new Error("Stream aborted"), { name: "AbortError" }));
            try {
              deferred.fail(Object.assign(new Error("Stream aborted"), { name: "AbortError" }));
            } catch {}
          }
        } catch {}
      });
      if (urgent) {
        this.queueUrgent(queuedEntry as Agent["pendingQueue"][number]);
      } else {
        this.pendingQueue.push(queuedEntry as any);
        this.persistNow();
      }
      // Attach deferred completion to queued promise without exposing it.
      // Real events are piped in pumpQueue() when the turn starts.
      void done.then(
        (res) => {
          // If pump already piped via real stream, deferred is already ended.
          // Otherwise (edge), end it here.
          try {
            if ((deferred as any).__piped !== true) {
              deferred.push({
                type: "done",
                delta: "",
                usage: res.usage,
                finishReason: res.finishReason,
                responseId: res.responseId,
              } as any);
              deferred.end(res);
            }
          } catch {}
        },
        (err) => {
          try {
            if ((deferred as any).__piped !== true) {
              deferred.fail(err instanceof Error ? err : new Error(String(err)));
            }
          } catch {}
        }
      );
      return deferred;
    }

    const s = this.startStreamingRun(prompt, options);
    this.wireStreamCallbacks(s, options);
    return s;
  }

  // Attaches onEvent/onDelta/onThinkingDelta to a stream and, with wrapThinking, adds display-only <think> tags and whitespace hygiene on the outer events; in: stream()/pumpQueue, out: listeners on the stream.
  private wireStreamCallbacks(s: AssistantMessageEventStream, options?: AgentRunOptions): void {
    // Wire one-liner callbacks so `stream:true` + onDelta is enough — no manual for-await needed
    if (options?.wrapThinking) {
      // Auto-wrap reasoning as <think>…</think> per-turn — clean boundaries across multi-turn agent runs.
      //
      // Display-only whitespace hygiene (cache-safe): provider thought
      // summaries routinely carry edge blank lines (observed `"...\n\n\n"`),
      // and the wrapper itself adds newlines around the span. Without care
      // this renders as blank lines after `<think>`, double blanks between
      // sections, and a stray blank line before `</think>`. The buffering
      // below touches ONLY the presented strings/callback args and synthetic
      // tag events — never provider accumulation, AgentContext history, or
      // request bodies — so prefix-cache affinity is untouched.
      //
      // Trailing-newline buffering: each chunk's trailing `\n` run is
      // withheld and prepended to the next chunk (or dropped at close), so
      // emitted display text never ends with `\n` and `</think>` never gets
      // a preceding blank line. Interior breaks are preserved (collapsed to
      // a single blank line at most).
      let isThinking = false;
      let emittedAny = false;
      let pendingNewlines = "";
      // True once text has been emitted without a trailing newline: the next
      // <think> open tag then needs its own leading newline, otherwise it
      // glues onto the streamed text mid-line. False at stream start and
      // after every tag (both end with newlines), preserving the exact
      // "<think>\n...\n</think>\n" contract for thinking-first streams.
      let needThinkNewline = false;
      // Set on every think close; consumed by the next text_delta(s) to strip
      // model-leading blank lines display-only (cache-safe: outer events only).
      // Stays set until non-empty text is emitted so split "\n" | "\nText"
      // chunks cannot leak a blank line.
      let justClosedThink = false;
      const collapseBlankLines = (s: string): string => s.replace(/\n{3,}/g, "\n\n");
      const userOnThinking = options.onThinkingDelta;
      const userOnDelta = options.onDelta;
      const userOnEvent = options.onEvent;
      if (userOnEvent) s.on("*", userOnEvent as any);

      const openThink = (e?: any) => {
        if (!isThinking) {
          isThinking = true;
          emittedAny = false;
          pendingNewlines = "";
          const tag = (needThinkNewline ? "\n" : "") + "<think>\n";
          needThinkNewline = false;
          if (userOnThinking) userOnThinking(tag, e);
          else if (userOnDelta) userOnDelta(tag, e as any);
        }
      };

      const closeThink = (e?: any) => {
        if (isThinking) {
          isThinking = false;
          // Drop any withheld trailing newlines: the span ends cleanly and
          // the tag supplies its own single line break. Empty spans still close.
          pendingNewlines = "";
          const close = emittedAny ? "\n</think>\n" : "</think>\n";
          emittedAny = false;
          justClosedThink = true;
          if (userOnThinking) userOnThinking(close, e);
          else if (userOnDelta) userOnDelta(close, e as any);
        }
      };

      /**
       * Strips model-leading blank lines after a think close, display-only.
       * Mutates `e.delta` in place so `for-await` consumers see the same clean
       * text; safe because loop context derives from the provider result, not
       * these outer events. Returns the display string (`""` when nothing
       * displayable yet — caller skips the callback but keeps the flag set so
       * a split newline-only chunk cannot leak a blank line).
       */
      const stripLeadingAfterClose = (e: any): string => {
        const raw: string = e.delta ?? "";
        if (!justClosedThink) return raw;
        const stripped = raw.replace(/^\n+/, "");
        try {
          e.delta = stripped;
        } catch {}
        if (!stripped) return "";
        justClosedThink = false;
        return stripped;
      };

      /** Buffers one raw thinking chunk, returning the display string to
       * emit now (`""` when nothing displayable yet). Mutates the event in
       * place so manual `for-await` consumers see the same clean text; safe
       * because loop context derives from the provider result, not these
       * outer events. */
      const bufferThinkingEvent = (e: any): string => {
        const raw: string = e.thinkingDelta ?? "";
        let chunk = collapseBlankLines(pendingNewlines + raw);
        pendingNewlines = "";
        if (!emittedAny) {
          chunk = chunk.replace(/^\n+/, "");
        }
        if (!chunk) return "";
        const m = chunk.match(/\n+$/);
        if (m) {
          pendingNewlines = m[0];
          chunk = chunk.slice(0, -m[0].length);
          if (!chunk) return "";
        }
        emittedAny = true;
        e.thinkingDelta = chunk;
        if (typeof e.partialThinking === "string") {
          e.partialThinking = collapseBlankLines(e.partialThinking);
        }
        return chunk;
      };

      if (userOnThinking || userOnDelta) {
        s.on("thinking_delta", (e: any) => {
          openThink(e);
          const chunk = bufferThinkingEvent(e);
          if (!chunk) return;
          if (userOnThinking) userOnThinking(chunk, e);
          else if (userOnDelta) userOnDelta(chunk, e as any);
        });
        s.on("text_delta", (e: any) => {
          closeThink(e);
          const display = stripLeadingAfterClose(e);
          if (!display) {
            needThinkNewline = false;
            return;
          }
          needThinkNewline = !display.endsWith("\n");
          if (userOnDelta) userOnDelta(display, e);
          else if (userOnThinking) userOnThinking(display, e as any);
        });
        // Close thinking tag and reset turn state before tool/subagent execution or results
        s.on("tool_call_start" as any, (e: any) => closeThink(e));
        s.on("tool_call_complete" as any, (e: any) => closeThink(e));
        s.on("tool_result" as any, (e: any) => closeThink(e));
        s.on("subagent_complete" as any, (e: any) => closeThink(e));
        s.on("done", (e: any) => {
          closeThink(e || ({ type: "done" } as any));
        });
      } else {
        // No callbacks but wrapThinking true — still emit tags as events for manual iteration.
        // Same display hygiene as above (in-place event normalization is safe:
        // loop context derives from the provider result, not outer events).
        const closeSynthetic = () => {
          if (isThinking) {
            isThinking = false;
            pendingNewlines = "";
            const tag = emittedAny ? "\n</think>\n" : "</think>\n";
            emittedAny = false;
            justClosedThink = true;
            s.push({ type: "thinking_delta", thinkingDelta: tag, __synthetic: true } as any);
          }
        };
        s.on("thinking_delta", (e: any) => {
          // Ignore our own synthetic tags: push() redelivers events to
          // listeners synchronously, so without this guard the handler
          // re-enters on every tag it emits (duplicate <think> spans and
          // mutated queued events).
          if ((e as any).__synthetic) return;
          if (!isThinking) {
            isThinking = true;
            emittedAny = false;
            pendingNewlines = "";
            const openTag = (needThinkNewline ? "\n" : "") + "<think>\n";
            needThinkNewline = false;
            s.push({ type: "thinking_delta", thinkingDelta: openTag, __synthetic: true } as any);
          }
          const chunk = bufferThinkingEvent(e);
          if (!chunk) {
            e.thinkingDelta = "";
          }
        });
        s.on("text_delta", (e: any) => {
          closeSynthetic();
          if (justClosedThink) {
            const stripped: string = (e.delta ?? "").replace(/^\n+/, "");
            try {
              e.delta = stripped;
            } catch {}
            if (!stripped) return;
            justClosedThink = false;
          }
          needThinkNewline = !(e.delta ?? "").endsWith("\n");
        });
        s.on("tool_call_start" as any, () => {
          closeSynthetic();
        });
        s.on("tool_call_complete" as any, () => {
          closeSynthetic();
        });
        s.on("tool_result" as any, () => {
          closeSynthetic();
        });
        s.on("subagent_complete" as any, () => {
          closeSynthetic();
        });
        s.on("done", () => {
          closeSynthetic();
        });
        if (userOnEvent) s.on("*", userOnEvent as any);
      }
    } else {
      if (options?.onEvent) s.on("*", options.onEvent as any);
      if (options?.onDelta) s.on("text_delta", (e: any) => options.onDelta!(e.delta!, e));
      if (options?.onThinkingDelta) s.on("thinking_delta", (e: any) => options.onThinkingDelta!(e.thinkingDelta!, e));
    }
  }
}

/** What a failed run attempt got done before it failed (the `partial` the loop attaches to its error). */
type FailedAttempt = Partial<AgentResponse> & { usage: TokenUsage };

// Adds what failed attempts already did (tool calls, results, workers, turns, token usage) to the response of the attempt that finally worked, so a retry never hides side effects or cost; in: the final response + each failed attempt's `err.partial`, out: the run's AgentResponse.
function withFailedAttempts(res: AgentResponse, failed: FailedAttempt[]): AgentResponse {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const f of failed) accumulateUsage(usage, f.usage);
  accumulateUsage(usage, res.usage);
  return new AgentResponse({
    text: res.text,
    ...(res.parsed !== undefined ? { parsed: res.parsed } : {}),
    thinking: res.thinking,
    thoughtSignature: res.thoughtSignature,
    toolCalls: [...failed.flatMap((f) => f.toolCalls ?? []), ...res.toolCalls],
    toolResults: [...failed.flatMap((f) => f.toolResults ?? []), ...res.toolResults],
    subagents: [...failed.flatMap((f) => f.subagents ?? []), ...res.subagents],
    usage,
    responseId: res.responseId,
    model: res.model,
    provider: res.provider,
    finishReason: res.finishReason,
    rawFinishReason: res.rawFinishReason,
    durationMs: res.durationMs,
    raw: res.raw,
    turns: res.turns + failed.reduce((n, f) => n + (typeof f.turns === "number" ? f.turns : 0), 0),
    providerSteps: res.providerSteps,
  });
}

/** Normalizes the public `thinkingLevel` flag into provider-neutral thinking settings. */
export function normalizeThinking(config: AgentConfig, fallbackLevel?: string): ThinkingConfig | undefined {
  // DX4: only thinkingLevel, values: none, dynamic, minimal, low, medium, high, xhigh, max
  // `thinking` (canonical) wins over legacy `thinkingLevel`; `{ level }` objects are unwrapped.
  const rawLevel = normalizeThinkingV2(config.thinking, config.thinkingLevel) ?? fallbackLevel;
  if (typeof config.thinking === "object" && config.thinking?.budgetTokens !== undefined) {
    // No provider maps an explicit token budget yet: say so instead of ignoring it silently.
    telemetryBus.emitWarning(
      "config.thinking_budget_ignored",
      "[Agent Accelerator] thinking.budgetTokens is not forwarded by any provider adapter yet; the level alone is used.",
      { budgetTokens: config.thinking.budgetTokens }
    );
  }
  const level = rawLevel as ThinkingLevel | undefined;

  if (!level) return undefined;

  // Validate model thinking from catalog if model is configured
  if (config.model) {
    try {
      const rawModel: any = (config.model as any)?.model ? (config.model as any).model : config.model;
      const modelStr = typeof rawModel === "string" ? rawModel : rawModel?.id || "";
      const provStr =
        typeof rawModel === "object" && rawModel?.provider
          ? rawModel.provider
          : modelStr.includes("/")
            ? modelStr.split("/")[0]
            : "";
      const actualModelId = modelStr.includes("/") ? modelStr.split("/").slice(1).join("/") : modelStr;
      if (actualModelId) {
        validateModelThinking(provStr || "openrouter", actualModelId, level);
      }
    } catch (e) {
      throw e;
    }
  }

  if (level === "none") {
    return { enabled: false, level: "none", budgetTokens: 0 };
  }
  if (level === "dynamic") {
    return { enabled: true, level: "dynamic", budgetTokens: -1 };
  }
  return { enabled: true, level };
}

/** Maps the public `toolChoice` option onto the provider wire-neutral form. */
function normalizeToolChoiceOption(choice: ToolChoiceOption | undefined): ProviderRequestOptions["toolChoice"] {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice;
  if (choice.tool) return { type: "function", function: { name: choice.tool } };
  return choice.mode;
}
