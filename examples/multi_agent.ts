import * as fs from "node:fs";
import { Agent } from "agent-accelerator";

const agent = new Agent({
  name: "Editorial Orchestrator",
  instructions: fs.readFileSync(new URL("../SYSTEM_PROMPT_AGENT.md", import.meta.url), "utf8"),
  model: process.env.MODEL,
  SubAgentModel: process.env.SUB_AGENT_MODEL,
  EnableSubagents: true,
  ThinkingLevel: (process.env.THINKING_LEVEL as any) ?? "medium",
  cache: { retention: (process.env.CACHE_RETENTION as any) ?? "short" },
});

const totals = { in: 0, out: 0, cr: 0, cw: 0, cost: 0 };
const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;

async function ask(prompt: string) {
  console.log(`\n\x1b[36m━━━ User: ${prompt} ━━━\x1b[0m\n`);
  const res = await agent.run(prompt, {
    stream: true,
    wrapThinking: true,
    onThinkingDelta: (d) => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
    onDelta: (d) => process.stdout.write(d),
    onEvent: (e) => {
      if (e.type === "subagent_complete") {
        console.log(`\n\x1b[90m↳ ${e.subagent!.name} done (${fmt(e.subagent!.usage.totalTokens)} tok)\x1b[0m`);
      }
    },
  });

  const u = res.usage;
  totals.in += u.inputTokens ?? 0;
  totals.out += u.outputTokens ?? 0;
  const cr = u.cachedTokens ?? u.cacheReadTokens ?? 0;
  totals.cr += cr;
  totals.cw += u.cacheWriteTokens ?? 0;
  if (u.cost?.totalCost) totals.cost += u.cost.totalCost;
  const ch = u.inputTokens ? ((cr / u.inputTokens) * 100).toFixed(1) : "0";
  const lvl = (agent as any).thinkingConfig?.level ? ` • ${(agent as any).thinkingConfig.level}` : "";

  console.log(`\n\x1b[35m↑${fmt(totals.in)} ↓${fmt(totals.out)} CR${fmt(totals.cr)} CW${fmt(totals.cw)} CH${ch}% $${totals.cost.toFixed(3)} • ${res.provider}/${res.model}${lvl} ${res.durationMs}ms\x1b[0m`);
  if (res.subagents?.length) {
    console.log(`\x1b[90m  subagents: ${res.subagents.map((s: any) => `${s.name}:ok`).join(", ")}\x1b[0m`);
  }
  return res;
}

// Chained pipeline — append as many requests as you want:
const r1 = await ask("Research on the rising HBM RAM pricings and rapid development in the AI space, then merge both to make a final editorial-level professional detailed report.");
const r2 = await ask("Based on the editorial report above, summarize all critical strategic takeaways in bullet points and identify the #1 supplier positioned to benefit the most.");
const r3 = await ask("Based on the editorial report above, explain the entire report clearly in bullet points, covering all major findings, arguments, data, implications, and conclusions.");