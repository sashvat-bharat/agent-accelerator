/**
 * OpenRouter decisions (`POST https://openrouter.ai/api/alpha/decisions`, an alpha endpoint), for every decision model OpenRouter
 * lists. The shared question shape is OpenRouter's own, so `questions` goes as given (a map by name of `{ type, instructions,
 * criteria }`). `state` is a plain string when the input is one piece of text, else a list: text as strings, and media as `image_url`
 * (a data URL, with `detail`), `input_audio` (raw base64 and its format), `video_url` (a data URL) and `file` (a PDF as a data URL).
 * The request arrives already checked (`decision/request.ts`), so this file only maps it to the wire, adds the developer's provider
 * routing and `user` from the `openrouter` setting, and reads the reply. The reply's `answers` map is handed back as it is (the core
 * checks it); OpenRouter reports `usage.cost`, which the SDK takes as the price (an explicit 0, a free model, counts). The endpoint
 * is documented as alpha ("the shape may change"). A model that does not read a kind of media answers 400, and routing may then try
 * another endpoint of the same model.
 */
import type { ProviderRequestOptions } from "../types/model.ts";
import { beforeFirst } from "../utils/text.ts";
import { BULK_REPLY_LIMIT, readTextCapped } from "../utils/body.ts";
import type { ProviderDecisionRequest, ProviderDecisionResult } from "../types/decision.ts";
import type { InputPartData } from "../utils/provider-call.ts";
import type { TokenUsage } from "../types/core.ts";
import { openRouterSetting } from "../config/settings.ts";
import { buildSessionHeaders, setHeaderCaseInsensitive } from "../utils/headers.ts";
import { toConciseProviderError } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { ConfigError } from "../types/errors.ts";
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

/** `input_audio.format` for the MIME subtypes that are spelled differently. */
const AUDIO_FORMAT: Record<string, string> = { mpeg: "mp3", "x-wav": "wav", wave: "wav", mp4: "m4a" };
/** `ImagePart.resolution` as OpenRouter's `image_url.detail` (auto, low, high). */
const IMAGE_DETAIL = { low: "low", medium: "auto", high: "high", ultra_high: "high" } as const;

interface DecisionReply {
  id?: string;
  answers?: ProviderDecisionResult["answers"];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

// The alpha endpoint next to the chat API (`.../api/v1` becomes `.../api/alpha/decisions`), also for a proxy or `base_urls.openrouter`; in: openrouterDecide, out: the URL.
function decisionsUrl(options?: ProviderRequestOptions): string {
  return `${resolveProviderBaseUrl("openrouter", options).replace(/\/v1$/, "")}/alpha/decisions`;
}

// One part as OpenRouter takes it in `state`: text as a string, media as its own part shape; in: buildState, out: the item.
function toItem(part: InputPartData): string | Record<string, unknown> {
  if (part.kind === "text") return part.text;
  if (part.kind === "image")
    return {
      type: "image_url",
      image_url: { url: part.media.dataUrl, ...(part.resolution ? { detail: IMAGE_DETAIL[part.resolution] } : {}) },
    };
  if (part.kind === "audio") {
    const subtype = beforeFirst(part.media.mimeType, ";").split("/")[1] ?? "";
    return {
      type: "input_audio",
      input_audio: { data: part.media.base64Data, format: AUDIO_FORMAT[subtype] ?? subtype },
    };
  }
  if (part.kind === "video") return { type: "video_url", video_url: { url: part.media.dataUrl } };
  return { type: "file", file: { file_data: part.media.dataUrl } };
}

// Usage as TokenUsage: the input and output tokens, the cached input, and OpenRouter's reported cost (0 counts); in: a reply, out: TokenUsage.
function mapUsage(raw: DecisionReply["usage"]): TokenUsage {
  const input = raw?.input_tokens ?? 0;
  const output = raw?.output_tokens ?? 0;
  const cached = Math.min(raw?.input_tokens_details?.cached_tokens ?? 0, input);
  const usage: TokenUsage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cachedTokens: cached,
    cacheReadTokens: cached,
  };
  if (typeof raw?.cost === "number" && raw.cost >= 0) usage.cost = { totalCost: raw.cost };
  return usage;
}

/** Answers the questions of a decision request with a decision model through OpenRouter, in one `/decisions` request. */
export async function openrouterDecide(
  modelId: string,
  request: ProviderDecisionRequest,
  options?: ProviderRequestOptions
): Promise<ProviderDecisionResult> {
  const started = Date.now();
  const apiKey = resolveProviderApiKey("openrouter", options);
  if (!apiKey)
    throw new ConfigError("[Agent Accelerator] Missing OpenRouter API key. Set OPENROUTER_API_KEY or pass apiKey.");
  const url = decisionsUrl(options);

  // Provider routing and `user` come from the developer's `openrouter` setting, exactly as for chat, images and embeddings.
  const setting = openRouterSetting();
  const routing: Record<string, unknown> = {};
  for (const key of OPENROUTER_ROUTING_KEYS) if (setting[key] !== undefined) routing[key] = setting[key];
  const only = request.input.length === 1 ? request.input[0] : undefined;
  const body: Record<string, unknown> = {
    model: modelId,
    state: only?.kind === "text" ? only.text : request.input.map(toItem),
    questions: request.questions,
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

  const doCall = async (): Promise<ProviderDecisionResult> => {
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
    throwOpenRouterHttpError(res.status, url, text, modelId, responseHeaders, "decision");
    let reply: DecisionReply;
    try {
      reply = JSON.parse(text) as DecisionReply;
    } catch {
      throw toConciseProviderError(
        Object.assign(new Error("Invalid JSON response from the OpenRouter decisions API"), {
          statusCode: res.status,
          responseBody: text.slice(0, 500),
          url,
        }),
        "openrouter",
        modelId
      );
    }
    return {
      answers: reply.answers ?? {},
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
