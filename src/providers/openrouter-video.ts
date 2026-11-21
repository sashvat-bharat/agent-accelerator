/**
 * OpenRouter video generation (`POST {baseUrl}/videos`, then `GET {baseUrl}/videos/{id}` until the job ends, then the file). A video
 * is a job here: the submit answers 202 with a job id at once, the job runs for seconds to minutes (statuses `pending`,
 * `in_progress`, then `completed`, `failed`, `cancelled` or `expired`), and the finished job lists the file(s). The request arrives
 * already checked against the model's list entry (`video/request.ts`); this file maps it to the wire (`duration` with `-1` for "the
 * provider chooses", `resolution`, `aspect_ratio`, `size`, `frame_images` with a `frame_type` per picture, `input_references` for
 * reference pictures and clips, `generate_audio`, `seed`, `previous_job_id` for an edit), adds the developer's provider routing and `user` from the `openrouter`
 * setting, polls with the shared `pollJob` (deadline, abort, `onProgress`, the job id on every error) and downloads the first file with
 * the key (the key is sent to OpenRouter's own host only). OpenRouter reports the job's USD `cost`, which is the price. A job that
 * is still running when the call ends is NOT cancelled (OpenRouter has no cancel): the error carries `jobId`.
 * Mock-verified only: written from OpenRouter's video guide and API reference, no paid key was used.
 */
import type { ProviderRequestOptions } from "../types/model.ts";
import type { ProviderVideoRequest, ProviderVideoResult, ProviderVideoResumeRequest } from "../types/video.ts";
import type { TokenUsage } from "../types/core.ts";
import { openRouterSetting } from "../config/settings.ts";
import { sniffMimeType } from "../utils/media.ts";
import { buildSessionHeaders, setHeaderCaseInsensitive } from "../utils/headers.ts";
import { toConciseProviderError } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { ConfigError, TimeoutError, isAbortError } from "../types/errors.ts";
import { pollJob } from "../video/poll.ts";
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

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
/** The wait for a job when the call sets no deadline. */
const NO_DEADLINE_MS = 24 * 60 * 60 * 1000;

interface JobReply {
  id?: string;
  status?: string;
  status_detail?: string;
  progress?: number;
  urls?: string[];
  unsigned_urls?: string[];
  usage?: { cost?: number; is_byok?: boolean };
  error?: string;
}

// The job's USD cost as usage (the tokens of a video job are not reported); in: the finished job, out: TokenUsage.
function mapUsage(raw: JobReply["usage"]): TokenUsage {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  if (typeof raw?.cost === "number" && raw.cost >= 0) usage.cost = { totalCost: raw.cost };
  return usage;
}

// One picture as the `image_url` object OpenRouter takes; in: buildOpenRouterVideoBody, out: the object.
const imageUrl = (dataUrl: string) => ({ type: "image_url", image_url: { url: dataUrl } });

/** The `POST /videos` body for one request, without routing (exported for the tests). */
export function buildOpenRouterVideoBody(modelId: string, request: ProviderVideoRequest): Record<string, unknown> {
  const frames = [
    ...(request.firstFrame ? [{ ...imageUrl(request.firstFrame.dataUrl), frame_type: "first_frame" }] : []),
    ...(request.lastFrame ? [{ ...imageUrl(request.lastFrame.dataUrl), frame_type: "last_frame" }] : []),
  ];
  const references = [
    ...request.referenceImages.map((i) => imageUrl(i.dataUrl)),
    ...request.referenceVideos.map((c) => ({ type: "video_url", video_url: { url: c.media.dataUrl } })),
  ];
  return {
    model: modelId,
    ...(request.prompt ? { prompt: request.prompt } : {}),
    ...(request.durationAuto
      ? { duration: -1 }
      : request.durationSeconds !== undefined
        ? { duration: request.durationSeconds }
        : {}),
    ...(request.resolution ? { resolution: request.resolution } : {}),
    ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
    ...(request.size ? { size: request.size } : {}),
    ...(frames.length > 0 ? { frame_images: frames } : {}),
    ...(references.length > 0 ? { input_references: references } : {}),
    ...(request.audio !== undefined ? { generate_audio: request.audio } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.previousId ? { previous_job_id: request.previousId } : {}),
  };
}

type Client = ReturnType<typeof connect>;

