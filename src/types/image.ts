import type { ThinkingLevel, TokenUsage } from "./core.ts";
import type { RetryPolicyConfig } from "./agent.ts";
import type { ProviderId, ProviderRawData } from "./model.ts";
import type { NormalizedMedia } from "../utils/media.ts";
import type { CaptureRawMode } from "../utils/raw-capture.ts";
import type { GeneratedImage } from "../image/result.ts";

/** A picture to use as input: a path, URL, data URL, base64 string, bytes, or an image the SDK made. */
export type ImageInput = string | Uint8Array | ArrayBuffer | GeneratedImage;

/** Size tier of the picture (`512` = 512 px on the long side's tier, `1K`, `2K`, `4K`); each model lists the tiers it makes. */
export type ImageResolution = "512" | "1K" | "2K" | "4K";

/** Output file format. */
export type ImageFormat = "png" | "jpeg" | "webp";

/** What `generateImage` takes. Only `model` and `prompt` are required; everything else is checked against what that model supports. */
export interface ImageOptions {
  /** `provider/model` of a supported image model (see `listImageModels`). */
  model: string;
  /** What to draw, or, with `images`, what to change. */
  prompt: string;
  /** Pictures to edit or combine. Each model has its own limit (`listImageModels`). */
  images?: ImageInput[];
  /** `"16:9"`, `"1:1"` ...; each model lists the ratios it makes. */
  aspectRatio?: string;
  /** Size tier. Google models make tiers; OpenAI turns the tier and the ratio into pixels. */
  resolution?: ImageResolution;
  /** Exact `WIDTHxHEIGHT` (OpenAI models only; cannot be combined with `aspectRatio` or `resolution`). */
  size?: string;
  /** Quality level (OpenAI models). */
  quality?: string;
  format?: ImageFormat;
  /** `"transparent"` needs `png` or `webp` (OpenAI models). */
  background?: "transparent" | "opaque" | "auto";
  /** How many pictures, 1 to 10. A model that makes fewer per request is called several times in parallel. Default 1. */
  n?: number;
  /** Thinking level (Google models); each model lists the levels it accepts. */
  thinking?: ThinkingLevel;
  /** Stops the request (an `AbortError`). */
  signal?: AbortSignal;
  /** Per request, in ms. Default 300 000; `0` or `Infinity` turns it off. */
  timeoutMs?: number;
  /** Retries of transient failures (429, 5xx) before any picture exists. */
  retry?: RetryPolicyConfig;
  /** A cost cap for this call: stops (a `BudgetExceededError`) when the estimated or reported cost passes it. */
  budget?: { maxCostUsd?: number };
  /** Local reference images must be inside these folders (`[]` denies all local paths). */
  fileAccess?: { roots?: string[] };
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  fetch?: typeof fetch;
  /** What `ImageResult.raw` keeps of the wire exchange (same policy as `AgentConfig.captureRaw`). */
  captureRaw?: CaptureRawMode;
}

/** What an adapter receives: the request already checked and with its reference images read. */
export interface ProviderImageRequest {
  prompt: string;
  images: NormalizedMedia[];
  aspectRatio?: string;
  resolution?: ImageResolution;
  /** Exact `WIDTHxHEIGHT` (OpenAI), already computed from the ratio and tier when the caller gave those. */
  size?: string;
  quality?: string;
  format?: ImageFormat;
  background?: "transparent" | "opaque" | "auto";
  thinking?: ThinkingLevel;
  /** How many pictures THIS call must return (never above the model's per-request maximum). */
  count: number;
}

/** What an adapter returns for one call. */
export interface ProviderImageResult {
  images: Array<{ bytes: Uint8Array; mimeType: string }>;
  /** Words the model wrote next to the picture. */
  text?: string;
  usage: TokenUsage;
  finishReason?: string;
  responseId?: string;
  model: string;
  provider: ProviderId;
  raw: ProviderRawData;
  durationMs: number;
}

/** The pictures of one `generateImage` call. */
export interface ImageResultData {
  images: GeneratedImage[];
  text?: string;
  usage: TokenUsage;
  model: string;
  provider: ProviderId;
  finishReason?: string;
  raw: ProviderRawData;
  durationMs: number;
  /** Provider requests made (more than one when `n` is above the model's per-request maximum). */
  requests: number;
}
