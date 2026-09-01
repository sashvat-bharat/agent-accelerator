import * as fs from "node:fs";
import { Agent } from "agent-accelerator";

const agent = new Agent({
  name: "Editorial Orchestrator",
  instructions: fs.readFileSync(new URL("../SYSTEM_PROMPT_ORCHESTRATOR.md", import.meta.url), "utf8"),
  model: process.env.MODEL,
  EnableSubagents: true,
  ThinkingLevel: "minimal",
  cache: { retention: "short" },
});

async function ask(prompt: string) {
  console.log(`\n━━━ User: ${prompt} ━━━\n`);
  const res = await agent.run(prompt, {
    stream: true,
    wrapThinking: true,
    onThinkingDelta: (d) => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
    onDelta: (d) => process.stdout.write(d),
    onEvent: (e) => {
      if (e.type === "subagent_complete") console.log(`\n↳ ${e.subagent!.name} done — ${e.subagent!.usage.totalTokens} tok`);
    },
  });
  console.log("\n");
  return res;
}

const r1 = await ask("Research rising HBM pricing and rapid AI development, then merge into an editorial-grade report.");
const r2 = await ask("Summarize critical takeaways in bullets and name the #1 supplier to benefit.");

const hit = r2.usage.inputTokens ? ((r2.usage.cachedTokens ?? 0) / r2.usage.inputTokens * 100).toFixed(1) : "0";
console.log("─".repeat(50));

console.log(JSON.stringify({
  sessionId: agent.sessionId, model: agent.modelStringOrSpec,
  cacheHit: `${hit}%`, speedup: `${(r1.durationMs / Math.max(r2.durationMs, 1)).toFixed(1)}x`,
  r1: { ms: r1.durationMs, subagents: r1.subagents.length }, r2: { ms: r2.durationMs },
}, null, 2));