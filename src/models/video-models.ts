/**
 * The video generation models the SDK knows, as small tables of facts: what each one takes in (prompt, first/last frame pictures,
 * reference pictures and clips), the durations, resolutions and aspect ratios it makes, whether it writes audio, its limits and its
 * prices. Google is curated by hand from Google's own pages (checked 21 Nov 2026); a fact the provider does not state is left out,
 * never guessed. OpenRouter serves dozens of video models that change often, so its entries come from OpenRouter's own public
 * list, cached in the home folder (`openrouter-videos.ts`). models.dev is not used for these.
 *
 * Google has ONE video model here, `gemini-omni-1.2-flash`. Its predecessor `gemini-omni-1.1-flash` is not listed on purpose:
 * Google reroutes it to 1.2 from 3 Dec 2026, so an old id is simply "not a known video model".
 */
import { openRouterVideoModels } from "./openrouter-videos.ts";

/** Which end of the clip a picture fixes. */
export type VideoFrameRole = "first_frame" | "last_frame";

/** How many reference clips a model takes. */
export interface VideoClipReferences {
  /** Clips per request. */
  maxClips: number;
  /** Longest clip, in seconds. */
  clipSeconds: number;
  /** Above `aboveSeconds` of output the limit is `maxClips` instead (Google: 1 clip for a clip of 11 s or more). */
  longOutput?: { aboveSeconds: number; maxClips: number };
}

/** Prices of a Google video model in USD per 1M tokens; the output is billed per second of video at a token rate that depends on the resolution. */
export interface VideoTokenPrices {
  /** Prompt and input pictures or clips. */
  inputPerMillion: number;
  /** Text the model writes next to the video. */
  textOutputPerMillion: number;
  videoOutputPerMillion: number;
  /** Output tokens one second of video costs, by resolution. */
  outputTokensPerSecond: Readonly<Record<string, number>>;
}

/** One supported video model and everything it can and cannot do. */
export interface VideoModelInfo {
  /** The full `provider/id` string to pass as `model`. */
  model: string;
  provider: "google" | "openrouter";
  id: string;
  name: string;
  description: string;
  /** Release date `YYYY-MM-DD` as the provider states it. Unset when not stated. */
  released?: string;
  /** Clip lengths in whole seconds the model makes, sorted. */
  durations: readonly number[];
  /** The model can also pick the length itself (OpenRouter `-1`: for example following an input video). */
  durationAuto?: boolean;
  /** Used when the call names none (Google states it; OpenRouter does not). */
  defaultDuration?: number;
  /** Resolution tiers as the provider spells them (`360p` ... `1080p`, `1K`, `2K`, `4K`). Empty = not stated. */
  resolutions: readonly string[];
  defaultResolution?: string;
  /** Aspect ratios (`"16:9"`). Empty = not stated. */
  aspectRatios: readonly string[];
  /** Exact `WIDTHxHEIGHT` sizes the model lists (OpenRouter). */
  sizes?: readonly string[];
  /** Which ends of the clip a picture may fix. Empty = the model is prompt-only. */
  frames: readonly VideoFrameRole[];
  /** The model can write audio with the video. Unset = not stated. */
  audio?: boolean;
  /** The model takes a `seed`. Unset = not stated. */
  seed?: boolean;
  /** Reference pictures and clips (guidance without fixing frames). `"unknown"` = the provider does not state it. */
  references: {
    images: { max?: number } | "unknown";
    videos: "no" | "unknown" | VideoClipReferences;
  };
  /** Limits as the provider states them (unset = not stated). */
  limits?: {
    /** Longest video the model takes to edit or extend, in seconds. */
    inputVideoSeconds?: number;
    /** Two fixed frames (first and last) allow at most this many seconds. */
    framePairMaxSeconds?: number;
    /** A video above this many bytes must be delivered as a link, not inline. */
    inlineOutputBytes?: number;
  };
  /** Request fields the provider accepts beyond the common ones (OpenRouter `allowed_passthrough_parameters`). */
  passthrough?: readonly string[];
  /** Google: exact prices. Unset = the price is unknown (OpenRouter reports the cost of each job itself). */
  prices?: VideoTokenPrices;
  /** OpenRouter: the price entries as listed (units differ per model); not interpreted by the SDK. */
  pricingSkus?: Readonly<Record<string, string>>;
}

