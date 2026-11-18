/**
 * The image-generation models the SDK supports, as a small curated table: what each one accepts (aspect ratios, sizes,
 * quality levels, reference images, thinking levels), its limits and its prices. models.dev is not used for these: it has
 * no price or limits for OpenAI's image models and does not list `gemini-nano-banana-2.1` for Google. Only image-generation
 * models are here; a model outside the table is not supported (`unsupportedImageModelReason` says why). Every number comes
 * from the provider's own pages (Google `ai.google.dev` pricing and model pages, OpenAI `developers.openai.com` model, pricing
 * and image-generation pages), checked 18 Nov 2026. A fact the provider does not state is left out, never guessed.
 * Google's Search grounding is never used and is not modelled here.
 */
import type { ThinkingLevel } from "../types/core.ts";

/** Prices in USD per 1M tokens. Image output is what makes an image cost money; the rest bills the prompt and any reference images. */
export interface ImageTokenPrices {
  textInput: number;
  /** Text (and thinking) the model writes next to the picture; unset when the model writes none. */
  textOutput?: number;
  imageInput: number;
  imageOutput: number;
  /** Image input served from the provider's cache (OpenAI bills it only when the call goes through its Responses image tool). */
  cacheRead?: number;
  /** Writing image input to the cache (listed for the 2.6 models by OpenRouter). */
  cacheWrite?: number;
}

/** A size rule for providers that take any WIDTHxHEIGHT (OpenAI). */
export interface ImageSizeRules {
  multipleOf: number;
  maxEdge: number;
  minPixels: number;
  maxPixels: number;
  /** Longest side divided by shortest side, at most. */
  maxRatio: number;
  /** Sizes the provider lists as the normal ones. */
  recommended: readonly string[];
  /** Larger than this (width x height) works but the provider calls it experimental. */
  experimentalAbove?: { width: number; height: number };
}

/** One supported image-generation model and everything it can and cannot do. */
export interface ImageModelInfo {
  /** The full `provider/id` string to pass as `model`. */
  model: string;
  provider: "google" | "openai";
  id: string;
  name: string;
  description: string;
  /** Release date `YYYY-MM-DD` (Google: as listed; OpenAI: its snapshot date). Unset when the provider does not state one. */
  released?: string;
  /** What the model takes in and gives out. */
  inputs: readonly ("text" | "image" | "video" | "pdf")[];
  outputs: readonly ("image" | "text")[];
  /** Token limits as the provider states them (unset = not stated). */
  limits: {
    inputTokens?: number;
    outputTokens?: number /** Longest prompt in characters (OpenAI: 32,000). */;
    promptChars?: number;
  };
  /** The aspect ratios the model accepts (`"16:9"`), or `any` within a ratio range (the size rules then decide). */
  aspectRatios: readonly string[] | "any";
  /** Resolution tiers (`image_size` on Google). Unset = the model has no tiers (OpenAI takes exact sizes). */
  resolutions?: readonly ("512" | "1K" | "2K" | "4K")[];
  defaultResolution?: "512" | "1K" | "2K" | "4K";
  /** Tokens one output image costs, by resolution tier (Google). */
  tokensPerImage?: Readonly<Record<string, number>>;
  /** Exact-size rules (OpenAI). */
  sizeRules?: ImageSizeRules;
  /** Quality levels (OpenAI). Unset = no quality control. */
  quality?: readonly string[];
  formats: readonly ("png" | "jpeg" | "webp")[];
  /** Backgrounds the model can make (OpenAI). Unset = no control. */
  backgrounds?: readonly ("transparent" | "opaque" | "auto")[];
  /** Reference images per request. `max` unset = the provider states no limit; `note` is a caution to show when many are sent. */
  referenceImages: { max?: number; note?: string };
  /** Images one request returns; asking for more makes the SDK send parallel requests. */
  imagesPerRequest: { max: number };
  /** Thinking levels the model accepts and its default; unset = the model has no thinking control. */
  thinking?: { levels: readonly ThinkingLevel[]; default: ThinkingLevel };
  /** Standard prices. Each output image is billed in image-output tokens at `imageOutput`. */
  prices: ImageTokenPrices;
  /** Batch prices (half price where the provider offers it); unset = no batch. */
  batchPrices?: ImageTokenPrices;
}

const GOOGLE_IMAGE_TOKENS = 30; // USD per 1M image-output tokens, both Google models

