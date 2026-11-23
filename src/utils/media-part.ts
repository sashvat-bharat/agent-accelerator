/**
 * Typed access to the payload of a media part (`image`, `audio`, `video` or `file`). The payload sits under a key named after the
 * part's type, so code that handles all four used to reach it through a cast; these helpers do it once, with types.
 */
import type { ImagePart, AudioPart, VideoPart, FilePart, MediaResolution } from "../types/message.ts";

/** The part types that carry media, which are also the names of the keys that hold it. */
export const MEDIA_KEYS = ["image", "audio", "video", "file"] as const;
/** One of {@link MEDIA_KEYS}. */
export type MediaKey = (typeof MEDIA_KEYS)[number];
/** A part that carries media. */
type MediaPart = ImagePart | AudioPart | VideoPart | FilePart;

/** The media key of a part, or undefined when it is not a media part. Safe for untrusted data (a saved session): it reads only `type`. */
export function mediaKeyOf(part: unknown): MediaKey | undefined {
  if (part === null || typeof part !== "object") return undefined;
  const type: unknown = Reflect.get(part, "type");
  return MEDIA_KEYS.find((key) => key === type);
}

/** The payload of a typed media part: a path, a URL, a data URL, base64 text or bytes. */
export function mediaValueOf(part: MediaPart): string | Uint8Array | ArrayBuffer {
  switch (part.type) {
    case "image":
      return part.image;
    case "audio":
      return part.audio;
    case "video":
      return part.video;
    case "file":
      return part.file;
  }
}

/** A media part of kind `type` that holds `value`, with the optional extras that kind supports (a detail level for pictures and video, a file name for documents). */
export function makeMediaPart(
  type: MediaKey,
  value: string,
  extras: {
    mimeType?: string | undefined;
    filename?: string | undefined;
    resolution?: MediaResolution | undefined;
  } = {}
): MediaPart {
  const { mimeType, filename, resolution } = extras;
  const mime = mimeType ? { mimeType } : {};
  switch (type) {
    case "image":
      return { type, image: value, ...mime, ...(resolution ? { resolution } : {}) };
    case "audio":
      return { type, audio: value, ...mime };
    case "video":
      return { type, video: value, ...mime, ...(resolution ? { resolution } : {}) };
    case "file":
      return { type, file: value, ...mime, ...(filename ? { filename } : {}) };
  }
}
