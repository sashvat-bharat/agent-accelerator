import type { ModelSpec } from "./model.ts";
import type { ToolDefinition } from "./tool.ts";
import type {
  ThinkingLevel,
  CacheConfig,
  ServiceTier,
} from "./core.ts";
import type { ModelProviderInstance } from "../providers/registry.ts";
import type { Agent } from "../agent/agent.ts";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Q-52/Q-53/Q-54 canonical option types (all additive; nothing renamed).
//
// Canonical homes (one place per setting):
// - Worker model: `dynamicSubagents.model` only. Top-level `subagentModel`
//   is a deprecated alias (still honored: dynamicSubagents.model ??
//   subagentModel ?? SUB_AGENT_MODEL ?? parent model).
// - Session identity: agent-level `sessionId` only (per-run `sessionId`
//   selects a named session entry; `cache.sessionId` is a deprecated alias).
// - Model identity: `ModelRef` = string (`provider/model`) | catalog
//   `ModelSpec` | `ModelProviderInstance` ({ provider, model, apiKey?,
//   baseUrl? }). Explicit `Agent` config always wins over env; constructing
//   an `Agent` with an explicit `model` reads no env for routing.
// ---------------------------------------------------------------------------

/** Canonical model reference: `provider/model` string, catalog spec, or provider helper result. */
export type ModelRef = string | ModelSpec | ModelProviderInstance;

/** Canonical reasoning option (Q-52): bare level, or level + explicit token budget. */
export type ThinkingOption = ThinkingLevel | { level?: ThinkingLevel; budgetTokens?: number };

/** Canonical sampling knobs (Q-54). Read by the loop via `(config as any).sampling`. */
export interface SamplingConfig {
  temperature?: number;
  topP?: number;
}

/** Canonical retry policy (Q-54). Read by the loop via `(config as any).retry`. */
export interface RetryPolicyConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  budgetMs?: number;
}

/** Minimal logger surface for Agent/loop telemetry (Q-54). */
export interface AgentLogger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/** Canonical tool-selection control (Q-54). String form is the portable subset. */
export type ToolChoiceOption =
  | "auto"
  | "none"
  | "required"
  | { mode?: "auto" | "none" | "required"; tool?: string };

/** Canonical stop control (Q-54): sequence(s) halting generation. */
export type StopOption = string | string[];

/** Canonical structured-output input (Q-61). Zod, JSON Schema, or explicit form. */
export type StructuredOutputOption =
  | z.ZodType
  | Record<string, unknown>
  | {
      name?: string;
      description?: string;
      schema: z.ZodType | Record<string, unknown>;
      strict?: boolean;
    };

