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
 * Collapses a Vercel `APICallError` (which carries the full request/response
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
  const err = new Error(
    `[${displayModel(providerId, modelId)}] unsupported ${missing.join("+")} input (supports: ${supported.join(", ") || "text"}). Use a capable model or drop the ${missing.join("+")} part.`
  );
  err.name = "AgentAccelProviderError";
  Object.defineProperties(err, {
    [CONCISE]: { value: true, enumerable: false },
    provider: { value: providerId, enumerable: false },
    model: { value: modelId, enumerable: false },
  });
  throw err;
}
