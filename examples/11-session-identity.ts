// Worker identity: every worker has a session id and a tracking id, agent.track(id) replays what it did,
// and a saved session keeps those traces.
// Run: bun run examples/11-session-identity.ts
import * as path from "node:path";
import { Agent, loadSessionDir, resolveHome, sessionDirFor } from "agent-accelerator";
import { fail, MODEL, SUB_AGENT_MODEL } from "./_shared";

const agent = new Agent({
  name: "Identity Lead",
  instructions: "You coordinate parallel research. Always delegate with the subagents tool, then synthesize.",
  model: MODEL,
  dynamicSubagents: { model: SUB_AGENT_MODEL, maxSpawn: 2 },
  persist: {}, // every step is saved under .agent-accel/sessions/<id>/, so a crash loses at most the step in flight
});
console.log("parent session:", agent.sessionId);

const res = await agent
  .run(
    "Start 2 workers in the same turn: one researches battery pricing in one sentence, the other AI power demand " +
      "in one sentence. Then merge both into a 3-line report."
  )
  .catch(fail);
console.log(res.text);

console.log("\n--- workers ---");
for (const s of res.subagents) {
  console.log(`${s.name}: ${s.model}, ${s.usage.totalTokens} tokens`);
  console.log(
    `  tracking id ${s.trackingId}, session ${s.sessionId}, child of this parent: ${s.parentSessionId === agent.sessionId}`
  );
  const trace = s.trackingId ? agent.track(s.trackingId) : undefined;
  console.log(`  track(): ${trace?.status}, steps: ${trace?.steps.map((step) => step.type).join(", ")}`);
}

// Save, reload, resume: the worker traces come back with the session.
agent.persistNow();
const dir = sessionDirFor(path.join(resolveHome(), "sessions"), agent.sessionId);
const loaded = loadSessionDir(dir);
if (!loaded) fail(new Error(`Could not reload ${dir}`));

const resumed = new Agent({ name: "Resumer", model: MODEL });
resumed.importSession(loaded!.session);
console.log(`\nreloaded ${dir}`);
console.log(
  `resumed: ${resumed.context.messages.length} messages, traces: ${resumed.listTrackedSubAgents().join(", ")}`
);