/** Configuration used to construct an {@link Agent}. */
export interface AgentConfig {
  /** Display name used in tool and sub-agent metadata. */
  name?: string;
  /** Human-readable description used when this agent is delegated to. */
  description?: string;
  /** Stable system instructions for the agent. */
  instructions?: string;
  /** Model string (`provider/model`), catalog spec, or ModelProvider helper result. */
  model?: string | ModelSpec | ModelProviderInstance;
  /** Developer-only model for dynamically spawned sub-agents. Never exposed to the Main Agent LLM. */
  subagentModel?: string | ModelSpec | ModelProviderInstance;
  /** Dynamic sub-agent spawning policy. `subagents` lists pre-defined workers; this enables LLM-spawned stateless workers. */
  dynamicSubagents?: DynamicSubagentsConfig;
  /** Per-agent API key override. */
  apiKey?: string;
  /** Per-agent provider base URL override. */
  baseUrl?: string;
  /** Tools exposed to the model, keyed by name or supplied as an array. */
  tools?: Record<string, ToolDefinition> | ToolDefinition[];
  /** Requested reasoning level, validated against the model catalog. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Canonical reasoning option (Q-52, preferred over `thinkingLevel`).
   * Accepts a bare level or `{ level, budgetTokens }`. When both are set,
   * `thinking` wins; resolution honors `thinking ?? thinkingLevel`.
   * See `normalizeThinkingV2` (re-exported from the root entry).
   */
  thinking?: ThinkingOption;
  /** Prompt-cache retention and session-affinity settings. */
  cache?: CacheConfig;
  /** Provider service tier, when supported. */
  serviceTier?: ServiceTier;
  /**
   * When true, `file` parts are converted client-side to `<Document>` Markdown
   * for models lacking native support (capable models still receive files
   * natively; unknown models count as capable). Also auto-registers the
   * `convert_document_to_markdown` tool for path/URL mentions in plain text.
   */
  bypassInputFileModality?: boolean;
  /** Stable conversation/cache session ID. */
  sessionId?: string;
  /** Headers merged into every provider request. */
  headers?: Record<string, string>;
  /**
   * Maximum model/tool turns per run. `0` or omitted means infinite
   * (legacy `0` alias, normalized to `Infinity`; prefer omitting).
   */
  maxTurns?: number;
  /** Fixed worker agents exposed as delegation tools. */
  subagents?: (Agent | { name: string; description: string; agent: Agent })[];
  /** Clears conversation state before and after every run. */
  stateless?: boolean;
  /**
   * Mid-session queue policy for new queries arriving while a run is active.
   * - `{ mode: "steer" }`: only steer (inject into current turn) is allowed.
   * - `{ mode: "queue" }`: only queue (next-turn follow-up) is allowed.
   * - `{ mode: "auto" }` (default): caller picks per message via `enqueue` or `steer()`/`queue()`.
   * `interrupt` (cancel stream now) is always available via `interrupt()`/`cancel()`/`AbortSignal`.
   */
  midSession?: MidSessionConfig;
  /**
   * Durable session persistence: when set, the session file is rewritten
   * after every step (user turn, assistant turn, tool batch, sub-agent
   * step) so a crash loses at most the in-flight step. Pass `{ dir }` for
   * `sessions/<sessionId>/session.json` layout or `{ file }` for a single
   * pretty `.session.json` file. Writes are atomic and never fail a turn.
   */
  persist?: { dir?: string; file?: string };
  // Q-54 missing knobs (all optional, additive; loop reads via `(config as any).*`).
  /** Canonical tool-selection control (`"auto"` default). */
  toolChoice?: ToolChoiceOption;
  /** Maximum output tokens for one model call. */
  maxOutputTokens?: number;
  /** Sampling knobs. */
  sampling?: SamplingConfig;
  /** Stop sequence(s). */
  stop?: StopOption;
  /** Deterministic seed, when the provider supports it. */
  seed?: number;
  /**
   * Optional output schema (Zod, JSON Schema, or `{ name, schema, strict }`,
   * see `StructuredOutputOption`, stored as `unknown` so `zod`
   * stays optional for type-only consumers). Agent-level only; per-run
   * overrides are intentionally unsupported. When set, the model answer is
   * constrained to the schema on all providers and `AgentResponse.parsed`
   * carries the validated value.
   */
  output?: unknown;
  /** Retry policy for provider calls. */
  retry?: RetryPolicyConfig;
  /** Fetch implementation override (defaults to global `fetch`). */
  fetch?: typeof fetch;
  /** Provider/env overrides forwarded to key resolution. */
  env?: Record<string, string>;
  /** Structured logger for loop telemetry (defaults to no-op). */
  logger?: AgentLogger;
  /** Control hooks (Q-59). All optional, fail-open by default. */
  hooks?: unknown;
  /** Threshold compaction policy (Q-60a). Fully configurable/replaceable. */
  contextManagement?: unknown;
  /** Telemetry bus (Q-41). Default no-op; pretty logger lives in /cli. */
  telemetry?: { onEvent?: (e: any) => void } | unknown;
  /** Local file access roots (Q-08). Default deny; `path` sources must resolve inside roots. */
  fileAccess?: { roots?: string[] };
  /** Raw capture policy (Q-11). Default "redacted": no bodies. */
  captureRaw?: false | "redacted" | true;
  /** Opt-in run budgets (Q-39). All fields default unlimited. */
  budget?: Budget;
  /** Run + network limits (Q-22). Turn/budget caps unlimited by default; network timeouts finite. */
  limits?: AgentRunLimits;
}

