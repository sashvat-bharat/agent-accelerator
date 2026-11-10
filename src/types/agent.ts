import type { ModelSpec } from "./model.ts";
import type { ToolDefinition } from "./tool.ts";
import type { ThinkingLevel, CacheOption, ServiceTier } from "./core.ts";
import type { ModelProviderInstance } from "../providers/registry.ts";
import type { Agent } from "../agent/agent.ts";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Canonical option types (all additive; nothing renamed).
//
// Canonical homes (one place per setting):
// - Worker model: `dynamicSubagents.model` only. Top-level `subagentModel`
//   is a deprecated alias (still honored: dynamicSubagents.model ??
//   subagentModel ?? SUB_AGENT_MODEL ?? parent model).
// - Session identity: agent-level `sessionId` only (per-run `sessionId`
//   selects a named session entry).
// - Model identity: `ModelRef` = string (`provider/model`) | catalog
//   `ModelSpec` | `ModelProviderInstance` ({ provider, model, apiKey?,
//   baseUrl? }). Explicit `Agent` config always wins over env; constructing
//   an `Agent` with an explicit `model` reads no env for routing.
// ---------------------------------------------------------------------------

/** Canonical model reference: `provider/model` string, catalog spec, or provider helper result. */
export type ModelRef = string | ModelSpec | ModelProviderInstance;

/** Canonical reasoning option: bare level, or level + explicit token budget. */
export type ThinkingOption = ThinkingLevel | { level?: ThinkingLevel; budgetTokens?: number };

/** Canonical retry policy. Read by the loop via `(config as any).retry`. */
export interface RetryPolicyConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  budgetMs?: number;
}

/** Minimal logger surface for Agent/loop telemetry. */
export interface AgentLogger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/** Canonical tool-selection control. String form is the portable subset. */
export type ToolChoiceOption = "auto" | "none" | "required" | { mode?: "auto" | "none" | "required"; tool?: string };