// The connection of one call: key (a ConfigError when missing), base URL, headers, retry, and the two HTTP helpers; in: both entry points, out: the client.
function connect(modelId: string, options: ProviderRequestOptions | undefined) {
  const apiKey = resolveProviderApiKey("openrouter", options);
  if (!apiKey)
    throw new ConfigError("[Agent Accelerator] Missing OpenRouter API key. Set OPENROUTER_API_KEY or pass apiKey.");
  const baseUrl = resolveProviderBaseUrl("openrouter", DEFAULT_BASE_URL, options);
  const headers = buildSessionHeaders("openrouter", options?.headers, undefined);
  setHeaderCaseInsensitive(headers, "Content-Type", "application/json");
  if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "Authorization", `Bearer ${apiKey}`);
  const getHeaders = { ...headers };
  delete getHeaders["Content-Type"];
  const doFetch = options?.fetch ?? fetch;
  const timeoutMs = timeoutFor(options);
  const retry = { ...retryOptionsFrom(options), signal: options?.signal, label: { providerId: "openrouter", modelId } };

  // One HTTP call under the request timeout (a timer that fires is a TimeoutError, the caller's abort stays an AbortError); in: submit, poll and download, out: the reply.
  const call = async (target: string, init: RequestInit, what: string): Promise<Response> => {
    const { signal, cleanup } = combinedSignal(options?.signal, timeoutMs);
    try {
      return await doFetch(target, { ...init, signal });
    } catch (err) {
      if (isAbortError(err) && !options?.signal?.aborted && timeoutMs !== undefined)
        throw new TimeoutError(`[Agent Accelerator] ${what} timed out after ${timeoutMs} ms.`);
      throw err;
    } finally {
      cleanup();
    }
  };
  // A JSON reply, or a thrown concise error for a non-2xx status or a body that is not JSON; in: submit and poll, out: the parsed reply.
  const jsonCall = async (
    target: string,
    init: RequestInit,
    what: string
  ): Promise<{ reply: JobReply; res: Response }> => {
    const res = await call(target, init, what);
    const text = await res.text();
    throwOpenRouterHttpError(res.status, target, text, modelId, headersToRecord(res.headers), "video");
    try {
      return { reply: JSON.parse(text) as JobReply, res };
    } catch {
      throw toConciseProviderError(
        Object.assign(new Error("Invalid JSON response from OpenRouter Videos API"), {
          statusCode: res.status,
          responseBody: text.slice(0, 500),
          url: target,
        }),
        "openrouter",
        modelId
      );
    }
  };
  return { baseUrl, headers, getHeaders, retry, call, jsonCall, signal: options?.signal };
}

// Polls a job to its end, then downloads the first file; in: a submitted job or a resumed one, out: the video, its cost and the last status reply for the audit.
async function finishJob(
  c: Client,
  modelId: string,
  jobId: string,
  timing: { deadlineMs: number; pollIntervalMs: number; onProgress?: ProviderVideoRequest["onProgress"] },
  started: number,
  rawRequest: { url: string; method: string; headers: Record<string, string>; body: unknown },
  submitted?: { reply: JobReply; res: Response }
): Promise<ProviderVideoResult> {
  const jobUrl = `${c.baseUrl}/videos/${encodeURIComponent(jobId)}`;
  let last = submitted;
  const deadlineMs = Number.isFinite(timing.deadlineMs)
    ? Math.max(0, timing.deadlineMs - (Date.now() - started))
    : NO_DEADLINE_MS;
  // Ask how far the job is until it ends; a poll that fails for a transient reason is retried, any other end of the job is an error.
  const done = await pollJob<JobReply>({
    jobId,
    what: "OpenRouter video job",
    intervalMs: timing.pollIntervalMs,
    deadlineMs,
    signal: c.signal ?? new AbortController().signal,
    ...(timing.onProgress ? { onProgress: timing.onProgress } : {}),
    poll: async () => {
      last = await withRetries(
        () => c.jsonCall(jobUrl, { method: "GET", headers: c.getHeaders }, "The OpenRouter video status check"),
        c.retry
      );
      const job = last.reply;
      const status = job.status ?? "pending";
      if (status === "completed") return { done: true, value: job };
      if (status === "failed" || status === "cancelled" || status === "expired")
        throw toConciseProviderError(
          new Error(
            `OpenRouter video job ${status}${job.error ? `: ${job.error}` : job.status_detail ? `: ${job.status_detail}` : ""}`
          ),
          "openrouter",
          modelId
        );
      return { done: false, status, ...(typeof job.progress === "number" ? { progress: job.progress } : {}) };
    },
  });

  // The file: the key-protected link (the key goes only to OpenRouter's own host), else the signed link, which needs no key.
  const origin = new URL(c.baseUrl).origin;
  const fileTarget = done.unsigned_urls?.[0]
    ? { url: new URL(done.unsigned_urls[0], origin).toString(), signed: false }
    : done.urls?.[0]
      ? { url: done.urls[0], signed: true }
      : undefined;
  if (!fileTarget)
    throw withJob(
      toConciseProviderError(new Error("OpenRouter finished the video job but listed no file"), "openrouter", modelId),
      jobId
    );
  const sendKey = !fileTarget.signed && new URL(fileTarget.url).origin === origin;
  const fileHeaders = sendKey ? c.getHeaders : redactedNone(c.getHeaders);
  const file = await withRetries(async () => {
    const res = await c.call(fileTarget.url, { method: "GET", headers: fileHeaders }, "The OpenRouter video download");
    if (res.status < 200 || res.status >= 300)
      throwOpenRouterHttpError(
        res.status,
        fileTarget.url,
        await res.text(),
        modelId,
        headersToRecord(res.headers),
        "video"
      );
    return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type") };
  }, c.retry).catch((err: unknown) => {
    throw withJob(err, jobId);
  });
  const mimeType =
    file.type && file.type.startsWith("video/")
      ? file.type.split(";")[0]!.trim()
      : (sniffMimeType(file.bytes) ?? "video/mp4");

  return {
    video: { bytes: file.bytes, mimeType },
    usage: mapUsage(done.usage),
    ...(file.bytes.byteLength > 0 ? { finishReason: "stop" } : {}),
    jobId,
    model: modelId,
    provider: "openrouter",
    raw: {
      request: rawRequest,
      response: {
        status: last!.res.status,
        statusText: last!.res.statusText,
        headers: headersToRecord(last!.res.headers),
        body: last!.reply,
      },
    },
    durationMs: Date.now() - started,
  };
}

