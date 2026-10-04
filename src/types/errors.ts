import type { TokenUsage } from "./core.ts";
import type { ToolCallRecord, ToolResultRecord } from "./tool.ts";

/** Machine-readable error codes. No ANSI in messages. */
export type AgentAccelErrorCode =
  | "config"
  | "provider"
  | "timeout"
  | "budget_exceeded"
  | "tool"
  | "validation"
  | "session_load"
  | "security_policy"
  | "abort"
  | "incomplete_stream"
  | "context_overflow";

export interface AgentAccelErrorContext {
  provider?: string;
  model?: string;
  status?: number;
  requestId?: string;
  retryable?: boolean;
  runId?: string;
  turnId?: string;
  docs?: string;
  fixes?: string[];
  partial?: {
    usage?: TokenUsage;
    turns?: number;
    text?: string;
    toolCalls?: ToolCallRecord[];
    toolResults?: ToolResultRecord[];
  };
  [k: string]: unknown;
}

/** Base for all SDK errors. Message is one line, no ANSI. */
export class AgentAccelError extends Error {
  readonly code: AgentAccelErrorCode;
  readonly retryable: boolean;
  readonly context: AgentAccelErrorContext;
  constructor(code: AgentAccelErrorCode, message: string, opts?: { retryable?: boolean; context?: AgentAccelErrorContext; cause?: unknown }) {
    super(message);
    this.name = "AgentAccelError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.context = opts?.context ?? {};
    if (opts?.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

export class ConfigError extends AgentAccelError {
  constructor(message: string, context?: AgentAccelErrorContext) {
    super("config", message, { retryable: false, context });
    this.name = "ConfigError";
  }
}

export class ProviderError extends AgentAccelError {
  readonly status?: number;
  constructor(message: string, opts?: { status?: number; provider?: string; model?: string; requestId?: string; retryable?: boolean; context?: AgentAccelErrorContext }) {
    super("provider", message, {
      retryable: opts?.retryable ?? false,
      context: { ...opts?.context, provider: opts?.provider, model: opts?.model, status: opts?.status, requestId: opts?.requestId },
    });
    this.name = "ProviderError";
    this.status = opts?.status;
  }
}

export class TimeoutError extends AgentAccelError {
  constructor(message: string, context?: AgentAccelErrorContext) {
    super("timeout", message, { retryable: true, context });
    this.name = "TimeoutError";
  }
}

export class BudgetExceededError extends AgentAccelError {
  constructor(message: string, context?: AgentAccelErrorContext) {
    super("budget_exceeded", message, { retryable: false, context });
    this.name = "BudgetExceededError";
  }
}

export class ToolError extends AgentAccelError {
  readonly expose: boolean;
  constructor(message: string, opts?: { retryable?: boolean; expose?: boolean; context?: AgentAccelErrorContext }) {
    super("tool", message, { retryable: opts?.retryable ?? false, context: opts?.context });
    this.name = "ToolError";
    this.expose = opts?.expose ?? true;
  }
}

export class ValidationError extends AgentAccelError {
  constructor(message: string, context?: AgentAccelErrorContext) {
    super("validation", message, { retryable: false, context });
    this.name = "ValidationError";
  }
}

export class SessionLoadError extends AgentAccelError {
  constructor(message: string, context?: AgentAccelErrorContext) {
    super("session_load", message, { retryable: false, context });
    this.name = "SessionLoadError";
  }
}

export class SecurityPolicyError extends AgentAccelError {
  constructor(message: string, context?: AgentAccelErrorContext) {
    super("security_policy", message, { retryable: false, context });
    this.name = "SecurityPolicyError";
  }
}

/** Abort is signal.aborted or name === AbortError only. Never message regex. */
export function isAbortError(error: unknown): boolean {
  const err = error as { name?: unknown } | null;
  if (!err || typeof err !== "object") return false;
  if ((err as { name?: unknown }).name === "AbortError") return true;
  return false;
}

/** Format without ANSI for CLI pretty-printing. */
export function formatErrorPlain(err: unknown): string {
  if (err instanceof AgentAccelError) {
    const ctx = err.context?.provider ? ` [${err.context.provider}${err.context.model ? `/${err.context.model}` : ""}]` : "";
    const status = err.context?.status ? ` (${err.context.status})` : "";
    return `[${err.code}]${ctx}${status}: ${err.message}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
