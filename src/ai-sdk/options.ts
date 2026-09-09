import type { ThinkingConfig, CacheConfig, ServiceTier } from "../types/core.ts";
import type { ProviderRequestOptions } from "../types/model.ts";
import { buildSessionHeaders } from "../utils/headers.ts";
import { toConciseProviderError } from "./errors.ts";
import { getPromptCacheRetention } from "../utils/cache.ts";

export type AiSdkReasoning = "provider-default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AiSdkToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "tool"; toolName: string };

export interface AiSdkCallOptions {
  reasoning?: AiSdkReasoning;
  toolChoice?: AiSdkToolChoice;
  providerOptions?: Record<string, Record<string, unknown>>;
  headers?: Record<string, string>;
  abortSignal?: AbortSignal;
}

/**
 * Maps Agent Accelerator thinkingLevel to Vercel AI SDK reasoning.
 */
export function mapThinkingToReasoning(thinking?: ThinkingConfig): AiSdkReasoning | undefined {
  if (!thinking) return undefined;
  if (thinking.enabled === false) return "none";
  const level = thinking.level;
  if (!level) return undefined;
  if (level === "none") return "none";
  if (level === "dynamic") return "provider-default";
  if (level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh") {
    return level;
  }
  return "provider-default";
}

/**
 * Resolves per-run thinking override without mutating agent config.
 */
export function resolveEffectiveThinking(
  base?: ThinkingConfig,
  overrideLevel?: string
): ThinkingConfig | undefined {
  if (!overrideLevel) return base;
  if (overrideLevel === "none") return { enabled: false, level: "none", budgetTokens: 0 };
  if (overrideLevel === "dynamic") return { enabled: true, level: "dynamic", budgetTokens: -1 };
  return { enabled: true, level: overrideLevel as ThinkingConfig["level"] };
}

/**
 * Maps Agent Accelerator toolChoice to Vercel AI SDK toolChoice.
 */
export function mapToolChoice(
  choice?: ProviderRequestOptions["toolChoice"]
): AiSdkToolChoice | undefined {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    if (choice === "auto") return { type: "auto" };
    if (choice === "none") return { type: "none" };
    if (choice === "required") return { type: "required" };
    return undefined;
  }
  if (choice.type === "function") {
    const name = choice.function?.name;
    if (name) return { type: "tool", toolName: name };
    return { type: "required" };
  }
  return undefined;
}

function mergeProviderOptions(
  target: Record<string, Record<string, unknown>>,
  source: Record<string, Record<string, unknown>>
): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = { ...(target[key] ?? {}), ...value };
  }
}

/**
 * Maps thinking details to provider-specific providerOptions.
 */
export function mapThinkingToProviderOptions(
  providerId: string,
  thinking?: ThinkingConfig
): Record<string, Record<string, unknown>> {
  if (!thinking || thinking.enabled === false) return {};
  const level = thinking.level;
  if (!level || level === "none" || level === "dynamic") return {};
  const norm = providerId.toLowerCase().trim();

  if (norm === "google" || norm === "gemini") {
    const googleLevel = level === "xhigh" ? "high" : level === "minimal" ? "minimal" : level;
    if (googleLevel === "minimal" || googleLevel === "low" || googleLevel === "medium" || googleLevel === "high") {
      return {
        google: {
          thinkingConfig: {
            thinkingLevel: googleLevel,
            includeThoughts: thinking.includeThoughts ?? true,
          },
        },
      };
    }
    return {};
  }

  if (norm === "openai") {
    if (level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh") {
      return { openai: { reasoningEffort: level } };
    }
    return {};
  }

  return {};
}

/**
 * Maps serviceTier to provider-specific providerOptions.
 */
export function mapServiceTierToProviderOptions(
  providerId: string,
  tier?: ServiceTier
): Record<string, Record<string, unknown>> {
  if (!tier) return {};
  const norm = providerId.toLowerCase().trim();
  if (norm === "google" || norm === "gemini") {
    return { google: { serviceTier: tier } };
  }
  if (norm === "openai") {
    return { openai: { serviceTier: tier } };
  }
  return {
    openai: { serviceTier: tier },
    [norm]: { serviceTier: tier },
  };
}

