/**
 * OpenRouter embeddings (`POST {baseUrl}/embeddings`), for every embedding model OpenRouter lists. The request is a list of
 * inputs, one per item: a plain string when every item is one piece of text (the form every model takes), else
 * `{ content: [parts] }` per item (text, `image_url`, `input_audio`, `input_video`, `input_file`), where the parts of one item are
 * embedded together into ONE vector. The request arrives already checked (`embedding/request.ts`), so this file only maps it to the
 * wire (`dimensions` and `input_type` as asked: OpenRouter's list does not say which model takes them, so the provider decides),
 * adds the developer's provider routing and `user` from the `openrouter` setting, and reads the reply. OpenRouter reports `usage.cost`
 * in USD, which the SDK takes as the price (an explicit 0, a free model, counts). Vectors are asked as floats; `base64` is never used.
 */
import type { ProviderRequestOptions } from "../types/model.ts";
import { beforeFirst } from "../utils/text.ts";
import { BULK_REPLY_LIMIT, readTextCapped } from "../utils/body.ts";
import type { EmbeddingPartData, ProviderEmbeddingRequest, ProviderEmbeddingResult } from "../types/embedding.ts";
import type { TokenUsage } from "../types/core.ts";
import { openRouterSetting } from "../config/settings.ts";
import { buildSessionHeaders, setHeaderCaseInsensitive } from "../utils/headers.ts";
import { toConciseProviderError } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { ConfigError } from "../types/errors.ts";
import { emitProviderWarning, mapEmbeddingTaskToOpenRouterInputType } from "../providers.ts";
import {
  OPENROUTER_ROUTING_KEYS,
  combinedSignal,
  headersToRecord,
  redactedHeaders,
  resolveProviderApiKey,
  resolveProviderBaseUrl,
  retryOptionsFrom,
  timeoutFor,
} from "./shared.ts";
import { throwOpenRouterHttpError } from "./openrouter-image.ts";

/** `MultimodalMedia.format` for the common MIME subtypes that differ from it. */
const FORMAT_ALIASES: Record<string, string> = { mpeg: "mp3", "x-wav": "wav", wave: "wav", quicktime: "mov" };

interface EmbeddingsReply {
  id?: string;
  data?: Array<{ embedding?: number[] | string; index?: number }>;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
    cost?: number;
    prompt_tokens_details?: {
      text_tokens?: number;
      image_tokens?: number;
      audio_tokens?: number;
      video_tokens?: number;
      file_tokens?: number;
    };
  };
}

// One part of an item as an OpenRouter content part; media goes inline as a data URL; in: buildBody, out: the wire part.
function toContentPart(p: EmbeddingPartData): Record<string, unknown> {
  if (p.kind === "text") return { type: "text", text: p.text };
  if (p.kind === "image") return { type: "image_url", image_url: { url: p.media.dataUrl } };
  const subtype = beforeFirst(p.media.mimeType, ";").split("/")[1] ?? "";
  const media = { data: p.media.dataUrl, format: p.kind === "pdf" ? "pdf" : (FORMAT_ALIASES[subtype] ?? subtype) };
  return p.kind === "audio"
    ? { type: "input_audio", input_audio: media }
    : p.kind === "video"
      ? { type: "input_video", input_video: media }
      : { type: "input_file", input_file: media };
}

// Usage as TokenUsage: the prompt tokens with the per-kind split when OpenRouter gives one (a split that counts file tokens is left out: the table has no document rate), and its USD `cost` (0 counts); in: a reply, out: TokenUsage.
function mapUsage(raw: EmbeddingsReply["usage"]): TokenUsage {
  const input = raw?.prompt_tokens ?? 0;
  const usage: TokenUsage = { inputTokens: input, outputTokens: 0, totalTokens: raw?.total_tokens ?? input };
  const d = raw?.prompt_tokens_details;
  if (d && !(d.file_tokens && d.file_tokens > 0)) {
    const kept = Object.fromEntries(
      Object.entries({
        textTokens: d.text_tokens,
        imageTokens: d.image_tokens,
        audioTokens: d.audio_tokens,
        videoTokens: d.video_tokens,
      }).filter(([, v]) => typeof v === "number")
    );
    if (Object.keys(kept).length > 0) usage.inputDetails = kept;
  }
  if (typeof raw?.cost === "number" && raw.cost >= 0) usage.cost = { totalCost: raw.cost };
  return usage;
}

/** Makes one vector per item with an embedding model through OpenRouter, in one `/embeddings` request. */
export async function openrouterEmbed(
  modelId: string,
  request: ProviderEmbeddingRequest,
  options?: ProviderRequestOptions
): Promise<ProviderEmbeddingResult> {
  const started = Date.now();
  const apiKey = resolveProviderApiKey("openrouter", options);
  if (!apiKey)
    throw new ConfigError("[Agent Accelerator] Missing OpenRouter API key. Set OPENROUTER_API_KEY or pass apiKey.");
  const url = `${resolveProviderBaseUrl("openrouter", options)}/embeddings`;

  // Provider routing and `user` come from the developer's `openrouter` setting, exactly as for chat and images.
  const setting = openRouterSetting();
  const routing: Record<string, unknown> = {};
  for (const key of OPENROUTER_ROUTING_KEYS) if (setting[key] !== undefined) routing[key] = setting[key];
  let inputType: string | undefined;
  if (request.task) {
    const mapped = mapEmbeddingTaskToOpenRouterInputType(request.task);
    inputType = mapped.inputType;
    if (mapped.note)
      emitProviderWarning({
        provider: "openrouter",
        capability: "embedding task",
        requested: `${request.task} (openrouter/${modelId})`,
        reason: `${mapped.note}.`,
        fallback: inputType ? `input_type ${inputType}` : "the model's default (the option is not sent)",
      });
  }
  const plain = request.items.every((item) => item.length === 1 && item[0]!.kind === "text");
  const body: Record<string, unknown> = {
    model: modelId,
    input: plain
      ? request.items.map((item) => (item[0] as { text: string }).text)
      : request.items.map((item) => ({ content: item.map(toContentPart) })),
    ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
    ...(inputType ? { input_type: inputType } : {}),
    ...(Object.keys(routing).length > 0 ? { provider: routing } : {}),
    ...(typeof setting["user"] === "string" ? { user: setting["user"] } : {}),
  };
  const headers = buildSessionHeaders("openrouter", options?.headers, undefined);
  setHeaderCaseInsensitive(headers, "Content-Type", "application/json");
  if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "Authorization", `Bearer ${apiKey}`);
  const rawRequest = {
    url,
    method: "POST",
    headers: redactedHeaders({ ...headers, Authorization: "[REDACTED]" }),
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
    throwOpenRouterHttpError(res.status, url, text, modelId, responseHeaders, "embedding");
    let reply: EmbeddingsReply;
    try {
      reply = JSON.parse(text) as EmbeddingsReply;
    } catch {
      throw toConciseProviderError(
        Object.assign(new Error("Invalid JSON response from OpenRouter Embeddings API"), {
          statusCode: res.status,
          responseBody: text.slice(0, 500),
          url,
        }),
        "openrouter",
        modelId
      );
    }
    // The reply lists vectors with their position in the request; put them back in order (a `base64` string is not a vector and is left for the core to refuse).
    const ordered = [...(reply.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return {
      vectors: ordered.map((d) => (Array.isArray(d.embedding) ? d.embedding : [])),
      usage: mapUsage(reply.usage),
      ...(reply.id ? { responseId: reply.id } : {}),
      model: modelId,
      provider: "openrouter",
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
    label: { providerId: "openrouter", modelId },
  });
}
