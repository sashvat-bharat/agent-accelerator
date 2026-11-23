/**
 * OpenAI image generation (`POST {baseUrl}/images/generations`, and `/images/edits` when reference images are sent), for the
 * `gpt-image-*` models. JSON bodies only (reference images travel as data URLs), one request per call, base64 pictures back.
 * The request arrives already checked against the model's table entry (`image/request.ts`): this file only maps it to the
 * wire, reads the reply and maps errors. Streaming (`partial_images`), masks, markup, SVG and GIF are never sent.
 */
import type { ProviderRequestOptions } from "../types/model.ts";
import { BULK_REPLY_LIMIT, readTextCapped } from "../utils/body.ts";
import type { ProviderImageRequest, ProviderImageResult } from "../types/image.ts";
import type { TokenUsage } from "../types/core.ts";
import { base64ToBytes } from "../utils/base64.ts";
import { sniffMimeType } from "../utils/media.ts";
import { buildSessionHeaders, setHeaderCaseInsensitive } from "../utils/headers.ts";
import { toConciseProviderError } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { ConfigError } from "../types/errors.ts";
import {
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

const FORMAT_MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

interface ImagesResponse {
  data?: Array<{ b64_json?: string }>;
  output_format?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { image_tokens?: number; text_tokens?: number };
    output_tokens_details?: { image_tokens?: number; text_tokens?: number };
  };
}

// The usage block as TokenUsage, with the text/image split the image pricing reads; in: a successful reply, out: TokenUsage.
function mapUsage(raw: ImagesResponse["usage"]): TokenUsage {
  const input = raw?.input_tokens ?? 0;
  const output = raw?.output_tokens ?? 0;
  const usage: TokenUsage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: raw?.total_tokens ?? input + output,
  };
  const inD = raw?.input_tokens_details;
  if (inD) usage.inputDetails = { imageTokens: inD.image_tokens ?? 0, textTokens: inD.text_tokens ?? 0 };
  const outD = raw?.output_tokens_details;
  if (outD) usage.outputDetails = { imageTokens: outD.image_tokens ?? 0, textTokens: outD.text_tokens ?? 0 };
  return usage;
}

/** Throws a concise provider error for a non-2xx OpenAI reply: status, OpenAI's code and type, Retry-After, a key hint on 401 and the categories of a moderation block; in: the OpenAI image and embedding calls, out: nothing or a thrown error. */
export function throwOpenAIHttpError(
  status: number,
  url: string,
  bodyText: string,
  modelId: string,
  headers: Record<string, string>
): void {
  if (status >= 200 && status < 300) return;
  const { message, code, errorType, raw } = readErrorPayload(bodyText);
  let extra = "";
  if (code === "moderation_blocked") {
    try {
      const d = (
        JSON.parse(bodyText) as {
          error?: { moderation_details?: { moderation_stage?: string; categories?: string[] } };
        }
      ).error?.moderation_details;
      extra = ` (blocked by moderation${d?.moderation_stage ? ` at the ${d.moderation_stage} stage` : ""}${d?.categories?.length ? `: ${d.categories.join(", ")}` : ""}; change the prompt or the images, retrying as is will not help)`;
    } catch {
      extra = " (blocked by moderation; change the prompt or the images)";
    }
  }
  const hint =
    status === 401
      ? " Check OPENAI_API_KEY (no quotes/spaces, correct provider), the base_urls.openai setting, and that the key is loaded (bun --env-file=.env.local)."
      : "";
  const full = `${message}${extra}${hint}`;
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
  throw toConciseProviderError(err, "openai", modelId);
}

/** Makes `request.count` pictures with an OpenAI image model in one request (an edit when reference images are given). */
export async function openaiGenerateImage(
  modelId: string,
  request: ProviderImageRequest,
  options?: ProviderRequestOptions
): Promise<ProviderImageResult> {
  const started = Date.now();
  const apiKey = resolveProviderApiKey("openai", options);
  if (!apiKey) {
    throw new ConfigError(
      "[Agent Accelerator] Missing OpenAI API key. Set OPENAI_API_KEY (or OPENAI_BASE_API_KEY) or pass apiKey."
    );
  }
  const editing = request.images.length > 0;
  const url = `${resolveProviderBaseUrl("openai", options)}/images/${editing ? "edits" : "generations"}`;
  const body: Record<string, unknown> = {
    model: modelId,
    prompt: request.prompt,
    ...(editing ? { images: request.images.map((i) => ({ image_url: i.dataUrl })) } : {}),
    n: request.count,
    ...(request.size ? { size: request.size } : {}),
    ...(request.quality ? { quality: request.quality } : {}),
    ...(request.format ? { output_format: request.format } : {}),
    ...(request.background ? { background: request.background } : {}),
  };
  const headers = buildSessionHeaders("openai", options?.headers, undefined);
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
      text = await readTextCapped(res, BULK_REPLY_LIMIT);
    } finally {
      cleanup();
    }
    const responseHeaders = headersToRecord(res.headers);
    throwOpenAIHttpError(res.status, url, text, modelId, responseHeaders);
    let parsed: ImagesResponse;
    try {
      parsed = JSON.parse(text) as ImagesResponse;
    } catch {
      throw toConciseProviderError(
        Object.assign(new Error("Invalid JSON response from OpenAI Images API"), {
          statusCode: res.status,
          responseBody: text.slice(0, 500),
          url,
        }),
        "openai",
        modelId
      );
    }
    const images = (parsed.data ?? []).flatMap((d) => {
      if (typeof d.b64_json !== "string" || !d.b64_json) return [];
      const bytes = base64ToBytes(d.b64_json);
      return [
        {
          bytes,
          mimeType: sniffMimeType(bytes) ?? FORMAT_MIME[parsed.output_format ?? request.format ?? "png"] ?? "image/png",
        },
      ];
    });
    return {
      images,
      usage: mapUsage(parsed.usage),
      ...(images.length > 0 ? { finishReason: "stop" } : {}),
      ...(responseHeaders["x-request-id"] ? { responseId: responseHeaders["x-request-id"] } : {}),
      model: modelId,
      provider: "openai",
      raw: {
        request: rawRequest,
        response: { status: res.status, statusText: res.statusText, headers: responseHeaders, body: parsed },
      },
      durationMs: Date.now() - started,
    };
  };

  return withRetries(doCall, {
    ...retryOptionsFrom(options),
    signal: options?.signal,
    label: { providerId: "openai", modelId },
  });
}
