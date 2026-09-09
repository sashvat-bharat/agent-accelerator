import { z } from "zod";
import type {
  ToolDefinition,
  StandardToolDeclaration,
  ToolExecuteFn,
} from "../types/tool.ts";
import { zodToJsonSchema } from "./schema.ts";

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
  /** Maximum simultaneous executions of this tool. `0`/omitted uses the global pool. */
  maxConcurrency?: number | string;
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
 *     return username === "Akshat Dwivedi" ? "Valid" : "Invalid";
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
  return {
    name: options.name,
    description: options.description,
    input: options.input,
    parameters: options.parameters,
    strict: options.strict,
    timeoutMs: options.timeoutMs,
    maxTries: options.maxTries,
    maxConcurrency: options.maxConcurrency,
    execute: options.execute,
  };
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
