/**
 * `generateVideo`: one call that makes a clip with a known video model (`listVideoModels`). It checks the request against what that
 * model supports, reads the pictures and clips (checking the clip lengths the provider states), makes ONE provider request (for a
 * provider that works in jobs the adapter submits, polls and downloads inside it), checks that a video really came back, prices it
 * and returns a `VideoResult`. A call that returns always has a video.
 */
import { getVideoModel, unsupportedVideoModelReason } from "../models/video-models.ts";
import { ensureOpenRouterVideoModels } from "../models/openrouter-videos.ts";
import { assertModelAllowed } from "../config/models.ts";
import { getProvider } from "../providers/registry.ts";
import { emitProviderWarning } from "../providers.ts";
import { withProviderSlot } from "../agent/governor.ts";
import { assertPathAllowed, isLocalPathInput } from "../utils/safe-io.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import { mp4DurationSeconds } from "../utils/mp4.ts";
import { base64ToBytes } from "../utils/base64.ts";
import { abortError, providerOptionsFrom } from "../utils/provider-call.ts";
import { BudgetExceededError, ConfigError, ValidationError } from "../types/errors.ts";
import { readImageInput } from "../image/generate.ts";
import type { ProviderVideoRequest, ReadClip, VideoInput, VideoOptions } from "../types/video.ts";
import { estimateVideoCostUsd } from "./pricing.ts";
import { resolveVideoRequest } from "./request.ts";
import { finishVideo, inheritFrom } from "./finish.ts";
import { GeneratedVideo, type VideoResult, videoOriginOf } from "./result.ts";

/** Default time the whole call may take, polling included (a clip takes seconds to minutes). */
const DEFAULT_TIMEOUT_MS = 600_000;
/** OpenRouter asks to poll every 10 to 30 seconds. */
const DEFAULT_POLL_MS = 10_000;
/** A clip may be this much longer than the limit before it counts as over it (an encoder rounds a "3 second" clip up a little). */
const SECONDS_TOLERANCE = 0.25;

/** How long an adapter has to end by itself after an abort before the call is cut off. */
const ABORT_GRACE_MS = 250;

// Runs the adapter; once the signal aborts it waits ABORT_GRACE_MS for the adapter's own error (which holds the job id), then rejects with an AbortError; in: generateVideo, out: the adapter's result.
function withAbortGrace<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal, "Video generation aborted"));
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      timer = setTimeout(() => reject(abortError(signal, "Video generation aborted")), ABORT_GRACE_MS);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    task()
      .then(resolve, reject)
      .finally(() => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      });
  });
}

// Reads one clip: a video the SDK made goes in as its bytes, anything else through the media normalizer (a local path must be inside `fileAccess.roots` when set); its length is read from the file when it is an MP4 or MOV; in: generateVideo, out: the media and its seconds.
async function readClip(input: VideoInput, fileAccess?: { roots?: string[] }): Promise<ReadClip> {
  if (input instanceof GeneratedVideo) {
    return {
      media: { mimeType: input.mimeType, base64Data: input.base64, dataUrl: input.dataUrl },
      ...(input.durationSeconds !== undefined ? { seconds: input.durationSeconds } : {}),
    };
  }
  if (fileAccess?.roots && isLocalPathInput(input)) await assertPathAllowed(input, fileAccess.roots);
  const media = await normalizeMediaInput(input);
  if (!media.mimeType.startsWith("video/"))
    throw new ValidationError(
      `[Agent Accelerator] A reference video has the type "${media.mimeType}", which is not a video.`
    );
  const seconds = mp4DurationSeconds(base64ToBytes(media.base64Data));
  return { media, ...(seconds !== undefined ? { seconds } : {}) };
}

/**
 * Makes one video with a known video model. `model` is a `provider/model` string from `listVideoModels()`; every other option is
 * checked against what that model supports: a length, tier, ratio or size it does not make, a picture role it has no use for, or too
 * many reference pictures or clips is one `ValidationError` listing every problem, and a control the model does not have at all is
 * dropped with a single `provider_warning`. A reference clip longer than the model's limit is refused too (its length is read from
 * MP4 and MOV files; other containers are left to the provider). Throws `ConfigError` for an unknown model or a missing key,
 * `ModelNotAllowedError` for a model outside the `setModels` list, `BudgetExceededError` over `budget.maxCostUsd`, `TimeoutError`
 * when `timeoutMs` passes (the error carries the provider's `jobId`), `ProviderError` when no video comes back, and `AbortError`
 * when `signal` aborts. A job already running at the provider is not cancelled by a timeout or an abort: keep `error.jobId`.
 *
 * @example `const r = await generateVideo({ model: "google/gemini-omni-1.2-flash", prompt: "A marble on a chain reaction track", duration: 6 }); await r.video.save("marble.mp4");`
 */
