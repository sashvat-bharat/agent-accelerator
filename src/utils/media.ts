// NOTE: no static node:fs import — it breaks browser bundles. Local file
// paths are loaded via a lazy dynamic import so browsers never resolve it.
import { bytesToBase64 } from "./base64.ts";

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
    const mimeType = explicitMimeType || "application/octet-stream";
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
    const response = await fetch(input);
    if (!response.ok) {
      throw new Error(`Failed to fetch media from URL: ${input} (${response.statusText})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    const mimeType =
      explicitMimeType ||
      response.headers.get("content-type") ||
      inferMimeType(input);
    const base64Data = bytesToBase64(buffer);
    return {
      mimeType,
      base64Data,
      dataUrl: `data:${mimeType};base64,${base64Data}`,
    };
  }

  // 4. If input is already raw base64 string (stricter: length threshold + no file markers)
  if (
    typeof input === "string" &&
    !input.includes("/") && // file paths contain /
    !input.includes("\\") &&
    input.length > 100 &&
    /^[A-Za-z0-9+/=\n\r]+$/.test(input.slice(0, 200)) &&
    input.length % 4 === 0
  ) {
    const mimeType = explicitMimeType || "image/jpeg";
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
      const mimeType = explicitMimeType || inferMimeType(input);
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
        const mimeType = explicitMimeType || "image/jpeg";
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
