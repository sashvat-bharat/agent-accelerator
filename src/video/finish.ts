/**
 * The end of every video call, shared by `generateVideo` and `resumeVideo`: check that a video really came back, price it, apply the
 * budget, and build the `VideoResult` with the origin an `edit()` later continues from.
 */
import type { VideoModelInfo } from "../models/video-models.ts";
import type { ProviderVideoResult, VideoOptions } from "../types/video.ts";
import { applyCaptureRaw, type CaptureRawMode } from "../utils/raw-capture.ts";
import { BudgetExceededError, ProviderError } from "../types/errors.ts";
import { priceVideoUsage } from "./pricing.ts";
import { GeneratedVideo, VideoResult, attachVideoOrigin } from "./result.ts";

/** The connection settings of a call that an edit of its clip reuses. */
export type VideoInherit = NonNullable<Parameters<typeof attachVideoOrigin>[1]>["inherit"];

// The connection settings of `opts` that an edit should reuse; in: generateVideo and resumeVideo, out: the origin's `inherit`.
export function inheritFrom(
  opts: Pick<
    VideoOptions,
    "apiKey" | "baseUrl" | "headers" | "env" | "fetch" | "retry" | "timeoutMs" | "pollIntervalMs" | "captureRaw"
  >
): VideoInherit {
  return {
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
    ...(opts.captureRaw ? { captureRaw: opts.captureRaw } : {}),
  };
}

/** Turns an adapter's answer into a `VideoResult`, or throws: no video is a non-retryable `ProviderError` that carries the model's words; a cost over `maxCost` is a `BudgetExceededError` with the paid-for clip on `partial`. */
export function finishVideo(args: {
  def: VideoModelInfo;
  res: ProviderVideoResult;
  maxCost: number | undefined;
  captureRaw: CaptureRawMode | undefined;
  inherit: VideoInherit;
  started: number;
}): VideoResult {
  const { def, res, maxCost, captureRaw, inherit, started } = args;
  if (!res.video?.bytes || res.video.bytes.byteLength === 0) {
    const why = (res.text || res.finishReason)?.replace(/[.\s]+$/, "");
    throw new ProviderError(`[${def.model}] returned no video${why ? `: ${why}` : ""}.`, {
      provider: def.provider,
      model: def.id,
      retryable: false,
    });
  }
  // The provider's own cost wins; else the table prices the reported tokens; else it stays unknown (and counts as 0 for the budget).
  let usage = res.usage;
  if (usage.cost?.totalCost === undefined) {
    const cost = priceVideoUsage(def, usage);
    if (cost) usage = { ...usage, cost };
  }
  const video = new GeneratedVideo(res.video.bytes, res.video.mimeType || "video/mp4");
  const chainId = def.provider === "google" ? res.responseId : res.jobId;
  attachVideoOrigin(video, { model: def.model, ...(chainId ? { chainId } : {}), inherit });
  const spent = usage.cost?.totalCost ?? 0;
  if (maxCost !== undefined && spent > maxCost)
    throw Object.assign(
      new BudgetExceededError(`[Agent Accelerator] Cost $${spent.toFixed(4)} is above budget.maxCostUsd $${maxCost}.`),
      { partial: { video, usage }, ...(res.jobId ? { jobId: res.jobId } : {}) }
    );
  return new VideoResult({
    video,
    ...(res.text ? { text: res.text } : {}),
    usage,
    model: def.id,
    provider: def.provider,
    ...(res.finishReason ? { finishReason: res.finishReason } : {}),
    ...(res.responseId ? { responseId: res.responseId } : {}),
    ...(res.jobId ? { jobId: res.jobId } : {}),
    raw: applyCaptureRaw(res.raw, captureRaw) ?? res.raw,
    durationMs: Date.now() - started,
  });
}
