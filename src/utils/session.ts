import { clampCacheKey } from "./cache.ts";

/**
 * Creates or formats a unique session ID for prompt caching affinity (clamped to 64 chars like agent-accel)
 */
/**
 * Creates a unique, provider-safe session ID for cache affinity.
 *
 * @example `const sessionId = createSessionId("checkout");`
 */
export function createSessionId(prefix = "accel"): string {
  let id: string;
  try {
    const webCrypto =
      (globalThis as any)?.crypto ?? (typeof crypto !== "undefined" ? crypto : undefined);
    if (webCrypto && typeof webCrypto.randomUUID === "function") {
      id = `${prefix}-${webCrypto.randomUUID()}`;
    } else {
      throw new Error("no randomUUID");
    }
  } catch {
    // Fallback — still clamp
    id = `${prefix}-${Math.random().toString(36).slice(2, 11)}-${Date.now().toString(36)}`;
  }
  return clampCacheKey(id) || id;
}

/**
 * Short stable hash (FNV-1a, 8 hex chars) for embedding parent lineage
 * into truncated child session IDs without extra dependencies.
 */
export function hashSessionPart(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * System-generated 32-char TrackingID for one sub-agent (lowercase hex, no
 * dashes). Surfaced as the suffix in `SUBAGENT-NAME-{TrackingID}` display ids
 * so `agent.track(id)` can address one worker among many concurrent ones.
 */
export function createTrackingId(): string {
  try {
    const c = (globalThis as any)?.crypto;
    if (c && typeof c.randomUUID === "function") {
      return String(c.randomUUID()).replace(/-/g, "").slice(0, 32);
    }
  } catch {}
  try {
    const nodeCrypto: any = (globalThis as any)?.process?.getBuiltinModule?.("node:crypto") ?? null;
    if (nodeCrypto?.randomUUID) {
      return String(nodeCrypto.randomUUID()).replace(/-/g, "").slice(0, 32);
    }
  } catch {}
  let out = "";
  while (out.length < 32) out += Math.random().toString(16).slice(2);
  return out.slice(0, 32);
}
