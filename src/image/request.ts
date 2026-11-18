/**
 * Checks an image request against what the chosen model supports (`models/image-models.ts`) and turns it into the one
 * request every adapter receives. Pure: no network, no files. A value a model supports but was not given a valid value for
 * (a ratio, tier, quality, format, thinking level or reference-image count outside its list) is a problem that fails the
 * whole call with ONE `ValidationError` listing every problem; a control the model does not have at all (`quality` on a
 * Google model) becomes a warning and is dropped, so the same code keeps working across models.
 */
import { ValidationError } from "../types/errors.ts";
import type { ImageModelInfo, ImageSizeRules } from "../models/image-models.ts";
import type { ImageFormat, ImageOptions, ImageResolution } from "../types/image.ts";
import type { ThinkingLevel } from "../types/core.ts";

/** Most pictures one call may ask for (the OpenAI per-request maximum; Google models are called several times). */
export const MAX_IMAGES = 10;

/** A control the model does not have: reported once on the bus by the caller, then dropped. */
export interface ImageWarning {
  capability: string;
  requested: string;
  reason: string;
  fallback: string;
}

/** The request after the checks: values are final, the size is computed, `count` is how many pictures are wanted in total. */
export interface ResolvedImageRequest {
  def: ImageModelInfo;
  prompt: string;
  aspectRatio?: string;
  resolution?: ImageResolution;
  size?: string;
  quality?: string;
  format?: ImageFormat;
  background?: "transparent" | "opaque" | "auto";
  thinking?: ThinkingLevel;
  count: number;
  referenceCount: number;
}

// The picture area each tier aims for on a model that takes exact sizes: 1K = 1024 x 1024 pixels, 2K = 2048 x 2048, like Google's tiers (4K is capped by the model's own maximum, see sizeFromTier); in: sizeFromTier, out: the edge of the square with that area.
const TIER_EDGE: Record<ImageResolution, number> = { "512": 512, "1K": 1024, "2K": 2048, "4K": 4096 };

// "16:9" as [16, 9], or undefined when it is not a ratio; in: the ratio checks, out: its two numbers.
function ratioOf(text: string): [number, number] | undefined {
  const m = /^(\d+):(\d+)$/.exec(text);
  return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? [Number(m[1]), Number(m[2])] : undefined;
}

// Checks a WIDTHxHEIGHT against the size rules of an OpenAI model, pushing one problem per broken rule; in: size checks, out: problems.
function checkPixels(w: number, h: number, rules: ImageSizeRules, problems: string[], what: string): void {
  if (w % rules.multipleOf !== 0 || h % rules.multipleOf !== 0)
    problems.push(`${what} ${w}x${h}: width and height must be multiples of ${rules.multipleOf}.`);
  if (Math.max(w, h) > rules.maxEdge)
    problems.push(`${what} ${w}x${h}: no side may be longer than ${rules.maxEdge} px.`);
  if (Math.max(w, h) / Math.min(w, h) > rules.maxRatio)
    problems.push(`${what} ${w}x${h}: the long side may be at most ${rules.maxRatio} times the short side.`);
  if (w * h < rules.minPixels)
    problems.push(`${what} ${w}x${h}: too small (at least ${rules.minPixels} pixels); use a higher resolution.`);
  if (w * h > rules.maxPixels)
    problems.push(
      `${what} ${w}x${h}: too large (at most ${rules.maxPixels} pixels); use a lower resolution or a wider ratio.`
    );
}

// The WIDTHxHEIGHT for a ratio and tier on a model with exact-size rules: the tier's area (4K: at most the model's pixel maximum) at that ratio, no side past the maximum edge, both sides rounded to the multiple and kept under the pixel maximum; in: resolveImageRequest, out: [width, height].
function sizeFromTier(ratio: [number, number], tier: ImageResolution, rules: ImageSizeRules): [number, number] {
  const area = Math.min(TIER_EDGE[tier] ** 2, rules.maxPixels);
  let w = Math.sqrt((area * ratio[0]) / ratio[1]);
  let h = (w * ratio[1]) / ratio[0];
  const long = Math.max(w, h);
  if (long > rules.maxEdge) {
    w = (w * rules.maxEdge) / long;
    h = (h * rules.maxEdge) / long;
  }
  const snap = (x: number): number => Math.max(rules.multipleOf, Math.round(x / rules.multipleOf) * rules.multipleOf);
  let [sw, sh] = [snap(w), snap(h)];
  while (sw * sh > rules.maxPixels) w >= h ? (sw -= rules.multipleOf) : (sh -= rules.multipleOf);
  return [sw, sh];
}