/** Canonical structured-output input. Zod, JSON Schema, or explicit form. */
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
   * Canonical reasoning option (preferred over `thinkingLevel`).
   * Accepts a bare level or `{ level, budgetTokens }`. When both are set,
   * `thinking` wins; resolution honors `thinking ?? thinkingLevel`.
   * See `normalizeThinkingV2` (re-exported from the root entry).
   */
  thinking?: ThinkingOption;
  /**
   * Prompt-cache lifetime: `"implicit" | "5m" | "30m" | "1h" | "12h"`. Omit for the provider default.
   * A value the provider does not support falls back to its default with one `provider_warning`.
   */
  cache?: CacheOption;
  /** Provider service tier, when supported. */
  serviceTier?: ServiceTier;
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
   * `interrupt` (stop the active run now, optionally start a new message) is always available, whatever the mode:
   * `interrupt()`, `interrupt(message)`, `enqueue: "interrupt"`, `cancel()` and `AbortSignal`.
   */
  midSession?: MidSessionConfig;
  /**
   * Durable session persistence: when set, the session file is rewritten
   * after every step (user turn, assistant turn, tool batch, sub-agent
   * step) so a crash loses at most the in-flight step. Pass `{ dir }` for
   * `sessions/<sessionId>/session.json` layout or `{ file }` for a single
   * pretty `.session.json` file. `persist: {}` (neither) uses `<home>/sessions`.
   * Writes are atomic and never fail a turn.
   */
  persist?: { dir?: string; file?: string };
  /**
   * How many times a run that FAILED for a transient reason (provider down or overloaded, timeouts, a cut stream, after
   * the provider layer's own `retry` gave up) is tried again from where it stopped, with a growing wait (5 s, 15 s, 45 s,
   * then 60 s). Default 3; `0` turns it off. Finished tool calls are not repeated. Never for aborts, bad config or input
   * (401/400/...), budgets or limits. Applies to `run()` and queued runs, not to `stream()`. The final response also reports the
   * tool calls, results, turns and token usage of the failed attempts (they happened and cost money).
   */
  runRetries?: number;
  /**
   * What happens to a run a crash cut off (needs `persist: { dir }` and the SAME `sessionId` after the restart).
   * `"automatic"` (default): the Agent continues it as soon as it is constructed (tool calls that already have a saved
   * result are not run again), then runs any prompts that were waiting. `"explicit"`: nothing runs until you call
   * `agent.resume()`; `agent.interrupted()` lists what was cut off.
   */
  resume?: "automatic" | "explicit";
  /**
   * Folder for everything Agent Accelerator writes to disk (`sessions/`,
   * `scheduled/`, `telemetry/`). Defaults to `setHome()`, then the `AGENT_ACCEL_HOME` env var, then `.agent-accel/` in the working directory.
   * An explicit `persist.dir` / `persist.file` still wins for sessions.
   */
  home?: string;
  // Additional options (all optional, additive; loop reads via `(config as any).*`).
  /**
   * Canonical tool-selection control (`"auto"` default). `"none"` applies to
   * every turn of a run; `"required"` and a pinned tool (`{ tool: "name" }`)
   * apply to the FIRST model turn only, since forcing a tool call on every
   * turn would make a run unable to finish.
   */
  toolChoice?: ToolChoiceOption;
  /** Google Interactions storage tier for the chain-TTL gate: `"free"` (23h, default) or `"paid"` (54d). */
  googleTier?: "free" | "paid";
  /** Maximum output tokens for one model call. */
  maxOutputTokens?: number;
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
  /** @deprecated Not implemented yet; subscribe with `telemetryBus.onEvent` instead. Passing it emits a `config.unsupported_option` warning. */
  logger?: AgentLogger;
  /** @deprecated Not implemented yet (accepted for forward compatibility; passing it emits a `config.unsupported_option` warning). */
  hooks?: unknown;
  /** @deprecated Not implemented yet (accepted for forward compatibility; passing it emits a `config.unsupported_option` warning). */
  contextManagement?: unknown;
  /**
   * Telemetry options. `persist: true` appends every `telemetryBus` event (except full reasoning text). An event
   * that belongs to a persisted session (`data.sessionId`: tool events, resume and retry events) goes to
   * `<session folder>/telemetry.ndjson`, next to the session's journal; every other event goes to
   * `<home>/telemetry/<date>.ndjson`. Nothing is written outside the home. Off by default: the SDK writes nothing unless asked.
   */
  telemetry?: { persist?: boolean };
  /**
   * Local file policy. With `roots` set, every local-path media part must
   * resolve inside them (`[]` denies all local paths). Without it, local
   * paths in message parts are unrestricted.
   */
  fileAccess?: { roots?: string[] };
  /**
   * Conversation handling when a run FAILS (aborts always keep partial
   * history). `"auto"` (default) restores the pre-run state unless a tool
   * already ran, since rolling back would erase the record of real side
   * effects and a retry would repeat them. `"rollback"` always restores;
   * `"keep"` never does.
   */
  onFailure?: "auto" | "rollback" | "keep";
  /**
   * What `AgentResponse.raw` keeps of the wire exchange. `"redacted"` (default):
   * URL, method, redacted headers and HTTP status, with request/response BODIES
   * replaced by a content-free summary so prompts, files and model output never
   * leak into logs via `toJSON()`. `true`: full bodies (debugging). `false`:
   * URL, method and status only.
   */
  captureRaw?: false | "redacted" | true;
  /**
   * Opt-in budgets, enforced PER RUN (counters restart with every `run`/`stream`)
   * and including sub-agent usage. Exceeding a cap throws `BudgetExceededError`
   * with the partial usage attached. `maxCostUsd` counts only priced usage:
   * models with unknown pricing contribute $0, never a guess.
   */
  budget?: Budget;
  /** Run + network limits. Turn/budget caps unlimited by default; network timeouts finite. */
  limits?: AgentRunLimits;
  /**
   * The only models this agent may use, as `provider/model` strings compared as written. Unset (default) = any model.
   * Checked when the Agent is built (also for a config an agent edited through {@link Agent.fromConfig}); a model
   * outside the list throws a `ConfigError`. Workers and `subagentModel` are not affected.
   */
  allowedModels?: string[];
}

/**
 * The part of an agent that an agent may edit (self-improvement): see {@link Agent.toConfig} and {@link Agent.fromConfig}.
 * Plain JSON. Every other setting (limits, budget, cache, thinking, keys, ...) stays with the developer.
 */
export interface EditableAgentConfig {
  /** `provider/model`; must be in `allowedModels` when the developer set it. */
  model?: string;
  /** System instructions. */
  instructions?: string;
  /** Names of tools, picked from the developer's tool pool (`base.tools` of `fromConfig`). */
  tools?: string[];
}

/** A run that a crash cut off (see {@link Agent.interrupted}). */
export interface InterruptedRun {
  runId: string;
  /** Epoch ms when the run began. */
  startedAt: number;
  /** Preview of the prompt that started it. */
  prompt: string;
  /** Names of tool calls it had asked for that have no result yet. */
  pendingToolCalls: string[];
}

/** Per-request + run limits. */
export interface AgentRunLimits {
  maxTurns?: number;
  deadlineMs?: number;
  maxTotalTokens?: number;
  maxToolCallsPerRun?: number;
  /** Network timeouts in ms. Defaults 300 000 / 120 000 / 300 000. `0` or `Infinity` turns one off. */
  requestTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
}

