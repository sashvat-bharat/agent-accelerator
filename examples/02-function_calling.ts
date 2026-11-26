// A function tool the model can call.
// Run: bun run examples/02-function_calling.ts
import { Agent, tool } from "agent-accelerator";
import { z } from "zod";
import { fail, MODEL } from "./_shared";

const getStatus = tool({
  name: "get_status",
  description: "Check user authentication status.",
  input: z.object({ username: z.string() }),
  execute: async ({ username }) => (username === "alice" ? "Valid username. Welcome!" : "Invalid username"),
});

const agent = new Agent({
  model: MODEL,
  instructions: "Verify users via get_status. Be concise.",
  tools: { get_status: getStatus },
});

const res = await agent.run("Check status for username: alice").catch(fail);

console.log(res.text);
for (const r of res.toolResults) console.log(`tool ${r.name} -> ${JSON.stringify(r.result)} (${r.durationMs ?? 0} ms)`);
