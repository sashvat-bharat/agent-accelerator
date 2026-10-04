import { z } from "zod";
import type {
  ToolDefinition,
  StandardToolDeclaration,
  ToolExecuteFn,
} from "../types/tool.ts";
import type { ThinkingLevel } from "../types/core.ts";
import type { ThinkingOption } from "../types/agent.ts";
import { zodToJsonSchema } from "./schema.ts";
import { ConfigError } from "../types/errors.ts";

/**
 * Valid tool-name pattern (Q-55): 1–64 chars of letters, digits, `_`, `-`.
 * Names are validated at registration in {@link tool} (record-key fallback
 * included); invalid names throw `ConfigError` with a fix.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Throws `ConfigError` when `name` is not a valid tool name.
 *
 * @example `assertValidToolName("get_status");`
 */
export function assertValidToolName(name: string): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new ConfigError(
      `[Agent Accelerator] Invalid tool name "${name}": expected 1-64 characters of letters, digits, "_" or "-". ` +
        `Fix: rename the tool (e.g. "get_status").`
    );
  }
}

/**
 * Normalizes the Q-52 canonical `thinking` option to a bare level.
 * Accepts a level string or `{ level, budgetTokens }`; `budgetTokens` is
 * carried separately by providers, so only the level is returned here.
 * Resolution honors `thinking ?? thinkingLevel`.
 *
 * @example `normalizeThinkingV2({ level: "medium" }, "low"); // "medium"`
 */
export function normalizeThinkingV2(
  thinking?: ThinkingOption,
  thinkingLevel?: ThinkingLevel
): ThinkingLevel | undefined {
  if (thinking !== undefined) {
    if (typeof thinking === "string") return thinking;
    return thinking.level ?? thinkingLevel;
  }
  return thinkingLevel;
}

/**
 * Resolves the Q-51 canonical busy policy. `whenBusy` wins over `mode`.
 *
 * @example `resolveWhenBusy({ whenBusy: "queue", mode: "steer" }); // "queue"`
 */
export function resolveWhenBusy(
  config?: { mode?: "steer" | "queue" | "auto"; whenBusy?: "steer" | "queue" | "auto" }
): "steer" | "queue" | "auto" {
  const v = config?.whenBusy ?? config?.mode ?? "auto";
  return v === "steer" || v === "queue" ? v : "auto";
}

/**
 * Maps the Q-52 canonical worker-timeout knobs to the legacy `timeout` value
 * (`0` = no limit, `-1` = model sets per-task `timeoutMs`, `>0` = fixed ms).
 * An explicit `timeout`/`workerTimeoutMs` wins over `modelMaySetTimeout`.
 *
 * @example `normalizeWorkerTimeout({ modelMaySetTimeout: true }); // -1`
 */
export function normalizeWorkerTimeout(
  config?: { timeout?: number; workerTimeoutMs?: number; modelMaySetTimeout?: boolean }
): number {
  const explicit = config?.workerTimeoutMs ?? config?.timeout;
  if (Number.isFinite(explicit as number)) return Math.floor(explicit as number);
  if (config?.modelMaySetTimeout === true) return -1;
  return 0;
}

/**
 * Normalizes the Q-52 `maxAttempts` alias to a `maxTries` value.
 * `maxTries` wins when both are set.
 *
 * @example `normalizeMaxAttempts({ maxAttempts: 3 }); // 3`
 */
export function normalizeMaxAttempts(
  config?: { maxTries?: number | string; maxAttempts?: number | string }
): number | string | undefined {
  return config?.maxTries ?? config?.maxAttempts;
}

