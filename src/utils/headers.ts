import type { ProviderId } from "../types/model.ts";
import type { CacheConfig } from "../types/core.ts";
import { clampCacheKey } from "./cache.ts";

export function isBrowserRuntime(): boolean {
  try {
    return typeof (globalThis as any).window !== "undefined" && typeof (globalThis as any).window.document !== "undefined";
  } catch {
    return false;
  }
}

function getAgentAccelUserAgent(): string {
  try {
    const os = (globalThis as any).process?.getBuiltinModule?.("node:os") ?? null;
    if (os) {
      return `agent-accel (${os.platform()} ${os.release()}; ${os.arch()})`;
    }
  } catch {}
  return "agent-accel (linux; x64)";
}

const BROWSER_DROPPED = new Set([
  "user-agent",
  "x-session-id",
  "x-client-request-id",
  "session_id",
  "x-opencode-session",
  "x-opencode-client",
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
  const headers: Record<string, string> = {
    ...(browser ? {} : { "User-Agent": "Agent-Accelerator/1.0" }),
    ...(customHeaders ?? {}),
  };

  const rawSessionId = explicitSessionId || cache?.sessionId;
  const sessionId = clampCacheKey(rawSessionId);

  if (sessionId && !browser) {
    if (provider === "opencode" || provider === "opencode-zen" || provider === "opencode-go") {
      headers["x-opencode-session"] = sessionId;
      headers["x-session-id"] = sessionId;
      headers["x-client-request-id"] = sessionId;
      headers["session_id"] = sessionId;
      headers["x-opencode-client"] = "agent-accel";
      headers["User-Agent"] = getAgentAccelUserAgent();
    } else if (provider === "openrouter") {
      headers["x-session-id"] = sessionId;
      headers["x-client-request-id"] = sessionId;
      headers["HTTP-Referer"] = "https://sashvat.com";
      headers["X-Title"] = "Agent Accelerator";
    } else if (provider === "google") {
      headers["x-goog-api-client"] = "agent-accel/1.0";
      headers["x-session-id"] = sessionId;
      headers["x-client-request-id"] = sessionId;
    } else {
      headers["x-session-id"] = sessionId;
      headers["x-client-request-id"] = sessionId;
      headers["session_id"] = sessionId;
    }
  } else if (provider === "openrouter") {
    if (!headers["HTTP-Referer"]) headers["HTTP-Referer"] = "https://sashvat.com";
    if (!headers["X-Title"]) headers["X-Title"] = "Agent Accelerator";
  }

  if (provider === "google" && !browser && !headers["x-goog-api-client"]) {
    headers["x-goog-api-client"] = "agent-accel/1.0";
  }

  if (
    (provider === "opencode" || provider === "opencode-zen" || provider === "opencode-go") &&
    !browser &&
    !headers["x-opencode-client"]
  ) {
    headers["x-opencode-client"] = "agent-accel";
    headers["User-Agent"] = getAgentAccelUserAgent();
  }

  if (browser) return stripForBrowser(headers);
  return headers;
}
