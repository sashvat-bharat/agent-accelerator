/**
 * Agent Accelerator - Interactive Chat CLI
 *
 * Ultra-clean, persistent multi-turn chat session with automatic .session.jsonl persistence,
 * subagent orchestration, streaming thought traces, and unified metadata & cost telemetry.
 *
 * Run: bun run examples/chat.ts
 */

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  Agent,
  resolveModel,
  getModelFromCatalog,
  getModelThinkingInfo,
  validateModelThinking,
} from "agent-accelerator";

// ---------------------------------------------------------------------------
// 1. Session Persistence (JSONL)
// ---------------------------------------------------------------------------
const SESSION_FILE =
  process.env.SESSION_FILE ??
  process.argv.find((a) => a.startsWith("--session-file="))?.split("=")[1] ??
  path.join(process.cwd(), ".session.jsonl");

interface PersistedSession {
  sessionId: string;
  model: string;
  subAgentModel?: string;
  thinkingLevel?: string;
  cache?: { retention: "short" | "medium" | "long" };
  cachedContentId?: string;
  context?: { systemPrompt?: string; messages: any[] };
  totals?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    cost: number;
  };
}

function loadSession(): PersistedSession | null {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    if (!raw.trim().startsWith('{"type"')) {
      return JSON.parse(raw);
    }
    const lines = raw.split("\n").filter(Boolean);
    let sessionId = "";
    let model = "";
    let subAgentModel: string | undefined;
    let thinkingLevel: string | undefined;
    let cache: any;
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
          cachedContentId = obj.cachedContentId ?? cachedContentId;
        } else if (obj.type === "main_model") {
          model = obj.id ?? obj.model ?? model;
          thinkingLevel = obj.thinkingLevel ?? thinkingLevel;
        } else if (obj.type === "subagent_model") {
          subAgentModel = obj.id ?? obj.model ?? subAgentModel;
        } else if (obj.type === "metrics") {
          totals = obj.metrics ?? totals;
        } else if (obj.type === "model_change") {
          model = obj.modelId ?? obj.model ?? model;
        } else if (obj.type === "thinking_level_change") {
          thinkingLevel = obj.thinkingLevel;
        } else if (obj.type === "message" && obj.message) {
          messages.push(obj.message);
        } else if (obj.type === "totals") {
          totals = obj.totals ?? totals;
          cache = obj.cache ?? cache;
          cachedContentId = obj.cachedContentId ?? cachedContentId;
        } else if (obj.type === "context") {
          if (obj.systemPrompt) systemPrompt = obj.systemPrompt;
          if (Array.isArray(obj.messages)) messages.push(...obj.messages);
        }
      } catch {}
    }

    if (!sessionId && messages.length === 0) return null;
    return {
      sessionId: sessionId || `accel-${Date.now()}`,
      model: model || process.env.MODEL || "google/gemini-3.5-flash-lite",
      subAgentModel,
      thinkingLevel,
      cache,
      cachedContentId,
      context: { systemPrompt, messages },
      totals,
    };
  } catch {
    return null;
  }
}

function loadPrompt(): string {
  const candidates = [
    path.join(process.cwd(), "SYSTEM_PROMPT_AGENT.md"),
    path.join(import.meta.dir, "../SYSTEM_PROMPT_AGENT.md"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, "utf8");
  }
  return "You are a concise, helpful engineering assistant.";
}

// ---------------------------------------------------------------------------
// 2. Metrics & Cost Formatters (Inspired by metadata.ts)
// ---------------------------------------------------------------------------
const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;

const formatCost = (c?: number) => {
  if (!c || c <= 0) return "$0.00";
  if (c < 0.0001) return `$${c.toFixed(6)}`;
  if (c < 0.01) return `$${c.toFixed(4)}`;
  if (c < 1.0) return `$${c.toFixed(3)}`;
  return `$${c.toFixed(2)}`;
};

// ---------------------------------------------------------------------------
// 3. Agent Setup (Clean 1-line hardcoded ThinkingLevel default)
// ---------------------------------------------------------------------------
const saved = loadSession();
const initialModel = saved?.model ?? process.env.MODEL ?? "google/gemini-3.5-flash-lite";
const initialThinking = (saved?.thinkingLevel as any) ?? (process.env.THINKING_LEVEL as any) ?? "medium";

const agent = new Agent({
  name: "Chat Orchestrator",
  instructions: loadPrompt(),
  model: initialModel,
  SubAgentModel: saved?.subAgentModel ?? process.env.SUB_AGENT_MODEL,
  ThinkingLevel: initialThinking as any,
  EnableSubagents: true,
  cache: (saved?.cache as any) ?? { retention: "implicit" as const },
  sessionId: saved?.sessionId,
  maxTurns: 10,
});

// Restore context messages from auto-detected session
if (saved?.context?.messages?.length) {
  agent.context.messages = saved.context.messages;
  if (saved.context.systemPrompt) agent.context.systemPrompt = saved.context.systemPrompt;
  if (saved.cachedContentId) {
    (agent.context as any).cachedContentId = saved.cachedContentId;
  }
}

