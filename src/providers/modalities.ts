// Pre-flight checks of a request's input parts against the model's catalog modalities. They run before any network call,
// in the adapters, so `utils/` never has to import the catalog.
import type { ProviderContext } from "../types/message.ts";
import { getModelFromCatalog } from "../models/catalog.ts";
import { ValidationError } from "../types/errors.ts";
import { dig, displayModel } from "../utils/errors.ts";

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
      const kind = String(dig(part, "type"));
      const mapped = Object.hasOwn(PART_TO_MODALITY, kind) ? PART_TO_MODALITY[kind] : undefined; // "constructor" is not a part type
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
