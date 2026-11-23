/**
 * Google video generation with Gemini Omni (`POST {baseUrl}/interactions`, the same Interactions endpoint as chat, with
 * `response_format: { type: "video" }`). One request makes one clip and is synchronous (`background: false`): the reply carries the
 * video as base64 in the `model_output` step, or, for the larger outputs (1080p and 4K, the docs advise a link above 4 MB), as a
 * Files API link (`delivery: "uri"`) that is polled until the file is ACTIVE and then downloaded. The request arrives already
 * checked against the model's table entry (`video/request.ts`), so this file only maps it to the wire.
 *
 * The input is a list of content blocks with NO role field: the first frame, the last frame, the reference pictures and the reference
 * clips are plain `image` and `video` blocks in that order, followed by the prompt text. What each picture means is told to the model by
 * `generation_config.video_config.task` when it is unambiguous (a lone first frame is `image_to_video`, references only are
 * `reference_to_video`); a pair of frames or a text-only call sends none, because Google advises prompting first and says the task
 * field adds constraints. Google can answer in words instead of a video (a refusal): that comes back as text with no video and the
 * core turns it into an error. Checked against Google's Gemini Omni guide only (mock-verified, no paid key).
 */
import type { ProviderRequestOptions } from "../types/model.ts";
import { beforeFirst } from "../utils/text.ts";
import { BULK_REPLY_LIMIT, DOWNLOAD_LIMIT, ERROR_BODY_LIMIT, readBytesCapped, readTextCapped } from "../utils/body.ts";
import type { ProviderVideoRequest, ProviderVideoResult } from "../types/video.ts";
import type { TokenUsage } from "../types/core.ts";
import type { NormalizedMedia } from "../utils/media.ts";
import { base64ToBytes } from "../utils/base64.ts";
import { setHeaderCaseInsensitive } from "../utils/headers.ts";
import { toConciseProviderError } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { ConfigError, TimeoutError, ValidationError, isAbortError } from "../types/errors.ts";
import { pollJob } from "../video/poll.ts";
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
import { GOOGLE_IMAGE_INPUT_MIME, GOOGLE_IMAGE_MIME_ALIASES, throwGoogleHttpError } from "./google-image.ts";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Video types Google reads inline (the Gemini video list), and the common spelling it is not given as. */
const VIDEO_MIME = [
  "video/mp4",
  "video/mpeg",
  "video/mpg",
  "video/mov",
  "video/avi",
  "video/x-flv",
  "video/webm",
  "video/wmv",
  "video/3gpp",
];
const VIDEO_MIME_ALIASES: Record<string, string> = { "video/quicktime": "video/mov" };
/** Google's limit for the inline media of one request (decoded bytes); larger files go through the Files API, which this call does not upload to. */
const MAX_INLINE_INPUT_BYTES = 100 * 1024 * 1024;
/** Outputs above 720p are asked for as a link: the docs advise it for videos over 4 MB, which 1080p and 4K clips are. */
const LINK_RESOLUTIONS = new Set(["1080p", "4K"]);
/** How long a Files API link may take to become ACTIVE when the call sets no deadline. */
const FILE_WAIT_MS = 600_000;

type Modality = { modality?: string; tokens?: number };
interface Block {
  type?: string;
  text?: string;
  data?: string;
  uri?: string;
  mime_type?: string;
}
interface InteractionReply {
  id?: string;
  status?: string;
  error?: { message?: string; code?: string | number } | null;
  steps?: Array<{ type?: string; content?: Block[] }>;
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    total_tokens?: number;
    output_tokens_by_modality?: Modality[];
  };
}

// Usage as TokenUsage: thinking tokens are billed as output (folded into it) and, with the per-modality split, priced as text; the video tokens are kept apart for the video price; in: a reply, out: TokenUsage.
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
  const video = modalityTokens(raw?.output_tokens_by_modality, "video");
  if (video !== undefined) {
    const text = (modalityTokens(raw?.output_tokens_by_modality, "text") ?? 0) + thought;
    usage.outputDetails = { videoTokens: video, textTokens: text };
  }
  return usage;
}

