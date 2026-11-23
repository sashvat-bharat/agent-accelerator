/**
 * Google decisions (`POST {baseUrl}/decisions`, Gemini Decision 1). One request carries the shared input and every question:
 * `input` is a plain string when it is one piece of text, else a list of content blocks (`text`, and inline `image`, `audio`,
 * `video` and `document` blocks with their MIME type and an optional `resolution`), and `questions` maps each name to
 * `{ type, instructions, criteria }`, which are already Google's own shapes. The request arrives already checked
 * (`decision/request.ts`), so this file only maps it to the wire, reads the reply and maps errors. The reply's `answers` map is
 * handed back as it is (the core checks it); usage is the input tokens, with Google's per-modality split kept. Google sends no
 * text, so there are no output tokens.
 */
import type { ProviderRequestOptions } from "../types/model.ts";
import { BULK_REPLY_LIMIT, readTextCapped } from "../utils/body.ts";
import type { ProviderDecisionRequest, ProviderDecisionResult } from "../types/decision.ts";
import type { InputPartData } from "../utils/provider-call.ts";
import type { TokenUsage } from "../types/core.ts";
import { setHeaderCaseInsensitive } from "../utils/headers.ts";
import { toConciseProviderError } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { ConfigError, ValidationError } from "../types/errors.ts";
import {
  combinedSignal,
  headersToRecord,
  redactedHeaders,
  resolveProviderApiKey,
  resolveProviderBaseUrl,
  retryOptionsFrom,
  timeoutFor,
} from "./shared.ts";
import { throwGoogleHttpError } from "./google-image.ts";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** What Gemini Decision 1 reads inline, by kind (docs: decisions, "Input"). */
const MEDIA_MIME: Record<"image" | "audio" | "video" | "pdf", readonly string[]> = {
  image: ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif", "image/gif", "image/bmp", "image/tiff"],
  audio: [
    "audio/wav",
    "audio/mp3",
    "audio/mpeg",
    "audio/aiff",
    "audio/aac",
    "audio/ogg",
    "audio/flac",
    "audio/m4a",
    "audio/opus",
    "audio/webm",
    "audio/l16",
    "audio/alaw",
    "audio/mulaw",
  ],
  video: ["video/mp4", "video/mpeg", "video/mov", "video/avi", "video/webm", "video/wmv", "video/x-flv", "video/3gpp"],
  pdf: ["application/pdf"],
};
/** Common MIME spellings mapped to the names Google lists. */
const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "video/quicktime": "video/mov",
};
/** The block type Google calls each kind. */
const BLOCK_TYPE = { image: "image", audio: "audio", video: "video", pdf: "document" } as const;

interface DecisionReply {
  answers?: ProviderDecisionResult["answers"];
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_tokens?: number;
    input_tokens_by_modality?: Array<{ modality?: string; tokens?: number }>;
  };
}

// One part as a Google content block: text as is, media inline under Google's MIME name (checked before the network); in: buildBody, out: the block.
function toBlock(part: InputPartData, modelId: string): Record<string, unknown> {
  if (part.kind === "text") return { type: "text", text: part.text };
  const mime = MIME_ALIASES[part.media.mimeType] ?? part.media.mimeType;
  if (!MEDIA_MIME[part.kind].includes(mime))
    throw new ValidationError(
      `[Agent Accelerator] [google/${modelId}] does not read ${part.kind} of type "${mime}" (supported: ${MEDIA_MIME[part.kind].join(", ")}). Convert the file or pass the correct mimeType.`,
      { provider: "google", model: modelId }
    );
  return {
    type: BLOCK_TYPE[part.kind],
    data: part.media.base64Data,
    mime_type: mime,
    ...(part.resolution ? { resolution: part.resolution } : {}),
  };
}

// Tokens of one modality in the reply's breakdown, or undefined when it does not list it; in: mapUsage, out: a count.
function tokensOf(
  list: NonNullable<DecisionReply["usage"]>["input_tokens_by_modality"],
  modality: string
): number | undefined {
  const hits = (list ?? []).filter((m) => m.modality === modality);
  return hits.length > 0 ? hits.reduce((n, m) => n + (m.tokens ?? 0), 0) : undefined;
}

// Usage as TokenUsage: the input tokens, with the per-modality split Google reports (a PDF's pages count as image tokens, as Google bills them); in: a reply, out: TokenUsage.
function mapUsage(raw: DecisionReply["usage"]): TokenUsage {
  const input = raw?.total_input_tokens ?? 0;
  const output = raw?.total_output_tokens ?? 0;
  const usage: TokenUsage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: raw?.total_tokens ?? input + output,
  };
  const parts = {
    textTokens: tokensOf(raw?.input_tokens_by_modality, "text"),
    imageTokens: tokensOf(raw?.input_tokens_by_modality, "image"),
    audioTokens: tokensOf(raw?.input_tokens_by_modality, "audio"),
    videoTokens: tokensOf(raw?.input_tokens_by_modality, "video"),
  };
  const kept = Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== undefined));
  if (Object.keys(kept).length > 0) usage.inputDetails = kept;
  return usage;
}

/** Answers the questions of a decision request with a Google decision model, in one `/decisions` request. */
export async function googleDecide(
  modelId: string,
  request: ProviderDecisionRequest,
  options?: ProviderRequestOptions
): Promise<ProviderDecisionResult> {
  const started = Date.now();
  const apiKey = resolveProviderApiKey("google", options);
  if (!apiKey)
    throw new ConfigError(
      "[Agent Accelerator] Missing Google API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) or pass apiKey."
    );
  const url = `${resolveProviderBaseUrl("google", DEFAULT_BASE_URL, options)}/decisions`;
  const only = request.input.length === 1 ? request.input[0] : undefined;
  const body = {
    model: modelId,
    input: only?.kind === "text" ? only.text : request.input.map((p) => toBlock(p, modelId)),
    questions: request.questions,
  };
  const headers: Record<string, string> = { "Content-Type": "application/json", ...options?.headers };
  if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "x-goog-api-key", apiKey);
  const rawRequest = {
    url,
    method: "POST",
    headers: redactedHeaders({ ...headers, "x-goog-api-key": "[REDACTED]" }),
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
    throwGoogleHttpError(res.status, url, text, modelId, responseHeaders);
    let reply: DecisionReply;
    try {
      reply = JSON.parse(text) as DecisionReply;
    } catch {
      throw toConciseProviderError(
        Object.assign(new Error("Invalid JSON response from the Google decisions API"), {
          statusCode: res.status,
          responseBody: text.slice(0, 500),
          url,
        }),
        "google",
        modelId
      );
    }
    return {
      answers: reply.answers ?? {},
      usage: mapUsage(reply.usage),
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
