import type { z } from "zod";

export interface ToolExecutionContext {
  /** Unique ID for the model-generated invocation. */
  toolCallId: string;
  /** Name of the owning agent, when invoked through an Agent. */
  agentName?: string;
  /** Abort signal for parent cancellation or a tool timeout. */
  signal?: AbortSignal;
  /** Session identifier associated with this invocation. */
  sessionId?: string;
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
