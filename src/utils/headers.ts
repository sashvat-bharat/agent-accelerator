import type { ProviderId } from "../types/model.ts";
import type { CacheConfig } from "../types/core.ts";
import { clampCacheKey } from "./cache.ts";

function getAgentAccelUserAgent(): string {
  try {
    // match agent-accel's agent-accel-user-agent.ts: agent-accel (platform release; arch)
    // use node:os if available, else fallback
    const os = (globalThis as any).process?.getBuiltinModule?.("node:os") ?? null;
    if (os) {
      return `agent-accel (${os.platform()} ${os.release()}; ${os.arch()})`;
    }
  } catch {}
  return "agent-accel (linux; x64)";
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
  const sessionId = clampCacheKey(rawSessionId);

  if (sessionId) {
    if (provider === "opencode" || provider === "opencode-zen" || provider === "opencode-go") {
      // OpenCode session affinity headers for completions and responses endpoints
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
    } else {
      headers["x-session-id"] = sessionId;
      headers["x-client-request-id"] = sessionId;
      headers["session_id"] = sessionId;
    }
  }

  // agent-accel also sets x-opencode-client via getAgentAccelUserAgent for opencode — ensure it persists even without sessionId
  if ((provider === "opencode" || provider === "opencode-zen" || provider === "opencode-go") && !headers["x-opencode-client"]) {
    // Even without sessionId, agent-accel still advertises client for attribution (helps opencode allow free models)
    headers["x-opencode-client"] = "agent-accel";
    headers["User-Agent"] = getAgentAccelUserAgent();
  }

  return headers;
}
