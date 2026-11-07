import { clampCacheKey } from "./cache.ts";
import type { ThinkingLevel } from "../types/core.ts";
import type { ModelSpec } from "../types/model.ts";
import type { ModelProviderInstance } from "../providers/registry.ts";
import type { ContentPart } from "../types/message.ts";
import { ConfigError } from "../types/errors.ts";

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
    const webCrypto =
      (globalThis as any)?.crypto ?? (typeof crypto !== "undefined" ? crypto : undefined);
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

/**
 * Monotonic clock for measuring durations (Q-42). Uses `performance.now()`
 * when available, falling back to `Date.now()`. Differences on the same
 * clock are valid durations; never treat the value as wall-clock epoch.
 *
 * @example `const start = nowMs(); ...; const durationMs = nowMs() - start;`
 */
export function nowMs(): number {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch {}
  return Date.now();
}

function random32Hex(): string {
  try {
    const c = (globalThis as any)?.crypto;
    if (c && typeof c.randomUUID === "function") {
      return String(c.randomUUID()).replace(/-/g, "").slice(0, 32);
    }
  } catch {}
  let out = "";
  while (out.length < 32) out += Math.random().toString(16).slice(2);
  return out.slice(0, 32);
}

/**
 * New stable run id: 32 lowercase hex chars (crypto.randomUUID, no dashes) (Q-42).
 * Opaque lineage token attached via `(metadata as any).runId`.
 */
export function newRunId(): string {
  return random32Hex();
}

/**
 * New stable turn id: 32 lowercase hex chars (crypto.randomUUID, no dashes) (Q-42).
 * Opaque lineage token attached via `(metadata as any).turnId`.
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

/** Parsed model reference returned by {@link parseModelRef} (Q-48). */
export interface ParsedModelRef {
  provider: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  thinking?: ThinkingLevel;
}

function splitModelString(raw: string): { provider: string; modelId: string } {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return { provider: "openrouter", modelId: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash).toLowerCase(),
    modelId: trimmed.slice(slash + 1),
  };
}

function isModelProviderInstance(v: unknown): v is ModelProviderInstance {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r["model"] === "string" && (r["model"] as string).length > 0;
}

function isModelSpec(v: unknown): v is ModelSpec {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r["provider"] === "string" && typeof r["id"] === "string";
}

/**
 * Single model-ref parser (Q-48). Table-driven, no env sniffing:
 * - string `"provider/model"` → split on first `/`; bare ids default to `openrouter`.
 * - `ModelProviderInstance` (`{ model, apiKey?, baseUrl?, thinkingLevel? }`) → parse `model`, passthrough creds.
 * - `ModelSpec` (`{ provider, id }`) → direct mapping.
 *
 * @example `parseModelRef("google/gemini-3.5-flash-lite")`
 */
export function parseModelRef(input: string | ModelSpec | ModelProviderInstance): ParsedModelRef {
  if (typeof input === "string") {
    if (!input.trim()) throw new ConfigError("parseModelRef: model string must be non-empty.");
    const { provider, modelId } = splitModelString(input);
    return { provider, modelId };
  }
  if (isModelProviderInstance(input)) {
    const { provider, modelId } = splitModelString(input.model);
    const out: ParsedModelRef = { provider, modelId };
    if (input.apiKey !== undefined) out.apiKey = input.apiKey;
    if (input.baseUrl !== undefined) out.baseUrl = input.baseUrl;
    if (input.thinkingLevel !== undefined) out.thinking = input.thinkingLevel;
    return out;
  }
  if (isModelSpec(input)) {
    return { provider: String(input.provider), modelId: String(input.id) };
  }
  throw new ConfigError("parseModelRef: expected string | ModelSpec | ModelProviderInstance.");
}
