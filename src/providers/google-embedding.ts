/**
 * Google embeddings (`POST {baseUrl}/models/{model}:batchEmbedContents`), for `gemini-embedding-2` and `gemini-embedding-001`.
 * One request per call, one `EmbedContentRequest` per item: separate requests give separate vectors on both models (a single
 * `content` with several parts would be combined into ONE vector, which is what `{ parts }` items ask for and nothing else). At
 * most 100 requests fit in one batch, which the model table states as the request size. The request arrives already checked
 * (`embedding/request.ts`), so this file only maps it to the wire: the task becomes a `taskType` field on `gemini-embedding-001`
 * and words in front of the text on `gemini-embedding-2` (which has no task field), `dimensions` becomes `outputDimensionality`,
 * media travels inline as base64. `gemini-embedding-001` reports no usage, so its cost stays unknown.
 */
import type { ProviderRequestOptions } from "../types/model.ts";
import { BULK_REPLY_LIMIT, readTextCapped } from "../utils/body.ts";
import type { EmbeddingPartData, ProviderEmbeddingRequest, ProviderEmbeddingResult } from "../types/embedding.ts";
import type { TokenUsage } from "../types/core.ts";
import { getEmbeddingModel } from "../models/embedding-models.ts";
import { setHeaderCaseInsensitive } from "../utils/headers.ts";
import { toConciseProviderError } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { ConfigError, ValidationError } from "../types/errors.ts";
import { googleEmbeddingText, mapEmbeddingTaskToGoogleTaskType } from "../providers.ts";
import {
  combinedSignal,
  headersToRecord,
  modalityTokens,
  redactedHeaders,
  resolveProviderApiKey,
  resolveProviderBaseUrl,
  retryOptionsFrom,
  timeoutFor,
} from "./shared.ts";
import { throwGoogleHttpError } from "./google-image.ts";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** What `gemini-embedding-2` reads, by kind (docs: embeddings, "Supported modalities and limits"). */
const MEDIA_MIME: Record<"image" | "audio" | "video" | "pdf", readonly string[]> = {
  image: ["image/png", "image/jpeg"],
  audio: ["audio/mpeg", "audio/mp3", "audio/wav"],
  video: ["video/mp4", "video/quicktime"],
  pdf: ["application/pdf"],
};
const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
};

type WirePart = { text: string } | { inlineData: { mimeType: string; data: string } };
interface BatchReply {
  embeddings?: Array<{ values?: number[] }>;
  usageMetadata?: { promptTokenCount?: number; promptTokenDetails?: Array<{ modality?: string; tokenCount?: number }> };
}

// Usage as TokenUsage with the per-kind split the pricing reads; a reply that counts DOCUMENT tokens leaves the split out (the table has no document rate, so the cost stays unknown); in: a reply, out: TokenUsage.
function mapUsage(raw: BatchReply["usageMetadata"]): TokenUsage {
  const input = raw?.promptTokenCount ?? 0;
  const usage: TokenUsage = { inputTokens: input, outputTokens: 0, totalTokens: input };
  const details = raw?.promptTokenDetails;
  if (!details) return usage;
  const d = details.map((x) => ({ modality: x.modality, tokens: x.tokenCount }));
  if (modalityTokens(d, "DOCUMENT") !== undefined) return usage;
  const parts = {
    textTokens: modalityTokens(d, "TEXT"),
    imageTokens: modalityTokens(d, "IMAGE"),
    audioTokens: modalityTokens(d, "AUDIO"),
    videoTokens: modalityTokens(d, "VIDEO"),
  };
  const kept = Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== undefined));
  if (Object.keys(kept).length > 0) usage.inputDetails = kept;
  return usage;
}

