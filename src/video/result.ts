/**
 * The clip and the result of a video call. A `GeneratedVideo` holds the real bytes and knows how to save itself and how to become a
 * `VideoPart` for an agent; a `VideoResult` is that clip plus usage, the job id and the wire audit.
 */
import * as path from "node:path";
import { bytesToBase64 } from "../utils/base64.ts";
import { writeFileDurable } from "../utils/durable.ts";
import { mp4DurationSeconds } from "../utils/mp4.ts";
import type { VideoPart } from "../types/message.ts";
import type { VideoResultData } from "../types/video.ts";
import type { TokenUsage } from "../types/core.ts";
import type { ProviderId, ProviderRawData } from "../types/model.ts";

const EXTENSION: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/mpeg": ".mpeg",
};

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
    const { video, ...rest } = this;
    return { ...(rest as unknown as Omit<VideoResultData, "video">), video: video.toJSON() };
  }
}