/**
 * Maps cache config to provider-specific providerOptions.
 * retention short|medium|long maps to OpenCode prompt_cache_retention;
 * session affinity maps to OpenAI promptCacheKey; explicit Google
 * cachedContentId maps to google.cachedContent. Implicit prefix caching
 * itself needs no flag beyond a stable prompt plus session headers.
 */
export function mapCacheToProviderOptions(
  providerId: string,
  cache?: CacheConfig,
  sessionId?: string
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (!cache && !sessionId) return out;
  const norm = providerId.toLowerCase().trim();
  const cachedContentId = cache?.cachedContentId;
  if (cachedContentId && (norm === "google" || norm === "gemini")) {
    mergeProviderOptions(out, { google: { cachedContent: cachedContentId } });
  }
  const affinity = sessionId || cache?.sessionId;
  if (affinity) {
    mergeProviderOptions(out, { openai: { promptCacheKey: affinity } });
    if (norm !== "openai" && norm !== "google" && norm !== "gemini") {
      mergeProviderOptions(out, { [norm]: { promptCacheKey: affinity } });
    }
  }
  const retention = cache?.retention;
  if (retention && retention !== "implicit") {
    const promptCacheRetention = getPromptCacheRetention(retention, true);
    if (promptCacheRetention && (norm === "opencode" || norm === "opencode-zen" || norm === "opencode-go")) {
      mergeProviderOptions(out, {
        opencode: { prompt_cache_retention: promptCacheRetention },
        openai: { promptCacheRetention: promptCacheRetention },
      });
    }
  }
  return out;
}

/**
 * Builds Vercel AI SDK call options from Agent Accelerator request options.
 */
export function buildAiSdkCallOptions(
  providerId: string,
  options?: ProviderRequestOptions
): AiSdkCallOptions {
  const reasoning = mapThinkingToReasoning(options?.thinking);
  const toolChoice = mapToolChoice(options?.toolChoice);
  const providerOptions: Record<string, Record<string, unknown>> = {};
  mergeProviderOptions(providerOptions, mapThinkingToProviderOptions(providerId, options?.thinking));
  mergeProviderOptions(providerOptions, mapServiceTierToProviderOptions(providerId, options?.serviceTier));
  mergeProviderOptions(providerOptions, mapCacheToProviderOptions(providerId, options?.cache, options?.sessionId));

  const headers: Record<string, string> = buildSessionHeaders(
    providerId,
    options?.cache,
    options?.headers,
    options?.sessionId
  );

  const result: AiSdkCallOptions = {};
  if (reasoning !== undefined) result.reasoning = reasoning;
  if (toolChoice !== undefined) result.toolChoice = toolChoice;
  if (Object.keys(providerOptions).length > 0) result.providerOptions = providerOptions;
  if (Object.keys(headers).length > 0) result.headers = headers;
  if (options?.signal) result.abortSignal = options.signal;
  return result;
}

/**
 * Checks whether a provider error is transient and safe to retry.
 */
export function isAbortError(error: unknown): boolean {
  const err = error as { name?: unknown; message?: unknown } | null;
  if (!err || typeof err !== "object") return false;
  if ((err as { name?: unknown }).name === "AbortError") return true;
  return /abort|cancell?ed/i.test(String((err as { message?: unknown }).message ?? error));
}

export function isTransientAiSdkError(error: unknown): boolean {
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
 * Runs a Vercel AI SDK call with bounded retries for transient failures.
 */
export async function withAiSdkRetries<T>(
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
      if (attempt >= maxRetries || !isTransientAiSdkError(error)) fail(error);
      const delay = Math.min(maxDelay, 250 * 2 ** attempt + Math.random() * 100);
      attempt += 1;
      await sleep(delay, options?.signal);
    }
  }
}
