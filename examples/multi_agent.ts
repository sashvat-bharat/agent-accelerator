// Achieved ~99.3% of Cache Hit Rate!!

import * as fs from "node:fs";
import { Agent } from "agent-accelerator";

let agent: Agent;
try {
  agent = new Agent({
    name: "Editorial Lead",
    instructions: fs.readFileSync(new URL("../SYSTEM_PROMPT_AGENT.md", import.meta.url), "utf8"),
    model: process.env.MODEL,
    SubAgentModel: process.env.SUB_AGENT_MODEL,
    EnableSubagents: true,
    ThinkingLevel: (process.env.THINKING_LEVEL as any) ?? "medium",
    cache: { retention: (process.env.CACHE_RETENTION as any) ?? "short" },
  });
} catch (err: any) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

const totals = { in: 0, out: 0, cr: 0, cw: 0, cost: 0 };
const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;

function formatCost(c: number): string {
  if (!c || c <= 0) return "$0.00";
  if (c < 0.0001) return `$${c.toFixed(6)}`;
  if (c < 0.01) return `$${c.toFixed(4)}`;
  if (c < 1.0) return `$${c.toFixed(3)}`;
  return `$${c.toFixed(2)}`;
}

async function ask(prompt: string) {
  console.log(`\n\x1b[36m━━━ User: ${prompt} ━━━\x1b[0m\n`);
  const res = await agent.run(prompt, {
    stream: true,
    wrapThinking: true,
    onThinkingDelta: (d) => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
    onDelta: (d) => process.stdout.write(d),
    onEvent: (e) => {
      if (e.type === "subagent_complete") {
        const sCost = e.subagent!.usage?.cost?.totalCost ?? 0;
        const costPart = sCost > 0 ? ` • ${formatCost(sCost)}` : "";
        console.log(`\n\x1b[90m↳ ${e.subagent!.name} done (${fmt(e.subagent!.usage.totalTokens)} tok${costPart})\x1b[0m`);
      }
    },
  });

  const u = res.usage;
  totals.in += u.inputTokens ?? 0;
  totals.out += u.outputTokens ?? 0;
  const cr = u.cachedTokens ?? u.cacheReadTokens ?? 0;
  totals.cr += cr;
  totals.cw += u.cacheWriteTokens ?? 0;
  const turnCost = u.cost?.totalCost ?? 0;
  totals.cost += turnCost;
  const ch = u.inputTokens ? ((cr / u.inputTokens) * 100).toFixed(1) : "0";
  const lvl = (agent as any).thinkingConfig?.level ? ` • ${(agent as any).thinkingConfig.level}` : "";
  const costSummary = turnCost > 0 ? `turn: ${formatCost(turnCost)} | total: ${formatCost(totals.cost)}` : formatCost(totals.cost);

  console.log(`\n\x1b[35m↑${fmt(totals.in)} ↓${fmt(totals.out)} CR${fmt(totals.cr)} CW${fmt(totals.cw)} CH${ch}% [${costSummary}] • ${res.provider}/${res.model}${lvl} ${res.durationMs}ms\x1b[0m`);
  if (res.subagents?.length) {
    console.log(`\x1b[90m  subagents: ${res.subagents.map((s: any) => `${s.name}:ok (${formatCost(s.usage?.cost?.totalCost ?? 0)})`).join(", ")}\x1b[0m`);
  }
  return res;
}

// Chained pipeline — append as many requests as you want:
const r1 = await ask("Research on the rising HBM RAM pricings and rapid development in the AI space, then merge both to make a final editorial-level professional detailed report.");
const r2 = await ask("Based on the editorial report above, summarize all critical strategic takeaways in bullet points and identify the #1 supplier positioned to benefit the most.");
const r3 = await ask("Based on the editorial report above, explain the entire report clearly in bullet points, covering all major findings, arguments, data, implications, and conclusions.");