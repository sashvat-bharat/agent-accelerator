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

// HTTP status from the shapes provider errors carry, else undefined; in: toConciseProviderError, out: a status.
function readStatus(error: any): number | undefined {
  const s =
    error?.statusCode ??
    error?.status ??
    error?.response?.status ??
    error?.lastError?.statusCode ??
    error?.lastError?.status;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// The request URL of an error without its query string; in: toConciseProviderError, out: a string.
function readUrl(error: any): string {
  const raw =
    (typeof error?.url === "string" && error.url) ||
    (typeof error?.request?.url === "string" && error.request.url) ||
    "";
  return raw.split("?")[0];
}

// The provider's own message from the error's data, body or message; in: toConciseProviderError, out: one trimmed line.
function readProviderMessage(error: any): string {
  const data = error?.data;
  if (typeof data?.error?.message === "string" && data.error.message.trim()) return data.error.message.trim();
  if (typeof data?.error === "string" && data.error.trim()) return data.error.trim();
  if (typeof data?.message === "string" && data.message.trim()) return data.message.trim();
  const body = error?.responseBody;
  if (typeof body === "string" && body.trim()) {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.error?.message === "string" && parsed.error.message.trim()) return parsed.error.message.trim();
      if (typeof parsed?.message === "string" && parsed.message.trim()) return parsed.message.trim();
    } catch {}
    if (body.length <= 300) return body.trim();
  }
  return String(error?.message ?? error).slice(0, 300);
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
  if (error instanceof AgentAccelError || (error instanceof Error && (error as any)[CONCISE])) return error;
  const err = error as any;
  const status = readStatus(err);
  const url = readUrl(err);
  let detail = readProviderMessage(err);
  // Append OpenRouter-style raw metadata once (pi api/openai-completions.ts:719
  // rule): normalize already stringifies error.error, so only append raw when
  // absent to avoid double-printing.
  const rawMeta =
    (typeof err?.raw === "string" && err.raw.trim() ? err.raw.trim() : undefined) ??
    (typeof err?.error?.metadata?.raw === "string" && err.error.metadata.raw.trim()
      ? err.error.metadata.raw.trim()
      : undefined);
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
      value: typeof err?.responseBody === "string" ? err.responseBody.slice(0, 500) : undefined,
      enumerable: false,
    },
    // Forwarded when present (e.g. OpenRouter's canonical `error_type`,
    // which disambiguates lossy native codes). Survives re-wraps so retry
    // helpers never strip it.
    ...(typeof err?.errorType === "string" ? { errorType: { value: err.errorType, enumerable: false } } : {}),
    // The provider's own error code (e.g. Google's `not_found` chain-eviction code, which carries no HTTP status on
    // SSE error frames); `code` itself is the SDK kind (`"provider"`). Survives re-wraps so chain detectors never lose it.
    ...((typeof err?.code === "string" || typeof err?.code === "number") && err.code !== ""
      ? { providerCode: { value: err.code, enumerable: false } }
      : {}),
    // Server rate-limit hint in ms (from Retry-After); survives re-wraps so
    // `withRetries` can honor it instead of hammering a 429.
    ...(typeof err?.retryAfterMs === "number" && Number.isFinite(err.retryAfterMs)
      ? { retryAfterMs: { value: err.retryAfterMs, enumerable: false } }
      : {}),
    ...(typeof (err as { raw?: unknown })?.raw === "string"
      ? { raw: { value: (err as { raw: string }).raw.slice(0, 500), enumerable: false } }
      : {}),
  });
  return concise;
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
    if (!Array.isArray((msg as any)?.content)) continue;
    for (const part of (msg as any).content) {
      const mapped = PART_TO_MODALITY[(part as any)?.type];
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
 * (`Failed to parse the file ... Provide a PDF document`, observed live on
 * `openrouter/stealth/space-bunny-alpha` under the old Responses skin despite
 * its catalog `video` flag, which is chat-transport oriented). Fail fast with
 * a clear one-liner instead; video stays Gemini-only, and OpenRouter Chat
 * Completions carries `video_url` natively (no guard there). Throws a `ValidationError`.
 */
export function assertNoVideoPartsOnResponses(context: ProviderContext, providerId: string, modelId: string): void {
  let hasVideo = false;
  for (const msg of context.messages) {
    if (!Array.isArray((msg as any)?.content)) continue;
    for (const part of (msg as any).content) {
      if ((part as any)?.type === "video") {
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
  } catch {}
  throw new ValidationError(
    `[${displayModel(providerId, modelId)}] unsupported video input (the Responses API accepts text/image/file only; supports: ${supported}). Use a video-capable model (e.g. google/gemini-*) or drop the video part.`,
    { provider: providerId, model: modelId }
  );
}
