import { z } from "zod";
import type {
  ToolDefinition,
  StandardToolDeclaration,
  ToolExecuteFn,
} from "../types/tool.ts";
import { zodToJsonSchema } from "./schema.ts";

export interface CreateToolOptions<TInput = any, TOutput = any> {
  name?: string;
  description: string;
  input?: z.ZodType<TInput> | Record<string, unknown>;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  execute: ToolExecuteFn<TInput, TOutput>;
}

/**
 * Creates a type-safe tool definition for the Agent
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
    execute: options.execute,
  };
}

/**
 * Converts internal tool definitions to standard declarations for AI Providers
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
