/**
 * Helpers shared by the one-call functions that talk to a provider outside an Agent (`generateImage`, `generateEmbedding`):
 * an abort error that carries the signal's reason, a timeout-and-abort bound around one provider request, and the sum of
 * several usages.
 */
import { TimeoutError } from "../types/errors.ts";
import type { TokenUsage } from "../types/core.ts";
import type { RetryPolicyConfig } from "../types/agent.ts";
import type { ProviderRequestOptions } from "../types/model.ts";

/** An `AbortError` carrying the signal's reason message (`what` names the call when there is none); in: the abort paths of the one-call functions, out: the error to throw. */
export function abortError(signal: AbortSignal, what = "Request aborted"): Error {
  const reason = (signal as { reason?: unknown }).reason;
  return Object.assign(new Error(reason instanceof Error ? reason.message : what), { name: "AbortError" });
}

/** Runs `task`, rejecting with a `TimeoutError` after `ms` or an `AbortError` as soon as `signal` aborts, even when the adapter ignores its signal; in: each provider request, out: the task's result. */
export function bounded<T>(
  task: () => Promise<T>,
  ms: number,
  signal: AbortSignal,
  names: { timeout: string; aborted: string }
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal, names.aborted));
  return new Promise<T>((resolve, reject) => {
    const timer =
      Number.isFinite(ms) && ms > 0
        ? setTimeout(
            () => reject(new TimeoutError(`[Agent Accelerator] ${names.timeout} timed out after ${ms}ms.`)),
            ms
          )
        : undefined;
    const onAbort = (): void => reject(abortError(signal, names.aborted));
    signal.addEventListener("abort", onAbort, { once: true });
    task()
      .then(resolve, reject)
      .finally(() => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      });
  });
}

/** Adds one usage into a running total: tokens always, the media token details when reported; the cost is NOT summed here (callers use their own `sumCosts`, so an unpriced call keeps the total cost unknown); in: the one-call functions after their requests, out: the total. */
export function addUsage(total: TokenUsage, u: TokenUsage): void {
  total.inputTokens += u.inputTokens || 0;
  total.outputTokens += u.outputTokens || 0;
  total.totalTokens += u.totalTokens || 0;
  for (const k of ["cachedTokens", "cacheReadTokens", "cacheWriteTokens", "thinkingTokens"] as const)
    if (u[k] !== undefined) total[k] = (total[k] ?? 0) + (u[k] ?? 0);
  for (const [group, parts] of [
    ["inputDetails", ["audioTokens", "videoTokens", "imageTokens", "textTokens"]],
    ["outputDetails", ["audioTokens", "imageTokens", "textTokens"]],
  ] as const) {
    for (const part of parts) {
      const v = (u[group] as Record<string, number | undefined> | undefined)?.[part];
      if (v === undefined) continue;
      const into = ((total[group] as Record<string, number> | undefined) ??= {});
      into[part] = (into[part] ?? 0) + v;
    }
  }
}

/** The connection settings every one-call function takes (`generateImage`, `generateEmbedding`). */
export interface ConnectionOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  fetch?: typeof fetch;
  /** Retries of transient failures (429, 5xx) before any result exists. */
  retry?: RetryPolicyConfig;
}

/** The provider request options for one call: the connection settings the caller gave, the retry knobs, and the per-request timeout when it is finite and above 0 (`0` or `Infinity` turns it off); in: the one-call functions, out: the options each provider request receives. */
export function providerOptionsFrom(opts: ConnectionOptions, timeoutMs: number): ProviderRequestOptions {
  const retry = opts.retry ?? {};
  return {
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(retry.maxRetries !== undefined ? { maxRetries: retry.maxRetries } : {}),
    ...(retry.maxDelayMs !== undefined ? { maxRetryDelayMs: retry.maxDelayMs } : {}),
    ...(retry.baseDelayMs !== undefined ? { retryBaseDelayMs: retry.baseDelayMs } : {}),
    ...(retry.budgetMs !== undefined ? { retryBudgetMs: retry.budgetMs } : {}),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  };
}
