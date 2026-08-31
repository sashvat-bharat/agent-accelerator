/**
 * Interactive Chat with SubAgent spawning + Pi-style footer
 *  ↑ = input tokens  ↓ = output  R = cacheRead  CH = cache hit%  ctx%/window (auto)
 *  Works cross-provider (google / opencode / openrouter) — same Agent code.
 *
 *  Run:  bun run examples/chat.ts
 *  Env:  MODEL=opencode-zen/hy3-free  SUB_AGENT_MODEL=google/gemini-3.5-flash-lite
 *  Exit: /exit, /quit, Ctrl+C
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "agent-accelerator";
import { getProvider } from "agent-accelerator";
import { getContextWindow as getCatalogContextWindow } from "../src/models/catalog.ts";

// Load lean orchestrator prompt from project root (pi-inspired, editable .md)
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
  // Fallback inline (same as file)
  return `You are the Orchestrator — decide when to answer directly vs delegate.`;
}

// ---------- Pi-style helpers (from references/pi/packages/coding-agent/src/modes/interactive/components/footer.ts) ----------
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatContextWindow(n: number): string {
  return formatTokens(n);
}

// ---------- Agent (bloatfree flags) ----------
// Now loads SYSTEM_PROMPT_ORCHESTRATOR.md (lean, pi-inspired) instead of inline
const agent = new Agent({
  name: "Chat Orchestrator",
  instructions: loadOrchestratorPrompt(),
  model: process.env.MODEL,
  SubAgentModel: process.env.SUB_AGENT_MODEL,
  ThinkingLevel: (process.env.THINKING_LEVEL as any) || "medium",
  EnableSubagents: true,
  ServiceTier: (process.env.SERVICE_TIER as any) || undefined, // flex|priority, standard = undefined
  cache: { retention: "short" as const }, // long for 80-90% hit (was medium -> 40% metric bug, now fixed to long like multi_agent)
  // maxTurns: 10,
});

// Cumulative totals like pi's usageTotals
let totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
let lastCacheHitRate: number | undefined;

function getContextWindow(): number {
  // Battle-tested: total context length via catalog limit.context (opencode hy3-free: 190000, gemini: 1048576)
  try {
    const modelStr = agent.modelStringOrSpec as string;
    const prov = modelStr.includes("/") ? modelStr.split("/")[0]! : "opencode";
    const id = modelStr.includes("/") ? modelStr.split("/").slice(1).join("/") : modelStr;
    const cw = getCatalogContextWindow(prov, id);
    if (cw) return cw;
  } catch {}
  try {
    const tryProviders: string[] = ["google", "opencode", "openrouter"];
    for (const pid of tryProviders) {
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

  // Battle-tested hit: cached / input (input already includes cached for opencode/google/openrouter)
  // Matches multi_agent.ts: cached / input *100 -> 72% vs old (cached/(input+cached))=40% was wrong
  const latestInput = usage.inputTokens ?? 0;
  const latestRead = usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
  if (latestInput > 0) {
    lastCacheHitRate = (latestRead / latestInput) * 100;
  } else if (latestRead > 0) {
    lastCacheHitRate = 100;
  }
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
  // pi footer: R = cacheRead (not reasoning), W = cacheWrite
  if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
  else if (totals.reasoning) parts.push(`R${formatTokens(totals.reasoning)}`); // fallback if no cache
  if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
  if (lastCacheHitRate !== undefined) {
    parts.push(`CH${lastCacheHitRate.toFixed(1)}%`);
  } else if (totals.input > 0) {
    const hit = totals.input > 0 ? (totals.cacheRead / totals.input) * 100 : 0;
    parts.push(`CH${hit.toFixed(1)}%`);
  }
  if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
  const { pct, window } = contextPercent();
  const ctxStr = pct === "?" ? `?/${formatContextWindow(window)} (auto)` : `${pct}%/${formatContextWindow(window)} (auto)`;
  parts.push(ctxStr);
  return parts.join(" ");
}
function renderFooter(): string {
  // kept for /stats — purple single line like pi but now via renderFooterStats
  return `\x1b[35m${renderFooterStats()}  •  ${agent.modelStringOrSpec}\x1b[0m`;
}

function saveSessionForResume() {
  try {
    const file = path.join(process.cwd(), ".session.json");
    const data = {
      sessionId: agent.sessionId,
      model: agent.modelStringOrSpec,
      subAgentModel: agent.subagentModel,
      thinkingLevel: (agent as any).thinkingConfig?.level,
      cache: agent.cacheConfig,
      serviceTier: agent.serviceTier,
      headers: agent.customHeaders,
      cachedContentId: (agent.context as any).cachedContentId,
      context: { systemPrompt: agent.context.systemPrompt, messages: agent.context.messages, thoughtSignatures: (agent.context as any).thoughtSignatures },
      totals,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

// ---------- Chat loop ----------
async function main() {
  console.log(`\x1b[1mAgent Accelerator — Interactive Chat + SubAgents\x1b[0m`);
  console.log(`Model: ${agent.modelStringOrSpec}  SubModel: ${agent.subagentModel || "inherit"}  Session: ${agent.sessionId}`);
  console.log(`Footer: ↑input ↓output Rreasoning/cacheRead CHhit%  ctx%/window (auto)  — like pi`);
  console.log(`Commands: /exit /quit /clear /reset /stats\n`);

  const rl = readline.createInterface({ input, output });

  // Running context tokens for display — we use totals for cumulative like pi does across session
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
        console.log("\x1b[90m— context cleared —\x1b[0m");
        continue;
      }
      if (trimmed === "/stats") {
        console.log(renderFooter());
        if (agent.context.messages.length > 0) {
          console.log(`Messages in context: ${agent.context.messages.length}`);
        }
        continue;
      }

      process.stdout.write("\x1b[2m— streaming —\x1b[0m\n");
      const stream = agent.stream(trimmed);
      let isThinking = false;
      let hadSubagents = false;

      for await (const ev of stream) {
        if (ev.type === "thinking_start") {
          if (!isThinking) { isThinking = true; process.stdout.write("\x1b[90m"); }
        } else if (ev.type === "thinking_delta") {
          const d = (ev as any).thinkingDelta ?? (ev as any).delta ?? (ev as any).thinking ?? "";
          if (!isThinking) { isThinking = true; process.stdout.write("\x1b[90m"); }
          if (d) process.stdout.write(d);
        } else if (ev.type === "thinking_end") {
          if (isThinking) {
            process.stdout.write("\x1b[0m\n");
            isThinking = false;
          }
        } else if (ev.type === "text_delta" && (ev as any).delta) {
          if (isThinking) {
            process.stdout.write("\x1b[0m\n");
            isThinking = false;
          }
          process.stdout.write((ev as any).delta);
        } else if (ev.type === "tool_call_complete") {
          // optional debug
          // process.stdout.write(`\n\x1b[90m[tool: ${(ev as any).toolCall.name}]\x1b[0m `);
        } else if (ev.type === "subagent_complete") {
          hadSubagents = true;
          const s = (ev as any).subagent;
          process.stdout.write(`\n\x1b[90m↳ subagent ${s.name} (${s.provider}/${s.model}) ${formatTokens(s.usage.totalTokens)} in ${s.durationMs}ms\x1b[0m\n`);
        }
      }
      if (isThinking) process.stdout.write("\x1b[0m\n");
      process.stdout.write("\n");

      const result = await stream.result();
      updateTotals(result.usage);
      saveSessionForResume();
      // Single purple line, non-repeating — like pi but condensed: stats + model once
      const thinkingPart = (agent as any).thinkingConfig?.level ? ` • ${(agent as any).thinkingConfig.level}` : "";
      const singleLine = `${renderFooterStats()}  •  ${result.provider}/${result.model}${thinkingPart}  ${result.durationMs}ms  ${result.finishReason || ""}`;
      console.log(`\x1b[35m${singleLine}\x1b[0m`);
      if (result.subagents && result.subagents.length > 0) {
        console.log(`\x1b[90m  subagents: ${result.subagents.map(s => `${s.name}:${s.isError ? "ERR" : "ok"}`).join(", ")}  turns:${result.turns}  tools:${result.toolCalls.length}\x1b[0m`);
      }
      console.log("");
    }
  } finally {
    rl.close();
    saveSessionForResume();
    // Final raw summary like multi_agent does
    console.log("\n===============================================================================");
    console.log("  SESSION SUMMARY (RAW JSON)");
    console.log("===============================================================================");
    console.log(JSON.stringify({
      sessionId: agent.sessionId,
      model: agent.modelStringOrSpec,
      subModel: agent.subagentModel,
      totals,
      context: agent.context.messages.slice(-2).map(m => ({ role: m.role, preview: typeof m.content === "string" ? m.content.slice(0,120) : JSON.stringify(m.content).slice(0,200) })),
    }, null, 2));
    console.log("===============================================================================\n");
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
