/**
 * Checks a video request against what the chosen model supports (`models/video-models.ts`) and turns it into the one request the
 * rest of the call works from. Pure: no network, no files. A value a model does not accept (a length, tier, ratio or size outside its
 * list, a picture role it has no use for, too many reference pictures or clips) is a problem that fails the whole call with ONE
 * `ValidationError` listing every problem; a control the model does not have at all (`seed`, `size`, a switch for audio) becomes a
 * warning and is dropped, so the same code keeps working across models. Pictures and clips are content, not controls, so they are never
 * dropped: asking for a first frame from a model that takes none is an error, not a silent text-to-video.
 */
import { ValidationError } from "../types/errors.ts";
import type { VideoModelInfo } from "../models/video-models.ts";
import type { VideoOptions } from "../types/video.ts";

/** A control the model does not have: reported once on the bus by the caller, then dropped (or, for a clip a provider may ignore, sent as asked). */
interface VideoWarning {
  capability: string;
  requested: string;
  reason: string;
  fallback: string;
}

/** The request after the checks: values are final (the tier spelled as the model lists it), the media is only counted here. */
interface ResolvedVideoRequest {
  def: VideoModelInfo;
  prompt?: string;
  /** Whole seconds: the caller's, else the model's default. Unset when the model states none and none was given. */
  durationSeconds?: number;
  durationAuto?: boolean;
  resolution?: string;
  aspectRatio?: string;
  size?: string;
  hasFirstFrame: boolean;
  hasLastFrame: boolean;
  referenceImageCount: number;
  referenceVideoCount: number;
  audio?: boolean;
  seed?: number;
}

const list = (items: readonly (string | number)[]): string => items.join(", ");

// A value as it is spelled in a model's list (a case-insensitive match, so "4k" finds "4K"), or undefined; in: resolution checks, out: the listed spelling.
function spelled(value: string, listed: readonly string[]): string | undefined {
  return listed.find((x) => x.toLowerCase() === value.toLowerCase());
}

/**
 * Checks `opts` against `def` and returns the final request and the warnings. Throws one `ValidationError` that lists every
 * problem (so one fix round is enough).
 */