/** Developer policy for mid-session new-query insertion while a run is active. */
export type MidSessionMode = "steer" | "queue" | "auto";

/** Canonical busy-policy alias: prefer `whenBusy`, `mode` kept for compat. */
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
   * Canonical alias for `mode` (preferred). When both are set,
   * `whenBusy` wins. Accepted anywhere `mode` is read; resolution honors
   * `whenBusy ?? mode ?? "auto"`.
   */
  whenBusy?: MidSessionMode;
  /** Max queued (follow-up) requests buffered while busy. Extra `queue()` calls throw. Defaults to 20. */
  maxQueued?: number;
}

/** Developer-configured policy for LLM-spawned dynamic sub-agents. */
export interface DynamicSubagentsConfig {
  /** Adds the `subagents` tool (spawn, message, close, list persistent workers). Defaults to true when the object is present; `agent.workers` works either way. */
  enabled?: boolean;
  /**
   * Lets the Main Agent schedule dynamic sub-agents to run later (once or on
   * repeat) via the `scheduled_actions` and `get_datetime` tools. Off by
   * default: without it no tool, clock or timer exists. Needs a worker model.
   */
  allowScheduledActions?: boolean;
  /** Developer-only worker model override. Never choosable by the Main Agent LLM. Falls back to top-level `subagentModel`, then `SUB_AGENT_MODEL` env, then the parent model. */
  model?: string | ModelSpec | ModelProviderInstance;
  /** Max workers that may be open at once on this agent (the model must close one before spawning another). Default: no limit; set a whole number >= 1 to cap it. */
  maxSpawn?: number;
  /** Fixed reasoning level for all dynamic workers. The Main Agent cannot override it. Falls back to the parent level when omitted. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Spending cap of EACH worker (the `subagents` tool, `agent.workers` and scheduled actions), set as that worker's own
   * per-run `budget`: a spawn, a message or a scheduled run is one run, and the usage of the worker's own workers counts
   * toward it. Exceeding it fails that call with a budget error and leaves the worker open. Default: unlimited. Models
   * with unknown pricing count $0 toward `maxCostUsd`. Passed down to the workers' own workers.
   */
  workerBudget?: Pick<Budget, "maxCostUsd" | "maxTotalTokens">;
  /**
   * How many levels of workers may exist below this agent. Default: no limit. `1` = workers cannot start workers of their
   * own; `3` = a worker may start workers that start workers. A worker with levels left gets its own `subagents` tool, and
   * its children can only be granted the tools the worker itself was granted. A whole number >= 1, or omit it for no limit.
   */
  maxDepth?: number;
  /** Tool pool available to dynamic workers. Workers receive zero tools unless the Main Agent grants a per-task `tools` subset by name. */
  tools?: Record<string, ToolDefinition> | ToolDefinition[];
  /**
   * Longest a SCHEDULED ACTION's run may take, in ms (the `subagents` tool and `agent.workers` have no timeouts). An
   * action can set its own shorter `timeoutMs`; this is the ceiling for it, and the limit for actions that set none.
   * Default: no limit (`0` and `Infinity` mean the same).
   */
  workerTimeoutMs?: number;
}

/** Per-run overrides for {@link Agent.run}, {@link Agent.ask}, and {@link Agent.stream}. */
export interface AgentRunOptions {
  /** Per-run reasoning-level override, validated against the selected model. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Canonical per-run reasoning option (preferred over `thinkingLevel`).
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
   * `"interrupt"` is honored in every mode: it stops the active run (provider request, tools, workers) and starts this
   * prompt as the next run, ahead of queued follow-ups.
   */
  enqueue?: "steer" | "queue" | "interrupt";
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
  // Per-run knobs (all optional, additive; `output` intentionally
  // omitted here — it is agent-level only, see AgentConfig.output).
  /** Per-run tool-selection override. */
  toolChoice?: ToolChoiceOption;
  /** Per-run output-token cap. */
  maxOutputTokens?: number;
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

/** Optional run budgets enforced by delegation helpers. All fields default to unlimited. */
export interface Budget {
  /** Maximum total cost in USD across this agent + spawned workers. */
  maxCostUsd?: number;
  /** Maximum total tokens across this agent + spawned workers. */
  maxTotalTokens?: number;
  /** Maximum wall/monotonic duration in ms since budget tracking started. */
  maxDurationMs?: number;
  /** Maximum total dynamic sub-agents spawned in one run (`subagents` tool or `agent.workers.spawn`). */
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

/** Run/turn lineage attached to sub-agent metadata via `(metadata as any)`. */
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