/** Makes one video with an OpenRouter video model: submits the job, polls it to the end and downloads the file. */
export async function openrouterGenerateVideo(
  modelId: string,
  request: ProviderVideoRequest,
  options?: ProviderRequestOptions
): Promise<ProviderVideoResult> {
  const started = Date.now();
  const c = connect(modelId, options);
  const url = `${c.baseUrl}/videos`;
  // Provider routing and `user` come from the developer's `openrouter` setting, exactly as for chat.
  const setting = openRouterSetting();
  const routing: Record<string, unknown> = {};
  for (const key of OPENROUTER_ROUTING_KEYS) if (setting[key] !== undefined) routing[key] = setting[key];
  const body: Record<string, unknown> = {
    ...buildOpenRouterVideoBody(modelId, request),
    ...(Object.keys(routing).length > 0 ? { provider: routing } : {}),
    ...(typeof setting["user"] === "string" ? { user: setting["user"] } : {}),
  };
  const rawRequest = {
    url,
    method: "POST",
    headers: redactedHeaders({ ...c.headers, Authorization: "[REDACTED]" }),
    body,
  };
  const submitted = await withRetries(
    () =>
      c.jsonCall(
        url,
        { method: "POST", headers: c.headers, body: JSON.stringify(body) },
        "The OpenRouter video request"
      ),
    c.retry
  );
  const jobId = submitted.reply.id;
  if (!jobId)
    throw toConciseProviderError(
      new Error("OpenRouter accepted the video request but sent no job id"),
      "openrouter",
      modelId
    );
  return finishJob(c, modelId, jobId, request, started, rawRequest, submitted);
}

/** Waits for a video job that already exists (no new job is submitted) and downloads the file. */
export async function openrouterResumeVideo(
  modelId: string,
  request: ProviderVideoResumeRequest,
  options?: ProviderRequestOptions
): Promise<ProviderVideoResult> {
  const started = Date.now();
  const c = connect(modelId, options);
  const rawRequest = {
    url: `${c.baseUrl}/videos/${encodeURIComponent(request.jobId)}`,
    method: "GET",
    headers: redactedHeaders({ ...c.getHeaders, Authorization: "[REDACTED]" }),
    body: null,
  };
  return finishJob(c, modelId, request.jobId, request, started, rawRequest);
}

// The headers without any credential, for a download from a host that is not OpenRouter's; in: the file step, out: a copy.
function redactedNone(h: Record<string, string>): Record<string, string> {
  const out = { ...h };
  for (const k of Object.keys(out)) if (k.toLowerCase() === "authorization") delete out[k];
  return out;
}

// Puts the job id on an error (not enumerable) so a failed download can be found at the provider; in: the download step, out: the same error.
function withJob<E>(err: E, jobId: string): E {
  if (err && typeof err === "object" && (err as { jobId?: unknown }).jobId === undefined)
    Object.defineProperty(err, "jobId", { value: jobId, enumerable: false, configurable: true, writable: true });
  return err;
}
