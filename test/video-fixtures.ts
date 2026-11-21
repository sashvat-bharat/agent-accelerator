// Small binary fixtures for the video tests: a valid-looking MP4 header of a given length, and a PNG signature.

// A big-endian 32-bit number as four bytes.
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
// A box: size, four-character type, body.
const box = (type: string, body: number[]): number[] => [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body];

/** An MP4 file of `seconds` seconds (ftyp + moov/mvhd, version 0 or 1) followed by `extra` bytes of fake media data. No real frames: only the header the SDK reads. */
export function fakeMp4(seconds: number, opts: { timescale?: number; version?: 0 | 1; extra?: number; moovLast?: boolean } = {}): Uint8Array {
  const timescale = opts.timescale ?? 1000;
  const duration = Math.round(seconds * timescale);
  const version = opts.version ?? 0;
  const mvhdBody =
    version === 1
      ? [1, 0, 0, 0, ...new Array(16).fill(0), ...u32(timescale), ...u32(0), ...u32(duration), ...new Array(80).fill(0)]
      : [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(timescale), ...u32(duration), ...new Array(80).fill(0)];
  const ftyp = box("ftyp", [...[..."isom"].map((c) => c.charCodeAt(0)), ...u32(512), ...[..."isom"].map((c) => c.charCodeAt(0))]);
  const moov = box("moov", box("mvhd", mvhdBody));
  const mdat = box("mdat", new Array(opts.extra ?? 32).fill(7));
  return Uint8Array.from(opts.moovLast ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat]);
}

/** The first bytes of a PNG (enough for the media sniffer to say `image/png`). */
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