/** Complete configuration accepted by {@link tool}. */
export interface CreateToolOptions<TInput = any, TOutput = any> {
  /** Optional public name; record keys are used when omitted. */
  name?: string;
  /** Clear description that helps the model decide when to call this tool. */
  description: string;
  /** Zod input schema or a plain JSON Schema object. */
  input?: z.ZodType<TInput> | Record<string, unknown>;
  /** Explicit JSON Schema passed to providers instead of deriving it from `input`. */
  parameters?: Record<string, unknown>;
  /** Provider-specific strict argument validation flag. */
  strict?: boolean;
  /** Maximum best-effort wall-clock time, in milliseconds, for one attempt. `0`/omitted means unlimited. `ctx.signal` enables cooperative cancellation. */
  timeoutMs?: number;
  /** Maximum total attempts for transient failures. `0`/omitted means no configured limit. */
  maxTries?: number | string;
  /**
   * Canonical alias for `maxTries` (Q-52). When both are set, `maxTries` wins.
   * Normalized by `normalizeMaxAttempts`.
   */
  maxAttempts?: number | string;
  /** Maximum simultaneous executions of this tool. `0`/omitted uses the global pool. */
  maxConcurrency?: number | string;
  /**
   * Whether this tool is safe to retry on transient failures. Retry defaults
   * to a single attempt unless this is `true` (bounded retries) or `maxTries`
   * explicitly overrides the attempt count.
   */
  idempotent?: boolean;
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
   * Canonical alias for `redactError` (Q-55). When both are set,
   * `redactError` wins.
   */
  redact?: (err: unknown) => string;
  /**
   * Explicit retry policy (Q-55). Preferred over bare `maxTries` for new
   * code; the executor reads via `(toolDef as any).retry`.
   */
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
  /** Free-form tags for grouping/filtering tools (e.g. `["web", "readonly"]`). */
  tags?: string[];
  /**
   * When true, the host must approve this call before execution. Stored only;
   * enforcement is wired by the host, default open.
   */
  needsApproval?: boolean;
  /**
   * Optional output schema (Zod or JSON Schema, stored as `unknown` so `zod`
   * stays optional for type-only consumers).
   */
  output?: unknown;
  /** Implementation invoked with validated input and execution metadata. */
  execute: ToolExecuteFn<TInput, TOutput>;
}

/**
 * Creates a type-safe tool definition for an Agent.
 *
 * The returned definition can be supplied in `AgentConfig.tools`. The model
 * receives the name, description, and generated JSON Schema; the runtime then
 * validates arguments, applies timeout/retry/concurrency policies, executes
 * the function, and makes its result safe for model context.
 *
 * @example
 * ```ts
 * const getStatus = tool({
 *   name: "get_status",
 *   description: "Check user authentication status.",
 *   input: z.object({ username: z.string() }),
 *   timeoutMs: 5_000,
 *   maxTries: 2,
 *   maxConcurrency: 2,
 *   execute: async ({ username }, ctx) => {
 *     return username === "alice" ? "Valid" : "Invalid";
 *   },
 * });
 * ```
 *
 * @typeParam TInput Type inferred from the input schema.
 * @typeParam TOutput Value returned by the implementation.
 */
export function tool<TInput = any, TOutput = any>(
  options: CreateToolOptions<TInput, TOutput>
): ToolDefinition<TInput, TOutput> {
  // Q-55: names are validated at registration (record-key fallback included).
  if (options.name !== undefined) assertValidToolName(options.name);
  // ToolDefinition (src/types/tool.ts) carries the v2 policies as typed
  // optionals; the executor additionally reads them via `(toolDef as any).*`.
  return {
    name: options.name,
    description: options.description,
    input: options.input,
    parameters: options.parameters,
    strict: options.strict,
    timeoutMs: options.timeoutMs,
    maxTries: normalizeMaxAttempts(options),
    maxConcurrency: options.maxConcurrency,
    execute: options.execute,
    ...(options.idempotent !== undefined ? { idempotent: options.idempotent } : {}),
    ...(options.repeatable !== undefined ? { repeatable: options.repeatable } : {}),
    ...(options.maxResultChars !== undefined ? { maxResultChars: options.maxResultChars } : {}),
    ...(options.redactError !== undefined ? { redactError: options.redactError } : {}),
    ...(options.redactError === undefined && options.redact !== undefined ? { redactError: options.redact } : {}),
    ...(options.redact !== undefined ? { redact: options.redact } : {}),
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
    ...(options.tags !== undefined ? { tags: options.tags } : {}),
    ...(options.needsApproval !== undefined ? { needsApproval: options.needsApproval } : {}),
    ...(options.output !== undefined ? { output: options.output } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  } as ToolDefinition<TInput, TOutput>;
}

/**
 * Converts internal tool definitions to standard declarations for AI providers.
 *
 * @example `const declarations = toStandardToolDeclarations({ getStatus });`
 */
export function toStandardToolDeclarations(
  tools: Record<string, ToolDefinition> | ToolDefinition[] | undefined
): StandardToolDeclaration[] {
  if (!tools) return [];

  const list: ToolDefinition[] = Array.isArray(tools)
    ? tools
    : Object.entries(tools).map(([key, def]) => ({
        ...def,
        name: def.name || key,
      }));

  return list.map((t) => {
    const name = t.name ?? "unnamed_tool";
    const schema = t.parameters ?? (t.input ? zodToJsonSchema(t.input) : { type: "object", properties: {} });

    return {
      name,
      description: t.description,
      parameters: schema,
      ...(t.strict !== undefined ? { strict: t.strict } : {}),
    };
  });
}
