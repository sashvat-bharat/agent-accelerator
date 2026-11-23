/**
 * `resumeVideo`: waits for a video job that already exists. A timeout or an abort does not cancel a job at the provider (OpenRouter
 * has no cancel), so the job usually finishes by itself; the error that ended the call carries its `jobId`, and this function asks
 * for that job again, polls it to the end and downloads the file, without submitting (or paying for) a new one.
 */
import { getVideoModel, unsupportedVideoModelReason } from "../models/video-models.ts";
import { ensureOpenRouterVideoModels } from "../models/openrouter-videos.ts";
import { assertModelAllowed } from "../config/models.ts";
import { getProvider } from "../providers/registry.ts";
import { withProviderSlot } from "../agent/governor.ts";
import { providerOptionsFrom } from "../utils/provider-call.ts";
import { ConfigError, ValidationError, abortErrorFor } from "../types/errors.ts";
import type { ResumeVideoOptions } from "../types/video.ts";
import { finishVideo, inheritFrom } from "./finish.ts";
import type { VideoResult } from "./result.ts";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 10_000;

/**
 * Waits for the video job `jobId` of an OpenRouter video model and returns its `VideoResult` (the clip, its reported cost, the job id).
 * Throws what `generateVideo` throws while waiting (`TimeoutError`, `AbortError`, `ProviderError` for a failed, cancelled or expired
 * job; each carries `jobId`), `ConfigError` for an unknown model or a provider that has no jobs to resume, and `ValidationError` for
 * a job id that is not a string.
 *
 * @example `const r = await resumeVideo({ model: "openrouter/google/veo-3.1", jobId: err.jobId }); await r.video.save("clip.mp4");`
 */
export async function resumeVideo(opts: ResumeVideoOptions): Promise<VideoResult> {
  const modelText = String(opts?.model ?? "");
  if (modelText.toLowerCase().startsWith("openrouter/"))
    await ensureOpenRouterVideoModels(opts.fetch ? { fetch: opts.fetch } : {});
  const def = getVideoModel(modelText);
  if (!def) throw new ConfigError(`[Agent Accelerator] ${unsupportedVideoModelReason(modelText) ?? "No model given."}`);
  assertModelAllowed(def.provider, def.id);
  const provider = getProvider(def.provider);
  if (!provider.resumeVideo)
    throw new ConfigError(
      `[Agent Accelerator] ${def.provider} makes a video in one request, so there is no job to resume. Only OpenRouter video jobs can be resumed.`
    );
  if (typeof opts.jobId !== "string" || opts.jobId.trim() === "")
    throw new ValidationError("[Agent Accelerator] jobId must be the job id string of an earlier video call.");
  const maxCost = opts.budget?.maxCostUsd;
  if (maxCost !== undefined && !(typeof maxCost === "number" && Number.isFinite(maxCost) && maxCost > 0))
    throw new ValidationError("[Agent Accelerator] budget.maxCostUsd must be a number greater than 0.");
  const timeoutOpt = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!(typeof timeoutOpt === "number" && timeoutOpt >= 0))
    throw new ValidationError(
      "[Agent Accelerator] timeoutMs must be a number of milliseconds (0 or Infinity = no limit)."
    );
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  if (!(typeof pollMs === "number" && Number.isFinite(pollMs) && pollMs > 0))
    throw new ValidationError("[Agent Accelerator] pollIntervalMs must be a number of milliseconds above 0.");

  const deadlineMs = timeoutOpt === 0 ? Infinity : timeoutOpt;
  const signal = opts.signal ?? new AbortController().signal;
  if (signal.aborted) throw abortErrorFor(signal, "Video generation aborted");
  const providerOptions = providerOptionsFrom(opts, Number.isFinite(deadlineMs) ? deadlineMs : 0);
  const started = Date.now();
  const res = await withProviderSlot(def.provider, signal, () =>
    provider.resumeVideo!(
      def.id,
      {
        jobId: opts.jobId.trim(),
        deadlineMs,
        pollIntervalMs: pollMs,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      },
      { ...providerOptions, signal }
    )
  );
  return finishVideo({ def, res, maxCost, captureRaw: opts.captureRaw, inherit: inheritFrom(opts), started });
}