export function resolveVideoRequest(
  opts: VideoOptions,
  def: VideoModelInfo
): { request: ResolvedVideoRequest; warnings: VideoWarning[] } {
  const problems: string[] = [];
  const warnings: VideoWarning[] = [];
  const drop = (capability: string, requested: string, reason: string): void => {
    warnings.push({ capability, requested, reason, fallback: "the model's default (the option is not sent)" });
  };

  const hasFirstFrame = opts.firstFrame !== undefined;
  const hasLastFrame = opts.lastFrame !== undefined;

  // Prompt.
  const prompt = typeof opts.prompt === "string" ? opts.prompt.trim() : "";
  if (opts.prompt !== undefined && typeof opts.prompt !== "string") problems.push("prompt: must be a string.");
  else if (!prompt && !hasFirstFrame)
    problems.push("prompt: required, a non-empty string (only a call with a firstFrame may leave it out).");

  // Duration.
  let durationSeconds: number | undefined;
  let durationAuto: boolean | undefined;
  const d = opts.duration;
  if (d === "auto") {
    if (def.durationAuto) durationAuto = true;
    else problems.push(`duration: ${def.model} cannot choose the length itself; give one of: ${list(def.durations)}.`);
  } else if (d !== undefined) {
    if (!Number.isInteger(d) || (d as number) < 1)
      problems.push(`duration: must be a whole number of seconds; got ${JSON.stringify(d)}.`);
    else if (!def.durations.includes(d as number))
      problems.push(`duration: ${d} s is not available on ${def.model}. It makes: ${list(def.durations)} seconds.`);
    else durationSeconds = d as number;
  } else if (def.defaultDuration !== undefined && opts.continueFrom === undefined)
    durationSeconds = def.defaultDuration; // an edit keeps the clip's own length unless asked

  // Tier, ratio and exact size.
  let resolution = opts.resolution;
  let aspectRatio = opts.aspectRatio;
  let size = opts.size;
  if (resolution !== undefined) {
    const listed = def.resolutions.length > 0 ? spelled(String(resolution), def.resolutions) : undefined;
    if (def.resolutions.length === 0) drop("resolution", resolution, "this model lists no size tiers.");
    else if (!listed)
      problems.push(
        `resolution: "${resolution}" is not available on ${def.model}. It makes: ${list(def.resolutions)}.`
      );
    resolution = listed;
  }
  if (aspectRatio !== undefined) {
    if (def.aspectRatios.length === 0) {
      drop("aspect ratio", aspectRatio, "this model lists no aspect ratios.");
      aspectRatio = undefined;
    } else if (!def.aspectRatios.includes(aspectRatio))
      problems.push(
        `aspectRatio: "${aspectRatio}" is not available on ${def.model}. It makes: ${list(def.aspectRatios)}.`
      );
  }
  if (size !== undefined) {
    if (!def.sizes || def.sizes.length === 0) {
      drop("size", size, "this model lists no exact sizes: use resolution and aspectRatio.");
      size = undefined;
    } else if (aspectRatio !== undefined || opts.resolution !== undefined)
      problems.push("size: cannot be combined with aspectRatio or resolution; give an exact size OR a ratio and tier.");
    else if (!def.sizes.includes(size))
      problems.push(`size: "${size}" is not available on ${def.model}. It makes: ${list(def.sizes)}.`);
  }

  // A continued clip has its pictures already: new ones cannot be added.
  if (
    opts.continueFrom !== undefined &&
    (hasFirstFrame ||
      hasLastFrame ||
      (opts.referenceImages?.length ?? 0) > 0 ||
      (opts.referenceVideos?.length ?? 0) > 0)
  )
    problems.push(
      "continueFrom: an edit changes the clip with the prompt only; firstFrame, lastFrame, referenceImages and referenceVideos cannot be added to it."
    );

  // Pictures that fix a frame.
  if (hasFirstFrame && !def.frames.includes("first_frame"))
    problems.push(`firstFrame: ${def.model} takes no first frame (it makes a video from the prompt alone).`);
  if (hasLastFrame && !def.frames.includes("last_frame"))
    problems.push(
      `lastFrame: ${def.model} takes no last frame${def.frames.includes("first_frame") ? " (a first frame only)" : ""}.`
    );
  const limits = def.limits;
  if (
    hasFirstFrame &&
    hasLastFrame &&
    limits?.framePairMaxSeconds !== undefined &&
    durationSeconds !== undefined &&
    durationSeconds > limits.framePairMaxSeconds
  )
    problems.push(
      `duration: ${durationSeconds} s is too long with both a first and a last frame; ${def.model} allows at most ${limits.framePairMaxSeconds} s then.`
    );

  // Reference pictures.
  const referenceImageCount = opts.referenceImages?.length ?? 0;
  if (opts.referenceImages !== undefined && !Array.isArray(opts.referenceImages))
    problems.push("referenceImages: must be a list of pictures.");
  else if (
    def.references.images !== "unknown" &&
    def.references.images.max !== undefined &&
    referenceImageCount > def.references.images.max
  )
    problems.push(
      `referenceImages: ${referenceImageCount} pictures; ${def.model} takes at most ${def.references.images.max}.`
    );
  if (def.provider === "openrouter" && referenceImageCount > 0 && (hasFirstFrame || hasLastFrame))
    problems.push(
      "referenceImages: OpenRouter treats a call with first or last frames as image-to-video and ignores reference pictures; send frames OR reference pictures."
    );

  // Reference clips.
  const referenceVideoCount = opts.referenceVideos?.length ?? 0;
  if (opts.referenceVideos !== undefined && !Array.isArray(opts.referenceVideos))
    problems.push("referenceVideos: must be a list of videos.");
  else if (referenceVideoCount > 0) {
    const v = def.references.videos;
    if (v === "no") problems.push(`referenceVideos: ${def.model} reads no reference clips.`);
    else if (v === "unknown")
      warnings.push({
        capability: "reference videos",
        requested: `${referenceVideoCount} clip(s)`,
        reason:
          "the provider's list does not say whether this model reads reference clips; a provider that does not simply ignores them.",
        fallback: "sending them anyway (the model may ignore them)",
      });
    else {
      const max =
        v.longOutput && durationSeconds !== undefined && durationSeconds > v.longOutput.aboveSeconds
          ? v.longOutput.maxClips
          : v.maxClips;
      if (referenceVideoCount > max)
        problems.push(
          `referenceVideos: ${referenceVideoCount} clips; ${def.model} takes at most ${max}${max !== v.maxClips ? ` for a clip longer than ${v.longOutput!.aboveSeconds} s` : ""}, each up to ${v.clipSeconds} s.`
        );
    }
  }

  // Audio and seed.
  let audio = opts.audio;
  if (audio !== undefined && typeof audio !== "boolean") {
    problems.push("audio: must be true or false.");
    audio = undefined;
  } else if (audio === false && def.audioAlways) {
    drop("audio", "false", "this model always writes audio.");
    audio = undefined;
  } else if (audio === true && def.audio === false) {
    drop("audio", "true", "this model makes silent videos.");
    audio = undefined;
  }
  let seed = opts.seed;
  if (seed !== undefined) {
    if (!Number.isInteger(seed)) {
      problems.push(`seed: must be a whole number; got ${JSON.stringify(seed)}.`);
      seed = undefined;
    } else if (def.seed === false) {
      drop("seed", String(seed), "this model takes no seed.");
      seed = undefined;
    }
  }

  if (problems.length > 0)
    throw new ValidationError(
      `[Agent Accelerator] Invalid video request for ${def.model} (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.map((p, i) => `(${i + 1}) ${p}`).join(" ")}`,
      { provider: def.provider, model: def.id }
    );

  const request: ResolvedVideoRequest = { def, hasFirstFrame, hasLastFrame, referenceImageCount, referenceVideoCount };
  if (prompt) request.prompt = prompt;
  if (durationSeconds !== undefined) request.durationSeconds = durationSeconds;
  if (durationAuto) request.durationAuto = true;
  if (resolution !== undefined) request.resolution = resolution;
  if (aspectRatio !== undefined) request.aspectRatio = aspectRatio;
  if (size !== undefined) request.size = size;
  if (audio !== undefined) request.audio = audio;
  if (seed !== undefined) request.seed = seed;
  return { request, warnings };
}
