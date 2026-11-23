import { clampCacheKey } from "./cache.ts";
import type { ModelSpec } from "../types/model.ts";
import type { ContentPart } from "../types/message.ts";

/**
 * Creates a unique, provider-safe session ID for cache affinity: a bare random
 * UUID by default, or `${prefix}-<uuid>` when a prefix is given (clamped to 64 chars).
 *
 * @example `const sessionId = createSessionId();`
 */
export function createSessionId(prefix?: string): string {
  const head = prefix ? `${prefix}-` : "";
  let id: string;
  try {
    const webCrypto = typeof crypto !== "undefined" ? crypto : undefined;
    if (webCrypto && typeof webCrypto.randomUUID === "function") {
      id = `${head}${webCrypto.randomUUID()}`;
    } else {
      throw new Error("no randomUUID");
    }
  } catch {
    // Fallback — still clamp
    id = `${head}${Math.random().toString(36).slice(2, 11)}-${Date.now().toString(36)}`;
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
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  }
  let out = "";
  while (out.length < 32) out += Math.random().toString(16).slice(2);
  return out.slice(0, 32);
}

/**
 * Monotonic clock for measuring durations. Uses `performance.now()`
 * when available, falling back to `Date.now()`. Differences on the same
 * clock are valid durations; never treat the value as wall-clock epoch.
 *
 * @example `const start = nowMs(); ...; const durationMs = nowMs() - start;`
 */
export function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

// 32 random lowercase hex characters; in: newRunId/newTurnId, out: a string.
function random32Hex(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  }
  let out = "";
  while (out.length < 32) out += Math.random().toString(16).slice(2);
  return out.slice(0, 32);
}

/**
 * New stable run id: 32 lowercase hex chars (crypto.randomUUID, no dashes).
 * Opaque lineage token attached to sub-agent metadata as `runId`.
 */
export function newRunId(): string {
  return random32Hex();
}

/**
 * New stable turn id: 32 lowercase hex chars (crypto.randomUUID, no dashes).
 * Opaque lineage token attached to sub-agent metadata as `turnId`.
 */
export function newTurnId(): string {
  return random32Hex();
}

/** Bounded (500 chars), display-only preview of a prompt, used in `queued`/`steer_injected` events, turn lists and `interrupted()`. */
export function previewPrompt(prompt: string | ContentPart[]): string {
  if (typeof prompt === "string") return prompt.slice(0, 500);
  try {
    const texts = (prompt as ContentPart[])
      .filter((p) => (p as { type?: unknown }).type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("\n");
    return (texts || "[multipart]").slice(0, 500);
  } catch {
    return "[multipart]";
  }
}

// Type guard for a catalog spec (`provider` and `id` strings); in: parseModelRef, out: a boolean.
export function isModelSpec(v: unknown): v is ModelSpec {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r["provider"] === "string" && typeof r["id"] === "string";
}
