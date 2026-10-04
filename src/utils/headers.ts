import type { ProviderId } from "../types/model.ts";
import type { CacheConfig } from "../types/core.ts";
import { clampCacheKey } from "./cache.ts";

export function isBrowserRuntime(): boolean {
  try {
    const g = globalThis as any;
    if (typeof g.window !== "undefined" && typeof g.window.document !== "undefined") return true;
    // Web Workers / Service Workers have no window.document but are still
    // CORS-constrained browser scopes: custom x-* headers trigger preflights
    // the providers never allow-list (surfaces as `TypeError: Failed to fetch`).
    if (typeof g.WorkerGlobalScope !== "undefined") return true;
    if (typeof g.importScripts === "function") return true;
    if (typeof g.navigator !== "undefined" && g.navigator?.product === "ReactNative") return true;
    return false;
  } catch {
    return false;
  }
}

/** Package version for User-Agent strings. Reads the npm-injected env first. */
export function getPackageVersion(): string {
  try {
    const v = (globalThis as any).process?.env?.npm_package_version;
    if (typeof v === "string" && v) return v;
  } catch {}
  return "0.4.0";
}

function getAgentAccelUserAgent(): string {
  const version = getPackageVersion();
  try {
    const os = (globalThis as any).process?.getBuiltinModule?.("node:os") ?? null;
    if (os) {
      return `agent-accel/${version} (${os.platform()} ${os.release()}; ${os.arch()})`;
    }
  } catch {}
  return `agent-accel/${version} (linux; x64)`;
}

// Re-exported for tests/diagnostics (unused by wire headers directly).
export const AGENT_ACCEL_USER_AGENT = getAgentAccelUserAgent;

// ---------------------------------------------------------------------------
// Attribution (Q-17): configurable, default none except OpenRouter legacy.
// ---------------------------------------------------------------------------

/** Configurable attribution headers (OpenRouter `HTTP-Referer` / `X-Title`). */
export interface AttributionConfig {
  referer?: string;
  title?: string;
  userAgent?: string;
}

let attribution: AttributionConfig = {};

/**
 * Configures global attribution headers. Defaults to none (no hardcoded
 * site); OpenRouter keeps its legacy `sashvat.com` / `Agent Accelerator`
 * fallback when no custom attribution is set (backward compat).
 * @example `setAttribution({ referer: "https://example.com", title: "My App" });`
 */
export function setAttribution(cfg: AttributionConfig): void {
  attribution = { ...attribution, ...cfg };
  if (cfg.referer === undefined && cfg.title === undefined && cfg.userAgent === undefined) {
    // Explicit empty reset: `setAttribution({})` clears prior values.
    if (Object.keys(cfg).length === 0) attribution = {};
  }
}

/** Returns a copy of the current attribution config (default `{}`). */
export function getAttribution(): AttributionConfig {
  return { ...attribution };
}

/** First-class providers with documented session-affinity headers. */
const FIRST_CLASS = new Set(["google", "openai", "openrouter"]);

/** Case-insensitive header lookup. */
function findHeaderKey(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return k;
  }
  return undefined;
}

/**
 * Sets a header case-insensitively (removes any case-variant duplicate
 * first). Use when applying canonical `Authorization` / `Content-Type` over
 * user-supplied `customHeaders` so `authorization` + `Authorization` never
 * coexist on the wire.
 * @example `setHeaderCaseInsensitive(headers, "Authorization", "Bearer k");`
 */
export function setHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
  value: string
): void {
  const existing = findHeaderKey(headers, name);
  if (existing !== undefined && existing !== name) delete headers[existing];
  headers[name] = value;
}

// ---------------------------------------------------------------------------
// Thought-signature namespacing (Q-18).
// ---------------------------------------------------------------------------

/**
 * Tags a captured thought signature with its issuing provider so history
 * builders echo it only on the same provider. Untagged (legacy) signatures
 * echo everywhere for backward compat.
 */
export function withProviderSignature(
  sig: string | undefined,
  provider: string
): { thoughtSignature?: string; thoughtSignatureProvider?: string } {
  if (!sig) return {};
  return { thoughtSignature: sig, thoughtSignatureProvider: provider };
}

/**
 * Returns true when a stored signature may be echoed on `currentProvider`:
 * untagged (legacy) echoes everywhere, tagged echoes only on a match.
 */
export function shouldEchoSignature(
  storedProvider: unknown,
  currentProvider: string
): boolean {
  if (!storedProvider) return true;
  return storedProvider === currentProvider;
}

