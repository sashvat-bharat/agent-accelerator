/**
 * Unified Chat — interactive + session-persistent (merged from session-chat.ts)
 *  ↑ = input  ↓ = output  R = cacheRead  CH = hit%  pct%/window (auto)
 *  Works cross-provider (google / opencode / openrouter) — same Agent code.
 *  - Resumes .session.json if exists (or SESSION_ID / --session-file)
 *  - Proves cache is header-based (x-opencode-session / x-session-id)
 *
 *  Run: bun run examples/chat.ts
 *  Also: bun run examples/chat.ts --session-file ./my.json
 *        SESSION_ID=accel-... bun run examples/chat.ts
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "agent-accelerator";
import { getProvider } from "agent-accelerator";
import { getContextWindow as getCatalogContextWindow } from "../src/models/catalog.ts";
import { buildSessionHeaders } from "../src/utils/headers.ts";

// ---------- Session file handling (merged from session-chat.ts) ----------
const DEFAULT_SESSION_FILE = path.join(process.cwd(), ".session.json");
const ENV_SESSION_FILE = process.env.SESSION_FILE ?? process.env.SESSION_PATH;
const ARG_SESSION_FILE =
  process.argv.find((a) => a.startsWith("--session-file="))?.split("=")[1] ??
  (process.argv.includes("--session-file") ? process.argv[process.argv.indexOf("--session-file") + 1] : undefined);
const SESSION_FILE = ARG_SESSION_FILE ?? ENV_SESSION_FILE ?? DEFAULT_SESSION_FILE;

type PersistedSession = {
  sessionId: string;
  model: string;
  subAgentModel?: string;
  thinkingLevel?: string;
  cache?: { retention: "short" | "medium" | "long" };
  serviceTier?: string;
  headers?: Record<string, string>;
  cachedContentId?: string;
  context?: { systemPrompt?: string; messages: any[]; thoughtSignatures?: string[] };
  totals?: any;
};

function loadSession(): PersistedSession | null {
  if (process.env.SESSION_ID) {
    console.log(`\x1b[90m→ Using SESSION_ID from env: ${process.env.SESSION_ID}\x1b[0m`);
    return {
      sessionId: process.env.SESSION_ID,
      model: process.env.MODEL ?? "opencode/model-id",
      subAgentModel: process.env.SUB_AGENT_MODEL,
      thinkingLevel: process.env.THINKING_LEVEL ?? "medium",
      cache: { retention: (process.env.CACHE_RETENTION as any) ?? "short" },
      headers: process.env.SESSION_HEADERS ? JSON.parse(process.env.SESSION_HEADERS) : undefined,
    };
  }
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")) as PersistedSession;
      console.log(`\x1b[90m→ Resumed ${SESSION_FILE} (${data.sessionId.slice(0, 16)}… — ${data.context?.messages?.length ?? 0} msgs) → cache hit expected\x1b[0m`);
      try {
        const h = buildSessionHeaders(
          data.model?.startsWith("google") ? "google" : data.model?.startsWith("openrouter") ? "openrouter" : "opencode",
          data.cache as any, data.headers, data.sessionId
        );
        console.log(`\x1b[90m  headers: ${JSON.stringify(h)}\x1b[0m`);
        if (data.cachedContentId) console.log(`\x1b[90m  cachedContentId: ${data.cachedContentId}\x1b[0m`);
      } catch {}
      return data;
    } catch (e) {
      console.log(`\x1b[90m→ Failed to load ${SESSION_FILE}: ${e} — starting fresh\x1b[0m`);
    }
  } else {
    console.log(`\x1b[90m→ No session at ${SESSION_FILE} — starting fresh\x1b[0m`);
  }
  return null;
}

function loadPrompt(): string {
  for (const p of [path.join(process.cwd(), "SYSTEM_PROMPT_ORCHESTRATOR.md"), path.join(import.meta.dir, "../../SYSTEM_PROMPT_ORCHESTRATOR.md")]) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  return "You are the Orchestrator — delegate complex tasks via spawn_subagents.";
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n/1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n/1000)}k`;
  if (n < 10000000) return `${(n/1000000).toFixed(1)}M`;
  return `${Math.round(n/1000000)}M`;
}
const formatContextWindow = formatTokens;

// ---------- Load & create agent (with resume) ----------
const saved = loadSession();

const agent = new Agent({
  name: "Chat Orchestrator",
  instructions: loadPrompt(),
  model: saved?.model ?? process.env.MODEL,
  SubAgentModel: saved?.subAgentModel ?? process.env.SUB_AGENT_MODEL,
  ThinkingLevel: (saved?.thinkingLevel as any) ?? (process.env.THINKING_LEVEL as any) ?? "medium",
  EnableSubagents: true,
  ServiceTier: (saved?.serviceTier as any) ?? (process.env.SERVICE_TIER as any) ?? undefined,
  cache: (saved?.cache as any) ?? { retention: "short" as const },
  sessionId: saved?.sessionId,
  headers: saved?.headers,
  maxTurns: 10,
});

// Restore history
if (saved?.context?.messages?.length) {
  agent.context.messages = saved.context.messages;
  if (saved.context.systemPrompt) agent.context.systemPrompt = saved.context.systemPrompt;
  if (Array.isArray(saved.context.thoughtSignatures)) (agent.context as any).thoughtSignatures = saved.context.thoughtSignatures;
  if (saved.cachedContentId) {
    (agent.context as any).cachedContentId = saved.cachedContentId;
    if (agent.cacheConfig) (agent.cacheConfig as any).cachedContentId = saved.cachedContentId;
  }
  if (saved.totals) console.log(`\x1b[90m  restored ${saved.context.messages.length} msgs → 80-90% hit expected\x1b[0m`);
}

try {
  const eff = buildSessionHeaders(
    (agent.modelStringOrSpec as string).startsWith("google") ? "google" : (agent.modelStringOrSpec as string).startsWith("openrouter") ? "openrouter" : "opencode",
    agent.cacheConfig as any, agent.customHeaders, agent.sessionId
  );
  console.log(`\x1b[90mEffective headers: ${JSON.stringify(eff)}\x1b[0m`);
} catch {}

let totals = saved?.totals ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
let lastCacheHitRate: number | undefined;

function getContextWindow(): number {
  try {
    const m = agent.modelStringOrSpec as string;
    const prov = m.includes("/") ? m.split("/")[0]! : "opencode";
    const id = m.includes("/") ? m.split("/").slice(1).join("/") : m;
    const cw = getCatalogContextWindow(prov, id);
    if (cw) return cw;
  } catch {}
  try {
    for (const pid of ["google", "opencode", "openrouter"] as const) {
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
  const w = getContextWindow();
  const used = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  const pct = w > 0 ? ((used / w) * 100).toFixed(1) : "?";
  return { pct, window: w };
}

function renderFooterStats(): string {
  const parts: string[] = [];
  if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
  if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
  else if (totals.reasoning) parts.push(`R${formatTokens(totals.reasoning)}`);
  if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
  if (lastCacheHitRate !== undefined) parts.push(`CH${lastCacheHitRate.toFixed(1)}%`);
  else if (totals.input > 0) parts.push(`CH${((totals.cacheRead / totals.input) * 100).toFixed(1)}%`);
  if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
  const { pct, window } = contextPercent();
  const ctx = pct === "?" ? `?/${formatContextWindow(window)} (auto)` : `${pct}%/${formatContextWindow(window)} (auto)`;
  parts.push(ctx);
  return parts.join(" ");
}

function saveSession() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      sessionId: agent.sessionId, model: agent.modelStringOrSpec, subAgentModel: agent.subagentModel,
      thinkingLevel: (agent as any).thinkingConfig?.level, cache: agent.cacheConfig, serviceTier: agent.serviceTier,
      headers: agent.customHeaders, cachedContentId: (agent.context as any).cachedContentId,
      context: { systemPrompt: agent.context.systemPrompt, messages: agent.context.messages, thoughtSignatures: (agent.context as any).thoughtSignatures },
      totals,
    }, null, 2));
  } catch {}
}

// ---------- Chat loop ----------
console.log(`\n Agent Accelerator — Chat (persistent)  •  ${agent.modelStringOrSpec}  •  ${agent.sessionId.slice(0, 12)}… ${saved ? "(resumed)" : "(new)"}`);
console.log(` Context: ${formatContextWindow(getContextWindow())} • wrapThinking: <think> enabled • File: ${SESSION_FILE}`);
console.log(` Commands: /clear /stats /save /exit\n`);

const rl = readline.createInterface({ input: stdin, output: stdout });

while (true) {
  const q = (await rl.question("\x1b[36mYou>\x1b[0m ")).trim();
  if (!q) continue;
  if (["/exit", "/quit", "/q"].includes(q)) break;
  if (["/clear", "/reset"].includes(q)) {
    const hard = q.includes("--hard");
    agent.reset();
    totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
    lastCacheHitRate = undefined;
    console.log(hard ? "— cleared (hard, session rotated) —" : "— cleared —");
    if (hard) (agent as any).sessionId = undefined;
    continue;
  }
  if (q === "/stats") {
    console.log(`\x1b[35m${renderFooterStats()} • ${agent.modelStringOrSpec}\x1b[0m`);
    console.log(`Messages: ${agent.context.messages.length} • Window: ${formatContextWindow(getContextWindow())} • File: ${SESSION_FILE}`);
    continue;
  }
  if (q === "/save") { saveSession(); console.log(`\x1b[90m→ Saved to ${SESSION_FILE}\x1b[0m`); continue; }

  const res = await agent.run(q, {
    stream: true,
    wrapThinking: true,
    onThinkingDelta: (d) => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
    onDelta: (d) => process.stdout.write(d),
    onEvent: (e) => {
      if (e.type === "subagent_complete") console.log(`\n\x1b[90m↳ ${e.subagent!.name} done (${e.subagent!.usage.totalTokens} tok)\x1b[0m`);
    },
  });

  updateTotals(res.usage);
  saveSession();
  const lvl = (agent as any).thinkingConfig?.level ? ` • ${(agent as any).thinkingConfig.level}` : "";
  console.log(`\n\x1b[35m${renderFooterStats()} • ${res.provider}/${res.model}${lvl} ${res.durationMs}ms ${res.finishReason ?? ""}\x1b[0m`);
  if (res.subagents?.length) console.log(`\x1b[90m  subagents: ${res.subagents.map(s => `${s.name}:${s.isError ? "ERR" : "ok"}`).join(", ")}\x1b[0m`);
  console.log("");
}

rl.close();
saveSession();
console.log("\nSESSION SUMMARY");
console.log(JSON.stringify({ sessionId: agent.sessionId, model: agent.modelStringOrSpec, totals, window: formatContextWindow(getContextWindow()), file: SESSION_FILE }, null, 2));