/** Per-request + run limits (Q-22). */
export interface AgentRunLimits {
  maxTurns?: number;
  deadlineMs?: number;
  maxTotalTokens?: number;
  maxToolCallsPerRun?: number;
  requestTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
}

/** Developer policy for mid-session new-query insertion while a run is active. */
export type MidSessionMode = "steer" | "queue" | "auto";

/** Q-51 canonical busy-policy alias: prefer `whenBusy`, `mode` kept for compat. */
export type WhenBusyMode = MidSessionMode;

/** Developer-configured policy for LLM-spawned dynamic sub-agents. */
export interface MidSessionConfig {
  /**
   * Which mid-session method is allowed while a run is active:
   * - `"steer"`: only steer (inject into current turn) is allowed.
   * - `"queue"`: only queue (next-turn follow-up) is allowed.
   * - `"auto"` (default): caller/user picks per message via `enqueue` or `steer()`/`queue()`.
   */
  mode?: MidSessionMode;
  /**
   * Canonical alias for `mode` (Q-51, preferred). When both are set,
   * `whenBusy` wins. Accepted anywhere `mode` is read; resolution honors
   * `whenBusy ?? mode ?? "auto"`.
   */
  whenBusy?: MidSessionMode;
  /** Max queued (follow-up) requests buffered while busy. Extra `queue()` calls throw. Defaults to 20. */
  maxQueued?: number;
}

/** Developer-configured policy for LLM-spawned dynamic sub-agents. */
export interface DynamicSubagentsConfig {
  /** Enables the automatic `spawn_subagents` tool. Defaults to true when the object is present. */
  enabled?: boolean;
  /** Developer-only worker model override. Never choosable by the Main Agent LLM. Falls back to top-level `subagentModel`, then `SUB_AGENT_MODEL` env, then the parent model. */
  model?: string | ModelSpec | ModelProviderInstance;
  /** Max workers the Main Agent may spawn in a single `spawn_subagents` call. Extras are trimmed safely. Defaults to 4. */
  maxSpawn?: number;
  /** Fixed reasoning level for all dynamic workers. The Main Agent cannot override it. Falls back to the parent level when omitted. */
  thinkingLevel?: ThinkingLevel;
  /** Tool pool available to dynamic workers. Workers receive zero tools unless the Main Agent grants a per-task `tools` subset by name. */
  tools?: Record<string, ToolDefinition> | ToolDefinition[];
  /** Per-worker timeout in ms. `0` (default) = no limit. `-1` = the Main Agent sets a per-task `timeoutMs`. `>0` = fixed timeout for every worker. */
  timeout?: number;
  /**
   * Canonical per-worker timeout in ms (Q-52, preferred over `timeout`).
   * Maps to `timeout`: `workerTimeoutMs ?? timeout ?? 0`. See
   * `normalizeWorkerTimeout` (re-exported from the root entry).
   */
  workerTimeoutMs?: number;
  /**
   * When true, the Main Agent sets a per-task `timeoutMs` (maps to
   * `timeout: -1`). When both are set, an explicit `timeout`/`workerTimeoutMs`
   * wins over `modelMaySetTimeout`.
   */
  modelMaySetTimeout?: boolean;
}

