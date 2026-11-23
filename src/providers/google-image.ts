/**
 * Google image generation with the Gemini image models (`POST {baseUrl}/interactions`, the same Interactions endpoint as chat).
 * One request makes one picture (Google has no `n`: the core runs parallel requests). The request arrives already checked
 * against the model's table entry (`image/request.ts`), so this file only maps it to the wire: the prompt and reference images
 * as input blocks, `response_format` for the ratio, size tier and file type, `generation_config.thinking_level` for thinking.
 * The picture is the `image` block of the `model_output` step; the interim "thought images" in `thought` steps are never
 * returned (Google does not charge for them). Search grounding is never requested. Interactions are stored by Google (the
 * default), so a later edit can continue from `responseId`.
 */
import type { ProviderRequestOptions } from "../types/model.ts";
import { BULK_REPLY_LIMIT, readTextCapped } from "../utils/body.ts";
import type { ProviderImageRequest, ProviderImageResult } from "../types/image.ts";
import type { TokenUsage } from "../types/core.ts";
import { base64ToBytes } from "../utils/base64.ts";
import { sniffMimeType } from "../utils/media.ts";
import { setHeaderCaseInsensitive } from "../utils/headers.ts";
import { toConciseProviderError } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { ConfigError, ValidationError } from "../types/errors.ts";
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

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Image types Google reads as input (and the common spelling it is not given as). */
export const GOOGLE_IMAGE_INPUT_MIME: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/bmp",
  "image/tiff",
];
export const GOOGLE_IMAGE_MIME_ALIASES: Record<string, string> = { "image/jpg": "image/jpeg" };
const FORMAT_MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg" };

type Modality = { modality?: string; tokens?: number };
interface InteractionReply {
  id?: string;
  status?: string;
  error?: { message?: string; code?: string | number } | null;
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; data?: string; mime_type?: string }>;
  }>;
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    total_tokens?: number;
    input_tokens_by_modality?: Modality[];
    output_tokens_by_modality?: Modality[];
  };
}

// Tokens of one modality in a by-modality list, or undefined when the list does not mention it; in: mapUsage, out: a count.
function tokensOf(list: Modality[] | undefined, modality: string): number | undefined {
  const hits = (list ?? []).filter((m) => m.modality === modality);
  return hits.length > 0 ? hits.reduce((n, m) => n + (m.tokens ?? 0), 0) : undefined;
}

// Usage as TokenUsage: thinking tokens are billed as output (folded into it, like the chat adapter) and the image/text split is kept for the image pricing; in: a reply, out: TokenUsage.
function mapUsage(raw: InteractionReply["usage"]): TokenUsage {
  const input = raw?.total_input_tokens ?? 0;
  const thought = raw?.total_thought_tokens ?? 0;
  const output = (raw?.total_output_tokens ?? 0) + thought;
  const usage: TokenUsage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: raw?.total_tokens ?? input + output,
  };
  if (thought > 0) usage.thinkingTokens = thought;
  const inImage = tokensOf(raw?.input_tokens_by_modality, "image");
  const inText = tokensOf(raw?.input_tokens_by_modality, "text");
  if (inImage !== undefined || inText !== undefined)
    usage.inputDetails = { imageTokens: inImage ?? 0, textTokens: inText ?? 0 };
  const outImage = tokensOf(raw?.output_tokens_by_modality, "image");
  if (outImage !== undefined)
    usage.outputDetails = { imageTokens: outImage, textTokens: tokensOf(raw?.output_tokens_by_modality, "text") ?? 0 };
  return usage;
}

/** Throws a concise provider error for a non-2xx Google reply: status, Google's code, Retry-After and a key hint on 401; in: the Google image and embedding calls, out: nothing or a thrown error. */
export function throwGoogleHttpError(
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
      ? " Check GEMINI_API_KEY/GOOGLE_API_KEY (no quotes/spaces, correct provider), GOOGLE_BASE_URL, and that the key is loaded (bun --env-file=.env.local)."
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
  throw toConciseProviderError(err, "google", modelId);
}

