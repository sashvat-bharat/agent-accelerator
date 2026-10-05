/**
 * Shared provider helpers (Q-45-partial).
 *
 * Single home for the `redactedHeaders` / `readErrorPayload` /
 * `parseArguments` / `normalizeThinkingParts` helpers previously duplicated
 * across the four REST transports, plus timeout/signal and id helpers.
 */
import { toConciseProviderError } from "../utils/errors.ts";

/** Parses a JSON tool-argument string; non-objects degrade to `{ raw }`. */
export function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { raw };
  } catch {
    return { raw };
  }
}

/** Trims/collapses assembled thinking parts (no edge-tripling). */
export function normalizeThinkingParts(parts: string[]): string | undefined {
  const cleaned = parts
    .map((p) => p.replace(/\n{3,}/g, "\n\n").trim())
    .filter((p) => p.length > 0);
  return cleaned.length > 0 ? cleaned.join("\n") : undefined;
}

/**
 * Redacts secret-bearing headers for the raw audit trail. Superset of the
 * four adapter versions: `authorization` (any case) and `x-goog-api-key` are
 * redacted; all other headers pass through untouched.
 */
export function redactedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    out[k] = lower === "authorization" || lower === "x-goog-api-key" ? "[REDACTED]" : v;
  }
  return out;
}

/**
 * Extracts `{ message, code, errorType, raw }` from a non-2xx JSON body. Handles
 * OpenAI `type`, OpenRouter `metadata.error_type` + `metadata.raw`, and Google
 * `status` code shapes; unknown bodies degrade to a 300-char slice.
 */
export function readErrorPayload(
  bodyText: string
): { message: string; code?: string | number; errorType?: string; raw?: string } {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const err = (first as { error?: { message?: string; code?: string | number; type?: string; status?: string | number; metadata?: { error_type?: string; raw?: unknown } } })?.error;
    if (err && typeof err.message === "string") {
      const code = err.code ?? err.status;
      const errorType =
        err.type ?? err.metadata?.error_type ?? (first as { error_type?: string })?.error_type;
      const rawCandidate =
        (err as { metadata?: { raw?: unknown } }).metadata?.raw ??
        (first as { metadata?: { raw?: unknown } })?.metadata?.raw;
      const raw = typeof rawCandidate === "string" && rawCandidate.trim() ? rawCandidate.trim().slice(0, 500) : undefined;
      return {
        message: err.message,
        ...(code !== undefined ? { code } : {}),
        ...(typeof errorType === "string" ? { errorType } : {}),
        ...(raw ? { raw } : {}),
      };
    }
    return { message: bodyText.slice(0, 300) };
  } catch {
    return { message: bodyText.slice(0, 300) };
  }
}

/** Retryable incomplete-stream error for truncated SSE (Q-23). */
export function incompleteStreamError(provider: string, modelId: string): Error {
  const err = toConciseProviderError(
    Object.assign(new Error("Stream ended without terminal event"), {
      statusCode: 502,
      transient: true,
      retryable: true,
      url: provider,
    }),
    provider,
    modelId
  );
  (err as any).code = "incomplete_stream";
  return err;
}

/** Per-request timeout ms from provider options (Q-22). */
export function timeoutFor(options: { timeoutMs?: number } | undefined): number | undefined {
  const t = (options as { timeoutMs?: unknown } | undefined)?.timeoutMs;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.floor(t) : undefined;
}

/** Merges a parent signal with a timeout into one effective signal. Caller must call cleanup when the request settles so the timer never holds the loop open. */
export function combinedSignal(signal?: AbortSignal, timeoutMs?: number): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (timeoutMs === undefined) return { signal, cleanup: () => {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    try { ctrl.abort(); } catch {}
  }, timeoutMs);
  try { (timer as unknown as { unref?: () => void }).unref?.(); } catch {}
  const cleanup = () => {
    try { clearTimeout(timer); } catch {}
  };
  if (signal) {
    if (signal.aborted) {
      cleanup();
      ctrl.abort();
    } else {
      signal.addEventListener("abort", () => {
        cleanup();
        try { ctrl.abort(); } catch {}
      }, { once: true });
    }
  }
  return { signal: ctrl.signal, cleanup };
}

/** Q-34: crypto-backed tool-call id, no Math.random primary. */
export function newToolCallId(prefix = "call"): string {
  try {
    const c = (globalThis as any)?.crypto;
    if (c?.randomUUID) return `${prefix}_${c.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  } catch {}
  try {
    const nc: any = (globalThis as any)?.process?.getBuiltinModule?.("node:crypto") ?? null;
    if (nc?.randomUUID) return `${prefix}_${nc.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  } catch {}
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * True when custom headers already carry auth (proxy/Copilot flows).
 * Case-insensitive, non-empty `Authorization` or `cf-aig-authorization`.
 * Callers return `"unused"` instead of throwing missing-key.
 */
export function hasAuthHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if ((lower === "authorization" || lower === "cf-aig-authorization") && typeof v === "string" && v.trim().length > 0) {
      return true;
    }
  }
  return false;
}

/** True for truncated streamed tool args (`{ raw }` marker from `parseStreamedToolArguments`). */
export function hasTruncatedToolArguments(args: unknown): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const keys = Object.keys(args as Record<string, unknown>);
  return keys.length === 1 && keys[0] === "raw" && typeof (args as Record<string, unknown>).raw === "string";
}

/** Short hash for tool-ID clamping (FNV-1a, 8 hex chars, no deps). */
export function shortHashId(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Clamps a tool-call ID to the 40-char OpenAI limit (pi `api/openai-completions.ts:1194`).
 * Pipe IDs (`callId|itemId`) become `callId_itemHash`; overlong IDs truncate
 * with hash suffix. Plain IDs pass through (truncated if needed).
 */
export function clampToolCallId(id: string): string {
  const clean = String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!clean.includes("|")) {
    return clean.length > 40 ? clean.slice(0, 40) : clean || "call_unknown";
  }
  const sep = clean.indexOf("|");
  const callId = clean.slice(0, sep).replace(/_+$/, "") || "call";
  const itemId = clean.slice(sep + 1).replace(/_+$/, "");
  const combined = itemId ? `${callId}_${itemId}` : callId;
  if (combined.length <= 40) return combined;
  const hash = shortHashId(id).slice(0, 8);
  const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
  return `${prefix}_${hash}`;
}
