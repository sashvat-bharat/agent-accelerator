/**
 * Battle-tested cache helper — single source for 80-90% hit rate
 * Based on pi: openai-prompt-cache.ts + applyAnthropicCacheControl
 * - First turn already cache-optimized: system + tools + first user get cache_control
 * - Stable sessionId (64 clamp) + prompt_cache_key ensures affinity
 * - 4 breakpoint cap (Anthropic limit)
 * - Retention mapping: short=5m (no ttl), medium=1h, long=24h (prompt) / 1h (anthropic)
 */

import type { CacheRetention } from "../types/core.ts";
import type { ModelSpec } from "../types/model.ts";

const CACHE_KEY_MAX = 64;

export function clampCacheKey(key?: string): string | undefined {
  if (!key) return undefined;
  const chars = Array.from(key);
  if (chars.length <= CACHE_KEY_MAX) return key;
  return chars.slice(0, CACHE_KEY_MAX).join("");
}

export function getCacheControlForRetention(retention?: CacheRetention, supportsLong = true) {
  if (!retention) return undefined;
  // Anthropic: ttl undefined = 5m, ttl 1h for medium/long if supportsLong
  if (retention === "short") return { type: "ephemeral" as const };
  if (retention === "medium" || retention === "long") {
    return supportsLong ? ({ type: "ephemeral" as const, ttl: "1h" as const }) : ({ type: "ephemeral" as const });
  }
  return undefined;
}

export function getPromptCacheRetention(retention?: CacheRetention, supportsLong = true): "24h" | "1h" | undefined {
  if (!retention) return undefined;
  if (retention === "long" && supportsLong) return "24h";
  if (retention === "medium" && supportsLong) return "1h";
  if (retention === "long") return "24h"; // fallback even if supportsLong false, provider may ignore
  return undefined;
}

/**
 * Battle-tested: apply Anthropic cache_control to messages+tools, capped to 4
 * First turn optimization: system + last tool + last user are marked, so second turn's prefix (system+tools+history) hits.
 * This is called on every turn with same retention, so second turn's history (user1+assistant+tool) was already part of cached prefix.
 */
export function applyAnthropicCacheControl(
  messages: Array<Record<string, unknown>>,
  tools: Array<Record<string, unknown>> | undefined,
  retention?: CacheRetention,
  modelSpec?: ModelSpec
): number {
  if (!retention) return 0;
  const supportsLong = modelSpec?.capabilities.supportsLongCacheRetention ?? true;
  const canCache = modelSpec?.capabilities.supportsImplicitCaching ?? true;
  if (!canCache) return 0;

  const cacheControl = getCacheControlForRetention(retention, supportsLong);
  if (!cacheControl) return 0;

  let bpCount = 0;
  const maxBp = 4;

  // 1) system (most important for hit rate — stable prefix)
  if (bpCount < maxBp && messages.length > 0 && (messages[0] as any).role === "system") {
    const sys: any = messages[0];
    if (typeof sys.content === "string") {
      sys.content = [{ type: "text", text: sys.content, cache_control: cacheControl }];
      bpCount++;
    } else if (Array.isArray(sys.content) && sys.content.length > 0) {
      const arr = sys.content as any[];
      const last = arr[arr.length - 1];
      if (last?.type === "text") {
        last.cache_control = cacheControl;
        bpCount++;
      }
    }
  }

  // 2) last tool (stable prefix — tools rarely change)
  if (bpCount < maxBp && tools && tools.length > 0) {
    const lastTool: any = tools[tools.length - 1];
    if (lastTool) {
      lastTool.cache_control = cacheControl;
      bpCount++;
    }
  }

  // 3) last user (new prompt) — ensures next turn can extend cache
  for (let i = messages.length - 1; i >= 0 && bpCount < maxBp; i--) {
    const m: any = messages[i];
    if (m.role === "user") {
      if (typeof m.content === "string" && m.content.length > 0) {
        m.content = [{ type: "text", text: m.content, cache_control: cacheControl }];
        bpCount++;
        break;
      } else if (Array.isArray(m.content)) {
        for (let j = m.content.length - 1; j >= 0; j--) {
          if (m.content[j]?.type === "text") {
            m.content[j].cache_control = cacheControl;
            bpCount++;
            i = -1;
            break;
          }
        }
        if (i === -1) break;
      }
    }
  }

  // 4) earliest large assistant in history (stable for 80-90% hit across 4+ turns)
  // Pick the *first* large assistant (>2000 chars) — editorial stays stable, unlike most-recent which shifts to bullets on turn4 and breaks prefix
  if (bpCount < maxBp) {
    for (let i = 1; i < messages.length - 1; i++) {
      const m: any = messages[i];
      if (m.role !== "assistant") continue;
      let len = 0;
      let partIdx = -1;
      if (typeof m.content === "string") len = m.content.length;
      else if (Array.isArray(m.content)) {
        for (let j = 0; j < m.content.length; j++) {
          const c = m.content[j];
          if (c?.type === "text" && typeof c.text === "string" && c.text.length > len && !c.cache_control) {
            len = c.text.length;
            partIdx = j;
          }
        }
      }
      if (len > 2000) {
        if (typeof m.content === "string") {
          m.content = [{ type: "text", text: m.content, cache_control: cacheControl }];
        } else if (partIdx >= 0) {
          m.content[partIdx].cache_control = cacheControl;
        }
        bpCount++;
        break; // stable: first large editorial, not most recent
      }
    }
  }

  return bpCount;
}

/**
 * Tot context length via catalog — battle-tested
 */
export function getTotalContextLengthFromSpec(spec?: ModelSpec, fallback = 128000): number {
  if (!spec) return fallback;
  return spec.limit?.context ?? spec.contextWindow ?? fallback;
}