// One picture as an `image` block under Google's MIME name, failing before the network on a type Google does not read; in: buildBody, out: the block.
function imageBlock(media: NormalizedMedia): Record<string, string> {
  const mime = GOOGLE_IMAGE_MIME_ALIASES[media.mimeType] ?? media.mimeType;
  if (!GOOGLE_IMAGE_INPUT_MIME.includes(mime))
    throw new ValidationError(
      `[Agent Accelerator] Google does not accept the picture type "${media.mimeType}" for a video (supported: ${GOOGLE_IMAGE_INPUT_MIME.join(", ")}). Convert the picture first.`
    );
  return { type: "image", data: media.base64Data, mime_type: mime };
}

// One reference clip as a `video` block under Google's MIME name, failing before the network on a type Google does not read; in: buildBody, out: the block.
function videoBlock(media: NormalizedMedia): Record<string, string> {
  const mime = VIDEO_MIME_ALIASES[media.mimeType] ?? media.mimeType;
  if (!VIDEO_MIME.includes(mime))
    throw new ValidationError(
      `[Agent Accelerator] Google does not accept the video type "${media.mimeType}" (supported: ${VIDEO_MIME.join(", ")}). Convert the clip first.`
    );
  return { type: "video", data: media.base64Data, mime_type: mime };
}

// The decoded size of a base64 string without decoding it; in: the inline size check, out: bytes.
function decodedBytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** The Interactions request body for one video request (exported for the tests). */
function buildGoogleVideoBody(modelId: string, request: ProviderVideoRequest): Record<string, unknown> {
  const media = [request.firstFrame, request.lastFrame, ...request.referenceImages].filter(
    (m): m is NormalizedMedia => !!m
  );
  const clips = request.referenceVideos.map((c) => c.media);
  const total = [...media, ...clips].reduce((n, m) => n + decodedBytes(m.base64Data), 0);
  if (total > MAX_INLINE_INPUT_BYTES)
    throw new ValidationError(
      `[Agent Accelerator] [google/${modelId}] The pictures and clips of this request are ${(total / (1024 * 1024)).toFixed(1)} MB, over Google's ${MAX_INLINE_INPUT_BYTES / (1024 * 1024)} MB limit for inline media. Use smaller or shorter files.`
    );
  const blocks: Array<Record<string, string>> = [
    ...(request.firstFrame ? [imageBlock(request.firstFrame)] : []),
    ...(request.lastFrame ? [imageBlock(request.lastFrame)] : []),
    ...request.referenceImages.map(imageBlock),
    ...clips.map(videoBlock),
  ];
  if (request.prompt) blocks.push({ type: "text", text: request.prompt });
  const responseFormat: Record<string, string> = {
    type: "video",
    ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
    // Google spells the tier in lower case (`4k`).
    ...(request.resolution ? { resolution: request.resolution.toLowerCase() } : {}),
    ...(request.durationSeconds !== undefined ? { duration: `${request.durationSeconds}s` } : {}),
    ...(request.resolution && LINK_RESOLUTIONS.has(request.resolution) ? { delivery: "uri" } : {}),
  };
  const hasReferences = request.referenceImages.length > 0 || request.referenceVideos.length > 0;
  const onlyFirst = !!request.firstFrame && !request.lastFrame && !hasReferences;
  const task = onlyFirst
    ? "image_to_video"
    : hasReferences && !request.firstFrame && !request.lastFrame
      ? "reference_to_video"
      : undefined;
  return {
    model: modelId,
    ...(request.previousId ? { previous_interaction_id: request.previousId } : {}),
    input: blocks.length === 1 && blocks[0]!["type"] === "text" ? blocks[0]!["text"] : blocks,
    response_format: responseFormat,
    background: false,
    ...(task || request.seed !== undefined
      ? {
          generation_config: {
            ...(task ? { video_config: { task } } : {}),
            ...(request.seed !== undefined ? { seed: request.seed } : {}),
          },
        }
      : {}),
  };
}

