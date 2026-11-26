// NOTE: no static node:fs / node:path / node:dns imports: they break browser
// bundles. Everything Node-specific is loaded lazily inside the helpers.
import type { Message } from "../types/message.ts";
import { mediaKeyOf } from "./media-part.ts";
import { isBrowserRuntime } from "./headers.ts";
import { SecurityPolicyError } from "../types/errors.ts";

/** Default cap for one remote media download (bytes). */
const MAX_REMOTE_FETCH_BYTES = 200_000_000;

/**
 * True when a media string would be read from the local filesystem
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

/**
 * Validates every local-path media part in `messages` against `roots`. Used by
 * the loop each turn so developer-supplied parts, steered prompts and
 * imported sessions all obey `fileAccess.roots` the same way.
 */
export async function enforceFileAccess(messages: Message[], roots: readonly string[]): Promise<void> {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const key = mediaKeyOf(part);
      if (!key) continue;
      const value: unknown = Reflect.get(part, key);
      if (isLocalPathInput(value)) await assertPathAllowed(value, roots);
    }
  }
}

// ---------------------------------------------------------------------------
// Remote fetch guard (SSRF + size cap)
// ---------------------------------------------------------------------------

// True for the private, loopback, link-local and CGNAT IPv4 ranges; in: isPrivateAddress, out: a boolean.
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

// Reads an IPv6 address (no brackets, lower case, a trailing dotted IPv4 and a `%zone` allowed) into its 8 groups of 16 bits, or undefined when it is not one; in: isPrivateAddress, out: the groups.
function ipv6Groups(address: string): number[] | undefined {
  let text = address.split("%")[0] ?? "";
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const octets = dotted.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, dotted.index)}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 1 ? gap !== 0 : gap < 1) return undefined;
  const groups = [...head, ...Array.from({ length: halves.length === 1 ? 0 : gap }, () => "0"), ...tail].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN
  );
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : undefined;
}

// True when the IPv4 address hidden in the last 32 bits of an IPv6 address is private; in: isPrivateAddress, out: a boolean.
function embeddedIpv4Private(groups: number[]): boolean {
  const hi = groups[6] ?? 0;
  return ipv4Private(hi >> 8, hi & 255);
}

/** True for loopback, link-local, private, CGNAT and unique-local addresses, also an IPv4 hidden in an IPv6 one (mapped, compatible, NAT64, written in any form); an unreadable IPv6 address counts as private. */
export function isPrivateAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return ipv4Private(Number(v4[1]), Number(v4[2]));
  if (!host.includes(":")) return false;
  const g = ipv6Groups(host);
  if (!g) return true;
  const first = g[0] ?? 0;
  const zeroUpTo = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(6)) return embeddedIpv4Private(g); // "::", "::1" and "::a.b.c.d"
  if (zeroUpTo(5) && g[5] === 0xffff) return embeddedIpv4Private(g); // "::ffff:a.b.c.d"
  if (zeroUpTo(4) && g[4] === 0xffff && g[5] === 0) return embeddedIpv4Private(g); // "::ffff:0:a.b.c.d" (IPv4-translated)
  if (first === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embeddedIpv4Private(g); // NAT64
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0;
}

// True for localhost, .local/.internal names and private addresses; in: assertRemoteUrlAllowed, out: a boolean.
function isPrivateHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isPrivateAddress(host)
  );
}

/** Looks up every address of a host name (the private-host check's DNS step). */
export type HostLookup = (host: string) => Promise<string[]>;

// Every address of `host` from `node:dns` (throws when the name cannot be resolved, or when the runtime has no `node:dns`); in: assertRemoteUrlAllowed, out: the addresses.
async function dnsLookup(host: string): Promise<string[]> {
  const dns = await import("node:dns");
  const addresses = await dns.promises.lookup(host, { all: true });
  return addresses.map((a) => a.address);
}

let hostLookup: HostLookup = dnsLookup;

