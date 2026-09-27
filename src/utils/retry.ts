import { toConciseProviderError } from "./errors.ts";

/**
 * Checks whether a provider error is a cancellation (never retried).
 */
export function isAbortError(error: unknown): boolean {
  const err = error as { name?: unknown; message?: unknown } | null;
  if (!err || typeof err !== "object") return false;
  if ((err as { name?: unknown }).name === "AbortError") return true;
  return /abort|cancell?ed/i.test(String((err as { message?: unknown }).message ?? error));
}

/**
 * Checks whether a provider error is transient and safe to retry.
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  if (isAbortError(error)) return false;
  const err = error as Record<string, unknown>;
  if (err["transient"] === true) return true;
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
  return /(?:timed?\s?out|temporar(?:y|ily)|connection reset|connection refused|service unavailable|rate limit|\b5\d\d\b|overloaded)/i.test(
    String((err["message"] as string | undefined) ?? error)
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
 */
export async function withRetries<T>(
  fn: () => Promise<T> | PromiseLike<T>,
  options?: {
    maxRetries?: number;
    maxRetryDelayMs?: number;
    signal?: AbortSignal;
    label?: { providerId?: string; modelId?: string };
  }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 2;
  const maxDelay = options?.maxRetryDelayMs ?? 5000;
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
      const delay = Math.min(maxDelay, 250 * 2 ** attempt + Math.random() * 100);
      attempt += 1;
      await sleep(delay, options?.signal);
    }
  }
}
