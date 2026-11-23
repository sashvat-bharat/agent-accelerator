import type { ProviderContext } from "../types/message.ts";
import { getModelFromCatalog } from "../models/catalog.ts";
import { AgentAccelError, ProviderError, ValidationError, isAbortError } from "../types/errors.ts";

/**
 * Checks whether a provider error is transient and safe to retry.
 * Structured-data only: status / code / transient flag. Never message text,
 * so a 400 mentioning "512 tokens" is not retried.
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  if (isAbortError(error)) return false;
  const err = error as Record<string, unknown>;
  // An adapter's explicit "never retry" (e.g. Anthropic's monthly spend-cap 429, also once wrapped as a ProviderError) beats the status rules below.
  if (err["transient"] === false || (err as { retryable?: unknown }).retryable === false) return false;
  if (err["transient"] === true) return true;
  if ((err as { retryable?: unknown }).retryable === true) return true;
  const status = Number(
    (err["status"] as number | undefined) ??
      (err["statusCode"] as number | undefined) ??
      ((err["response"] as Record<string, unknown> | undefined)?.["status"] as number | undefined) ??
      ((err["lastError"] as Record<string, unknown> | undefined)?.["status"] as number | undefined) ??
      NaN
  );
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = String(
    (err["providerCode"] as string | undefined) ?? (err["code"] as string | undefined) ?? ""
  ).toUpperCase();
  if (["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "EPIPE", "ETIMEDOUT"].includes(code)) {
    return true;
  }
  return false;
}

const CONCISE = "__agentAccelConcise";

// Reads a nested field of an unknown value (`dig(e, "response", "status")`), undefined when any step is missing; in: the error readers below, out: the value.
function dig(value: unknown, ...path: string[]): unknown {
  let cur = value;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// A non-blank string trimmed, else undefined; in: readProviderMessage, out: the text.
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// HTTP status from the shapes provider errors carry, else undefined; in: toConciseProviderError, out: a status.
function readStatus(error: unknown): number | undefined {
  const s =
    dig(error, "statusCode") ??
    dig(error, "status") ??
    dig(error, "response", "status") ??
    dig(error, "lastError", "statusCode") ??
    dig(error, "lastError", "status");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// The request URL of an error without its query string; in: toConciseProviderError, out: a string.
function readUrl(error: unknown): string {
  const direct = dig(error, "url");
  const nested = dig(error, "request", "url");
  const raw = (typeof direct === "string" && direct) || (typeof nested === "string" && nested) || "";
  return raw.split("?")[0] ?? "";
}

// The provider's own message from the error's data, body or message; in: toConciseProviderError, out: one trimmed line.
function readProviderMessage(error: unknown): string {
  const fromData =
    text(dig(error, "data", "error", "message")) ??
    text(dig(error, "data", "error")) ??
    text(dig(error, "data", "message"));
  if (fromData) return fromData;
  const body = dig(error, "responseBody");
  if (typeof body === "string" && body.trim()) {
    try {
      const parsed: unknown = JSON.parse(body);
      const fromBody = text(dig(parsed, "error", "message")) ?? text(dig(parsed, "message"));
      if (fromBody) return fromBody;
    } catch {
      // why: the body is not JSON, so the raw text is used instead.
    }
    if (body.length <= 300) return body.trim();
  }
  return String(dig(error, "message") ?? error).slice(0, 300);
}

// `provider/model` without doubling an existing prefix; in: the error messages, out: a label.
function displayModel(providerId: string, modelId: string): string {
  if (modelId.toLowerCase().startsWith(`${providerId.toLowerCase()}/`)) return modelId;
  return `${providerId}/${modelId}`;
}

/**
 * Collapses a raw provider error (which carries the full request/response dump as enumerable props) into a one-line
 * `ProviderError` with `retryable` set from its status/code; the provider's own error code is `providerCode`. Raw
 * details stay available but non-enumerable, so runtime dumps stay small. An SDK error (already typed) passes through.
 */
