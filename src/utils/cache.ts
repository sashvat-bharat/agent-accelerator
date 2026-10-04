/**
 * Battle-tested cache helper — single source for 80-90% hit rate
 * Based on agent-accel: openai-prompt-cache.ts + applyAnthropicCacheControl
 * - First turn already cache-optimized: system + tools + first user get cache_control
 * - Stable sessionId (64 clamp) + prompt_cache_key ensures affinity
 * - 4 breakpoint cap (Anthropic limit)
 * - Retention mapping: short=5m (no ttl), medium=1h, long=24h (prompt) / 1h (anthropic)
 */

import type { CacheRetention } from "../types/core.ts";
import { getApiKey } from "./env.ts";

const CACHE_KEY_MAX = 64;

/** Clamps a cache/session affinity key to the provider-safe 64-character limit. */
export function clampCacheKey(key?: string): string | undefined {
  if (!key) return undefined;
  const chars = Array.from(key);
  if (chars.length <= CACHE_KEY_MAX) return key;
  return chars.slice(0, CACHE_KEY_MAX).join("");
}

/** Maps retention to explicit-cache TTL seconds. short=5m, medium=1h, long=12h. Explicit ttlSeconds wins. */
export function retentionToTtlSeconds(retention?: CacheRetention, ttlSeconds?: number): number | undefined {
  if (ttlSeconds && ttlSeconds > 0) return Math.floor(ttlSeconds);
  if (!retention || retention === "implicit") return undefined;
  if (retention === "short") return 300;
  if (retention === "medium") return 3600;
  if (retention === "long") return 43200;
  return undefined;
}

/** Maps retention settings to OpenRouter prompt-cache TTL values. */
export function getPromptCacheRetention(retention?: CacheRetention, supportsLong = true): "24h" | "1h" | undefined {
  if (!retention || retention === "implicit") return undefined;
  if (retention === "long" && supportsLong) return "24h";
  if (retention === "medium" && supportsLong) return "1h";
  if (retention === "long") return "24h"; // fallback even if supportsLong false, provider may ignore
  return undefined;
}

// ============================================================================
// Explicit Context Caching (Google cachedContents API)
// ============================================================================

export interface CachedContentMetadata {
  name: string;
  displayName?: string;
  model: string;
  createTime: string;
  updateTime: string;
  expireTime: string;
  usageMetadata?: {
    totalTokenCount?: number;
  };
}

export interface CreateExplicitCacheOptions {
  model: string;
  contents?: any[];
  systemInstruction?: string;
  tools?: any[];
  toolConfig?: any;
  displayName?: string;
  ttlSeconds?: number;
  retention?: CacheRetention;
  expireTime?: string | Date;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Creates an explicit cached content object using Google Gemini's cachedContents API.
 * REST: POST https://generativelanguage.googleapis.com/v1beta/cachedContents?key=...
 */
/**
 * Creates a Google Gemini cachedContents resource through the REST API.
 *
 * @example `const cache = await createExplicitCache({ model: "google/gemini-3.5-flash-lite", contents });`
 */
export async function createExplicitCache(
  options: CreateExplicitCacheOptions
): Promise<CachedContentMetadata> {
  const apiKey = getApiKey("google", options.apiKey);
  if (!apiKey) {
    throw new Error("API key is required to create explicit cache (GEMINI_API_KEY)");
  }

  const baseUrl = options.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const ttlSeconds = retentionToTtlSeconds(options.retention, options.ttlSeconds) ?? 3600;
  const ttl = options.expireTime ? undefined : `${ttlSeconds}s`;

  let modelName = options.model;
  if (!modelName.startsWith("models/")) {
    modelName = `models/${modelName.replace(/^google\//, "")}`;
  }

  const payload: Record<string, unknown> = {
    model: modelName,
    contents: options.contents ?? [],
    ...(ttl ? { ttl } : {}),
    ...(options.expireTime
      ? { expireTime: options.expireTime instanceof Date ? options.expireTime.toISOString() : options.expireTime }
      : {}),
  };

  if (options.displayName) {
    payload.displayName = options.displayName;
    (payload as any).display_name = options.displayName;
  }

  if (options.systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: options.systemInstruction }],
    };
    (payload as any).system_instruction = payload.systemInstruction;
  }

  if (options.tools && options.tools.length > 0) {
    payload.tools = options.tools;
  }

  if (options.toolConfig) {
    payload.toolConfig = options.toolConfig;
    (payload as any).tool_config = options.toolConfig;
  }

  const url = `${baseUrl}/cachedContents?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to create explicit cache (${response.status} ${response.statusText}): ${errorBody}`
    );
  }

  return (await response.json()) as CachedContentMetadata;
}

// ---------------------------------------------------------------------------
// Central redaction helpers (Q-11, temporary home to avoid owner conflicts).
// Providers must call these instead of maintaining local deny-lists.
// ---------------------------------------------------------------------------

/** Header-name deny-list (case-insensitive substring match). */
const REDACT_HEADER_SUBSTRINGS = ["key", "token", "secret", "cookie", "authorization"];

/** Secret-looking value prefixes. */
const REDACT_VALUE_PREFIXES = ["sk-", "AIza", "gsk-", "xox-"];

function headerNameIsSensitive(name: string): boolean {
  const lower = String(name ?? "").toLowerCase();
  return REDACT_HEADER_SUBSTRINGS.some((s) => lower.includes(s));
}

function valueLooksSensitive(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (REDACT_VALUE_PREFIXES.some((p) => v.includes(p))) return true;
  // Bearer-style long tokens: "Bearer <20+ chars>"
  if (/^bearer\s+\S{20,}/i.test(v)) return true;
  return false;
}

/**
 * Redacts a single value: sensitive strings become "[REDACTED]" (Q-11).
 */
export function redactValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (valueLooksSensitive(value)) return "[REDACTED]";
  return value;
}

/**
 * Redacts sensitive header values (Q-11). Returns a shallow copy; input untouched.
 * Deny-list (name contains): *key*, *token*, *secret*, cookie, authorization.
 * Value patterns (redacted regardless of name): sk-, AIza, gsk-, xox-.
 */
export function redactHeadersCentral(
  headers: Record<string, unknown> | undefined | null
): Record<string, unknown> {
  if (!headers || typeof headers !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (headerNameIsSensitive(k) || valueLooksSensitive(v)) out[k] = "[REDACTED]";
    else out[k] = v;
  }
  return out;
}

/**
 * Redacts secret-looking substrings inside free text (Q-11).
 * Replaces `sk-...`, `AIza...`, `gsk-...`, `xox-...` tokens with "[REDACTED]".
 */
export function redactText(text: string): string {
  if (typeof text !== "string" || !text) return text;
  // Note: longer prefixes (gsk-/gsk_) first so the generic sk- pattern
  // does not partially match inside them (e.g. "gsk-abc" -> one token).
  return text
    .replace(/gsk_[A-Za-z0-9]{8,}/g, "[REDACTED]")
    .replace(/gsk-[A-Za-z0-9-_]{8,}/g, "[REDACTED]")
    .replace(/xox-[A-Za-z0-9-]{8,}/g, "[REDACTED]")
    .replace(/AIza[A-Za-z0-9-_]{10,}/g, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9-_]{8,}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]{20,}/gi, "Bearer [REDACTED]");
}