/** Per-run overrides for {@link Agent.run}, {@link Agent.ask}, and {@link Agent.stream}. */
export interface AgentRunOptions {
  /** Per-run reasoning-level override, validated against the selected model. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Canonical per-run reasoning option (Q-52, preferred over `thinkingLevel`).
   * Resolution honors `thinking ?? thinkingLevel`.
   */
  thinking?: ThinkingOption;
  /** Return a streaming object instead of waiting for a final response. */
  stream?: boolean;
  /** Cancels provider, tool, and sub-agent work. */
  signal?: AbortSignal;
  /** Overrides the agent session for this run. */
  sessionId?: string;
  /** Context added only to this user turn, preserving the stable system prompt. */
  additionalContext?: string;
  /**
   * Mid-session method to use when this call arrives while another run is active.
   * Only honored when `midSession.mode` is `"auto"` (default). When the developer
   * enforces `"steer"` or `"queue"`, that policy wins and this field is ignored.
   * When idle, this field is ignored and the call runs immediately.
   * Defaults to `"queue"` (finish current turn, run as next turn).
   */
  enqueue?: "steer" | "queue";
  /** Headers merged for this run only. */
  headers?: Record<string, string>;
  /** Called for each text delta as it streams (only when stream:true). */
  onDelta?: (delta: string, event: import("./response.ts").StreamEvent) => void;
  /** Called for each thinking/reasoning delta (only when stream:true). */
  onThinkingDelta?: (delta: string, event: import("./response.ts").StreamEvent) => void;
  /** Called for every stream event (text_delta, thinking_delta, tool_call_complete, subagent_complete, etc.). */
  onEvent?: (event: import("./response.ts").StreamEvent) => void;
  /** When true, wraps reasoning stream as <think>\n...\n</think>\n\n — no manual isThinking needed. */
  wrapThinking?: boolean;
  /** Called after every model/tool turn with a turn summary (also drives sub-agent step logs + durable persistence). */
  onTurn?: (turn: AgentTurnEvent) => void;
  // Q-54 per-run knobs (all optional, additive; `output` intentionally
  // omitted here — it is agent-level only, see AgentConfig.output).
  /** Per-run tool-selection override. */
  toolChoice?: ToolChoiceOption;
  /** Per-run output-token cap. */
  maxOutputTokens?: number;
  /** Per-run sampling override. */
  sampling?: SamplingConfig;
  /** Per-run stop sequence(s). */
  stop?: StopOption;
  /** Per-run seed. */
  seed?: number;
  /** Per-run retry override. */
  retry?: RetryPolicyConfig;
  /** Per-run fetch override. */
  fetch?: typeof fetch;
  /** Per-run env overrides. */
  env?: Record<string, string>;
  /** Per-run logger. */
  logger?: AgentLogger;
}

/** Turn summary emitted to `AgentRunOptions.onTurn` after each loop turn. */
export interface AgentTurnEvent {
  /** 1-based turn count within this run. */
  turns: number;
  /** Assistant text produced this turn, if any. */
  text?: string;
  /** Reasoning produced this turn, if any. */
  thinking?: string;
  /** Tool calls requested this turn, if any. */
  toolCalls?: Array<{ id: string; name: string }>;
  /** Tool results executed this turn, if any. */
  toolResults?: Array<{ id: string; name: string; isError?: boolean }>;
}

/** Optional run budgets enforced by delegation helpers (Q-39). All fields default to unlimited. */
export interface Budget {
  /** Maximum total cost in USD across this agent + spawned workers. */
  maxCostUsd?: number;
  /** Maximum total tokens across this agent + spawned workers. */
  maxTotalTokens?: number;
  /** Maximum wall/monotonic duration in ms since budget tracking started. */
  maxDurationMs?: number;
  /** Maximum total dynamic sub-agents spawned via `spawn_subagents`. */
  maxTotalSubagents?: number;
}

/** Mutable counters backing a {@link Budget}. Stored on the agent instance (untyped `budgetState`). */
export interface BudgetState {
  /** Workers spawned so far (incremented by `reserveSpawn`). */
  spawned: number;
  /** Accumulated total tokens charged via `chargeBudgetUsage`. */
  totalTokens: number;
  /** Accumulated total cost in USD charged via `chargeBudgetUsage`. */
  totalCostUsd: number;
  /** Monotonic start time (`nowMs()` clock) for `maxDurationMs` checks. */
  startedAtMs: number;
}

/** Run/turn lineage attached to sub-agent metadata via `(metadata as any)` (Q-42). */
export interface SubAgentRunIds {
  /** Stable id for this worker batch/run (`newRunId`). */
  runId?: string;
  /** Stable id for this worker turn (`newTurnId`). */
  turnId?: string;
  /** Parent run id when known (opaque, forwarded when the host exposes one). */
  parentRunId?: string;
  /** Root run id when known (opaque, forwarded when the host exposes one). */
  rootRunId?: string;
}
