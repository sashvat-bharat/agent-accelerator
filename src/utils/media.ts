// NOTE: no static node:fs import — it breaks browser bundles. Local file
// paths are loaded via a lazy dynamic import so browsers never resolve it.
import { bytesToBase64, base64ToBytes } from "./base64.ts";
import { fetchRemoteBytes } from "./safe-io.ts";

export interface NormalizedMedia {
  mimeType: string;
  base64Data: string;
  dataUrl: string;
}

/**
 * Detects MIME type from common file signatures or extensions
 */
/**
 * Infers a MIME type from a URL/path extension.
 *
 * @example `const mime = inferMimeType("photo.webp");`
 */
export function inferMimeType(input: string, fallback = "application/octet-stream"): string {
  const clean = input.toLowerCase().split("?")[0]!;
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".mp3")) return "audio/mp3";
  if (clean.endsWith(".wav")) return "audio/wav";
  if (clean.endsWith(".ogg")) return "audio/ogg";
  if (clean.endsWith(".mp4")) return "video/mp4";
  if (clean.endsWith(".webm")) return "video/webm";
  if (clean.endsWith(".mov")) return "video/quicktime";
  if (clean.endsWith(".pdf")) return "application/pdf";
  return fallback;
}

const ascii = (bytes: Uint8Array, start: number, text: string): boolean =>
  bytes.length >= start + text.length && [...text].every((ch, i) => bytes[start + i] === ch.charCodeAt(0));

/**
 * Identifies common image/audio/video/document formats from their magic bytes.
 * Used when no MIME type was supplied (raw bytes, base64, extension-less or
 * `application/octet-stream` downloads) so providers receive a real type
 * instead of a generic one they would reject.
 *
 * @example `sniffMimeType(pngBytes) // "image/png"`
 */
export function sniffMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4) return undefined;
  if (bytes[0] === 0x89 && ascii(bytes, 1, "PNG")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, "GIF8")) return "image/gif";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav";
  if (ascii(bytes, 0, "%PDF")) return "application/pdf";
  if (ascii(bytes, 0, "OggS")) return "audio/ogg";
  if (ascii(bytes, 0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mp3";
  if (ascii(bytes, 4, "ftyp")) return ascii(bytes, 8, "qt") ? "video/quicktime" : "video/mp4";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return undefined;
}

const GENERIC_MIME = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/** Picks the best MIME type: explicit hint, then a specific candidate, then magic bytes, then the fallback. */
function resolveMime(explicit: string | undefined, candidate: string | null | undefined, bytes: Uint8Array, fallback: string): string {
  if (explicit) return explicit;
  const specific = candidate && !GENERIC_MIME.has(candidate.split(";")[0]!.trim().toLowerCase()) ? candidate : undefined;
  return specific || sniffMimeType(bytes) || candidate || fallback;
}

/** Magic-byte sniff of a base64 payload from its first bytes only (no full decode). */
function sniffBase64(b64: string): string | undefined {
  try {
    const head = b64.replace(/\s/g, "").slice(0, 32);
    return sniffMimeType(base64ToBytes(head.slice(0, head.length - (head.length % 4))));
  } catch {
    return undefined;
  }
}

/**
 * Normalizes an image, audio, or video input into raw base64 and data URL
 */
/**
 * Normalizes a path, URL, data URL, base64 string, or binary value into media payloads.
 *
 * @example `const image = await normalizeMediaInput("https://example.com/photo.png");`
 */
export async function normalizeMediaInput(
  input: string | Uint8Array | ArrayBuffer,
  explicitMimeType?: string
): Promise<NormalizedMedia> {
  // 1. If input is ArrayBuffer or Uint8Array
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const mimeType = resolveMime(explicitMimeType, undefined, bytes, "application/octet-stream");
    const base64Data = bytesToBase64(bytes);
    return {
      mimeType,
      base64Data,
      dataUrl: `data:${mimeType};base64,${base64Data}`,
    };
  }

  // 2. If input is data URL (data:image/png;base64,...)
  if (typeof input === "string" && input.startsWith("data:")) {
    const match = input.match(/^data:([^;]+);base64,(.+)$/);
    if (match && match[1] && match[2]) {
      return {
        mimeType: explicitMimeType || match[1],
        base64Data: match[2],
        dataUrl: input,
      };
    }
  }

  // 3. If input is a remote HTTP URL (check before base64 to avoid misclassifying URL as base64)
  if (typeof input === "string" && (input.startsWith("http://") || input.startsWith("https://"))) {
    // Developer-supplied URL: private hosts are allowed (intranet assets),
    // but redirects are re-checked and the download is size-capped.
    const response = await fetchRemoteBytes(input, { allowPrivateNetwork: true });
    if (!response.ok) {
      throw new Error(`Failed to fetch media from URL: ${input} (${response.statusText})`);
    }
    const buffer = response.bytes;
    const mimeType = resolveMime(explicitMimeType, response.contentType, buffer, inferMimeType(input));
    const base64Data = bytesToBase64(buffer);
    return {
      mimeType,
      base64Data,
      dataUrl: `data:${mimeType};base64,${base64Data}`,
    };
  }

  // 4. If input is already raw base64 string (stricter: length threshold + no file markers).
  // Note: `/` is a valid base64 character (RFC 4648 index 63), so it must NOT
  // exclude this path — POSIX file paths fail the base64 charset test below
  // on their own (`.`, `-`, short length). Only backslashes (Windows paths)
  // are excluded up front.
  if (
    typeof input === "string" &&
    !input.includes("\\") &&
    input.length > 100 &&
    /^[A-Za-z0-9+/=\n\r]+$/.test(input.slice(0, 200)) &&
    input.length % 4 === 0
  ) {
    const mimeType = explicitMimeType || sniffBase64(input) || "image/jpeg";
    return {
      mimeType,
      base64Data: input.replace(/\s/g, ""),
      dataUrl: `data:${mimeType};base64,${input.replace(/\s/g, "")}`,
    };
  }

  // 5. If input is local file path (Node only — browsers use data URLs / FileReader)
  if (typeof input === "string") {
    try {
      const { promises: fs } = await import("node:fs");
      const buffer = await fs.readFile(input);
      const byExtension = inferMimeType(input, "");
      const mimeType = resolveMime(explicitMimeType, byExtension, buffer, "application/octet-stream");
      const base64Data = bytesToBase64(buffer);
      return {
        mimeType,
        base64Data,
        dataUrl: `data:${mimeType};base64,${base64Data}`,
      };
    } catch (err) {
      // S11: don't silently return path string as base64 (would 400). Re-check if it's actually base64 with "/"
      const trimmed = input.replace(/\s/g, "");
      const isMaybeBase64 = trimmed.length > 100 && /^[A-Za-z0-9+/=\n\r]+$/.test(trimmed.slice(0, 500)) && trimmed.length % 4 === 0;
      if (isMaybeBase64) {
        const mimeType = explicitMimeType || sniffBase64(trimmed) || "image/jpeg";
        return {
          mimeType,
          base64Data: trimmed,
          dataUrl: `data:${mimeType};base64,${trimmed}`,
        };
      }
      throw new Error(`Failed to normalize media input: not a valid file path, data URL, http URL, or base64 string: ${input.slice(0, 80)}`);
    }
  }

  throw new Error(`Unsupported media input type: ${typeof input}`);
}