const BROWSER_DROPPED = new Set([
  "user-agent",
  "x-session-id",
  "x-client-request-id",
  "session_id",
  "x-goog-api-client",
]);

function stripForBrowser(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (BROWSER_DROPPED.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Builds provider-specific session, cache-affinity, and attribution headers.
 *
 * Q-17: attribution is configurable via `setAttribution()` (default none).
 * OpenRouter keeps its legacy `https://sashvat.com` / `Agent Accelerator`
 * fallback when no custom attribution is set. Custom (non-first-class)
 * prefixes receive minimal `x-session-id`/`x-client-request-id` affinity only
 * (no `session_id` alias, no attribution) when a session id is present.
 * `customHeaders` merge case-insensitively against canonical names.
 *
 * Browser note: custom `x-*` session/affinity headers force a CORS preflight
 * (`OPTIONS`) and providers only allow-list their own documented headers, so a
 * preflight failure surfaces as a bare `TypeError: Failed to fetch`. In browser
 * runtimes this returns only CORS-safe attribution headers (OpenRouter
 * `HTTP-Referer` / `X-Title`); session affinity still flows via `providerOptions`
 * (`promptCacheKey`), never via headers.
 * @example `const headers = buildSessionHeaders("google", { sessionId: "session-123" });`
 */
export function buildSessionHeaders(
  provider: ProviderId | string,
  cache?: CacheConfig,
  customHeaders?: Record<string, string>,
  explicitSessionId?: string
): Record<string, string> {
  const browser = isBrowserRuntime();
  const attr = getAttribution();
  const headers: Record<string, string> = {};
  if (!browser) {
    setHeaderCaseInsensitive(headers, "User-Agent", attr.userAgent ?? `Agent-Accelerator/${getPackageVersion()}`);
  }
  for (const [k, v] of Object.entries(customHeaders ?? {})) {
    const existing = findHeaderKey(headers, k);
    if (existing !== undefined && existing !== k) delete headers[existing];
    headers[k] = v;
  }

  const rawSessionId = explicitSessionId || cache?.sessionId;
  const sessionId = clampCacheKey(rawSessionId);
  const isFirstClass = FIRST_CLASS.has(provider);

  const getHeader = (name: string): string | undefined => {
    const key = findHeaderKey(headers, name);
    return key !== undefined ? headers[key] : undefined;
  };

  if (sessionId && !browser) {
    if (provider === "openrouter") {
      setHeaderCaseInsensitive(headers, "x-session-id", sessionId);
      setHeaderCaseInsensitive(headers, "x-client-request-id", sessionId);
      const referer = attr.referer ?? "https://sashvat.com";
      const title = attr.title ?? "Agent Accelerator";
      if (getHeader("HTTP-Referer") === undefined) headers["HTTP-Referer"] = referer;
      if (getHeader("X-Title") === undefined) headers["X-Title"] = title;
    } else if (provider === "google") {
      if (getHeader("x-goog-api-client") === undefined) {
        headers["x-goog-api-client"] = "agent-accel/1.0";
      }
      setHeaderCaseInsensitive(headers, "x-session-id", sessionId);
      setHeaderCaseInsensitive(headers, "x-client-request-id", sessionId);
    } else if (isFirstClass) {
      setHeaderCaseInsensitive(headers, "x-session-id", sessionId);
      setHeaderCaseInsensitive(headers, "x-client-request-id", sessionId);
      setHeaderCaseInsensitive(headers, "session_id", sessionId);
    } else {
      // Custom OpenAI-compatible prefix: headers-only affinity. Bodies carry
      // no affinity key on strict endpoints, so only the minimal pair is
      // sent (no `session_id` alias, no attribution).
      setHeaderCaseInsensitive(headers, "x-session-id", sessionId);
      setHeaderCaseInsensitive(headers, "x-client-request-id", sessionId);
    }
  } else if (provider === "openrouter") {
    const referer = attr.referer ?? "https://sashvat.com";
    const title = attr.title ?? "Agent Accelerator";
    if (getHeader("HTTP-Referer") === undefined) headers["HTTP-Referer"] = referer;
    if (getHeader("X-Title") === undefined) headers["X-Title"] = title;
  }

  if (provider === "google" && !browser && getHeader("x-goog-api-client") === undefined) {
    headers["x-goog-api-client"] = "agent-accel/1.0";
  }

  if (browser) return stripForBrowser(headers);
  return headers;
}