// One item as the parts of a Google `content`: text (with the task words in front on `gemini-embedding-2`, text-only items only) and inline media of a type the model reads; in: buildBody, out: the wire parts.
function toWireParts(
  item: EmbeddingPartData[],
  prefixTask: boolean,
  request: ProviderEmbeddingRequest,
  modelId: string
): WirePart[] {
  const textOnly = item.every((p) => p.kind === "text");
  return item.map((p): WirePart => {
    if (p.kind === "text")
      return { text: prefixTask && textOnly ? googleEmbeddingText(request.task, request.title, p.text) : p.text };
    const mime = MIME_ALIASES[p.media.mimeType] ?? p.media.mimeType;
    if (!MEDIA_MIME[p.kind].includes(mime))
      throw new ValidationError(
        `[Agent Accelerator] [google/${modelId}] does not read ${p.kind} of type "${mime}" (supported: ${MEDIA_MIME[p.kind].join(", ")}). Convert the file or pass the correct mimeType.`,
        { provider: "google", model: modelId }
      );
    return { inlineData: { mimeType: mime, data: p.media.base64Data } };
  });
}

/** Makes one vector per item with a Google embedding model, in one `batchEmbedContents` request. */
export async function googleEmbed(
  modelId: string,
  request: ProviderEmbeddingRequest,
  options?: ProviderRequestOptions
): Promise<ProviderEmbeddingResult> {
  const started = Date.now();
  const apiKey = resolveProviderApiKey("google", options);
  if (!apiKey)
    throw new ConfigError(
      "[Agent Accelerator] Missing Google API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) or pass apiKey."
    );
  const style = getEmbeddingModel(`google/${modelId}`)?.task;
  const url = `${resolveProviderBaseUrl("google", DEFAULT_BASE_URL, options)}/models/${modelId}:batchEmbedContents`;
  const body = {
    requests: request.items.map((item) => ({
      model: `models/${modelId}`,
      content: { parts: toWireParts(item, style === "prefix", request, modelId) },
      ...(request.dimensions !== undefined ? { outputDimensionality: request.dimensions } : {}),
      ...(style === "taskType" && request.task ? { taskType: mapEmbeddingTaskToGoogleTaskType(request.task) } : {}),
      ...(style === "taskType" && request.title ? { title: request.title } : {}),
    })),
  };
  const headers: Record<string, string> = { "Content-Type": "application/json", ...options?.headers };
  if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "x-goog-api-key", apiKey);
  const rawRequest = {
    url,
    method: "POST",
    headers: redactedHeaders({ ...headers, "x-goog-api-key": "[REDACTED]" }),
    body,
  };

  const doCall = async (): Promise<ProviderEmbeddingResult> => {
    const { signal, cleanup } = combinedSignal(options?.signal, timeoutFor(options));
    let res: Response;
    let text: string;
    try {
      res = await (options?.fetch ?? fetch)(url, { method: "POST", headers, body: JSON.stringify(body), signal });
      text = await readTextCapped(res, BULK_REPLY_LIMIT);
    } finally {
      cleanup();
    }
    const responseHeaders = headersToRecord(res.headers);
    throwGoogleHttpError(res.status, url, text, modelId, responseHeaders);
    let reply: BatchReply;
    try {
      reply = JSON.parse(text) as BatchReply;
    } catch {
      throw toConciseProviderError(
        Object.assign(new Error("Invalid JSON response from the Google embeddings API"), {
          statusCode: res.status,
          responseBody: text.slice(0, 500),
          url,
        }),
        "google",
        modelId
      );
    }
    return {
      vectors: (reply.embeddings ?? []).map((e) => e.values ?? []),
      usage: mapUsage(reply.usageMetadata),
      model: modelId,
      provider: "google",
      raw: {
        request: rawRequest,
        response: { status: res.status, statusText: res.statusText, headers: responseHeaders, body: reply },
      },
      durationMs: Date.now() - started,
    };
  };

  return withRetries(doCall, {
    ...retryOptionsFrom(options),
    signal: options?.signal,
    label: { providerId: "google", modelId },
  });
}
