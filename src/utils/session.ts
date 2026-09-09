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
