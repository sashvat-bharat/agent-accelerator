/**
 * Battle-tested cache helper — single source for 80-90% hit rate
 * Based on agent-accel: openai-prompt-cache.ts + applyAnthropicCacheControl
 * - First turn already cache-optimized: system + tools + first user get cache_control
 * - Stable sessionId (64 clamp) + prompt_cache_key ensures affinity
 * - 4 breakpoint cap (Anthropic limit)
 * - Retention mapping: short=5m (no ttl), medium=1h, long=24h (prompt) / 1h (anthropic)
 */

import type { CacheRetention } from "../types/core.ts";
import type { ModelSpec } from "../types/model.ts";
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

/** Maps retention settings to OpenCode/OpenRouter prompt-cache TTL values. */
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
