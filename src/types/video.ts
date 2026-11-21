import type { TokenUsage } from "./core.ts";
import type { ImageInput } from "./image.ts";
import type { ProviderId, ProviderRawData } from "./model.ts";
import type { NormalizedMedia } from "../utils/media.ts";
import type { CaptureRawMode } from "../utils/raw-capture.ts";
import type { ConnectionOptions } from "../utils/provider-call.ts";
import type { GeneratedVideo } from "../video/result.ts";

/** A video to use as input: a path, URL, data URL, base64 string, bytes, or a video the SDK made. */
export type VideoInput = string | Uint8Array | ArrayBuffer | GeneratedVideo;

/** Where a video job is (`onProgress`). */
export interface VideoProgress {
  /** The provider's own status word (`pending`, `in_progress`, `generating` ...). */
  status: string;
  /** 0 to 100, only when the provider reports it. */
  progress?: number;
  /** The provider's job id, once it exists (OpenRouter). */
  jobId?: string;
}

/** What `generateVideo` takes. Only `model` and `prompt` (unless a first frame is given) are required; everything else is checked against that model. */
export interface VideoOptions extends ConnectionOptions {
  /** `provider/model` of a known video model (see `listVideoModels`). */
  model: string;
  /** What happens in the clip. Required unless `firstFrame` is given. */
  prompt?: string;
  /** Length in whole seconds, or `"auto"` to let the model pick it (only models that allow that). Each model lists its lengths; a model with a default (Google: 10) uses it when this is omitted. */
  duration?: number | "auto";
  /** Size tier (`"720p"`, `"1080p"`, `"4K"` ...). Each model lists its tiers. */
  resolution?: string;
  /** `"16:9"`, `"9:16"` ...; each model lists its ratios. */
  aspectRatio?: string;
  /** Exact `WIDTHxHEIGHT` from the model's list (cannot be combined with `aspectRatio` or `resolution`). */
  size?: string;
  /** A picture the clip starts from. */
  firstFrame?: ImageInput;
  /** A picture the clip ends on. */
  lastFrame?: ImageInput;
  /** Pictures that guide who or what is in the clip without fixing a frame. */
  referenceImages?: ImageInput[];
  /** Short clips that guide the look or motion (only models that read them). */
  referenceVideos?: VideoInput[];
  /** `false` asks for a silent clip where the model has a switch for audio. */
  audio?: boolean;
  /** For repeatable results, on models that take one. */
  seed?: number;
  /** Stops the call (an `AbortError`). A job already running at the provider may keep running and billing: the error carries its `jobId` when there is one. */
  signal?: AbortSignal;
  /** The whole call, in ms, polling included. Default 600 000 (10 minutes); `0` or `Infinity` turns it off. On a timeout the error carries the provider's `jobId`. */
  timeoutMs?: number;
  /** How often a job is asked how far it is, in ms. Default 10 000. */
  pollIntervalMs?: number;
  /** Called each time a polled job reports its status. */
  onProgress?: (progress: VideoProgress) => void;
  /** A cost cap for this call: stops (a `BudgetExceededError`) when the estimated or reported cost passes it. */
  budget?: { maxCostUsd?: number };
  /** Local pictures and clips must be inside these folders (`[]` denies all local paths). */
  fileAccess?: { roots?: string[] };
  /** What `VideoResult.raw` keeps of the wire exchange (same policy as `AgentConfig.captureRaw`). */
  captureRaw?: CaptureRawMode;
}

/** One reference clip after it was read: its bytes as media and its length when the file says it. */
export interface ReadClip {
  media: NormalizedMedia;
  seconds?: number;
}

/** What an adapter receives: the request already checked and with its pictures and clips read. */
export interface ProviderVideoRequest {
  prompt?: string;
  /** Whole seconds (never set together with `durationAuto`). */
  durationSeconds?: number;
  /** The provider chooses the length. */
  durationAuto?: boolean;
  resolution?: string;
  aspectRatio?: string;
  size?: string;
  firstFrame?: NormalizedMedia;
  lastFrame?: NormalizedMedia;
  referenceImages: NormalizedMedia[];
  referenceVideos: ReadClip[];
  audio?: boolean;
  seed?: number;
  /** The call's deadline in ms for a provider that works in jobs (`Infinity` = none). */
  deadlineMs: number;
  /** How often to ask a job how far it is, in ms. */
  pollIntervalMs: number;
  onProgress?: (progress: VideoProgress) => void;
}

/** What an adapter returns for one call. */
export interface ProviderVideoResult {
  video: { bytes: Uint8Array; mimeType: string };
  /** Words the model wrote next to the video (Google Omni can answer in text too). */
  text?: string;
  usage: TokenUsage;
  finishReason?: string;
  /** Google: the interaction that made the video. */
  responseId?: string;
  /** OpenRouter: the job that made it. */
  jobId?: string;
  model: string;
  provider: ProviderId;
  raw: ProviderRawData;
  durationMs: number;
}

/** The video of one `generateVideo` call. */
export interface VideoResultData {
  video: GeneratedVideo;
  text?: string;
  usage: TokenUsage;
  model: string;
  provider: ProviderId;
  finishReason?: string;
  responseId?: string;
  jobId?: string;
  raw: ProviderRawData;
  durationMs: number;
}
