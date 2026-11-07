/** Runtime-agnostic base64 helpers — no Node Buffer, safe in browsers. */

/** Decodes base64 (whitespace ignored) to bytes, with Buffer when present, else atob; in: media and session code, out: a Uint8Array. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s/g, "");
  const nodeBuffer = (globalThis as any)?.Buffer;
  if (nodeBuffer && typeof nodeBuffer.from === "function") {
    const buf = nodeBuffer.from(clean, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encodes bytes as base64, with Buffer when present, else btoa in chunks; in: media and session code, out: a string. */
export function bytesToBase64(bytes: Uint8Array): string {
  const nodeBuffer = (globalThis as any)?.Buffer;
  if (nodeBuffer && typeof nodeBuffer.from === "function") {
    return nodeBuffer.from(bytes).toString("base64");
  }
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
