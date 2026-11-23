/**
 * Length of an MP4 or QuickTime file in seconds, read from its `moov/mvhd` header (no decoding, no dependency). Used to check the
 * clip limits the video providers state (a reference clip of 3 seconds, an input video of 15) before any network call. Any other
 * container, or a file whose header cannot be read, gives `undefined`: the limit is then left to the provider.
 */

// A big-endian unsigned integer of `size` bytes (4 or 8) at `at`, or undefined past the end; in: the box walker, out: a number.
function uint(bytes: Uint8Array, at: number, size: 4 | 8): number | undefined {
  if (at < 0 || at + size > bytes.length) return undefined;
  let n = 0;
  for (let i = 0; i < size; i++) n = n * 256 + (bytes[at + i] ?? 0); // the length check above keeps every read inside the data
  return n;
}

// The four-character type of the box at `at`; in: the box walker, out: a string.
function typeAt(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

// Walks the boxes in [start, end) and calls `visit` for each (type, body start, body end); `visit` returns true to stop; in: mp4DurationSeconds, out: nothing.
function boxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  visit: (type: string, from: number, to: number) => boolean
): void {
  let at = start;
  while (at + 8 <= end) {
    let size = uint(bytes, at, 4);
    if (size === undefined) return;
    const type = typeAt(bytes, at + 4);
    let header = 8;
    if (size === 1) {
      const large = uint(bytes, at + 8, 8);
      if (large === undefined) return;
      size = large;
      header = 16;
    } else if (size === 0) size = end - at; // the last box runs to the end of the file
    if (size < header || at + size > end) return; // damaged or cut: stop, nothing is guessed
    if (visit(type, at + header, at + size)) return;
    at += size;
  }
}

/** The length in seconds of an MP4 or MOV file, or `undefined` when it is not one or its header cannot be read. */
export function mp4DurationSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.length < 16 || typeAt(bytes, 4) !== "ftyp") return undefined;
  let seconds: number | undefined;
  boxes(bytes, 0, bytes.length, (type, from, to) => {
    if (type !== "moov") return false;
    boxes(bytes, from, to, (inner, f, t) => {
      if (inner !== "mvhd") return false;
      const version = bytes[f];
      const timescale = version === 1 ? uint(bytes, f + 20, 4) : uint(bytes, f + 12, 4);
      const duration = version === 1 ? uint(bytes, f + 24, 8) : uint(bytes, f + 16, 4);
      if (timescale && duration !== undefined && f + (version === 1 ? 32 : 20) <= t) seconds = duration / timescale;
      return true;
    });
    return true;
  });
  return seconds !== undefined && Number.isFinite(seconds) ? seconds : undefined;
}
