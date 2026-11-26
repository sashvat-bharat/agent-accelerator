// A terminal chat that keeps its session: stop it, run it again, and the conversation continues.
// Sessions are saved under .agent-accel/sessions/<id>/ (see `setHome` to move them).
// Run: bun run examples/05-chat.ts   (type /exit to quit)
import * as readline from "node:readline/promises";
import * as path from "node:path";
import { Agent, findLatestSessionDir, loadSessionDir, resolveHome, saveSessionDir } from "agent-accelerator";
import { MODEL, SUB_AGENT_MODEL } from "./_shared";

const sessionsDir = path.join(resolveHome(), "sessions");
const lastDir = findLatestSessionDir(sessionsDir);
const saved = lastDir ? loadSessionDir(lastDir)?.session : undefined;

const agent = new Agent({
  name: "Chat Agent",
  instructions:
    "You are a concise, helpful engineering assistant. For a big research question, start workers with the `subagents` tool.",
  model: MODEL,
  dynamicSubagents: { model: SUB_AGENT_MODEL, maxSpawn: 4 },
  thinking: "medium",
  maxTurns: 10,
});
if (saved) agent.importSession(saved); // a new Agent starts a new conversation; importing the saved one continues it

console.log(saved ? `Resumed ${agent.sessionId.slice(0, 8)} (${saved.messages.length} messages).` : "New session.");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt("\nYou> ");
rl.prompt();
for await (const line of rl) {
  const q = line.trim();
  if (q === "/exit") break;
  if (q) {
    try {
      const res = await agent.run(q, { stream: true, onDelta: (d) => process.stdout.write(d) });
      console.log(`\n[${res.usage.totalTokens} tokens, ${res.subagents.length} workers]`);
    } catch (e) {
      console.error(`\n✖ ${(e as Error).message}`);
    }
    saveSessionDir(sessionsDir, agent);
  }
  rl.prompt();
}
rl.close();
