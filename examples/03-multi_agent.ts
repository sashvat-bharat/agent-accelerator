// Dynamic sub-agents: the model starts workers itself with the built-in `subagents` tool.
// Run: bun run examples/03-multi_agent.ts
import { Agent } from "agent-accelerator";
import { fail, MODEL, SUB_AGENT_MODEL } from "./_shared";

const agent = new Agent({
  name: "Editorial Lead",
  instructions:
    "Answer simple questions directly. For research that needs several angles, start 2 to 4 focused workers with " +
    "the `subagents` tool, all in the same turn so they run in parallel, then merge their findings into one " +
    "editorial-grade report with a comparison table.",
  model: MODEL,
  dynamicSubagents: { model: SUB_AGENT_MODEL, maxSpawn: 3 }, // you pick the worker model and the limits, never the model
  budget: { maxCostUsd: 5 },
});

const prompts = [
  "Research the rising HBM memory prices and the AI demand behind them, then write an editorial-level report.",
  "Summarize the report above in bullet points and name the #1 supplier set to benefit.",
];

for (const prompt of prompts) {
  console.log(`\n> ${prompt}\n`);
  const res = await agent.run(prompt, { stream: true, onDelta: (d) => process.stdout.write(d) }).catch(fail);
  console.log(
    `\n\n[${res.subagents.length} workers, ${res.usage.totalTokens} tokens, $${res.usage.cost?.totalCost?.toFixed(4) ?? "?"}]`
  );
}
