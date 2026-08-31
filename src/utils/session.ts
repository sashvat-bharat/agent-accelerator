import { randomUUID as nodeRandomUUID } from "node:crypto";

const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
function clampSessionId(id: string): string {
  const chars = Array.from(id);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return id;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

/**
 * Creates or formats a unique session ID for prompt caching affinity (clamped to 64 chars like pi)
 */
export function createSessionId(prefix = "accel"): string {
  let id: string;
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      id = `${prefix}-${crypto.randomUUID()}`;
    } else {
      id = `${prefix}-${nodeRandomUUID()}`;
    }
  } catch {
    // Fallback — still clamp
    id = `${prefix}-${Math.random().toString(36).slice(2, 11)}-${Date.now().toString(36)}`;
  }
  return clampSessionId(id);
}
