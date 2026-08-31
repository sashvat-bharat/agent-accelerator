/**
 * Session-persistent Chat — resume same prompt-cache on a *completely new* process
 * by reusing the same sessionId / cache retention / model + restoring history.
 *
 * This proves that cache hit is not in-memory, but via headers:
 *   opencode:  x-opencode-session + x-opencode-client: pi + prompt_cache_key
 *   openrouter: x-session-id + prompt_cache_key
 *   google:    cachedContent (explicit) or implicit prefix
 *
 * Flow:
 *  1. Run `bun run examples/chat.ts` — on exit it writes .session.json (sessionId + context)
 *  2. Run `bun run examples/session-chat.ts` — it loads .session.json and resumes
 *     OR pass explicit env: SESSION_ID=accel-... MODEL=... bun run examples/session-chat.ts
 *     OR: bun run examples/session-chat.ts --session-file ./my-session.json
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "agent-accelerator";
import { getProvider } from "agent-accelerator";
import { getContextWindow as getCatalogContextWindow } from "../src/models/catalog.ts";
import { buildSessionHeaders } from "../src/utils/headers.ts";

// ---------- Session persistence helpers ----------
const DEFAULT_SESSION_FILE = path.join(process.cwd(), ".session.json");
const ENV_SESSION_FILE = process.env.SESSION_FILE || process.env.SESSION_PATH;
const ARG_SESSION_FILE = process.argv.find((a) => a.startsWith("--session-file="))?.split("=")[1] ||
  (process.argv.includes("--session-file") ? process.argv[process.argv.indexOf("--session-file") + 1] : undefined);

const SESSION_FILE = ARG_SESSION_FILE || ENV_SESSION_FILE || DEFAULT_SESSION_FILE;

type PersistedSession = {
  sessionId: string;
  model: string;
  subAgentModel?: string;
  thinkingLevel?: string;
  cache?: { retention: "short" | "medium" | "long" };
  serviceTier?: string;
  headers?: Record<string, string>;
  cachedContentId?: string;
  context?: {
    systemPrompt?: string;
    messages: any[];
    thoughtSignatures?: string[];
  };
  totals?: any;
};

function loadSession(): PersistedSession | null {
  // 1) Explicit env SESSION_ID takes precedence (manual test)
  if (process.env.SESSION_ID) {
    console.log(`\x1b[90m→ Using SESSION_ID from env: ${process.env.SESSION_ID}\x1b[0m`);
    return {
      sessionId: process.env.SESSION_ID,
      model: process.env.MODEL || "opencode/hy3-free",
      subAgentModel: process.env.SUB_AGENT_MODEL,
      thinkingLevel: process.env.THINKING_LEVEL || "medium",
      cache: { retention: (process.env.CACHE_RETENTION as any) || "short" },
      headers: process.env.SESSION_HEADERS ? JSON.parse(process.env.SESSION_HEADERS) : undefined,
    };
  }

  // 2) File
  const file = SESSION_FILE;
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const data = JSON.parse(raw) as PersistedSession;
      console.log(`\x1b[90m→ Resumed session from ${file} (id: ${data.sessionId.slice(0, 24)}…)\x1b[0m`);
      // Show what will be reused for cache
      try {
        const headers = buildSessionHeaders(
          data.model?.startsWith("google") ? "google" : data.model?.startsWith("openrouter") ? "openrouter" : "opencode",
          data.cache as any,
          data.headers,
          data.sessionId
        );
        console.log(`\x1b[90m  headers: ${JSON.stringify(headers)}\x1b[0m`);
        if (data.cachedContentId) console.log(`\x1b[90m  cachedContentId: ${data.cachedContentId}\x1b[0m`);
        console.log(`\x1b[90m  history: ${data.context?.messages?.length ?? 0} messages will be restored → cache hit expected\x1b[0m`);
      } catch {}
      return data;
    } catch (e) {
      console.log(`\x1b[90m→ Failed to load ${file}: ${e} — starting fresh\x1b[0m`);
    }
  } else {
    console.log(`\x1b[90m→ No session file at ${file} — starting fresh (run chat.ts first to create it)\x1b[0m`);
  }
  return null;
}

function saveSession(agent: Agent, totals: any) {
  const file = SESSION_FILE;
  const data: PersistedSession = {
    sessionId: agent.sessionId,
    model: agent.modelStringOrSpec as string,
    subAgentModel: agent.subagentModel as string,
    thinkingLevel: (agent as any).thinkingConfig?.level,
    cache: agent.cacheConfig as any,
    serviceTier: agent.serviceTier as any,
    headers: agent.customHeaders,
    cachedContentId: (agent.context as any).cachedContentId,
    context: {
      systemPrompt: agent.context.systemPrompt,
      messages: agent.context.messages,
      thoughtSignatures: (agent.context as any).thoughtSignatures,
    },
    totals,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    console.log(`\x1b[90m→ Session saved to ${file} (reuse with: bun run examples/session-chat.ts)\x1b[0m`);
    console.log(`\x1b[90m  To resume explicitly: SESSION_ID=${data.sessionId} bun run examples/session-chat.ts\x1b[0m`);
  } catch (e) {
    console.log(`\x1b[90m→ Failed to save session: ${e}\x1b[0m`);
  }
}

// Load orchestrator prompt same as chat.ts
function loadOrchestratorPrompt(): string {
  const candidates = [
    path.join(process.cwd(), "SYSTEM_PROMPT_ORCHESTRATOR.md"),
    path.join(import.meta.dir, "../SYSTEM_PROMPT_ORCHESTRATOR.md"),
    path.join(import.meta.dir, "../../SYSTEM_PROMPT_ORCHESTRATOR.md"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
    } catch {}
  }
  return `You are the Orchestrator — decide when to answer directly vs delegate.`;
}

// ---------- Helpers ----------
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}
function formatContextWindow(n: number): string { return formatTokens(n); }

// ---------- Agent creation with session reuse ----------
const persisted = loadSession();

const agent = new Agent({
  name: "Chat Orchestrator (resumed)",
  instructions: loadOrchestratorPrompt(),
  model: persisted?.model || process.env.MODEL,
  SubAgentModel: persisted?.subAgentModel || process.env.SUB_AGENT_MODEL,
  ThinkingLevel: (persisted?.thinkingLevel as any) || (process.env.THINKING_LEVEL as any) || "medium",
  EnableSubagents: true,
  ServiceTier: (persisted?.serviceTier as any) || (process.env.SERVICE_TIER as any) || undefined,
  cache: persisted?.cache || { retention: "short" as const },
  sessionId: persisted?.sessionId, // ← same header → same cache
  headers: persisted?.headers,
  maxTurns: 10,
});

// Restore history + explicit cache id for Google
if (persisted?.context) {
  if (persisted.context.systemPrompt) agent.context.systemPrompt = persisted.context.systemPrompt;
  if (Array.isArray(persisted.context.messages) && persisted.context.messages.length > 0) {
    // Use the persisted messages as the starting history (preserves prefix for cache)
    (agent.context as any).messages = persisted.context.messages;
  }
  if (Array.isArray(persisted.context.thoughtSignatures)) {
    (agent.context as any).thoughtSignatures = persisted.context.thoughtSignatures;
  }
  if (persisted.cachedContentId) {
    (agent.context as any).cachedContentId = persisted.cachedContentId;
    if (agent.cacheConfig) (agent.cacheConfig as any).cachedContentId = persisted.cachedContentId;
  }
  if (persisted.totals) {
    console.log(`\x1b[90m  restored ${persisted.context.messages.length} history messages → 80-90% hit expected on next turn\x1b[0m`);
  }
}

// Show effective headers that will be sent (proves same cache)
try {
  const effHeaders = buildSessionHeaders(
    (agent.modelStringOrSpec as string).startsWith("google") ? "google" : (agent.modelStringOrSpec as string).startsWith("openrouter") ? "openrouter" : "opencode",
    agent.cacheConfig as any,
    agent.customHeaders,
    agent.sessionId
  );
  console.log(`\x1b[90mEffective headers for this chat: ${JSON.stringify(effHeaders)}\x1b[0m`);
} catch {}

let totals = persisted?.totals || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
let lastCacheHitRate: number | undefined = undefined;

function getContextWindow(): number {
  try {
    const modelStr = agent.modelStringOrSpec as string;
    const prov = modelStr.includes("/") ? modelStr.split("/")[0]! : "opencode";
    const id = modelStr.includes("/") ? modelStr.split("/").slice(1).join("/") : modelStr;
    const cw = getCatalogContextWindow(prov, id);
    if (cw) return cw;
  } catch {}
  try {
    for (const pid of ["google", "opencode", "openrouter"]) {
      try {
        const p = getProvider(pid);
        const spec = p.getModel(agent.modelStringOrSpec as string);
        if (spec?.limit?.context) return spec.limit.context;
        if (spec?.contextWindow) return spec.contextWindow;
      } catch {}
    }
  } catch {}
  return 1_048_576;
}

function updateTotals(usage: any) {
  totals.input += usage.inputTokens ?? 0;
  totals.output += usage.outputTokens ?? 0;
  totals.cacheRead += usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
  totals.cacheWrite += usage.cacheWriteTokens ?? 0;
  totals.reasoning += usage.thinkingTokens ?? 0;
  if (usage.cost?.totalCost) totals.cost += usage.cost.totalCost;
  const latestInput = usage.inputTokens ?? 0;
  const latestRead = usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
  if (latestInput > 0) lastCacheHitRate = (latestRead / latestInput) * 100;
  else if (latestRead > 0) lastCacheHitRate = 100;
}

function contextPercent(): { pct: string; window: number } {
  const window = getContextWindow();
  const used = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  const pct = window > 0 ? ((used / window) * 100).toFixed(1) : "?";
  return { pct, window };
}

function renderFooterStats(): string {
  const parts: string[] = [];
  if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
  if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
  else if (totals.reasoning) parts.push(`R${formatTokens(totals.reasoning)}`);
  if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
  if (lastCacheHitRate !== undefined) parts.push(`CH${lastCacheHitRate.toFixed(1)}%`);
  else if (totals.input > 0) parts.push(`CH${(totals.cacheRead / totals.input * 100).toFixed(1)}%`);
  if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
  const { pct, window } = contextPercent();
  parts.push(pct === "?" ? `?/${formatContextWindow(window)} (auto)` : `${pct}%/${formatContextWindow(window)} (auto)`);
  return parts.join(" ");
}

// ---------- Main ----------
async function main() {
  console.log(`\x1b[1mAgent Accelerator — Session-Persistent Chat\x1b[0m`);
  console.log(`Model: ${agent.modelStringOrSpec}  SubModel: ${agent.subagentModel || "inherit"}  Session: ${agent.sessionId} ${persisted ? "(resumed)" : "(new)"}`);
  console.log(`Session file: ${SESSION_FILE} ${persisted ? "— will hit same cache as chat.ts" : "— will be created on exit"}`);
  console.log(`Footer: ↑input ↓output Rcache CH% ctx%/window — like pi`);
  console.log(`Commands: /exit /clear /stats /save\n`);

  // Also patch chat.ts to save session on exit for next time (if user runs chat.ts first)
  // The user can also manually do: SESSION_ID=accel-... bun run examples/session-chat.ts

  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const prompt = await rl.question("\x1b[36mYou>\x1b[0m ");
      const trimmed = prompt.trim();
      if (!trimmed) continue;
      if (["/exit", "/quit", "/q"].includes(trimmed.toLowerCase())) break;
      if (["/clear", "/reset"].includes(trimmed.toLowerCase())) {
        agent.reset();
        totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
        lastCacheHitRate = undefined;
        console.log("\x1b[90m— context cleared (sessionId kept for cache, use /clear --hard to rotate)\x1b[0m");
        if (trimmed.includes("--hard")) {
          // Hard reset also rotates sessionId — cache will miss
          (agent as any).sessionId = undefined;
        }
        continue;
      }
      if (trimmed === "/stats") {
        console.log(`\x1b[35m${renderFooterStats()}  •  ${agent.modelStringOrSpec}\x1b[0m`);
        console.log(`Messages: ${agent.context.messages.length}, cachedContentId: ${(agent.context as any).cachedContentId || "implicit"}`);
        continue;
      }
      if (trimmed === "/save") {
        saveSession(agent, totals);
        continue;
      }

      process.stdout.write("\x1b[2m— streaming —\x1b[0m\n");
      const stream = agent.stream(trimmed);
      let isThinking = false;
      for await (const ev of stream) {
        if (ev.type === "thinking_start") {
          if (!isThinking) { isThinking = true; process.stdout.write("\x1b[90m"); }
        } else if (ev.type === "thinking_delta") {
          const d = (ev as any).thinkingDelta ?? "";
          if (!isThinking) { isThinking = true; process.stdout.write("\x1b[90m"); }
          if (d) process.stdout.write(d);
        } else if (ev.type === "thinking_end") {
          if (isThinking) { process.stdout.write("\x1b[0m\n"); isThinking = false; }
        } else if (ev.type === "text_delta" && (ev as any).delta) {
          if (isThinking) { process.stdout.write("\x1b[0m\n"); isThinking = false; }
          process.stdout.write((ev as any).delta);
        } else if (ev.type === "subagent_complete") {
          const s = (ev as any).subagent;
          process.stdout.write(`\n\x1b[90m↳ subagent ${s.name} (${s.provider}/${s.model}) ${formatTokens(s.usage.totalTokens)} in ${s.durationMs}ms\x1b[0m\n`);
        }
      }
      if (isThinking) process.stdout.write("\x1b[0m\n");
      process.stdout.write("\n");
      const result = await stream.result();
      updateTotals(result.usage);
      const thinkingPart = (agent as any).thinkingConfig?.level ? ` • ${(agent as any).thinkingConfig.level}` : "";
      console.log(`\x1b[35m${renderFooterStats()}  •  ${result.provider}/${result.model}${thinkingPart}  ${result.durationMs}ms\x1b[0m`);
      if (result.subagents?.length) console.log(`\x1b[90m  subagents: ${result.subagents.map(s => `${s.name}:${s.isError ? "ERR" : "ok"}`).join(", ")}\x1b[0m`);
      console.log("");

      // Auto-save after each turn so a new process can resume and hit same cache
      saveSession(agent, totals);
    }
  } finally {
    rl.close();
    saveSession(agent, totals);
    console.log("\n===============================================================================");
    console.log("  SESSION SUMMARY (RAW JSON)");
    console.log("===============================================================================");
    console.log(JSON.stringify({
      sessionId: agent.sessionId,
      model: agent.modelStringOrSpec,
      subModel: agent.subagentModel,
      totals,
      headers: (() => {
        try {
          return buildSessionHeaders(
            (agent.modelStringOrSpec as string).startsWith("google") ? "google" : (agent.modelStringOrSpec as string).startsWith("openrouter") ? "openrouter" : "opencode",
            agent.cacheConfig as any,
            agent.customHeaders,
            agent.sessionId
          );
        } catch { return {}; }
      })(),
      cachedContentId: (agent.context as any).cachedContentId,
      contextPreview: agent.context.messages.slice(-2).map(m => ({ role: m.role, preview: typeof m.content === "string" ? m.content.slice(0,120) : JSON.stringify(m.content).slice(0,200) })),
    }, null, 2));
    console.log("===============================================================================\n");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
