/**
 * The clip and the result of a video call. A `GeneratedVideo` holds the real bytes and knows how to save itself and how to become a
 * `VideoPart` for an agent; a `VideoResult` is that clip plus usage, the job id and the wire audit.
 */
import * as path from "node:path";
import { bytesToBase64 } from "../utils/base64.ts";
import { writeFileDurable } from "../utils/durable.ts";
import { mp4DurationSeconds } from "../utils/mp4.ts";
import type { VideoPart } from "../types/message.ts";
import type { VideoEditOptions, VideoOptions, VideoResultData } from "../types/video.ts";
import { ConfigError } from "../types/errors.ts";
import type { TokenUsage } from "../types/core.ts";
import type { ProviderId, ProviderRawData } from "../types/model.ts";

const EXTENSION: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/mpeg": ".mpeg",
};

/** What a clip remembers about the call that made it, so `edit()` can go on from it. Kept out of the object (never in JSON or logs). */
interface Origin {
  /** `provider/model` of the call. */
  model: string;
  /** The provider's own id of the call (Google: the interaction; OpenRouter: the job). A later edit on the same model continues from it. */
  chainId?: string;
  /** The connection settings an edit reuses; shape options, the signal and the budget are not carried over. */
  inherit: Pick<
    VideoOptions,
    "apiKey" | "baseUrl" | "headers" | "env" | "fetch" | "retry" | "timeoutMs" | "pollIntervalMs" | "captureRaw"
  >;
}
const origins = new WeakMap<GeneratedVideo, Origin>();

/** Records where a clip came from (used by `generateVideo` and `resumeVideo`). Internal. */
export function attachVideoOrigin(video: GeneratedVideo, origin: Origin): void {
  origins.set(video, origin);
}

/** What a clip remembers about its call, if it was made by `generateVideo`. Internal. */
export function videoOriginOf(video: GeneratedVideo): Origin | undefined {
  return origins.get(video);
}

/** One generated clip. */
export class GeneratedVideo {
  readonly bytes: Uint8Array;
  readonly mimeType: string;

  constructor(bytes: Uint8Array, mimeType: string) {
    this.bytes = bytes;
    this.mimeType = mimeType;
  }

  /** The bytes as base64. */
  get base64(): string {
    return bytesToBase64(this.bytes);
  }

  /** `data:<mime>;base64,<bytes>`. */
  get dataUrl(): string {
    return `data:${this.mimeType};base64,${this.base64}`;
  }

  /** `.mp4`, `.mov`, `.webm` ... for this clip's type. */
  get extension(): string {
    return EXTENSION[this.mimeType] ?? ".bin";
  }

  /** The length in seconds when the file says it (MP4 and MOV), else `undefined`. */
  get durationSeconds(): number | undefined {
    return mp4DurationSeconds(this.bytes);
  }

  /** Writes the clip to `file` (folders are created; the write is atomic) and returns the absolute path. A name with no extension gets the right one. */
  async save(file: string): Promise<string> {
    const target = path.resolve(path.extname(file) ? file : `${file}${this.extension}`);
    writeFileDurable(target, this.bytes, { backup: false });
    return target;
  }

  /** The clip as a video part, to send it to an agent: `agent.run([{ type: "text", text: "..." }, video.toPart()])`. */
  toPart(): VideoPart {
    return { type: "video", video: this.bytes, mimeType: this.mimeType };
  }

  /**
   * Changes this clip: `await video.edit("Make it night")`. Runs `generateVideo` with `continueFrom: this`, the model and the
   * connection settings (key, endpoint, headers, fetch, retry, timeout) of the call that made it, and your options on top. Nothing
   * else carries over (ask again for a length or tier if you want them). Works on the model that made the clip: Google continues
   * the stored interaction, OpenRouter continues the job.
   */
  async edit(prompt: string, options: VideoEditOptions = {}): Promise<VideoResult> {
    const origin = videoOriginOf(this);
    const model = options.model ?? origin?.model;
    if (!model)
      throw new ConfigError(
        "[Agent Accelerator] edit() needs a model: this clip was not made by generateVideo, so pass { model }."
      );
    const { generateVideo } = await import("./generate.ts");
    return generateVideo({ ...origin?.inherit, ...options, model, prompt, continueFrom: this });
  }

  /** A short description (never the bytes) so `JSON.stringify` and logs stay small. */
  toJSON(): { mimeType: string; bytes: number; durationSeconds?: number } {
    const seconds = this.durationSeconds;
    return {
      mimeType: this.mimeType,
      bytes: this.bytes.byteLength,
      ...(seconds !== undefined ? { durationSeconds: seconds } : {}),
    };
  }
}

/** The result of `generateVideo`. */
export class VideoResult {
  readonly video: GeneratedVideo;
  /** Words the model wrote next to the clip, when it wrote any. */
  readonly text?: string;
  readonly usage: TokenUsage;
  readonly model: string;
  readonly provider: ProviderId;
  readonly finishReason?: string;
  /** Google: the interaction that made the clip. */
  readonly responseId?: string;
  /** OpenRouter: the job that made the clip. */
  readonly jobId?: string;
  readonly raw: ProviderRawData;
  readonly durationMs: number;

  constructor(data: VideoResultData) {
    this.video = data.video;
    if (data.text) this.text = data.text;
    this.usage = data.usage;
    this.model = data.model;
    this.provider = data.provider;
    if (data.finishReason) this.finishReason = data.finishReason;
    if (data.responseId) this.responseId = data.responseId;
    if (data.jobId) this.jobId = data.jobId;
    this.raw = data.raw;
    this.durationMs = data.durationMs;
  }

  /** JSON without the clip bytes. */
  toJSON(): Omit<VideoResultData, "video"> & { video: ReturnType<GeneratedVideo["toJSON"]> } {
    const { video, text, usage, model, provider, finishReason, responseId, jobId, raw, durationMs } = this;
    return { text, usage, model, provider, finishReason, responseId, jobId, raw, durationMs, video: video.toJSON() };
  }
}