let totals = saved?.totals ?? {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 0,
};

function getContextWindow(): number {
  try {
    const resolved = resolveModel(agent.modelStringOrSpec);
    const spec = getModelFromCatalog(resolved.provider.id, resolved.modelId);
    if (spec?.limit?.context) return spec.limit.context;
    if (spec?.contextWindow) return spec.contextWindow;
  } catch {}
  return 1_048_576;
}

function computeTurnCost(usage: any, modelStr: string): number {
  let cost = usage.cost?.totalCost ?? 0;
  if (!cost && modelStr) {
    try {
      const resolved = resolveModel(modelStr);
      const spec = getModelFromCatalog(resolved.provider.id, resolved.modelId);
      if (spec?.pricing || spec?.cost) {
        const inputP = spec.pricing?.inputPerMillion ?? spec.cost?.input ?? 0;
        const outputP = spec.pricing?.outputPerMillion ?? spec.cost?.output ?? 0;
        const crP = spec.pricing?.cacheReadPerMillion ?? spec.cost?.cache_read ?? 0;
        const cwP = spec.pricing?.cacheWritePerMillion ?? spec.cost?.cache_write ?? 0;
        const cr = usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
        const uncachedIn = Math.max(0, (usage.inputTokens ?? 0) - cr);
        cost =
          (uncachedIn / 1e6) * inputP +
          (cr / 1e6) * crP +
          ((usage.cacheWriteTokens ?? 0) / 1e6) * cwP +
          ((usage.outputTokens ?? 0) / 1e6) * outputP;
      }
    } catch {}
  }
  return cost;
}

function updateUsageTotals(usage: any, modelStr: string): number {
  totals.input += usage.inputTokens ?? 0;
  totals.output += usage.outputTokens ?? 0;
  totals.cacheRead += usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
  totals.cacheWrite += usage.cacheWriteTokens ?? 0;
  totals.reasoning += usage.thinkingTokens ?? 0;

  const turnCost = computeTurnCost(usage, modelStr);
  totals.cost += turnCost;
  return turnCost;
}

function saveSession() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    const lines: string[] = [];
    const level = (agent as any).thinkingConfig?.level ?? "none";

    // 1. Session line
    lines.push(
      JSON.stringify({
        type: "session",
        id: agent.sessionId,
        cache: agent.cacheConfig,
        timestamp: new Date().toISOString(),
      })
    );

    // 2. Main model line
    lines.push(
      JSON.stringify({
        type: "main_model",
        id: agent.modelStringOrSpec,
        thinkingLevel: level,
      })
    );

    // 3. Subagent model line (if defined)
    if (agent.subagentModel) {
      lines.push(
        JSON.stringify({
          type: "subagent_model",
          id: agent.subagentModel,
        })
      );
    }

    // 4. Metrics line
    lines.push(
      JSON.stringify({
        type: "metrics",
        metrics: totals,
      })
    );

    // 5. Conversation messages
    for (const msg of agent.context.messages) {
      lines.push(JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: msg }));
    }

    fs.writeFileSync(SESSION_FILE, lines.join("\n") + "\n");
  } catch {}
}