/** The Google video model (`POST /v1beta/interactions` with `response_format: { type: "video" }`). Facts and prices: Google's Gemini Omni guide, pricing and changelog pages, checked 21 Nov 2026. */
const GOOGLE: readonly VideoModelInfo[] = [
  {
    model: "google/gemini-omni-1.2-flash",
    provider: "google",
    id: "gemini-omni-1.2-flash",
    name: "Gemini Omni 1.2 Flash",
    description:
      "Google's native multimodal video model: makes and edits clips of 3 to 15 seconds with audio from text, pictures and clips, and goes on from an earlier clip in conversation.",
    released: "2026-11-05",
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    defaultDuration: 10,
    // Google spells 4K as "4k" on the wire; the adapter lower-cases it. 1080p and 4K are upscaled from 720p.
    resolutions: ["360p", "720p", "1080p", "4K"],
    defaultResolution: "720p",
    aspectRatios: ["16:9", "9:16"],
    frames: ["first_frame", "last_frame"],
    audio: true,
    seed: true,
    references: {
      images: { max: 6 },
      videos: { maxClips: 3, clipSeconds: 3, longOutput: { aboveSeconds: 10, maxClips: 1 } },
    },
    limits: { inputVideoSeconds: 15, framePairMaxSeconds: 10, inlineOutputBytes: 4_000_000 },
    prices: {
      inputPerMillion: 1.5,
      textOutputPerMillion: 9,
      videoOutputPerMillion: 12,
      outputTokensPerSecond: { "360p": 1931, "720p": 5792, "1080p": 8688, "4K": 17376 },
    },
  },
];

// `provider/id`, trimmed; a bare id has no provider; in: getVideoModel and unsupportedVideoModelReason, out: the parts.
function split(model: string): { provider?: string; id: string } {
  const text = String(model ?? "").trim();
  const slash = text.indexOf("/");
  if (slash <= 0) return { id: text.toLowerCase() };
  const provider = text.slice(0, slash).toLowerCase();
  return { provider: provider === "gemini" ? "google" : provider, id: text.slice(slash + 1) };
}

// Every known model: the curated Google table plus the OpenRouter models read from the cached list; in: the public functions, out: the entries.
function all(): readonly VideoModelInfo[] {
  return [...GOOGLE, ...openRouterVideoModels()];
}

/**
 * The known video models, sorted by `model`; pass a provider (`"google"`, `"openrouter"`) to see only its models.
 * The OpenRouter models come from the list cached by the last refresh (empty until `generateVideo` or
 * `refreshOpenRouterVideoModels` has read it once). A `setModels` list does not hide a model here; it still stops a call.
 */
export function listVideoModels(provider?: string): readonly VideoModelInfo[] {
  const wanted = provider ? split(`${provider}/x`).provider : undefined;
  return all()
    .filter((m) => !wanted || m.provider === wanted)
    .sort((a, b) => a.model.localeCompare(b.model));
}

/** One known video model by its `provider/id` string (a bare id matches when only one provider has it), or `undefined`. */
export function getVideoModel(model: string): VideoModelInfo | undefined {
  const { provider, id } = split(model);
  const found = all().filter((m) => m.id.toLowerCase() === id.toLowerCase() && (!provider || m.provider === provider));
  return provider || found.length === 1 ? found[0] : undefined;
}

/** Why `model` is not a known video model, or `undefined` when it is known. */
export function unsupportedVideoModelReason(model: string): string | undefined {
  if (getVideoModel(model)) return undefined;
  const { provider } = split(model);
  const known = all()
    .map((m) => m.model)
    .join(", ");
  const openrouterNote =
    provider === "openrouter"
      ? " (the OpenRouter list is read when the first video is made; it may not be loaded yet)"
      : "";
  return `"${model}" is not a known video model${openrouterNote}. Known video models: ${known}.`;
}
