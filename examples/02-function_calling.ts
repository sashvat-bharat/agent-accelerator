import { Agent, tool, z } from "agent-accelerator";
import { fail } from "./_shared";

const get_status = tool({
  timeoutMs: 5_000,
  maxAttempts: 2,
  idempotent: true,
  repeatable: true,
  maxResultChars: 20_000,
  name: "get_status",
  description: "Check user authentication status.",
  input: z.object({ username: z.string() }),
  execute: async ({ username }) => username === "alice"
    ? "Valid username. Welcome!"
    : "Invalid username",
});

const agent = new Agent({
  name: "Auth Agent",
  instructions: "Verify users via get_status. Be concise.",
  model: process.env.MODEL,
  tools: { get_status },
  thinking: "medium",
  retry: { maxRetries: 2 },
});

console.log("→ Checking alice...\n");

const response = await agent.run("Check status for username: alice", {
  stream: true,
  wrapThinking: true,
  onThinkingDelta: (d) => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
  onDelta: (d) => process.stdout.write(d),
  onEvent: (event) => {
    if (event.type === "tool_result" && event.toolResult) {
      process.stdout.write(
        `\n[tool] ${event.toolResult.name} completed in ${event.toolResult.durationMs ?? 0}ms\n`,
      );
    }
  },
}).catch(fail);

console.log("\n" + "─".repeat(40));
const toolResults = response.toolResults ?? [];
for (const result of toolResults) {
  console.log(
    `Tool: ${result.name} → ${JSON.stringify(result.result)} ` +
    `(${result.durationMs ?? 0}ms${result.isError ? ", error" : ""})`,
  );
}

const totalToolTime = toolResults.reduce(
  (total, result) => total + (result.durationMs ?? 0),
  0,
);
console.log(`Total tool execution time: ${totalToolTime}ms`);
console.log(`Agent round-trip duration: ${response.durationMs}ms • Tokens: ↑${response.usage.inputTokens} ↓${response.usage.outputTokens}`);
