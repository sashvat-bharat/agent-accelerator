/**
 * The picture and the result of an image call. A `GeneratedImage` holds the real bytes and knows how to save itself and
 * how to become an `ImagePart` for an agent; an `ImageResult` is the list of them plus usage and the wire audit.
 */
import * as path from "node:path";
import { bytesToBase64 } from "../utils/base64.ts";
import { writeFileDurable } from "../utils/durable.ts";
import type { ImagePart } from "../types/message.ts";
import type { ImageEditOptions, ImageOptions, ImageResultData } from "../types/image.ts";
import { ConfigError } from "../types/errors.ts";
import type { TokenUsage } from "../types/core.ts";
import type { ProviderId, ProviderRawData } from "../types/model.ts";

const EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** What a picture remembers about the call that made it, so `edit()` can go on from it. Kept out of the object (never in JSON or logs). */
interface Origin {
  /** `provider/model` of the call. */
  model: string;
  /** Google: the interaction that made it (a later edit on the same model continues from it). */
  chainId?: string;
  /** The connection settings an edit reuses; shape options, the signal and the budget are not carried over. */
  inherit: Pick<
    ImageOptions,
    "apiKey" | "baseUrl" | "headers" | "env" | "fetch" | "retry" | "timeoutMs" | "captureRaw" | "fileAccess"
  >;
}
const origins = new WeakMap<GeneratedImage, Origin>();

/** Records where a picture came from (used by `generateImage`). Internal. */
export function attachOrigin(image: GeneratedImage, origin: Origin): void {
  origins.set(image, origin);
}

/** What a picture remembers about its call, if it was made by `generateImage`. Internal. */
export function originOf(image: GeneratedImage): Origin | undefined {
  return origins.get(image);
}

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

  /**
   * Changes this picture: `await image.edit("Make it night")`. Runs `generateImage` with `continueFrom: this`, the model and the
   * connection settings (key, endpoint, headers, fetch, retry, timeout) of the call that made it, and your options on top. Nothing
   * else carries over: ask again for a size, quality or `n` if you want them (an edit keeps the picture's own size by default).
   * On the same Google model it continues the conversation; elsewhere the picture is sent as a reference.
   */
  async edit(prompt: string, options: ImageEditOptions = {}): Promise<ImageResult> {
    const origin = originOf(this);
    const model = options.model ?? origin?.model;
    if (!model)
      throw new ConfigError(
        "[Agent Accelerator] edit() needs a model: this picture was not made by generateImage, so pass { model }."
      );
    const { generateImage } = await import("./generate.ts");
    return generateImage({ ...origin?.inherit, ...options, model, prompt, continueFrom: this });
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
    const { images, text, usage, model, provider, finishReason, raw, durationMs, requests } = this;
    return {
      text,
      usage,
      model,
      provider,
      finishReason,
      raw,
      durationMs,
      requests,
      images: images.map((i) => i.toJSON()),
    };
  }
}
