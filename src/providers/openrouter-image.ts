/**
 * OpenRouter image generation (`POST {baseUrl}/images`, OpenRouter's Image API), for the OpenAI image models it routes
 * (`openai/gpt-image-2.5-*` and `2.6-*`). JSON in, base64 pictures out. The request arrives already checked against the
 * model's table entry (`image/request.ts`): this file only maps it to the wire (`aspect_ratio`, `quality`, `output_format`,
 * `background`, `n`, reference images as `input_references`), adds the developer's provider routing from the `openrouter`
 * setting, and reads the reply. OpenRouter reports `usage` with a USD `cost`, which the SDK takes as the price. Streaming,
 * seed and markup are never sent. A failed generation is a 502 with no charge and is retried like any 5xx.
 */
import type { ProviderRequestOptions } from "../types/model.ts";
import type { ProviderImageRequest, ProviderImageResult } from "../types/image.ts";
import type { TokenUsage } from "../types/core.ts";
import { openRouterSetting } from "../config/settings.ts";
import { base64ToBytes } from "../utils/base64.ts";
import { sniffMimeType } from "../utils/media.ts";
import { buildSessionHeaders, setHeaderCaseInsensitive } from "../utils/headers.ts";
import { toConciseProviderError } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { ConfigError } from "../types/errors.ts";
import {
  OPENROUTER_ROUTING_KEYS,
  combinedSignal,
  headersToRecord,
  parseRetryAfterMs,
  readErrorPayload,
  redactedHeaders,
  resolveProviderApiKey,
  resolveProviderBaseUrl,
  retryOptionsFrom,
  timeoutFor,
} from "./shared.ts";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const FORMAT_MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

interface ImagesReply {
  data?: Array<{ b64_json?: string; media_type?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
}

// Usage as TokenUsage; OpenRouter's USD `cost` (0 counts) is the price when it sends one; in: a reply, out: TokenUsage.
function mapUsage(raw: ImagesReply["usage"]): TokenUsage {
  const input = raw?.prompt_tokens ?? 0;
  const output = raw?.completion_tokens ?? 0;
  const usage: TokenUsage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: raw?.total_tokens ?? input + output,
  };
  if (typeof raw?.cost === "number" && raw.cost >= 0) usage.cost = { totalCost: raw.cost };
  return usage;
}

// Throws a concise provider error for a non-2xx reply: status, OpenRouter's code, Retry-After, a key hint on 401 and a credits hint on 402; in: generateImage, out: nothing or a thrown error.
function throwIfError(
  status: number,
  url: string,
  bodyText: string,
  modelId: string,
  headers: Record<string, string>
): void {
  if (status >= 200 && status < 300) return;
  const { message, code, errorType, raw } = readErrorPayload(bodyText);
  const hint =
    status === 401
      ? " Check OPENROUTER_API_KEY (no quotes/spaces, correct provider) and that the key is loaded (bun --env-file=.env.local)."
      : status === 402
        ? " OpenRouter says the account has too little credit for this image."
        : "";
  const full = `${message}${hint}`;
  const err: Record<string, unknown> & Error = new Error(full) as Record<string, unknown> & Error;
  err["statusCode"] = status;
  err["status"] = status;
  err["responseBody"] = bodyText.slice(0, 500);
  err["url"] = url.split("?")[0];
  err["data"] = { error: { message: full } };
  if (code !== undefined) err["code"] = code;
  if (errorType) err["errorType"] = errorType;
  if (raw) err["raw"] = raw;
  const retryAfterMs = parseRetryAfterMs(headers);
  if (retryAfterMs !== undefined) err["retryAfterMs"] = retryAfterMs;
  throw toConciseProviderError(err, "openrouter", modelId);
}

/** Makes `request.count` pictures with an image model through OpenRouter in one request (an edit when reference images are given). */
export async function openrouterGenerateImage(
  modelId: string,
  request: ProviderImageRequest,
  options?: ProviderRequestOptions
): Promise<ProviderImageResult> {
  const started = Date.now();
  const apiKey = resolveProviderApiKey("openrouter", options);
  if (!apiKey)
    throw new ConfigError("[Agent Accelerator] Missing OpenRouter API key. Set OPENROUTER_API_KEY or pass apiKey.");
  const url = `${resolveProviderBaseUrl("openrouter", DEFAULT_BASE_URL, options)}/images`;

  // Provider routing and `user` come from the developer's `openrouter` setting, exactly as for chat.
  const setting = openRouterSetting();
  const routing: Record<string, unknown> = {};
  for (const key of OPENROUTER_ROUTING_KEYS) if (setting[key] !== undefined) routing[key] = setting[key];
  const body: Record<string, unknown> = {
    model: modelId,
    prompt: request.prompt,
    n: request.count,
    ...(request.images.length > 0
      ? { input_references: request.images.map((i) => ({ type: "image_url", image_url: { url: i.dataUrl } })) }
      : {}),
    ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
    ...(request.quality ? { quality: request.quality } : {}),
    ...(request.format ? { output_format: request.format } : {}),
    ...(request.background ? { background: request.background } : {}),
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

  const doCall = async (): Promise<ProviderImageResult> => {
    const { signal, cleanup } = combinedSignal(options?.signal, timeoutFor(options));
    let res: Response;
    let text: string;
    try {
      res = await (options?.fetch ?? fetch)(url, { method: "POST", headers, body: JSON.stringify(body), signal });
      text = await res.text();
    } finally {
      cleanup();
    }
    const responseHeaders = headersToRecord(res.headers);
    throwIfError(res.status, url, text, modelId, responseHeaders);
    let reply: ImagesReply;
    try {
      reply = JSON.parse(text) as ImagesReply;
    } catch {
      throw toConciseProviderError(
        Object.assign(new Error("Invalid JSON response from OpenRouter Images API"), {
          statusCode: res.status,
          responseBody: text.slice(0, 500),
          url,
        }),
        "openrouter",
        modelId
      );
    }
    const images = (reply.data ?? []).flatMap((d) => {
      if (typeof d.b64_json !== "string" || !d.b64_json) return [];
      const bytes = base64ToBytes(d.b64_json);
      return [
        {
          bytes,
          mimeType: sniffMimeType(bytes) ?? d.media_type ?? FORMAT_MIME[request.format ?? "png"] ?? "image/png",
        },
      ];
    });
    return {
      images,
      usage: mapUsage(reply.usage),
      ...(images.length > 0 ? { finishReason: "stop" } : {}),
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
