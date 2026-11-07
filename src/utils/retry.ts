import { toConciseProviderError } from "./errors.ts";
import { isAbortError } from "../types/errors.ts";

export { isAbortError };

/**
 * Checks whether a provider error is transient and safe to retry.
 * Structured-data only: status / code / transient flag. Never message text,
 * so a 400 mentioning "512 tokens" is not retried (Q-24).
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  if (isAbortError(error)) return false;
  const err = error as Record<string, unknown>;
  if (err["transient"] === true) return true;
  if ((err as { retryable?: unknown }).retryable === true) return true;
  const status = Number(
    (err["status"] as number | undefined) ??
      (err["statusCode"] as number | undefined) ??
      ((err["response"] as Record<string, unknown> | undefined)?.["status"] as number | undefined) ??
      ((err["lastError"] as Record<string, unknown> | undefined)?.["status"] as number | undefined) ??
      NaN
  );
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = String((err["code"] as string | undefined) ?? "").toUpperCase();
  if (["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "EPIPE", "ETIMEDOUT"].includes(code)) {
    return true;
  }
  return false;
}

/**
 * Whether a FAILED RUN (the provider layer already retried the call) is worth trying again: the failure is transient
 * (HTTP 408/425/429/5xx, network codes, `transient`/`retryable` flags, `incomplete_stream`, a request/stream timeout).
 * Never for aborts, bad configuration or input (401/403/400/404, `ConfigError`, `ValidationError`, `SecurityPolicyError`,
 * `ThinkingLevelError`) and never for budgets or limits, which a retry would only reset or hit again.
 */
export function isRetryableRun(error: unknown): boolean {
  if (!error || isAbortError(error)) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "TimeoutError") return true; // the loop's own request / first-byte / idle timeouts
  if (["BudgetExceededError", "ConfigError", "ValidationError", "SecurityPolicyError", "SessionLoadError", "ThinkingLevelError", "ToolError"].includes(String(name))) return false;
  return isTransientError(error);
}

/** The server's wait hint in ms from `retryAfterMs` or a Retry-After header, capped at 60 s; in: withRetries, out: ms or undefined. */
export function readRetryAfterMs(error: unknown): number | undefined {
  const err = error as Record<string, unknown>;
  // Preferred: milliseconds attached by the adapter from the Retry-After header.
  const direct = err["retryAfterMs"];
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return Math.min(60_000, direct);
  const raw =
    ((err["response"] as Record<string, unknown> | undefined)?.["headers"] as Record<string, unknown> | undefined)?.["retry-after"] ??
    ((err["headers"] as Record<string, unknown> | undefined)?.["retry-after"]);
  if (raw === undefined) return undefined;
  const secs = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(secs) || secs < 0) return undefined;
  return Math.min(60_000, secs * 1000);
}

// Waits `ms`, rejecting with an AbortError as soon as `signal` aborts; in: retry backoff and Google background polling, out: the awaiting caller.
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    // Tag as AbortError so callers never retry it
    // (name assigned at reject site)
  });
}

/**
 * Runs a provider call with bounded retries for transient failures.
 * Honors Retry-After up to 60s cap. Streams retry only before first byte
 * (callers must not retry after partial output).
 */
export async function withRetries<T>(
  fn: () => Promise<T> | PromiseLike<T>,
  options?: {
    maxRetries?: number;
    maxRetryDelayMs?: number;
    signal?: AbortSignal;
    label?: { providerId?: string; modelId?: string };
    retryBudgetMs?: number;
    baseDelayMs?: number;
  }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 2;
  const maxDelay = options?.maxRetryDelayMs ?? 5000;
  const budgetMs = options?.retryBudgetMs ?? 30_000;
  const baseDelay = options?.baseDelayMs ?? 250;
  const started = Date.now();
  const fail = (error: unknown): never => {
    if (options?.label?.providerId && options?.label?.modelId) {
      throw toConciseProviderError(error, options.label.providerId, options.label.modelId);
    }
    throw error;
  };
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (options?.signal?.aborted || isAbortError(error)) throw error;
      if (attempt >= maxRetries || !isTransientError(error)) fail(error);
      if (Date.now() - started >= budgetMs) fail(error);
      const retryAfter = readRetryAfterMs(error);
      const backoff = Math.min(maxDelay, baseDelay * 2 ** attempt + Math.random() * 100);
      // A server-provided Retry-After is honored in full (it is the provider's
      // own instruction), but never past the retry budget: waiting that long is
      // pointless, so surface the 429 now instead of sleeping and failing anyway.
      const delay = retryAfter !== undefined ? Math.max(backoff, retryAfter) : backoff;
      if (retryAfter !== undefined && Date.now() - started + delay > budgetMs) fail(error);
      attempt += 1;
      await sleep(delay, options?.signal);
    }
  }
}
