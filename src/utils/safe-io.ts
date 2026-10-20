// NOTE: no static node:fs / node:path / node:dns imports: they break browser
// bundles. Everything Node-specific is loaded lazily inside the helpers.
import type { Message } from "../types/message.ts";
import { SecurityPolicyError } from "../types/errors.ts";

/** Default cap for one remote media/document download (bytes). */
export const MAX_REMOTE_FETCH_BYTES = 200_000_000;

/**
 * True when a media/document string would be read from the local filesystem
 * by `normalizeMediaInput` (i.e. it is not a data URL, an http(s) URL, or an
 * embedded base64 payload). Mirrors the classification order used there.
 */
export function isLocalPathInput(input: unknown): input is string {
  if (typeof input !== "string" || !input) return false;
  if (input.startsWith("data:")) return false;
  if (input.startsWith("http://") || input.startsWith("https://")) return false;
  if (
    !input.includes("\\") &&
    input.length > 100 &&
    /^[A-Za-z0-9+/=\n\r]+$/.test(input.slice(0, 200)) &&
    input.length % 4 === 0
  ) {
    return false;
  }
  return true;
}

const MAX_REDIRECTS = 5;

/** Raised when a remote fetch is blocked by policy or exceeds its size cap. */
export class RemoteFetchError extends SecurityPolicyError {
  readonly reason: "blocked" | "too_large";
  constructor(reason: "blocked" | "too_large", message: string, url?: string) {
    super(message, url ? { url } : undefined);
    this.name = "RemoteFetchError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Local path containment (`fileAccess.roots`)
// ---------------------------------------------------------------------------

/**
 * Throws {@link SecurityPolicyError} unless `target` resolves (after symlinks)
 * inside one of `roots`. An empty `roots` list denies every local path. URL
 * schemes other than plain paths (`file:`, `ftp:`, …) are always rejected.
 */
export async function assertPathAllowed(target: string, roots: readonly string[]): Promise<void> {
  if (/^[a-z][a-z0-9+.-]+:/i.test(target)) {
    throw new SecurityPolicyError(
      `[Agent Accelerator] Path "${target.slice(0, 80)}" uses a URL scheme; only plain local paths or http(s) URLs are allowed.`
    );
  }
  const path = await import("node:path");
  const fs = await import("node:fs");
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const resolved = real(path.resolve(target));
  for (const root of roots) {
    const base = real(path.resolve(root));
    const rel = path.relative(base, resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return;
  }
  throw new SecurityPolicyError(
    `[Agent Accelerator] Path "${target.slice(0, 120)}" is outside the allowed fileAccess roots` +
      `${roots.length === 0 ? " (no local paths are allowed)" : ""}.`
  );
}

const MEDIA_KEYS = ["image", "audio", "video", "file"] as const;

/**
 * Validates every local-path media part in `messages` against `roots`. Used by
 * the loop each turn so developer-supplied parts, steered prompts and
 * imported sessions all obey `fileAccess.roots` the same way.
 */
export async function enforceFileAccess(messages: Message[], roots: readonly string[]): Promise<void> {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const p = part as unknown as Record<string, unknown>;
      const key = MEDIA_KEYS.find((k) => k === p?.type);
      if (!key) continue;
      const value = p[key];
      if (isLocalPathInput(value)) await assertPathAllowed(value, roots);
    }
  }
}

// ---------------------------------------------------------------------------
// Remote fetch guard (SSRF + size cap)
// ---------------------------------------------------------------------------

function ipv4Private(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** True for loopback, link-local, private, CGNAT and unique-local addresses. */
export function isPrivateAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return ipv4Private(Number(v4[1]), Number(v4[2]));
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    const mapped = host.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (mapped) return ipv4Private(Number(mapped[1]), Number(mapped[2]));
    return /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  return false;
}

function isPrivateHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isPrivateAddress(host)
  );
}

async function assertRemoteUrlAllowed(url: URL, allowPrivateNetwork: boolean): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RemoteFetchError("blocked", `[Agent Accelerator] Only http(s) URLs are allowed (got ${url.protocol}).`, url.href);
  }
  if (allowPrivateNetwork) return;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isPrivateHostname(host)) {
    throw new RemoteFetchError("blocked", `[Agent Accelerator] Refusing to fetch private/internal host "${host}".`, url.href);
  }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return; // IP literal already checked
  try {
    const dns = await import("node:dns");
    const addrs = await dns.promises.lookup(host, { all: true });
    if (addrs.some((a) => isPrivateAddress(a.address))) {
      throw new RemoteFetchError("blocked", `[Agent Accelerator] Host "${host}" resolves to a private/internal address.`, url.href);
    }
  } catch (err) {
    if (err instanceof RemoteFetchError) throw err;
    // Resolution failed (or non-Node runtime): fetch will surface its own error.
  }
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const tooLarge = () =>
    new RemoteFetchError(
      "too_large",
      `[Agent Accelerator] Remote resource exceeds the ${(maxBytes / 1_000_000).toFixed(0)} MB fetch cap.`,
      url
    );
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch {}
    throw tooLarge();
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw tooLarge();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Result of {@link fetchRemoteBytes}; `bytes` is empty when `ok` is false. */
export interface RemoteBytes {
  ok: boolean;
  status: number;
  statusText: string;
  contentType: string | null;
  bytes: Uint8Array;
}

/**
 * Fetches a URL with redirect re-validation and a hard byte cap. Redirects
 * are followed manually (max 5) so every hop is checked. With
 * `allowPrivateNetwork: false` loopback/LAN/link-local/cloud-metadata hosts
 * (including DNS names that resolve to them) are refused.
 */
export async function fetchRemoteBytes(
  input: string,
  opts: { signal?: AbortSignal; maxBytes?: number; allowPrivateNetwork?: boolean } = {}
): Promise<RemoteBytes> {
  const maxBytes = opts.maxBytes ?? MAX_REMOTE_FETCH_BYTES;
  const allowPrivate = opts.allowPrivateNetwork ?? false;
  let current = new URL(input);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertRemoteUrlAllowed(current, allowPrivate);
    const res = await fetch(current.href, { signal: opts.signal, redirect: "manual" });
    if ((res as { type?: string }).type === "opaqueredirect") {
      // Browser runtimes hide the Location header: only trusted callers may follow blindly.
      if (!allowPrivate) {
        throw new RemoteFetchError("blocked", "[Agent Accelerator] Redirects cannot be validated in this runtime.", current.href);
      }
      const followed = await fetch(current.href, { signal: opts.signal });
      return {
        ok: followed.ok,
        status: followed.status,
        statusText: followed.statusText,
        contentType: followed.headers.get("content-type"),
        bytes: followed.ok ? await readCapped(followed, maxBytes, current.href) : new Uint8Array(0),
      };
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location) {
      try { await res.body?.cancel(); } catch {}
      current = new URL(location, current);
      continue;
    }
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get("content-type"),
      bytes: res.ok ? await readCapped(res, maxBytes, current.href) : new Uint8Array(0),
    };
  }
  throw new RemoteFetchError("blocked", `[Agent Accelerator] Too many redirects (> ${MAX_REDIRECTS}).`, input);
}
