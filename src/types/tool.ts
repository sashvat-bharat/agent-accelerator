import type { z } from "zod";

export interface ToolExecutionContext {
  toolCallId: string;
  agentName?: string;
  signal?: AbortSignal;
  sessionId?: string;
}

export type ToolExecuteFn<TInput = any, TOutput = any> = (
  input: TInput,
  context: ToolExecutionContext
) => Promise<TOutput> | TOutput;

export interface ToolDefinition<TInput = any, TOutput = any> {
  name?: string;
  description: string;
  input?: z.ZodType<TInput> | Record<string, unknown>;
  parameters?: Record<string, unknown>;
  strict?: boolean;
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
}

export interface ToolResultRecord {
  id: string;
  name: string;
  result: unknown;
  isError?: boolean;
  durationMs?: number;
}
