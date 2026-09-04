/**
 * Unified Chat — interactive + session-persistent (JSONL, merged from session-chat.ts)
 *  ↑ = input  ↓ = output  CR = cacheRead  CW = cacheWrite  CH = hit%  pct%/window (auto)
 *  Works cross-provider (google / opencode / openrouter) — same Agent code.
 *  File is JSONL like demo-session.jsonl — every turn is one line, not daunting.
 *
 *  Run: bun run examples/chat.ts
 *  Also: bun run examples/chat.ts --session-file ./my.jsonl
 *        SESSION_ID=accel-... bun run examples/chat.ts
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, getProvider, resolveModel } from "agent-accelerator";
import { getModelFromCatalog, getModelThinkingInfo, validateModelThinking } from "../src/models/catalog.ts";
import { buildSessionHeaders } from "../src/utils/headers.ts";

// ---------- Session file handling — JSONL (like demo-session.jsonl) ----------
const DEFAULT_SESSION_FILE = path.join(process.cwd(), ".session.jsonl");
const ENV_SESSION_FILE = process.env.SESSION_FILE ?? process.env.SESSION_PATH;
const ARG_SESSION_FILE =
  process.argv.find((a) => a.startsWith("--session-file="))?.split("=")[1] ??
  (process.argv.includes("--session-file") ? process.argv[process.argv.indexOf("--session-file") + 1] : undefined);
const SESSION_FILE = ARG_SESSION_FILE ?? ENV_SESSION_FILE ?? DEFAULT_SESSION_FILE;

// Legacy .session.json still supported for reading
const LEGACY_FILE = path.join(process.cwd(), ".session.json");

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

  // Try JSONL first, then legacy JSON
  const tryFile = (file: string): PersistedSession | null => {
    if (!fs.existsSync(file)) return null;
    try {
      const raw = fs.readFileSync(file, "utf8");
      // JSONL detection: multiple lines starting with {"type":
      if (raw.trim().startsWith('{"type"')) {
        const lines = raw.split("\n").filter(Boolean);
        let sessionId = "";
        let model = "";
        let subAgentModel: string | undefined;
        let thinkingLevel: string | undefined;
        let cache: any;
        let serviceTier: string | undefined;
        let headers: any;
        let cachedContentId: string | undefined;
        let systemPrompt: string | undefined;
        const messages: any[] = [];
        let totals: any;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === "session") {
              sessionId = obj.id ?? obj.sessionId ?? sessionId;
              model = obj.model ?? model;
              subAgentModel = obj.subAgentModel ?? subAgentModel;
              thinkingLevel = obj.thinkingLevel ?? thinkingLevel;
              cache = obj.cache ?? cache;
              serviceTier = obj.serviceTier ?? serviceTier;
              headers = obj.headers ?? headers;
              cachedContentId = obj.cachedContentId ?? cachedContentId;
            } else if (obj.type === "model_change") { model = obj.modelId ?? obj.model ?? model; }
            else if (obj.type === "thinking_level_change") { thinkingLevel = obj.thinkingLevel; }
            else if (obj.type === "message") { if (obj.message) messages.push(obj.message); }
            else if (obj.type === "totals") { totals = obj.totals ?? obj; cachedContentId = obj.cachedContentId ?? cachedContentId; cache = obj.cache ?? cache; }
            else if (obj.type === "context") { if (obj.systemPrompt) systemPrompt = obj.systemPrompt; if (Array.isArray(obj.messages)) messages.push(...obj.messages); }
          } catch {}
        }
        // Fallback: if no type:message lines but file is single JSON object
        if (messages.length === 0) {
          try { const single = JSON.parse(raw); if (single.context?.messages) return single as PersistedSession; } catch {}
        }
        if (!sessionId && messages.length === 0) return null;
        console.log(`\x1b[90m→ Resumed ${file} (${sessionId.slice(0, 16)}… — ${messages.length} msgs) → cache hit expected\x1b[0m`);
        return { sessionId: sessionId || `accel-${Date.now()}`, model: model || process.env.MODEL!, subAgentModel, thinkingLevel, cache, serviceTier, headers, cachedContentId, context: { systemPrompt, messages }, totals };
      } else {
        // Legacy single JSON
        const data = JSON.parse(raw) as PersistedSession;
        console.log(`\x1b[90m→ Resumed ${file} (${data.sessionId.slice(0, 16)}… — ${data.context?.messages?.length ?? 0} msgs) → cache hit expected\x1b[0m`);
        return data;
      }
    } catch (e) {
      console.log(`\x1b[90m→ Failed to load ${file}: ${e} — starting fresh\x1b[0m`);
      return null;
    }
  };

  return tryFile(SESSION_FILE) ?? tryFile(LEGACY_FILE) ?? (() => { console.log(`\x1b[90m→ No session at ${SESSION_FILE} — starting fresh\x1b[0m`); return null; })();
}

function loadPrompt(): string {
  for (const p of [path.join(process.cwd(), "SYSTEM_PROMPT_AGENT.md"), path.join(import.meta.dir, "../../SYSTEM_PROMPT_AGENT.md")]) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  return "You are an Agent — delegate complex tasks via spawn_subagents.";
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
const resolvedModelName = saved?.model ?? process.env.MODEL ?? "opencode/model-id";
const resolved = resolveModel(resolvedModelName);
const initialProv = resolved.provider.id;
const initialModelId = resolved.modelId;
const initialModelInfo = getModelThinkingInfo(initialProv, initialModelId);

let initialThinkingLevel: string = (saved?.thinkingLevel as any) ?? (process.env.THINKING_LEVEL as any);

if (!initialThinkingLevel) {
  if (initialModelInfo.supportsThinking && !initialModelInfo.supportsDisable) {
    initialThinkingLevel = initialModelInfo.allowedLevels[0] || "low";
  } else {
    initialThinkingLevel = "none";
  }
} else {
  try {
    validateModelThinking(initialProv, initialModelId, initialThinkingLevel);
  } catch (err: any) {
    console.log(`\x1b[31merror: ${err.message}\x1b[0m`);
    initialThinkingLevel = initialModelInfo.supportsThinking && !initialModelInfo.supportsDisable
      ? (initialModelInfo.allowedLevels[0] || "low")
      : "none";
    console.log(`\x1b[32m→ Auto-selected thinking level "${initialThinkingLevel}" for ${initialModelId}\x1b[0m`);
  }
}

const agent = new Agent({
  name: "Chat Orchestrator",
  instructions: loadPrompt(),
  model: resolvedModelName,
  SubAgentModel: saved?.subAgentModel ?? process.env.SUB_AGENT_MODEL,
  ThinkingLevel: initialThinkingLevel as any,
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
  const resolvedCurrent = resolveModel(agent.modelStringOrSpec);
  const eff = buildSessionHeaders(
    resolvedCurrent.provider.id,
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
    const spec = getModelFromCatalog(prov, id);
    if (spec?.limit?.context) return spec.limit.context;
    if (spec?.contextWindow) return spec.contextWindow;
  } catch {}
  try {
    for (const pid of ["google", "opencode", "openrouter", "openai"] as const) {
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

function formatCost(c: number): string {
  if (!c || c <= 0) return "$0.00";
  if (c < 0.0001) return `$${c.toFixed(6)}`;
  if (c < 0.01) return `$${c.toFixed(4)}`;
  if (c < 1.0) return `$${c.toFixed(3)}`;
  return `$${c.toFixed(2)}`;
}

function updateTotals(usage: any, modelStr?: string): number {
  totals.input += usage.inputTokens ?? 0;
  totals.output += usage.outputTokens ?? 0;
  totals.cacheRead += usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
  totals.cacheWrite += usage.cacheWriteTokens ?? 0;
  totals.reasoning += usage.thinkingTokens ?? 0;

  // Realtime cost tracking with fallback catalog calculation
  let turnCost = usage.cost?.totalCost ?? 0;
  if (!turnCost && modelStr) {
    const prov = modelStr.includes("/") ? modelStr.split("/")[0]! : "opencode";
    const id = modelStr.includes("/") ? modelStr.split("/").slice(1).join("/") : modelStr;
    const spec = getModelFromCatalog(prov, id);
    if (spec?.pricing || spec?.cost) {
      const inputP = spec.pricing?.inputPerMillion ?? spec.cost?.input ?? 0;
      const outputP = spec.pricing?.outputPerMillion ?? spec.cost?.output ?? 0;
      const crP = spec.pricing?.cacheReadPerMillion ?? spec.cost?.cache_read ?? 0;
      const cwP = spec.pricing?.cacheWritePerMillion ?? spec.cost?.cache_write ?? 0;
      const cr = usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
      const uncachedIn = Math.max(0, (usage.inputTokens ?? 0) - cr);
      turnCost =
        (uncachedIn / 1_000_000) * inputP +
        (cr / 1_000_000) * crP +
        ((usage.cacheWriteTokens ?? 0) / 1_000_000) * cwP +
        ((usage.outputTokens ?? 0) / 1_000_000) * outputP;
    }
  }
  totals.cost += turnCost;

  const latestInput = usage.inputTokens ?? 0;
  const latestRead = usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
  if (latestInput > 0) lastCacheHitRate = (latestRead / latestInput) * 100;
  else if (latestRead > 0) lastCacheHitRate = 100;

  return turnCost;
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
  if (totals.cacheRead) parts.push(`CR${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) parts.push(`CW${formatTokens(totals.cacheWrite)}`);
  if (lastCacheHitRate !== undefined) parts.push(`CH${lastCacheHitRate.toFixed(1)}%`);
  else if (totals.input > 0) parts.push(`CH${((totals.cacheRead / totals.input) * 100).toFixed(1)}%`);
  parts.push(formatCost(totals.cost));
  const { pct, window } = contextPercent();
  const ctx = pct === "?" ? `?/${formatContextWindow(window)} (auto)` : `${pct}%/${formatContextWindow(window)} (auto)`;
  parts.push(ctx);
  return parts.join(" ");
}

function saveSession() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    const lines: string[] = [];
    const currentLevel = (agent as any).thinkingConfig?.level ?? "none";
    lines.push(JSON.stringify({
      type: "session",
      id: agent.sessionId,
      model: agent.modelStringOrSpec,
      subAgentModel: agent.subagentModel,
      thinkingLevel: currentLevel,
      cache: agent.cacheConfig,
      serviceTier: agent.serviceTier,
      headers: agent.customHeaders,
      cachedContentId: (agent.context as any).cachedContentId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    }));
    lines.push(JSON.stringify({ type: "model_change", modelId: agent.modelStringOrSpec, provider: (agent.modelStringOrSpec as string).split("/")[0] ?? "unknown" }));
    lines.push(JSON.stringify({ type: "thinking_level_change", thinkingLevel: currentLevel }));
    for (const msg of agent.context.messages) {
      lines.push(JSON.stringify({ type: "message", id: `msg_${Math.random().toString(36).slice(2, 9)}`, timestamp: new Date().toISOString(), message: msg }));
    }
    lines.push(JSON.stringify({ type: "totals", totals, cache: agent.cacheConfig, cachedContentId: (agent.context as any).cachedContentId }));
    fs.writeFileSync(SESSION_FILE, lines.join("\n") + "\n");
  } catch {}
}

// ---------- Chat loop ----------
const activeThinking = (agent as any).thinkingConfig?.level ?? initialThinkingLevel;
console.log(`\n Agent Accelerator — Chat (persistent)  •  ${agent.modelStringOrSpec}  •  ${agent.sessionId.slice(0, 12)}… ${saved ? "(resumed)" : "(new)"}`);
console.log(` Context: ${formatContextWindow(getContextWindow())} • Thinking: ${activeThinking} • File: ${SESSION_FILE} (JSONL)`);
console.log(` Commands: /model <id>  /level <lvl>  /stats  /clear  /save  /help  /exit\n`);

const rl = readline.createInterface({ input: stdin, output: stdout });

while (true) {
  let rawQ: string;
  try {
    rawQ = await rl.question("\x1b[36mYou>\x1b[0m ");
  } catch {
    break;
  }
  if (rawQ === undefined || rawQ === null) break;
  const q = rawQ.trim();
  if (!q) continue;
  if (["/exit", "/quit", "/q"].includes(q)) break;

  if (q.startsWith("/model")) {
    const nextModel = q.slice(6).trim();
    if (nextModel) {
      const resolvedNext = resolveModel(nextModel);
      const prov = resolvedNext.provider.id;
      const modelId = resolvedNext.modelId;
      const currentLevel = (agent as any).thinkingConfig?.level;
      if (currentLevel && currentLevel !== "none") {
        try {
          validateModelThinking(prov, modelId, currentLevel);
        } catch (e: any) {
          console.log(`\x1b[33m⚠ Warning: current thinking level "${currentLevel}" is not valid for ${nextModel}.\x1b[0m`);
          console.log(`\x1b[90m${e.message}\x1b[0m`);
          const info = getModelThinkingInfo(prov, modelId);
          if (info.allowedLevels.length > 0) {
            const fallbackLevel = info.allowedLevels[0];
            (agent as any).thinkingConfig = { enabled: fallbackLevel !== "none", level: fallbackLevel as any };
            console.log(`\x1b[32m→ Auto-adjusted thinking level to "${fallbackLevel}" for ${nextModel}\x1b[0m`);
          } else if (!info.supportsThinking) {
            (agent as any).thinkingConfig = { enabled: false, level: "none", budgetTokens: 0 };
            console.log(`\x1b[32m→ Auto-adjusted thinking level to "none" (model does not think)\x1b[0m`);
          }
        }
      }
      (agent as any).modelStringOrSpec = nextModel;
      saveSession();
      console.log(`\x1b[32m✔ Switched model to: ${nextModel}\x1b[0m`);
    } else {
      console.log(`Current model: ${agent.modelStringOrSpec}`);
    }
    continue;
  }

  if (q.startsWith("/level") || q.startsWith("/thinking")) {
    const nextLevel = q.split(" ")[1]?.trim() as any;
    const currentModelStr = (agent.modelStringOrSpec as string) || "";
    const resolvedCurrent = resolveModel(currentModelStr);
    const prov = resolvedCurrent.provider.id;
    const modelId = resolvedCurrent.modelId;

    if (nextLevel) {
      try {
        validateModelThinking(prov, modelId, nextLevel);

        if (nextLevel === "none") {
          (agent as any).thinkingConfig = { enabled: false, level: "none", budgetTokens: 0 };
        } else if (nextLevel === "dynamic") {
          (agent as any).thinkingConfig = { enabled: true, level: "dynamic", budgetTokens: -1 };
        } else {
          (agent as any).thinkingConfig = { enabled: true, level: nextLevel };
        }
        saveSession();
        console.log(`\x1b[32m✔ Switched thinking level to: ${nextLevel}\x1b[0m`);
      } catch (err: any) {
        console.log(`\x1b[31m✖ ${err.message}\x1b[0m`);
      }
    } else {
      const info = getModelThinkingInfo(prov, modelId);
      console.log(`Current thinking level: ${(agent as any).thinkingConfig?.level ?? "none"}`);
      console.log(`\x1b[90m${info.description}\x1b[0m`);
    }
    continue;
  }

  if (q.startsWith("/tier")) {
    const tier = q.split(" ")[1]?.trim() as any;
    if (["flex", "priority", "standard"].includes(tier)) {
      (agent as any).serviceTier = tier === "standard" ? undefined : tier;
      saveSession();
      console.log(`\x1b[32m✔ Switched service tier to: ${tier}\x1b[0m`);
    } else {
      console.log(`Usage: /tier <standard | flex | priority>`);
    }
    continue;
  }

  if (q.startsWith("/cache")) {
    const ret = q.split(" ")[1]?.trim() as any;
    if (["short", "medium", "long"].includes(ret)) {
      (agent as any).cacheConfig = { ...(agent.cacheConfig || {}), retention: ret };
      saveSession();
      console.log(`\x1b[32m✔ Switched cache retention to: ${ret}\x1b[0m`);
    } else {
      console.log(`Usage: /cache <short | medium | long>`);
    }
    continue;
  }

  if (["/clear", "/reset"].includes(q) || q.startsWith("/clear") || q.startsWith("/reset")) {
    const hard = q.includes("--hard");
    agent.reset();
    totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
    lastCacheHitRate = undefined;
    console.log(hard ? "— cleared (hard, session rotated) —" : "— cleared —");
    if (hard) (agent as any).sessionId = `accel-${Date.now()}`;
    saveSession();
    continue;
  }

  if (q === "/help") {
    console.log(`\x1b[33mAvailable Commands:\x1b[0m`);
    console.log(`  /model <id>       Switch active model (e.g. /model opencode/gpt-5.4)`);
    console.log(`  /level <lvl>      Set thinking level (none, minimal, low, medium, high, xhigh, dynamic)`);
    console.log(`  /tier <tier>      Set service tier (standard, flex, priority)`);
    console.log(`  /cache <ret>      Set cache retention (short, medium, long)`);
    console.log(`  /stats            Show token totals, cache stats, and context usage`);
    console.log(`  /clear [--hard]   Reset conversation history`);
    console.log(`  /save             Save current state to ${SESSION_FILE}`);
    console.log(`  /exit, /quit      Exit chat session\n`);
    continue;
  }

  if (q === "/stats") {
    console.log(`\x1b[35m${renderFooterStats()} • ${agent.modelStringOrSpec}\x1b[0m`);
    console.log(`Messages: ${agent.context.messages.length} • Window: ${formatContextWindow(getContextWindow())} • File: ${SESSION_FILE}`);
    continue;
  }
  if (q === "/save") { saveSession(); console.log(`\x1b[90m→ Saved to ${SESSION_FILE} (${agent.context.messages.length} turns, JSONL)\x1b[0m`); continue; }

  let res: any;
  try {
    res = await agent.run(q, {
      stream: true,
      wrapThinking: true,
      onThinkingDelta: (d) => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
      onDelta: (d) => process.stdout.write(d),
      onEvent: (e) => {
        if (e.type === "subagent_complete") {
          const sCost = e.subagent!.usage?.cost?.totalCost ?? 0;
          const sCostLabel = sCost > 0 ? ` • ${formatCost(sCost)}` : "";
          console.log(`\n\x1b[90m↳ ${e.subagent!.name} done (${formatTokens(e.subagent!.usage.totalTokens)} tok${sCostLabel})\x1b[0m`);
        }
      },
    });
  } catch (e: any) {
    console.log(`\n\x1b[31m✖ ${e.message}\x1b[0m`);
    if (String(e.message).includes("503") || String(e.message).includes("Upstream")) {
      console.log(`\x1b[90m  Provider endpoint is temporarily unavailable. Try again or switch model:\x1b[0m`);
      console.log(`\x1b[90m  /model openrouter/model-id or /model opencode/model-id\x1b[0m`);
    }
    console.log("");
    continue;
  }

  const turnCost = updateTotals(res.usage, agent.modelStringOrSpec);
  saveSession();
  const lvl = (agent as any).thinkingConfig?.level ? ` • ${(agent as any).thinkingConfig.level}` : "";
  const costLabel = turnCost > 0 ? ` (+${formatCost(turnCost)})` : "";
  console.log(`\n\x1b[35m${renderFooterStats()}${costLabel} • ${res.provider}/${res.model}${lvl} ${res.durationMs}ms ${res.finishReason ?? ""}\x1b[0m`);
  if (res.subagents?.length) {
    console.log(`\x1b[90m  subagents: ${res.subagents.map((s: any) => `${s.name}:${s.isError ? "ERR" : "ok"} (${formatCost(s.usage?.cost?.totalCost ?? 0)})`).join(", ")}\x1b[0m`);
  }
  console.log("");
}

rl.close();
saveSession();
console.log("\nSESSION SUMMARY");
console.log(JSON.stringify({ sessionId: agent.sessionId, model: agent.modelStringOrSpec, totals, window: formatContextWindow(getContextWindow()), file: SESSION_FILE }, null, 2));
