/**
 * The picture and the result of an image call. A `GeneratedImage` holds the real bytes and knows how to save itself and
 * how to become an `ImagePart` for an agent; an `ImageResult` is the list of them plus usage and the wire audit.
 */
import * as path from "node:path";
import { bytesToBase64 } from "../utils/base64.ts";
import { writeFileDurable } from "../utils/durable.ts";
import type { ImagePart } from "../types/message.ts";
import type { ImageResultData } from "../types/image.ts";
import type { TokenUsage } from "../types/core.ts";
import type { ProviderId, ProviderRawData } from "../types/model.ts";

const EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** One generated picture. */
export class GeneratedImage {
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

  /** `data:<mime>;base64,<bytes>`, ready for an `<img>` or another API. */
  get dataUrl(): string {
    return `data:${this.mimeType};base64,${this.base64}`;
  }

  /** `.png`, `.jpg`, `.webp` ... for this picture's type. */
  get extension(): string {
    return EXTENSION[this.mimeType] ?? ".bin";
  }

  /** Writes the picture to `file` (folders are created; the write is atomic) and returns the absolute path. A name with no extension gets the right one. */
  async save(file: string): Promise<string> {
    const target = path.resolve(path.extname(file) ? file : `${file}${this.extension}`);
    writeFileDurable(target, this.bytes, { backup: false });
    return target;
  }

  /** The picture as an image part, to send it to an agent: `agent.run([{ type: "text", text: "..." }, image.toPart()])`. */
  toPart(): ImagePart {
    return { type: "image", image: this.bytes, mimeType: this.mimeType };
  }

  /** A short description (never the bytes) so `JSON.stringify` and logs stay small. */
  toJSON(): { mimeType: string; bytes: number } {
    return { mimeType: this.mimeType, bytes: this.bytes.byteLength };
  }
}

/** The result of `generateImage`. */
export class ImageResult {
  readonly images: GeneratedImage[];
  readonly text?: string;
  readonly usage: TokenUsage;
  readonly model: string;
  readonly provider: ProviderId;
  readonly finishReason?: string;
  readonly raw: ProviderRawData;
  readonly durationMs: number;
  readonly requests: number;

  constructor(data: ImageResultData) {
    this.images = data.images;
    if (data.text) this.text = data.text;
    this.usage = data.usage;
    this.model = data.model;
    this.provider = data.provider;
    if (data.finishReason) this.finishReason = data.finishReason;
    this.raw = data.raw;
    this.durationMs = data.durationMs;
    this.requests = data.requests;
  }

  /** The first picture (a result always has at least one). */
  get image(): GeneratedImage {
    return this.images[0]!;
  }

  /** JSON without the picture bytes. */
  toJSON(): Omit<ImageResultData, "images"> & { images: Array<{ mimeType: string; bytes: number }> } {
    const { images, ...rest } = this;
    return { ...(rest as unknown as Omit<ImageResultData, "images">), images: images.map((i) => i.toJSON()) };
  }
}