/** Replaces the DNS step of the private-host check, so tests never touch the network; no argument restores `node:dns`. Internal: not exported from the package. */
export function setHostLookup(lookup?: HostLookup): void {
  hostLookup = lookup ?? dnsLookup;
}

// Throws RemoteFetchError for a non-http(s) URL or, unless private hosts are allowed, a private host (also by DNS result); a name whose addresses cannot be looked up is refused too, because `fetch` would then resolve it unchecked; in: fetchRemoteBytes on every hop, out: nothing or a thrown error.
async function assertRemoteUrlAllowed(url: URL, allowPrivateNetwork: boolean): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RemoteFetchError(
      "blocked",
      `[Agent Accelerator] Only http(s) URLs are allowed (got ${url.protocol}).`,
      url.href
    );
  }
  if (allowPrivateNetwork || isBrowserRuntime()) return; // a browser fetches from the user's own machine: nothing to guard
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isPrivateHostname(host)) {
    throw new RemoteFetchError(
      "blocked",
      `[Agent Accelerator] Refusing to fetch private/internal host "${host}". Download the file yourself and pass its bytes, a data URL or base64.`,
      url.href
    );
  }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return; // IP literal already checked
  let addresses: string[] = [];
  let failure = "";
  try {
    addresses = await hostLookup(host);
  } catch (err) {
    failure = ` (${err instanceof Error ? err.message : String(err)})`;
  }
  if (addresses.length === 0) {
    throw new RemoteFetchError(
      "blocked",
      `[Agent Accelerator] Cannot check host "${host}": its address could not be looked up${failure}. Download the file yourself and pass its bytes, a data URL or base64.`,
      url.href
    );
  }
  if (addresses.some((address) => isPrivateAddress(address))) {
    throw new RemoteFetchError(
      "blocked",
      `[Agent Accelerator] Host "${host}" resolves to a private/internal address.`,
      url.href
    );
  }
}

// Reads a response body up to `maxBytes`, throwing too_large as soon as the declared or streamed size passes it; in: fetchRemoteBytes, out: the bytes.
async function readCapped(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const tooLarge = () =>
    new RemoteFetchError(
      "too_large",
      `[Agent Accelerator] Remote resource exceeds the ${(maxBytes / 1_000_000).toFixed(0)} MB fetch cap.`,
      url
    );
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      // why: cancelling or releasing something that is already closed is harmless.
    }
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
      try {
        await reader.cancel();
      } catch {
        // why: cancelling or releasing something that is already closed is harmless.
      }
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
interface RemoteBytes {
  ok: boolean;
  status: number;
  statusText: string;
  contentType: string | null;
  bytes: Uint8Array;
}

/**
 * Fetches a URL with redirect re-validation and a hard byte cap. Redirects
 * are followed manually (max 5) so every hop is checked. Unless
 * `allowPrivateNetwork` is true (the default is false) loopback, LAN,
 * link-local and cloud-metadata hosts (including DNS names that resolve to
 * them) are refused; a browser runtime is never guarded.
 */
export async function fetchRemoteBytes(
  input: string,
  opts: { signal?: AbortSignal; maxBytes?: number; allowPrivateNetwork?: boolean; fetch?: typeof fetch } = {}
): Promise<RemoteBytes> {
  const doFetch = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_REMOTE_FETCH_BYTES;
  const allowPrivate = opts.allowPrivateNetwork ?? false;
  let current = new URL(input);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertRemoteUrlAllowed(current, allowPrivate);
    const res = await doFetch(current.href, { signal: opts.signal, redirect: "manual" });
    if ((res as { type?: string }).type === "opaqueredirect") {
      // Browser runtimes hide the Location header: only trusted callers may follow blindly.
      if (!allowPrivate && !isBrowserRuntime()) {
        throw new RemoteFetchError(
          "blocked",
          "[Agent Accelerator] Redirects cannot be validated in this runtime.",
          current.href
        );
      }
      const followed = await doFetch(current.href, { signal: opts.signal });
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
      try {
        await res.body?.cancel();
      } catch {
        // why: cancelling or releasing something that is already closed is harmless.
      }
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
