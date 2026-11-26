// Which instructions produced this result? A scheduled action keeps its id when you edit its instructions, so the id alone
// cannot say why two results differ. Each run file records a `definition` fingerprint, taken when the run STARTS (a failed
// run records it too), and the exact text it stands for is saved once under `<id>/definitions/<hash>.json`.
//
//   1. Run the action: the run file names definition A.
//   2. Run it again, nothing changed: a second run file, the same definition, still one definition file.
//   3. Change the instructions (same id) and run it: a new definition B; the file of A is still there.
//   4. A run that fails still records the definition it started with.
//   5. Compare two results: read the `definition` of each run file, then diff the two definition files.
//
// It also works as a smoke check: it asserts these contracts and exits with code 1 if one stops holding.
//
// Run: bun run examples/16-definition-history.ts
// Offline: the model is a scripted stand-in (no network, no key, no cost) that answers one line or three bullets depending on
// the instructions it receives. Files go to .agent-accel/demo-definitions/ (gitignored, wiped at the start).
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, resolveHome } from "agent-accelerator";
import { check, nextDelivery } from "./_helpers";

const HOME = path.join(resolveHome(), "demo-definitions");
const HASH = /^[0-9a-f]{12}$/;

// A stand-in for the model: it reads the instructions the worker was given and answers in the style they ask for.
const scriptedFetch = (async (_url: string, init: { body: string }) => {
  if (init.body.includes("FAIL-ON-PURPOSE")) {
    return new Response(JSON.stringify({ error: { message: "the provider is down (scripted)" } }), { status: 400 });
  }
  const text = init.body.includes("three bullets")
    ? "- Open-weight models close the gap\n- Agent frameworks stay small\n- Prompt caching cuts long-session costs"
    : "Open-weight models close the gap on frontier benchmarks.";
  const message = { role: "assistant", content: text };
  const usage = { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 };
  return new Response(JSON.stringify({ id: "demo", choices: [{ message, finish_reason: "stop" }], usage }), {
    status: 200,
  });
}) as unknown as typeof fetch;

// A run file is a header between two "---" lines, then the result (see docs/scheduled-action-files.md).
function readRun(file: string): { header: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(fs.readFileSync(file, "utf8"));
  if (!m) throw new Error(`${file} is not a run file`);
  const header = Object.fromEntries(
    m[1]!.split("\n").map((l) => [l.slice(0, l.indexOf(": ")), l.slice(l.indexOf(": ") + 2)])
  );
  return { header, body: m[2]!.trimEnd() };
}

fs.rmSync(HOME, { recursive: true, force: true }); // the demo owns this folder

const agent = new Agent({
  name: "Planner",
  model: "demo/planner",
  apiKey: "demo",
  baseUrl: "http://localhost/v1",
  fetch: scriptedFetch,
  home: HOME,
  dynamicSubagents: { enabled: false, model: "demo/worker", allowScheduledActions: true },
});

// The action delivers tomorrow, so only our `run` calls start it.
const action = agent.scheduled.create({
  instructions: "You write a one-line AI news brief.",
  task: "Write today's brief.",
  scheduled_action: {
    name: "Daily AI Brief",
    id: "daily-ai-brief",
    timeToDeliver: "01:09:00",
    meridiem: "AM",
    retries: 0,
  },
});
const definitionsDir = path.join(HOME, "scheduled", action.id, "definitions");
const definitionFiles = () => fs.readdirSync(definitionsDir).sort();
const readDefinition = (hash: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(definitionsDir, `${hash}.json`), "utf8"));

// Runs the action now, waits for its run file and prints the definition its header names.
async function runOnce(label: string) {
  const delivery = nextDelivery(action.id);
  agent.scheduled.run(action.id);
  const run = readRun((await delivery).file);
  console.log(
    `${label}: status=${run.header["status"]}, definition=${run.header["definition"]}, files=${definitionFiles().length}`
  );
  console.log(run.body.replace(/^/gm, "    | "));
  return run;
}

console.log("1. First run");
const a = await runOnce("run 1");
check(HASH.test(a.header["definition"] ?? ""), "run 1 names a definition");
check(definitionFiles().length === 1, "one definition file after run 1");

console.log("\n2. Same action, nothing changed");
const again = await runOnce("run 2");
check(
  again.header["definition"] === a.header["definition"],
  "run 2 (nothing changed) has the same definition as run 1"
);
check(definitionFiles().length === 1, "still one definition file after run 2");

console.log("\n3. Change the instructions (the id stays the same)");
agent.scheduled.update(action.id, { instructions: "You write a brief in exactly three bullets." });
const b = await runOnce("run 3");
check(b.header["definition"] !== a.header["definition"], "changed instructions give run 3 a new definition");
check(definitionFiles().length === 2, "two definition files, the first one kept");
check(b.body !== a.body, "the two runs produced different results");

console.log("\n4. A failing run still records its definition");
agent.scheduled.update(action.id, { task: "Write today's brief. FAIL-ON-PURPOSE" });
const failed = await runOnce("run 4");
check(failed.header["status"] === "failed", "run 4 failed");
check(HASH.test(failed.header["definition"] ?? ""), "the failed run still names its definition");
check(definitionFiles().includes(`${failed.header["definition"]}.json`), "and its definition file exists");

console.log("\n5. Why do run 1 and run 3 differ? Diff the two definition files");
const defA = readDefinition(a.header["definition"]!);
const defB = readDefinition(b.header["definition"]!);
for (const key of Object.keys({ ...defA, ...defB })) {
  if (key === "hash" || JSON.stringify(defA[key]) === JSON.stringify(defB[key])) continue;
  console.log(`  ${key}:\n    - ${JSON.stringify(defA[key])}\n    + ${JSON.stringify(defB[key])}`);
}

console.log(
  `\nAll contracts hold. Look at the files in ${path.join(HOME, "scheduled", action.id)} (wiped at the next start).`
);