/** Makes one video with Gemini Omni. */
export async function googleGenerateVideo(
  modelId: string,
  request: ProviderVideoRequest,
  options?: ProviderRequestOptions
): Promise<ProviderVideoResult> {
  const started = Date.now();
  const apiKey = resolveProviderApiKey("google", options);
  if (!apiKey)
    throw new ConfigError(
      "[Agent Accelerator] Missing Google API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) or pass apiKey."
    );
  const baseUrl = resolveProviderBaseUrl("google", DEFAULT_BASE_URL, options);
  const url = `${baseUrl}/interactions`;
  const body = buildGoogleVideoBody(modelId, request);
  const headers: Record<string, string> = { "Content-Type": "application/json", ...options?.headers };
  if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "x-goog-api-key", apiKey);
  const rawRequest = {
    url,
    method: "POST",
    headers: redactedHeaders({ ...headers, "x-goog-api-key": "[REDACTED]" }),
    body,
  };
  const doFetch = options?.fetch ?? fetch;
  const timeoutMs = timeoutFor(options);

  // One HTTP call under the request timeout; a timer that fires is a TimeoutError (the caller's own abort stays an AbortError); in: the create POST and the file calls, out: the reply.
  const call = async (
    target: string,
    init: RequestInit,
    what: string
  ): Promise<{ res: Response; status: number; headers: Record<string, string> }> => {
    const { signal, cleanup } = combinedSignal(options?.signal, timeoutMs);
    try {
      const res = await doFetch(target, { ...init, signal });
      return { res, status: res.status, headers: headersToRecord(res.headers) };
    } catch (err) {
      if (isAbortError(err) && !options?.signal?.aborted && timeoutMs !== undefined)
        throw new TimeoutError(
          `[Agent Accelerator] ${what} timed out after ${timeoutMs} ms; the video may still be made at Google (interaction not known yet).`
        );
      throw err;
    } finally {
      cleanup();
    }
  };

  const create = async (): Promise<{
    reply: InteractionReply;
    status: number;
    statusText: string;
    headers: Record<string, string>;
  }> => {
    const r = await call(url, { method: "POST", headers, body: JSON.stringify(body) }, "The Google video request");
    const text = await readTextCapped(r.res, BULK_REPLY_LIMIT);
    throwGoogleHttpError(r.status, url, text, modelId, r.headers);
    try {
      return {
        reply: JSON.parse(text) as InteractionReply,
        status: r.status,
        statusText: r.res.statusText,
        headers: r.headers,
      };
    } catch {
      throw toConciseProviderError(
        Object.assign(new Error("Invalid JSON response from Google Interactions API"), {
          statusCode: r.status,
          responseBody: text.slice(0, 500),
          url,
        }),
        "google",
        modelId
      );
    }
  };
  const created = await withRetries(create, {
    ...retryOptionsFrom(options),
    signal: options?.signal,
    label: { providerId: "google", modelId },
  });
  const { reply } = created;
  if (reply.status === "failed" || reply.status === "cancelled") {
    const failure: Record<string, unknown> & Error = new Error(
      reply.error?.message || `Google interaction ${reply.status}`
    ) as Record<string, unknown> & Error;
    if (reply.error?.code !== undefined) failure["code"] = reply.error.code;
    throw Object.assign(toConciseProviderError(failure, "google", modelId), reply.id ? { jobId: reply.id } : {});
  }

  // The model's output: one video (inline or a link) and any words.
  const blocks = (reply.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []);
  const words = blocks.flatMap((b) => (b.type === "text" && b.text ? [b.text] : []));
  const clip = blocks.find((b) => b.type === "video" && (b.data || b.uri));
  let bytes: Uint8Array = new Uint8Array(0);
  let mimeType = clip?.mime_type ?? "video/mp4";
  if (clip?.data) bytes = base64ToBytes(clip.data);
  else if (clip?.uri) {
    const fileId = /files\/([^/:?#]+)/.exec(clip.uri)?.[1];
    if (!fileId)
      throw toConciseProviderError(
        new Error(`Google returned a video link this SDK cannot read: ${clip.uri.slice(0, 120)}`),
        "google",
        modelId
      );
    const id = reply.id ?? fileId;
    const fileUrl = `${baseUrl}/files/${fileId}`;
    const fileHeaders: Record<string, string> = { ...headers };
    delete fileHeaders["Content-Type"];
    // The link is a file that Google fills in: ask until it is ACTIVE, then download it.
    await pollJob<true>({
      jobId: id,
      what: "Google video file",
      intervalMs: request.pollIntervalMs,
      deadlineMs: Number.isFinite(request.deadlineMs)
        ? Math.max(0, request.deadlineMs - (Date.now() - started))
        : FILE_WAIT_MS,
      signal: options?.signal ?? new AbortController().signal,
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
      poll: async () => {
        const r = await withRetries(
          async () => {
            const got = await call(fileUrl, { method: "GET", headers: fileHeaders }, "The Google file check");
            const text = await readTextCapped(got.res, BULK_REPLY_LIMIT);
            throwGoogleHttpError(got.status, fileUrl, text, modelId, got.headers);
            return text;
          },
          { ...retryOptionsFrom(options), signal: options?.signal, label: { providerId: "google", modelId } }
        );
        const file = JSON.parse(r) as { state?: string | { name?: string } };
        const state = typeof file.state === "string" ? file.state : (file.state?.name ?? "");
        if (state === "ACTIVE") return { done: true, value: true };
        if (state === "FAILED")
          throw toConciseProviderError(
            new Error("Google could not finish the video file (state FAILED)"),
            "google",
            modelId
          );
        return { done: false, status: (state || "PROCESSING").toLowerCase() };
      },
    });
    const downloadUrl = `${fileUrl}:download?alt=media`;
    const dl = await withRetries(
      async () => {
        const got = await call(downloadUrl, { method: "GET", headers: fileHeaders }, "The Google video download");
        if (got.status < 200 || got.status >= 300)
          throwGoogleHttpError(
            got.status,
            downloadUrl,
            await readTextCapped(got.res, ERROR_BODY_LIMIT),
            modelId,
            got.headers
          );
        return { buffer: await readBytesCapped(got.res, DOWNLOAD_LIMIT), type: got.headers["content-type"] };
      },
      { ...retryOptionsFrom(options), signal: options?.signal, label: { providerId: "google", modelId } }
    );
    bytes = dl.buffer;
    if (dl.type && dl.type.startsWith("video/")) mimeType = beforeFirst(dl.type, ";").trim();
  }

  const finishReason = reply.status === "incomplete" ? "length" : bytes.byteLength > 0 ? "stop" : undefined;
  return {
    video: { bytes, mimeType },
    ...(words.length > 0 ? { text: words.join("\n") } : {}),
    usage: mapUsage(reply.usage),
    ...(finishReason ? { finishReason } : {}),
    ...(reply.id ? { responseId: reply.id } : {}),
    model: modelId,
    provider: "google",
    raw: {
      request: rawRequest,
      response: {
        status: created.status,
        statusText: created.statusText,
        headers: created.headers,
        // Never the video itself: a base64 clip would make the audit record as big as the clip.
        body: {
          ...reply,
          steps: (reply.steps ?? []).map((s) => ({
            ...s,
            content: s.content?.map((b) => (b.data ? { ...b, data: `[${b.data.length} base64 characters]` } : b)),
          })),
        },
      },
    },
    durationMs: Date.now() - started,
  };
}