const list = (items: readonly string[]): string => items.join(", ");

/**
 * Checks `opts` against `def` and returns the final request and the warnings. Throws one `ValidationError` that lists
 * every problem (so one fix round is enough).
 */
export function resolveImageRequest(
  opts: ImageOptions,
  def: ImageModelInfo
): { request: ResolvedImageRequest; warnings: ImageWarning[] } {
  const problems: string[] = [];
  const warnings: ImageWarning[] = [];
  const drop = (capability: string, requested: string, reason: string): void =>
    void warnings.push({ capability, requested, reason, fallback: "the model's default (the option is not sent)" });

  const prompt = typeof opts.prompt === "string" ? opts.prompt.trim() : "";
  if (!prompt) problems.push("prompt: required, a non-empty string.");
  else if (def.limits.promptChars !== undefined && prompt.length > def.limits.promptChars)
    problems.push(`prompt: ${prompt.length} characters; this model takes at most ${def.limits.promptChars}.`);

  // How many pictures.
  const n = opts.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES)
    problems.push(`n: must be a whole number from 1 to ${MAX_IMAGES}; got ${JSON.stringify(opts.n)}.`);

  // Reference images.
  const referenceCount = opts.images?.length ?? 0;
  if (opts.images !== undefined && !Array.isArray(opts.images)) problems.push("images: must be a list of pictures.");
  else if (def.referenceImages.max !== undefined && referenceCount > def.referenceImages.max)
    problems.push(`images: ${referenceCount} reference images; this model takes at most ${def.referenceImages.max}.`);
  else if (referenceCount > 1 && def.referenceImages.note)
    warnings.push({
      capability: "reference images",
      requested: `${referenceCount} images`,
      reason: def.referenceImages.note,
      fallback: "sending them anyway (results may be weaker)",
    });

  // Aspect ratio and size tier / exact size.
  const rules = def.sizeRules;
  let aspectRatio = opts.aspectRatio;
  let size = opts.size;
  let resolution = opts.resolution;
  if (aspectRatio !== undefined && !ratioOf(aspectRatio)) {
    problems.push(`aspectRatio: "${aspectRatio}" is not a ratio like "16:9".`);
    aspectRatio = undefined;
  }
  if (aspectRatio !== undefined && Array.isArray(def.aspectRatios) && !def.aspectRatios.includes(aspectRatio))
    problems.push(
      `aspectRatio: "${aspectRatio}" is not available on ${def.model}. It makes: ${list(def.aspectRatios as string[])}.`
    );
  if (aspectRatio !== undefined && def.aspectRatios === "any" && rules) {
    const [w, h] = ratioOf(aspectRatio) ?? [1, 1];
    if (Math.max(w, h) / Math.min(w, h) > rules.maxRatio)
      problems.push(
        `aspectRatio: "${aspectRatio}" is not available on ${def.model}: the long side may be at most ${rules.maxRatio} times the short side.`
      );
  }
  if (resolution !== undefined && def.resolutions && !def.resolutions.includes(resolution))
    problems.push(
      `resolution: "${resolution}" is not available on ${def.model}. It makes: ${list(def.resolutions)}${def.resolutions.length === 1 ? " only" : ""}.`
    );
  if (resolution !== undefined && !def.resolutions && !rules)
    problems.push(`resolution: ${def.model} has no size control.`);
  if (size !== undefined) {
    if (!rules) {
      drop("size", size, "this model makes pictures by aspectRatio and resolution, not exact sizes.");
      size = undefined;
    } else if (aspectRatio !== undefined || resolution !== undefined) {
      problems.push("size: cannot be combined with aspectRatio or resolution; give an exact size OR a ratio and tier.");
    } else if (size !== "auto") {
      const m = /^(\d+)x(\d+)$/.exec(size);
      if (!m) problems.push(`size: "${size}" is not "WIDTHxHEIGHT" (for example "1536x864") or "auto".`);
      else {
        const [w, h] = [Number(m[1]), Number(m[2])];
        checkPixels(w, h, rules, problems, "size");
        const exp = rules.experimentalAbove;
        if (exp && w * h > exp.width * exp.height)
          warnings.push({
            capability: "size",
            requested: size,
            reason: `OpenAI calls sizes above ${exp.width}x${exp.height} experimental.`,
            fallback: "sending it as asked",
          });
      }
    }
  } else if (rules && (aspectRatio !== undefined || resolution !== undefined) && problems.length === 0) {
    // An exact-size model: turn the ratio and tier into pixels (1:1 and 1K when only one is given).
    const tier = resolution ?? "1K";
    const [w, h] = sizeFromTier(ratioOf(aspectRatio ?? "1:1") ?? [1, 1], tier, rules);
    checkPixels(w, h, rules, problems, `resolution ${tier} at ${aspectRatio ?? "1:1"} gives`);
    size = `${w}x${h}`;
    resolution = undefined;
    aspectRatio = undefined;
  }

  // Quality.
  let quality = opts.quality;
  if (quality !== undefined) {
    if (!def.quality) {
      drop("quality", quality, "this model has no quality control.");
      quality = undefined;
    } else if (!def.quality.includes(quality))
      problems.push(`quality: "${quality}" is not available on ${def.model}. It takes: ${list(def.quality)}.`);
  }

  // Format and background.
  const format = opts.format;
  if (format !== undefined && !def.formats.includes(format))
    problems.push(`format: "${format}" is not available on ${def.model}. It makes: ${list(def.formats)}.`);
  let background = opts.background;
  if (background !== undefined) {
    if (!def.backgrounds) {
      drop("background", background, "this model has no background control.");
      background = undefined;
    } else if (!def.backgrounds.includes(background))
      problems.push(
        `background: "${background}" is not available on ${def.model}. It takes: ${list(def.backgrounds)}.`
      );
    else if (background === "transparent" && format === "jpeg")
      problems.push('background: "transparent" needs the png or webp format, not jpeg.');
  }

  // Thinking.
  let thinking = opts.thinking;
  if (thinking === "dynamic") thinking = undefined; // the model's own default
  if (thinking !== undefined) {
    if (!def.thinking) {
      drop("thinking", thinking, "this model has no thinking control.");
      thinking = undefined;
    } else if (!def.thinking.levels.includes(thinking))
      problems.push(
        `thinking: "${thinking}" is not available on ${def.model}. It takes: ${list(def.thinking.levels)} (default ${def.thinking.default}).`
      );
  }

  if (problems.length > 0)
    throw new ValidationError(
      `[Agent Accelerator] Invalid image request for ${def.model} (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.map((p, i) => `(${i + 1}) ${p}`).join(" ")}`,
      { provider: def.provider, model: def.id }
    );

  const request: ResolvedImageRequest = { def, prompt, count: n, referenceCount };
  if (aspectRatio !== undefined) request.aspectRatio = aspectRatio;
  if (resolution !== undefined) request.resolution = resolution;
  if (size !== undefined) request.size = size;
  if (quality !== undefined) request.quality = quality;
  if (format !== undefined) request.format = format;
  if (background !== undefined) request.background = background;
  if (thinking !== undefined) request.thinking = thinking;
  return { request, warnings };
}

/** The estimated cost of `count` pictures when the table knows the tokens per picture (Google models), else `undefined` (unknown stays unknown). Image output only: prompt and reference tokens are not counted. */
export function estimateImageCostUsd(
  def: ImageModelInfo,
  resolution: ImageResolution | undefined,
  count: number
): number | undefined {
  const tokens = def.tokensPerImage?.[resolution ?? def.defaultResolution ?? ""];
  return tokens === undefined ? undefined : (tokens * def.prices.imageOutput * count) / 1_000_000;
}