const GOOGLE_RATIOS_21 = [
  "1:1",
  "1:4",
  "1:8",
  "2:3",
  "3:2",
  "3:4",
  "4:1",
  "4:3",
  "4:5",
  "5:4",
  "8:1",
  "9:16",
  "16:9",
  "21:9",
] as const;
// Flash Lite: Google says 14 ratios but names only these 10, so only these are accepted.
const GOOGLE_RATIOS_LITE = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

const OPENAI_SIZE_RULES: ImageSizeRules = {
  multipleOf: 16,
  maxEdge: 3840,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxRatio: 3,
  recommended: ["1024x1024", "1536x1024", "1024x1536"],
};
const OPENAI_PRICES: ImageTokenPrices = { textInput: 5, imageInput: 8, imageOutput: 30, cacheRead: 2 };
// The 2.6 models: context and output of 400K tokens and a cache-write price, as OpenRouter lists them (it routes to OpenAI, so the model and its rates are the same).
const GPT_26_LIMITS = { promptChars: 32_000, inputTokens: 400_000, outputTokens: 400_000 };
const GPT_26_PRICES: ImageTokenPrices = { ...OPENAI_PRICES, cacheWrite: 10 };
const OPENAI_BATCH_PRICES: ImageTokenPrices = { textInput: 2.5, imageInput: 4, imageOutput: 15 };

// The four current OpenAI models differ only in what is listed in `overrides`; in: the table below, out: one ImageModelInfo.
function openai(
  id: string,
  name: string,
  description: string,
  released: string | undefined,
  overrides: Partial<ImageModelInfo> = {}
): ImageModelInfo {
  return {
    model: `openai/${id}`,
    provider: "openai",
    id,
    name,
    description,
    released,
    inputs: ["text", "image"],
    outputs: ["image"],
    limits: { promptChars: 32_000 },
    aspectRatios: "any",
    sizeRules: OPENAI_SIZE_RULES,
    quality: ["low", "medium", "high", "xhigh", "max", "auto"],
    formats: ["png", "jpeg", "webp"],
    backgrounds: ["transparent", "opaque", "auto"],
    referenceImages: { max: 16 },
    imagesPerRequest: { max: 10 },
    prices: OPENAI_PRICES,
    ...(released ? { released } : {}),
    ...overrides,
  };
}

/** Every supported image-generation model. Frozen: read it through `listImageModels` / `getImageModel`. */
const TABLE: readonly ImageModelInfo[] = [
  {
    model: "google/gemini-nano-banana-2.1",
    provider: "google",
    id: "gemini-nano-banana-2.1",
    name: "Nano Banana 2.1",
    description:
      "High-quality image generation and editing with enhanced factuality, visual fidelity and multi-turn consistency at Flash scale.",
    released: "2026-10-06",
    inputs: ["text", "image", "video", "pdf"],
    outputs: ["image", "text"],
    limits: { inputTokens: 131_072, outputTokens: 32_768 },
    aspectRatios: GOOGLE_RATIOS_21,
    resolutions: ["1K", "2K", "4K"],
    defaultResolution: "1K",
    // 1K and 2K from the size table; 4K from the pricing page (the size table says 2,520: to re-check against a real response).
    tokensPerImage: { "1K": 1120, "2K": 1680, "4K": 3780 },
    formats: ["png", "jpeg"],
    referenceImages: { max: 14 }, // up to 10 objects with high fidelity and up to 4 characters kept consistent
    imagesPerRequest: { max: 1 },
    thinking: { levels: ["minimal", "medium", "high"], default: "medium" },
    prices: { textInput: 1.5, textOutput: 7.5, imageInput: 1.5, imageOutput: GOOGLE_IMAGE_TOKENS },
    batchPrices: { textInput: 0.75, textOutput: 3.75, imageInput: 0.75, imageOutput: 15 },
  },
  {
    model: "google/gemini-3.1-flash-lite-image",
    provider: "google",
    id: "gemini-3.1-flash-lite-image",
    name: "Nano Banana 2 Lite",
    description:
      "The smallest and most cost-effective Google image model, built for generation and editing at scale (about 2 s).",
    released: "2026-06-30",
    inputs: ["text", "image", "video", "pdf"],
    outputs: ["image", "text"],
    limits: { inputTokens: 65_536, outputTokens: 4096 },
    aspectRatios: GOOGLE_RATIOS_LITE,
    resolutions: ["1K"],
    defaultResolution: "1K",
    tokensPerImage: { "1K": 1120 },
    formats: ["png", "jpeg"],
    referenceImages: {
      note: "Google says this model is not optimized for multiple reference images or multi-turn sequential editing.",
    },
    imagesPerRequest: { max: 1 },
    thinking: { levels: ["minimal", "high"], default: "minimal" },
    prices: { textInput: 0.25, textOutput: 1.5, imageInput: 0.25, imageOutput: GOOGLE_IMAGE_TOKENS },
    batchPrices: { textInput: 0.125, textOutput: 0.75, imageInput: 0.125, imageOutput: 15 },
  },
  openai(
    "gpt-image-2.5-sunburst",
    "GPT Image 2.5 Sunburst",
    "OpenAI's most capable image generation and editing model, for work where editing precision matters most.",
    "2026-09-08",
    {
      sizeRules: { ...OPENAI_SIZE_RULES, experimentalAbove: { width: 2560, height: 1440 } },
      batchPrices: OPENAI_BATCH_PRICES,
    }
  ),
  openai(
    "gpt-image-2.5-flare",
    "GPT Image 2.5 Flare",
    "OpenAI's fastest model for high-quality, everyday image generation.",
    "2026-09-08",
    {
      sizeRules: { ...OPENAI_SIZE_RULES, experimentalAbove: { width: 2560, height: 1440 } },
      batchPrices: OPENAI_BATCH_PRICES,
    }
  ),
  openai(
    "gpt-image-2.6-sunburst",
    "GPT Image 2.6 Sunburst",
    "Image generation and editing for detailed visual work (adds complexity control, markup-guided edits, SVG and GIF output).",
    undefined,
    { limits: GPT_26_LIMITS, prices: GPT_26_PRICES }
  ),
  openai(
    "gpt-image-2.6-flare",
    "GPT Image 2.6 Flare",
    "Image generation and editing for fast iteration (adds complexity control, markup-guided edits, SVG and GIF output).",
    undefined,
    { limits: GPT_26_LIMITS, prices: GPT_26_PRICES }
  ),
];