export async function generateVideo(opts: VideoOptions): Promise<VideoResult> {
  const modelText = String(opts?.model ?? "");
  // OpenRouter's video models come from its own list, read once and cached: make sure it is there before the lookup.
  if (modelText.toLowerCase().startsWith("openrouter/"))
    await ensureOpenRouterVideoModels(opts.fetch ? { fetch: opts.fetch } : {});
  const def = getVideoModel(modelText);
  if (!def) throw new ConfigError(`[Agent Accelerator] ${unsupportedVideoModelReason(modelText) ?? "No model given."}`);
  assertModelAllowed(def.provider, def.id);
  // Continuing a clip: only on the model that made it, from the provider's own id of that call.
  let previousId: string | undefined;
  if (opts.continueFrom !== undefined) {
    if (!(opts.continueFrom instanceof GeneratedVideo))
      throw new ValidationError("[Agent Accelerator] continueFrom must be a clip from generateVideo.");
    const origin = videoOriginOf(opts.continueFrom);
    if (!origin)
      throw new ValidationError(
        "[Agent Accelerator] This clip was not made by generateVideo, so there is nothing to continue from."
      );
    if (origin.model !== def.model)
      throw new ValidationError(
        `[Agent Accelerator] A clip can only be edited by the model that made it (${origin.model}); this call asked for ${def.model}.`
      );
    if (!origin.chainId)
      throw new ValidationError(
        `[Agent Accelerator] ${def.model} did not return an id for this clip, so it cannot be continued.`
      );
    previousId = origin.chainId;
  }
  const { request, warnings } = resolveVideoRequest(opts, def);
  for (const w of warnings)
    emitProviderWarning({
      provider: def.provider,
      capability: w.capability,
      requested: `${w.requested} (${def.model})`,
      reason: w.reason,
      fallback: w.fallback,
    });

  const provider = getProvider(def.provider);
  if (!provider.generateVideo)
    throw new ConfigError(`[Agent Accelerator] The ${def.provider} provider cannot make videos yet.`);

  const maxCost = opts.budget?.maxCostUsd;
  if (maxCost !== undefined) {
    if (!(typeof maxCost === "number" && Number.isFinite(maxCost) && maxCost > 0))
      throw new ValidationError("[Agent Accelerator] budget.maxCostUsd must be a number greater than 0.");
    const estimate = estimateVideoCostUsd(def, request.durationSeconds, request.resolution);
    if (estimate !== undefined && estimate > maxCost)
      throw new BudgetExceededError(
        `[Agent Accelerator] Estimated cost $${estimate.toFixed(4)} for ${request.durationSeconds} s on ${def.model} is above budget.maxCostUsd $${maxCost}.`
      );
  }

  const timeoutOpt = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!(typeof timeoutOpt === "number" && timeoutOpt >= 0))
    throw new ValidationError(
      "[Agent Accelerator] timeoutMs must be a number of milliseconds (0 or Infinity = no limit)."
    );
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  if (!(typeof pollMs === "number" && Number.isFinite(pollMs) && pollMs > 0))
    throw new ValidationError("[Agent Accelerator] pollIntervalMs must be a number of milliseconds above 0.");

  // Read every picture and clip, then check the clip lengths the provider states.
  const roots = opts.fileAccess;
  const firstFrame = opts.firstFrame !== undefined ? await readImageInput(opts.firstFrame, roots) : undefined;
  const lastFrame = opts.lastFrame !== undefined ? await readImageInput(opts.lastFrame, roots) : undefined;
  const referenceImages = await Promise.all((opts.referenceImages ?? []).map((i) => readImageInput(i, roots)));
  const referenceVideos = await Promise.all((opts.referenceVideos ?? []).map((v) => readClip(v, roots)));
  const clips = def.references.videos;
  if (typeof clips === "object") {
    const problems = referenceVideos.flatMap((c, i) =>
      c.seconds !== undefined && c.seconds > clips.clipSeconds + SECONDS_TOLERANCE
        ? [
            `referenceVideos[${i}]: ${c.seconds.toFixed(1)} s; ${def.model} takes clips up to ${clips.clipSeconds} s. Cut it shorter.`,
          ]
        : []
    );
    if (problems.length > 0)
      throw new ValidationError(
        `[Agent Accelerator] Invalid video request for ${def.model} (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.map((p, i) => `(${i + 1}) ${p}`).join(" ")}`,
        { provider: def.provider, model: def.id }
      );
  }

  const deadlineMs = timeoutOpt === 0 ? Infinity : timeoutOpt;
  const providerOptions = providerOptionsFrom(opts, Number.isFinite(deadlineMs) ? deadlineMs : 0);
  const signal = opts.signal ?? new AbortController().signal;
  if (signal.aborted) throw abortError(signal, "Video generation aborted");

  const body: ProviderVideoRequest = {
    referenceImages,
    referenceVideos,
    deadlineMs,
    pollIntervalMs: pollMs,
    ...(previousId ? { previousId } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(request.prompt ? { prompt: request.prompt } : {}),
    ...(request.durationSeconds !== undefined ? { durationSeconds: request.durationSeconds } : {}),
    ...(request.durationAuto ? { durationAuto: true } : {}),
    ...(request.resolution ? { resolution: request.resolution } : {}),
    ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
    ...(request.size ? { size: request.size } : {}),
    ...(firstFrame ? { firstFrame } : {}),
    ...(lastFrame ? { lastFrame } : {}),
    ...(request.audio !== undefined ? { audio: request.audio } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };
  const started = Date.now();
  // The deadline is enforced by the adapter (it knows the job id). An abort goes to the adapter first so its error can carry the job id; only an adapter that ignores its signal is cut off, after a short grace.
  const res = await withProviderSlot(def.provider, signal, () =>
    withAbortGrace(() => provider.generateVideo!(def.id, body, { ...providerOptions, signal }), signal)
  );
  return finishVideo({ def, res, maxCost, captureRaw: opts.captureRaw, inherit: inheritFrom(opts), started });
}
