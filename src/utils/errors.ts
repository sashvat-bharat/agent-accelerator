import type { ProviderContext } from "../types/message.ts";
import { getModelFromCatalog } from "../models/catalog.ts";

const CONCISE = "__agentAccelConcise";

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

function readUrl(error: any): string {
  const raw =
    (typeof error?.url === "string" && error.url) ||
    (typeof error?.request?.url === "string" && error.request.url) ||
    "";
  return raw.split("?")[0];
}

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

function displayModel(providerId: string, modelId: string): string {
  if (modelId.toLowerCase().startsWith(`${providerId.toLowerCase()}/`)) return modelId;
  return `${providerId}/${modelId}`;
}

/**
 * Collapses a raw provider error (which carries the full request/response
 * dump as enumerable props) into a one-line actionable error. Raw details stay
 * available but non-enumerable, so runtime dumps stay small.
 */
export function toConciseProviderError(error: unknown, providerId: string, modelId: string): Error {
  if (error instanceof Error && (error as any)[CONCISE]) return error;
  const err = error as any;
  const status = readStatus(err);
  const url = readUrl(err);
  const detail = readProviderMessage(err);
  const concise = new Error(
    `[${displayModel(providerId, modelId)}] request failed${status ? ` (${status})` : ""}: ${detail}`
  );
  concise.name = "AgentAccelProviderError";
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
    ...(typeof err?.errorType === "string"
      ? { errorType: { value: err.errorType, enumerable: false } }
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
 * lacks a requested input modality (image/audio/video/document). Unknown
 * models (custom providers, dynamic routers) are skipped: the provider
 * verdict stands and surfaces via toConciseProviderError instead.
 */
export function assertModalitiesSupported(
  context: ProviderContext,
  providerId: string,
  modelId: string
): void {
  const needed = new Set<string>();
  for (const msg of context.messages) {
    if (!Array.isArray((msg as any)?.content)) continue;
    for (const part of (msg as any).content) {
      const mapped = PART_TO_MODALITY[(part as any)?.type];
      if (mapped) needed.add(mapped);
    }
  }
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
  const docHint = missing.includes("pdf")
    ? " Documents can be converted client-side with the convert_document_to_markdown tool (bun add @firecrawl/anydoc) or Agent bypassInputFileModality: true."
    : "";
  const err = new Error(
    `[${displayModel(providerId, modelId)}] unsupported ${missing.join("+")} input (supports: ${supported.join(", ") || "text"}). Use a capable model or drop the ${missing.join("+")} part.${docHint}`
  );
  err.name = "AgentAccelProviderError";
  Object.defineProperties(err, {
    [CONCISE]: { value: true, enumerable: false },
    provider: { value: providerId, enumerable: false },
    model: { value: modelId, enumerable: false },
  });
  throw err;
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
 * Completions carries `video_url` natively (no guard there).
 */
export function assertNoVideoPartsOnResponses(
  context: ProviderContext,
  providerId: string,
  modelId: string
): void {
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
  const err = new Error(
    `[${displayModel(providerId, modelId)}] unsupported video input (the Responses API accepts text/image/file only; supports: ${supported}). Use a video-capable model (e.g. google/gemini-*) or drop the video part.`
  );
  err.name = "AgentAccelProviderError";
  Object.defineProperties(err, {
    [CONCISE]: { value: true, enumerable: false },
    provider: { value: providerId, enumerable: false },
    model: { value: modelId, enumerable: false },
  });
  throw err;
}
