// Fixed sub-agents: helpers you define once. Each becomes a tool the lead can call.
// Run: bun run examples/04-sub-agents.ts
import { Agent, tool } from "agent-accelerator";
import { z } from "zod";
import { fail, MODEL } from "./_shared";

const getTopicBrief = tool({
  name: "get_topic_brief",
  description: "Get a short technical briefing for a topic.",
  input: z.object({ topic: z.string() }),
  execute: async ({ topic }) => ({
    topic,
    maturity: "TRL 6-7 (prototype in an operational environment)",
    chemistries: [
      "sulfide: best conductivity, moisture sensitive",
      "oxide: stable but brittle",
      "polymer: easy to make, runs warm",
    ],
    targets: { energyDensity: "450-500 Wh/kg", fastCharge: "10-80% in 10-12 min", cycles: ">= 1,200" },
    roadmap: ["2026: pilot lines", "2027: first premium cars", "2030: price parity"],
  }),
});

// A sub-agent written as data runs on the worker model (SUB_AGENT_MODEL) unless it names a `model`.
// For thinking, cache or structured output, pass a plain `new Agent({ ... })` instead.
const lead = new Agent({
  name: "Editorial Lead",
  instructions:
    "Call get_topic_brief, have researcher investigate, give its findings to critic, " +
    "then write one balanced report with a comparison table.",
  model: MODEL,
  tools: { get_topic_brief: getTopicBrief },
  subagents: [
    {
      name: "researcher",
      description: "Researches a topic in depth, with numbers.",
      instructions: "Investigate the topic thoroughly. Give technical breakthroughs and quantified metrics.",
    },
    {
      name: "critic",
      description: "Challenges research findings and finds hidden risks.",
      instructions: "Be a skeptical devil's advocate. Expose weak assumptions, bottlenecks and failure points.",
    },
  ],
});

const res = await lead
  .run("Commercial deployment of solid-state batteries in consumer EVs over the next 3 years", {
    stream: true,
    onDelta: (d) => process.stdout.write(d),
    onEvent: (e) => {
      if (e.type === "subagent_complete") console.log(`\n[${e.subagent?.name} finished]\n`);
    },
  })
  .catch(fail);

console.log("\n--- sub-agents ---");
for (const s of res.subagents)
  console.log(`${s.name}: ${s.usage.totalTokens} tokens, ${Math.round(s.durationMs)} ms, ${s.model}`);
console.log(`total: ${res.usage.totalTokens} tokens, ${res.durationMs} ms`);
