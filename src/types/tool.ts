import type { z } from "zod";

/** Minimal logger surface accepted by tool contexts (Q-54/Q-55, additive). */
export interface ToolLogger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/** Live-event emitter handed to tools that stream progress (Q-55, additive). */
export type ToolEmitFn = (event: { type: string; [k: string]: unknown }) => void;

export interface ToolExecutionContext {
  /** Unique ID for the model-generated invocation. */
  toolCallId: string;
  /** Name of the owning agent, when invoked through an Agent. */
  agentName?: string;
  /** Abort signal for parent cancellation or a tool timeout. */
  signal?: AbortSignal;
  /** Session identifier associated with this invocation. */
  sessionId?: string;
  /** Forwards live sub-agent deltas (used by `spawn_subagents` for realtime tracking). */
  onSubagentEvent?: (event: { trackingId: string; delta?: string; thinkingDelta?: string; partialText?: string; partialThinking?: string }) => void;
  // Q-55 Tool API v2 context additions (all optional, additive).
  /** Stable id for this run (`newRunId`). Mirrors SubAgentRunIds.runId. */
  runId?: string;
  /** Live-event emitter for tools that stream progress. */
  emit?: ToolEmitFn;
  /** Structured logger for tool implementations (defaults to no-op). */
  logger?: ToolLogger;
}

export type ToolExecuteFn<TInput = any, TOutput = any> = (
  input: TInput,
  context: ToolExecutionContext
) => Promise<TOutput> | TOutput;

export interface ToolDefinition<TInput = any, TOutput = any> {
  /** Optional public name; record keys are used when omitted. */
  name?: string;
  /** Description shown to the model when selecting tools. */
  description: string;
  /** Zod schema (or JSON Schema object) used to validate the model input. */
  input?: z.ZodType<TInput> | Record<string, unknown>;
  /** Explicit JSON Schema, taking precedence over `input` for provider declarations. */
  parameters?: Record<string, unknown>;
  /** Whether providers should enforce strict function-argument validation. */
  strict?: boolean;
  /** Maximum best-effort wall-clock time for one execution attempt in milliseconds. 0/undefined means no bound. Cancellation is cooperative via `signal`. */
  timeoutMs?: number;
  /** Maximum total attempts for transient failures. 0/undefined means no configured retry limit. */
  maxTries?: number | string;
  /** Maximum simultaneous calls for this tool. 0/undefined uses the global pool. */
  maxConcurrency?: number | string;
  /** Function executed after validation; its result is made JSON-safe for model context. */
  execute: ToolExecuteFn<TInput, TOutput>;
  // Q-55 Tool API v2 additions (all optional, additive; loop reads via `(toolDef as any).*`).
  /**
   * Canonical alias for `maxTries`. When both are set, `maxTries` wins.
   * Normalized by `normalizeMaxAttempts` (see tools/tool.ts).
   */
  maxAttempts?: number | string;
  /**
   * Whether this tool is safe to retry on transient failures. Retry defaults
   * to a single attempt unless this is `true` (bounded retries) or `maxTries`/
   * `maxAttempts` explicitly overrides the attempt count.
   */
  idempotent?: boolean;
  /**
   * Explicit retry policy. Preferred over bare `maxTries` for new code;
   * `maxTries`/`maxAttempts` map to `{ maxRetries: n - 1 }`.
   */
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
  /**
   * Whether an identical call may repeat across consecutive turns. Defaults to
   * `true` for idempotent tools, `false` otherwise. Honored by repeat guards.
   */
  repeatable?: boolean;
  /**
   * Maximum characters of a string tool result kept for model context.
   * Longer strings are truncated with a `[Truncated: ...]` marker.
   * `0`/omitted uses the executor default (20000).
   */
  maxResultChars?: number | string;
  /** Optional hook to redact/replace the error message sent back to the model. */
  redactError?: (err: unknown) => string;
  /**
   * Canonical alias for `redactError`. When both are set, `redactError` wins.
   * Kept short for Q-55 Tool API v2 parity.
   */
  redact?: (err: unknown) => string;
  /** Free-form tags for grouping/filtering tools (e.g. `["web", "readonly"]`). */
  tags?: string[];
  /**
   * When true, the host must approve this call before execution (human-in-the-
   * loop). The loop reads via `(toolDef as any).needsApproval`; enforcement
   * is wired by the host, default open (undefined = no gate).
   */
  needsApproval?: boolean;
  /**
   * Optional output schema (Zod or JSON Schema) used to validate/coerce the
   * tool's return value before it reaches model context. Stored as `unknown`
   * so `zod` stays an optional peer for type-only consumers.
   */
  output?: unknown;
  /** Opaque brand marker narrowing bare object literals to `tool()` output. */
  readonly __brand?: "ToolDefinition";
}

export interface StandardToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
  thoughtSignature?: string;
  /**
   * Provider pairing identifier, distinct from the item `id` when the
   * provider uses both (e.g. Responses `call_id` alongside the `fc_…` item
   * id). Tool results pair against this when present.
   */
  callId?: string;
}

export interface ToolResultRecord {
  id: string;
  name: string;
  result: unknown;
  isError?: boolean;
  durationMs?: number;
}
