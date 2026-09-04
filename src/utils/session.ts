import { randomUUID as nodeRandomUUID } from "node:crypto";
import { clampCacheKey } from "./cache.ts";

/**
 * Creates or formats a unique session ID for prompt caching affinity (clamped to 64 chars like agent-accel)
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
  return clampCacheKey(id) || id;
}