/** Makes one picture with a Gemini image model. */
export async function googleGenerateImage(
  modelId: string,
  request: ProviderImageRequest,
  options?: ProviderRequestOptions
): Promise<ProviderImageResult> {
  const started = Date.now();
  const apiKey = resolveProviderApiKey("google", options);
  if (!apiKey)
    throw new ConfigError(
      "[Agent Accelerator] Missing Google API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) or pass apiKey."
    );
  const url = `${resolveProviderBaseUrl("google", DEFAULT_BASE_URL, options)}/interactions`;

  const input: Array<Record<string, string>> = [{ type: "text", text: request.prompt }];
  for (const image of request.images) {
    const mime = GOOGLE_IMAGE_MIME_ALIASES[image.mimeType] ?? image.mimeType;
    if (!GOOGLE_IMAGE_INPUT_MIME.includes(mime))
      throw new ValidationError(
        `[Agent Accelerator] Google does not accept the reference image type "${image.mimeType}" (supported: ${GOOGLE_IMAGE_INPUT_MIME.join(", ")}). Convert the picture first.`
      );
    input.push({ type: "image", data: image.base64Data, mime_type: mime });
  }
  const responseFormat: Record<string, string> = {
    ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
    ...(request.resolution ? { image_size: request.resolution } : {}),
    ...(request.format ? { mime_type: FORMAT_MIME[request.format] ?? "image/png" } : {}),
  };
  const body: Record<string, unknown> = {
    model: modelId,
    input,
    ...(Object.keys(responseFormat).length > 0 ? { response_format: { type: "image", ...responseFormat } } : {}),
    ...(request.thinking ? { generation_config: { thinking_level: request.thinking } } : {}),
    ...(request.previousInteractionId ? { previous_interaction_id: request.previousInteractionId } : {}),
  };
  const headers: Record<string, string> = { "Content-Type": "application/json", ...options?.headers };
  if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "x-goog-api-key", apiKey);
  const rawRequest = {
    url,
    method: "POST",
    headers: redactedHeaders({ ...headers, "x-goog-api-key": "[REDACTED]" }),
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
    throwGoogleHttpError(res.status, url, text, modelId, responseHeaders);
    let reply: InteractionReply;
    try {
      reply = JSON.parse(text) as InteractionReply;
    } catch {
      throw toConciseProviderError(
        Object.assign(new Error("Invalid JSON response from Google Interactions API"), {
          statusCode: res.status,
          responseBody: text.slice(0, 500),
          url,
        }),
        "google",
        modelId
      );
    }
    if (reply.status === "failed" || reply.status === "cancelled") {
      const failure: Record<string, unknown> & Error = new Error(
        reply.error?.message || `Google interaction ${reply.status}`
      ) as Record<string, unknown> & Error;
      if (reply.error?.code !== undefined) failure["code"] = reply.error.code;
      throw toConciseProviderError(failure, "google", modelId);
    }
    // Only the model's output: the `thought` steps hold interim images that are not the result.
    const images: ProviderImageResult["images"] = [];
    const words: string[] = [];
    for (const step of reply.steps ?? []) {
      if (step.type !== "model_output") continue;
      for (const block of step.content ?? []) {
        if (block.type === "text" && block.text) words.push(block.text);
        else if (block.type === "image" && block.data) {
          const bytes = base64ToBytes(block.data);
          images.push({ bytes, mimeType: sniffMimeType(bytes) ?? block.mime_type ?? "image/png" });
        }
      }
    }
    const finishReason = reply.status === "incomplete" ? "length" : images.length > 0 ? "stop" : undefined;
    return {
      images,
      ...(words.length > 0 ? { text: words.join("\n") } : {}),
      usage: mapUsage(reply.usage),
      ...(finishReason ? { finishReason } : {}),
      ...(reply.id ? { responseId: reply.id } : {}),
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