/** Models that used to be supported or that people still ask for, and what to use instead. Only OpenAI has any. */
const RETIRED: Readonly<Record<string, string>> = {
  "gpt-image-1": "was shut down by OpenAI on 23 Oct 2026",
  "gpt-image-1-mini": "is deprecated by OpenAI",
  "gpt-image-1.5": "is deprecated by OpenAI",
  "gpt-image-1.5-2025-12-16": "is deprecated by OpenAI",
  "gpt-image-2": "is deprecated by OpenAI",
  "gpt-image-2-2026-04-21": "is deprecated by OpenAI",
  "chatgpt-image-latest": "is deprecated by OpenAI",
};

// `provider/id`, trimmed and lower-cased; a bare id has no provider; in: getImageModel and unsupportedImageModelReason, out: the parts.
function split(model: string): { provider?: string; id: string } {
  const text = String(model ?? "")
    .trim()
    .toLowerCase();
  const slash = text.indexOf("/");
  if (slash <= 0) return { id: text };
  const provider = text.slice(0, slash);
  return { provider: provider === "gemini" ? "google" : provider, id: text.slice(slash + 1) };
}

/**
 * The supported image-generation models, sorted by `model`; pass a provider (`"google"`, `"openai"`) to see only its
 * models. Each entry says what the model accepts (aspect ratios, sizes, quality levels, reference images, thinking
 * levels), its limits and its prices. The list is the same for everyone: a `setModels` list does not hide a model here (it
 * still stops a run on a model outside it).
 *
 * @example `const models = listImageModels("google");`
 */
export function listImageModels(provider?: string): readonly ImageModelInfo[] {
  const wanted = provider ? split(`${provider}/x`).provider : undefined;
  return TABLE.filter((m) => !wanted || m.provider === wanted).sort((a, b) => a.model.localeCompare(b.model));
}

/** One supported image model by its `provider/id` string (a bare id matches when only one provider has it), or `undefined`. */
export function getImageModel(model: string): ImageModelInfo | undefined {
  const { provider, id } = split(model);
  return TABLE.find((m) => m.id.toLowerCase() === id && (!provider || m.provider === provider));
}

/** Why `model` is not a supported image model (retired, or not one of the supported list), or `undefined` when it is supported. */
export function unsupportedImageModelReason(model: string): string | undefined {
  if (getImageModel(model)) return undefined;
  const { id } = split(model);
  const supported = TABLE.map((m) => m.model).join(", ");
  const retired = RETIRED[id];
  return retired
    ? `"${model}" ${retired}. Supported image models: ${supported}.`
    : `"${model}" is not a supported image model. Supported image models: ${supported}.`;
}
