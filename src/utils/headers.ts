import type { ProviderId } from "../types/model.ts";
import type { CacheConfig } from "../types/core.ts";

const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
function clampSessionId(key?: string): string | undefined {
  if (!key) return undefined;
  const chars = Array.from(key);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

function getPiUserAgent(): string {
  try {
    // match pi's pi-user-agent.ts: pi (platform release; arch)
    // use node:os if available, else fallback
    const os = (globalThis as any).process?.getBuiltinModule?.("node:os") ?? null;
    if (os) {
      return `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
    }
  } catch {}
  return "pi (linux; x64)";
}

export function buildSessionHeaders(
  provider: ProviderId | string,
  cache?: CacheConfig,
  customHeaders?: Record<string, string>,
  explicitSessionId?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "Agent-Accelerator/1.0",
    ...(customHeaders ?? {}),
  };

  const rawSessionId = explicitSessionId || cache?.sessionId;
  const sessionId = clampSessionId(rawSessionId);

  if (sessionId) {
    if (provider === "opencode" || provider === "opencode-zen" || provider === "opencode-go") {
      // pi's provider-attribution.ts: getSessionHeaders for opencode → x-opencode-session + x-opencode-client: pi
      // Keep x-session-id for backward compat (test expects it) — opencode accepts both, pi only needs x-opencode-session
      headers["x-opencode-session"] = sessionId;
      headers["x-session-id"] = sessionId;
      headers["x-opencode-client"] = "pi";
      headers["User-Agent"] = getPiUserAgent();
    } else if (provider === "openrouter") {
      headers["x-session-id"] = sessionId;
      headers["HTTP-Referer"] = "https://agent-accelerator.dev";
      headers["X-Title"] = "Agent Accelerator";
    } else {
      headers["x-session-id"] = sessionId;
    }
  }

  // pi also sets x-opencode-client via getPiUserAgent for opencode — ensure it persists even without sessionId
  if ((provider === "opencode" || provider === "opencode-zen" || provider === "opencode-go") && !headers["x-opencode-client"]) {
    // Even without sessionId, pi still advertises client for attribution (helps opencode allow free models)
    headers["x-opencode-client"] = "pi";
    headers["User-Agent"] = getPiUserAgent();
  }

  return headers;
}
