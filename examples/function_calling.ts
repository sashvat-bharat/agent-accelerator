import { Agent, tool, z } from "agent-accelerator";

const get_status = tool({
  name: "get_status",
  description: "Check user authentication status.",
  input: z.object({ username: z.string() }),
  execute: async ({ username }) => username === "Akshat Dwivedi"
    ? "Valid username. Welcome home, Sir!"
    : "Invalid username",
});

const agent = new Agent({
  name: "Auth Agent",
  instructions: "Verify users via get_status. Be concise.",
  model: process.env.MODEL,
  tools: { get_status },
  ThinkingLevel: "medium",
});

console.log("→ Checking Akshat Dwivedi...\n");

const response = await agent.run("Check status for username: Akshat Dwivedi", {
  stream: true,
  wrapThinking: true,
  onThinkingDelta: (d) => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
  onDelta: (d) => process.stdout.write(d),
});

console.log("\n" + "─".repeat(40));
console.log(`Tool: ${response.toolResults?.[0]?.name} → ${JSON.stringify(response.toolResults?.[0]?.result)}`);
console.log(`Duration: ${response.durationMs}ms • Tokens: ↑${response.usage.inputTokens} ↓${response.usage.outputTokens}`);
