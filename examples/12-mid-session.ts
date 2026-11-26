// Messages while a run is busy: steer changes the run that is going (one answer), queue runs after it (two answers).
// The default policy lets each message pick; `midSession: { whenBusy: "steer" | "queue" }` enforces one.
// Run: bun run examples/12-mid-session.ts
import { Agent, tool } from "agent-accelerator";
import type { StreamEvent } from "agent-accelerator";
import { z } from "zod";
import { fail, MODEL } from "./_shared";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A slow tool keeps the run busy, so the second message lands in the middle of it.
const slowTool = tool({
  name: "slow_tool",
  description: "Call exactly once per task, then answer from its result.",
  input: z.object({}),
  execute: async () => {
    await wait(1200);
    return "slow action done";
  },
});

const agent = new Agent({
  instructions: "Be concise. Call slow_tool exactly once per task, then answer.",
  model: MODEL,
  tools: { slow_tool: slowTool },
});

const live = {
  stream: true as const,
  onDelta: (d: string) => process.stdout.write(d),
  onEvent: (e: StreamEvent) => {
    if (e.type === "steer_injected") console.log("\n  (steered into this turn)");
    if (e.type === "queued") console.log("\n  (queued for the next turn)");
  },
};

console.log("1. steer: same turn, one answer");
const first = agent.run("Call slow_tool once, then reply 'base done'.", live);
await wait(150);
const [res, steerRes] = await Promise.all([first, agent.steer("Use bullets.")]).catch(fail);
console.log(`\n   ${res.turns} turns, one response: ${res.text === steerRes.text}`);

console.log("\n2. queue: the follow-up is its own turn, two answers");
agent.reset();
const firstOfTwo = agent.run("Call slow_tool once, then reply 'first done'.", live);
await wait(150);
const followUp = agent.queue("Reply with exactly: follow-up done.");
console.log(`   busy: ${agent.isBusy}, queued: ${agent.pendingCount}`);
const [r1, r2] = await Promise.all([firstOfTwo, followUp]).catch(fail);
console.log(`\n   first ${r1.turns} turns, follow-up ${r2.turns} turn`);

console.log("\n3. stream: watch it live; steer() lands mid-turn, interrupt() would stop it");
agent.reset();
const stream = agent.stream("Call slow_tool once, then reply 'stream done'.", live);
await wait(150);
void agent.steer("Keep it to one line."); // to stop instead: agent.interrupt(), or agent.interrupt("Just give me the summary.")
const streamed = await stream.result().catch(fail);
console.log(`\n   ${streamed.turns} turns (${streamed.finishReason})`);