function renderUnifiedBar(turnCost: number, res: any): string {
  const inTok = res.usage.inputTokens ?? 0;
  const outTok = res.usage.outputTokens ?? 0;
  const crTok = res.usage.cachedTokens ?? res.usage.cacheReadTokens ?? 0;
  const cwTok = res.usage.cacheWriteTokens ?? 0;

  const hitRate = inTok > 0 ? ((crTok / inTok) * 100).toFixed(1) : "0.0";
  const cwLabel = cwTok > 0 ? ` CW${fmtTokens(cwTok)}` : "";

  const window = getContextWindow();
  const usedTokens = totals.input + totals.output + totals.cacheRead;
  const pct = window > 0 ? ((usedTokens / window) * 100).toFixed(1) : "0.0";

  const costDelta = turnCost > 0 ? ` (+${formatCost(turnCost)})` : "";
  const currentLevel = (agent as any).thinkingConfig?.level ?? "none";

  return `\x1b[35m↑${fmtTokens(inTok)} ↓${fmtTokens(outTok)} CR${fmtTokens(crTok)}${cwLabel} CH${hitRate}% ${formatCost(totals.cost)}${costDelta} ${pct}%/${fmtTokens(window)} • ${res.provider}/${res.model} • ${currentLevel} ${res.durationMs}ms ${res.finishReason ?? "STOP"}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// 4. Interactive Chat CLI Loop
// ---------------------------------------------------------------------------
const activeThinking = (agent as any).thinkingConfig?.level ?? initialThinking;
console.log(`\n\x1b[1;36mAgent Accelerator — Interactive CLI\x1b[0m`);
console.log(`Model: \x1b[32m"${agent.modelStringOrSpec}"\x1b[0m • Thinking: \x1b[33m${activeThinking}\x1b[0m • Context: \x1b[34m${fmtTokens(getContextWindow())}\x1b[0m`);
console.log(`Session: \x1b[90m${agent.sessionId.slice(0, 16)}… (${SESSION_FILE})\x1b[0m`);
console.log(`Commands: \x1b[90m/model "provider/model-id"  /level <lvl>  /help  /exit\x1b[0m\n`);

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
    const rawArg = q.slice(6).trim();
    if (!rawArg) {
      console.log(`Current model: "${agent.modelStringOrSpec}"`);
      console.log(`\x1b[90mUsage: /model "provider/model-id"\x1b[0m`);
      continue;
    }

    const match = rawArg.match(/^"([^"]+)"$/);
    if (!match) {
      console.log(`\x1b[31m✖ Invalid format. You must specify the model in quotes: /model "provider/model-id"\x1b[0m`);
      console.log(`\x1b[90mExample: /model "opencode/ling-3.0-flash-fin-free" or /model "google/gemini-3.5-flash-lite"\x1b[0m`);
      continue;
    }

    const nextModel = match[1]!.trim();
    if (!nextModel.includes("/")) {
      console.log(`\x1b[31m✖ Invalid model format "${nextModel}". Must be "provider/model-id" (e.g. /model "opencode/ling-3.0-flash-fin-free").\x1b[0m`);
      continue;
    }

    try {
      const resolved = resolveModel(nextModel);
      const currentLevel = (agent as any).thinkingConfig?.level;
      if (currentLevel && currentLevel !== "none") {
        validateModelThinking(resolved.provider.id, resolved.modelId, currentLevel);
      }
    } catch (e: any) {
      console.log(`\x1b[33m⚠ Thinking level notice:\x1b[0m \x1b[90m${e.message}\x1b[0m`);
    }

    (agent as any).modelStringOrSpec = nextModel;
    saveSession();
    console.log(`\x1b[32m✔ Switched model to: "${nextModel}"\x1b[0m`);
    continue;
  }

  if (q.startsWith("/level") || q.startsWith("/thinking")) {
    const nextLevel = q.split(" ")[1]?.trim() as any;
    const resolvedCurrent = resolveModel(agent.modelStringOrSpec);
    if (nextLevel) {
      try {
        validateModelThinking(resolvedCurrent.provider.id, resolvedCurrent.modelId, nextLevel);
        (agent as any).thinkingConfig = {
          enabled: nextLevel !== "none",
          level: nextLevel,
          budgetTokens: nextLevel === "dynamic" ? -1 : nextLevel === "none" ? 0 : undefined,
        };
        saveSession();
        console.log(`\x1b[32m✔ Switched thinking level to: ${nextLevel}\x1b[0m`);
      } catch (err: any) {
        console.log(`\x1b[31m✖ ${err.message}\x1b[0m`);
      }
    } else {
      const info = getModelThinkingInfo(resolvedCurrent.provider.id, resolvedCurrent.modelId);
      console.log(`Current thinking level: ${(agent as any).thinkingConfig?.level ?? "none"}`);
      console.log(`\x1b[90m${info.description}\x1b[0m`);
    }
    continue;
  }

  if (q === "/help") {
    console.log(`\x1b[33mAvailable Commands:\x1b[0m`);
    console.log(`  /model "provider/model-id"  Switch active model in quotes (e.g. /model "google/gemini-3.5-flash-lite")`);
    console.log(`  /level <lvl>               Set thinking level (none, minimal, low, medium, high, xhigh, dynamic)`);
    console.log(`  /exit, /quit               Exit chat session\n`);
    continue;
  }

  try {
    const res = await agent.run(q, {
      stream: true,
      wrapThinking: true,
      onThinkingDelta: (d) => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
      onDelta: (d) => process.stdout.write(d),
      onEvent: (e) => {
        if (e.type === "subagent_complete") {
          const sCost = e.subagent!.usage?.cost?.totalCost ?? 0;
          const sCostLabel = sCost > 0 ? ` • ${formatCost(sCost)}` : "";
          console.log(`\n\x1b[90m↳ ${e.subagent!.name} done (${fmtTokens(e.subagent!.usage.totalTokens)} tok${sCostLabel})\x1b[0m`);
        }
      },
    });

    const turnCost = updateUsageTotals(res.usage, agent.modelStringOrSpec);
    saveSession();

    console.log(`\n${renderUnifiedBar(turnCost, res)}`);
    if (res.subagents?.length) {
      console.log(
        `\x1b[90m  ↳ subagents: ${res.subagents
          .map((s: any) => `${s.name}:${s.isError ? "ERR" : "ok"} (${formatCost(s.usage?.cost?.totalCost ?? 0)})`)
          .join(", ")}\x1b[0m`
      );
    }
    console.log("");
  } catch (e: any) {
    console.log(`\n\x1b[31m✖ ${e.message}\x1b[0m\n`);
  }
}

rl.close();
saveSession();
