/**
 * OpenRouter's video generation models, read from OpenRouter's own public list (`GET /api/v1/videos/models`, no key needed) and
 * cached in the catalog folder (`<cache>/openrouter-videos.json`, see `openrouter-list.ts` for the refresh rules). OpenRouter serves
 * dozens of video models that change often, so the SDK keeps no hand-written table for them: each entry carries the durations,
 * resolutions, ratios, frame roles and audio flag the request checks need. Only models that make a video from a prompt (and
 * optionally pictures) are kept: the list also holds source-video tools (upscalers, editors, avatar makers) that have no
 * `supported_durations`; those are skipped. The list says nothing about which models read a reference VIDEO, so that stays unknown.
 */
import { createOpenRouterList, type OpenRouterList, type RefreshOpenRouterListOptions } from "./openrouter-list.ts";
import { isRecord } from "../utils/guards.ts";
import type { VideoModelInfo } from "./video-models.ts";

const DEFAULT_URL = "https://openrouter.ai/api/v1/videos/models";

/** Ids OpenRouter still lists that this SDK deliberately does not know: Google's previous generation, which Google reroutes to `gemini-omni-1.2-flash` (so there is one Omni model, and an old id is simply not found). */
const NOT_KNOWN = new Set(["google/gemini-omni-1.1-flash"]);

/** Options of a refresh. */
export type RefreshOpenRouterVideosOptions = RefreshOpenRouterListOptions;

// The strings of a list field, or undefined when it is not a list of strings; in: toModel, out: the strings.
function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

// A list field of whole numbers, or undefined; in: toModel, out: the numbers.
function integers(v: unknown): number[] | undefined {
  return Array.isArray(v) && v.length > 0 && v.every((x) => Number.isInteger(x)) ? (v as number[]) : undefined;
}

// One entry of OpenRouter's list as our model info, or undefined for an entry that is not usable (no id, no durations because it is not a prompt-to-video model, a model this SDK does not know, or expired); in: parseList, out: the entry.
function toModel(raw: unknown, now: number): VideoModelInfo | undefined {
  if (!isRecord(raw) || typeof raw["id"] !== "string" || !raw["id"]) return undefined;
  const id = raw["id"];
  if (NOT_KNOWN.has(id)) return undefined;
  const all = integers(raw["supported_durations"]);
  if (!all) return undefined; // upscalers, editors and avatar makers state no durations
  const expires = typeof raw["expiration_date"] === "string" ? Date.parse(raw["expiration_date"]) : NaN;
  if (Number.isFinite(expires) && expires <= now) return undefined;
  const durations = all.filter((d) => d > 0).sort((a, b) => a - b);
  if (durations.length === 0) return undefined;
  const frames = (strings(raw["supported_frame_images"]) ?? []).filter(
    (f): f is "first_frame" | "last_frame" => f === "first_frame" || f === "last_frame"
  );
  const skus = isRecord(raw["pricing_skus"]) ? raw["pricing_skus"] : undefined;
  const sizes = strings(raw["supported_sizes"]);
  const passthrough = strings(raw["allowed_passthrough_parameters"]);
  return {
    model: `openrouter/${id}`,
    provider: "openrouter",
    id,
    name: typeof raw["name"] === "string" && raw["name"] ? raw["name"] : id,
    description:
      typeof raw["description"] === "string" && raw["description"]
        ? raw["description"]
        : `${id} through OpenRouter's video endpoint.`,
    durations,
    ...(all.includes(-1) ? { durationAuto: true } : {}),
    resolutions: strings(raw["supported_resolutions"]) ?? [],
    aspectRatios: strings(raw["supported_aspect_ratios"]) ?? [],
    ...(sizes && sizes.length > 0 ? { sizes } : {}),
    frames,
    ...(typeof raw["generate_audio"] === "boolean" ? { audio: raw["generate_audio"] } : {}),
    ...(typeof raw["seed"] === "boolean" ? { seed: raw["seed"] } : {}),
    // The list does not say how many reference pictures a model takes, nor whether it reads a reference video.
    references: { images: "unknown", videos: "unknown" },
    ...(passthrough && passthrough.length > 0 ? { passthrough } : {}),
    // Kept as OpenRouter states them (units differ per model: seconds, tokens, cents); OpenRouter reports the real cost of each job.
    ...(skus
      ? {
          pricingSkus: Object.fromEntries(
            Object.entries(skus).filter((e): e is [string, string] => typeof e[1] === "string")
          ),
        }
      : {}),
  };
}

// Turns OpenRouter's `{ data: [...] }` into model infos (unusable entries are skipped); throws when the body is not the list; in: refresh, out: the models.
function parseList(body: unknown, now: number): VideoModelInfo[] {
  const data = isRecord(body) ? body["data"] : undefined;
  if (!Array.isArray(data)) throw new Error("the reply has no `data` list");
  const models = data.flatMap((raw) => {
    const m = toModel(raw, now);
    return m ? [m] : [];
  });
  if (models.length === 0) throw new Error("the list has no video model");
  return models;
}

const list = createOpenRouterList<VideoModelInfo>({
  file: "openrouter-videos.json",
  url: DEFAULT_URL,
  what: "video model list",
  codes: { writeFailed: "video_models_cache_write_failed", refreshFailed: "video_models_refresh_failed" },
  parse: parseList,
});

/** The OpenRouter video models from the saved list, read from disk without any network call (empty until the list was downloaded once). */
export const openRouterVideoModels: OpenRouterList<VideoModelInfo>["read"] = list.read;

/**
 * Downloads OpenRouter's video model list and saves it (unless the saved copy is still fresh and `force` is not set).
 * Throws a `ProviderError` when the download fails or is not the list; the saved copy is left as it was.
 */
export const refreshOpenRouterVideoModels: OpenRouterList<VideoModelInfo>["refresh"] = list.refresh;

/**
 * The OpenRouter video models, downloading the list only when needed: a fresh saved copy is returned at once; a missing or stale
 * one is refreshed (one download at a time). If the refresh fails, a stale copy is still used (with a warning on the bus); without
 * any copy the failure is thrown. The `catalog_refresh: "off"` setting never downloads: the saved copy, or `[]`, is returned.
 */
export const ensureOpenRouterVideoModels: OpenRouterList<VideoModelInfo>["ensure"] = list.ensure;

/** Forgets the in-memory copy and the failure backoff (tests only). */
export const resetOpenRouterVideosCache: OpenRouterList<VideoModelInfo>["reset"] = list.reset;