export function toConciseProviderError(error: unknown, providerId: string, modelId: string): Error {
  if (error instanceof AgentAccelError || (error instanceof Error && dig(error, CONCISE))) return error;
  const err = error;
  const status = readStatus(err);
  const url = readUrl(err);
  let detail = readProviderMessage(err);
  // Append OpenRouter-style raw metadata once (pi api/openai-completions.ts:719
  // rule): normalize already stringifies error.error, so only append raw when
  // absent to avoid double-printing.
  const rawMeta = text(dig(err, "raw")) ?? text(dig(err, "error", "metadata", "raw"));
  if (rawMeta && !detail.includes(rawMeta.slice(0, 80))) {
    detail = `${detail}\n${rawMeta.slice(0, 500)}`.slice(0, 800);
  }
  const concise = new ProviderError(
    `[${displayModel(providerId, modelId)}] request failed${status ? ` (${status})` : ""}: ${detail}`,
    { status, provider: providerId, model: modelId, retryable: isTransientError(err) }
  );
  Object.defineProperties(concise, {
    [CONCISE]: { value: true, enumerable: false },
    statusCode: { value: status, enumerable: false },
    provider: { value: providerId, enumerable: false },
    model: { value: modelId, enumerable: false },
    url: { value: url, enumerable: false },
    responseBody: {
      value:
        typeof dig(err, "responseBody") === "string" ? (dig(err, "responseBody") as string).slice(0, 500) : undefined,
      enumerable: false,
    },
    // Forwarded when present (e.g. OpenRouter's canonical `error_type`,
    // which disambiguates lossy native codes). Survives re-wraps so retry
    // helpers never strip it.
    ...(typeof dig(err, "errorType") === "string"
      ? { errorType: { value: dig(err, "errorType"), enumerable: false } }
      : {}),
    // The provider's own error code (e.g. Google's `not_found` chain-eviction code, which carries no HTTP status on
    // SSE error frames); `code` itself is the SDK kind (`"provider"`). Survives re-wraps so chain detectors never lose it.
    ...((typeof dig(err, "code") === "string" || typeof dig(err, "code") === "number") && dig(err, "code") !== ""
      ? { providerCode: { value: dig(err, "code"), enumerable: false } }
      : {}),
    // Server rate-limit hint in ms (from Retry-After); survives re-wraps so
    // `withRetries` can honor it instead of hammering a 429.
    ...(typeof dig(err, "retryAfterMs") === "number" && Number.isFinite(dig(err, "retryAfterMs"))
      ? { retryAfterMs: { value: dig(err, "retryAfterMs"), enumerable: false } }
      : {}),
    ...(typeof dig(err, "raw") === "string"
      ? { raw: { value: (dig(err, "raw") as string).slice(0, 500), enumerable: false } }
      : {}),
  });
  return concise;
}

/** Marks an error as worth retrying: the retry layers read its `retryable` and `transient` flags. */
export function markRetryable(error: Error): void {
  Reflect.set(error, "retryable", true);
  Reflect.set(error, "transient", true);
}

const PART_TO_MODALITY: Record<string, "image" | "audio" | "video" | "pdf"> = {
  image: "image",
  audio: "audio",
  video: "video",
  file: "pdf",
};

/**
 * Fails fast — before any network call — when the catalog knows the model
 * lacks a requested input modality (image/audio/video/document; files are
 * not checked on OpenRouter, which parses them for any model). Unknown
 * models (custom providers, dynamic routers) are skipped: the provider
 * verdict stands and surfaces via toConciseProviderError instead. Throws a `ValidationError`.
 */
export function assertModalitiesSupported(context: ProviderContext, providerId: string, modelId: string): void {
  const needed = new Set<string>();
  for (const msg of context.messages) {
    const content: unknown = dig(msg, "content");
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const mapped = PART_TO_MODALITY[String(dig(part, "type"))];
      if (mapped) needed.add(mapped);
    }
  }
  // OpenRouter reads a file with the model's native support or its own parser, so the catalog's "pdf" flag never gates a file there.
  if (providerId === "openrouter") needed.delete("pdf");
  if (needed.size === 0) return;
  let supported: readonly string[] | undefined;
  try {
    supported = getModelFromCatalog(providerId, modelId)?.modalities?.input;
  } catch {
    return;
  }
  if (!supported) return;
  const missing = [...needed].filter((k) => !supported.includes(k));
  if (missing.length === 0) return;
  throw new ValidationError(
    `[${displayModel(providerId, modelId)}] unsupported ${missing.join("+")} input (supports: ${supported.join(", ") || "text"}). Use a capable model or drop the ${missing.join("+")} part.`,
    { provider: providerId, model: modelId }
  );
}

/**
 * Rejects `video` parts on the OpenAI Responses transport.
 *
 * That wire has no video shape — only `input_text`/`input_image`/`input_file`
 * exist in either vendor's Responses docs — so a video part sent as
 * `input_file` lands in the router's document parser and 400s confusingly
 * (`Failed to parse the file ... Provide a PDF document`, observed live under
 * the old OpenRouter Responses skin despite the catalog `video` flag, which is
 * chat-transport oriented). Fail fast with
 * a clear one-liner instead; video stays Gemini-only, and OpenRouter Chat
 * Completions carries `video_url` natively (no guard there). Throws a `ValidationError`.
 */
export function assertNoVideoPartsOnResponses(context: ProviderContext, providerId: string, modelId: string): void {
  let hasVideo = false;
  for (const msg of context.messages) {
    const content: unknown = dig(msg, "content");
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (dig(part, "type") === "video") {
        hasVideo = true;
        break;
      }
    }
    if (hasVideo) break;
  }
  if (!hasVideo) return;
  let supported = "text, image";
  try {
    const known = getModelFromCatalog(providerId, modelId)?.modalities?.input;
    // List transport-usable modalities only: `video` is excluded even when
    // the catalog flags it, since this error exists precisely because the
    // Responses wire cannot carry it (listing it as "supported" would
    // contradict the rejection).
    if (known && known.length > 0) supported = known.filter((m) => m !== "video").join(", ") || "text";
  } catch {
    // why: a catalog problem makes the model "unknown", and this call goes ahead.
  }
  throw new ValidationError(
    `[${displayModel(providerId, modelId)}] unsupported video input (the Responses API accepts text/image/file only; supports: ${supported}). Use a video-capable model (e.g. google/gemini-*) or drop the video part.`,
    { provider: providerId, model: modelId }
  );
}
