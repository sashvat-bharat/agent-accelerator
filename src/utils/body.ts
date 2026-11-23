/**
 * Reads a response body with a byte cap. `await res.text()` reads everything a server sends, however much that is, so one
 * misconfigured or hostile endpoint could fill the memory of a small host. These helpers stop reading, and cancel the
 * connection, as soon as the cap is passed. A body over its cap is a non-retryable `ProviderError`.
 */
import { ProviderError } from "../types/errors.ts";

const MIB = 1024 * 1024;

/** The cap for the text reply of one chat call (64 MB). */
export const CHAT_REPLY_LIMIT: number = 64 * MIB;
/** The cap for replies that can honestly be big: pictures in base64, batches of vectors, answers to many questions (256 MB). */
export const BULK_REPLY_LIMIT: number = 256 * MIB;
/** The cap for an error body, of which only the first lines are ever shown (1 MB). */
export const ERROR_BODY_LIMIT: number = MIB;
/** The cap for a downloaded file, such as a generated video (512 MB). */
export const DOWNLOAD_LIMIT: number = 512 * MIB;

// The error for a body over its cap; in: readBytesCapped, out: a non-retryable ProviderError.
function tooLarge(res: Response, limit: number): ProviderError {
  return new ProviderError(
    `[Agent Accelerator] The provider's reply is larger than ${Math.round(limit / MIB)} MB, so it was not read.`,
    { status: res.status, retryable: false }
  );
}

/** Reads a body as bytes, stopping with a `ProviderError` as soon as it is over `limit` (an honest `content-length` fails before any byte is read). */
export async function readBytesCapped(res: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge(res, limit);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer()); // why: a response with no stream (some mocks) has nothing to cap while reading
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(res, limit);
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** Reads a body as UTF-8 text with the same cap as `readBytesCapped`. */
export async function readTextCapped(res: Response, limit: number): Promise<string> {
  return new TextDecoder().decode(await readBytesCapped(res, limit));
}
