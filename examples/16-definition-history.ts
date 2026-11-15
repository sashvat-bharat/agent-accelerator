/**
 * Agent Accelerator - Which instructions produced this result?
 *
 * A scheduled action keeps its `id` when you edit its instructions. So when two results of the same action differ, the
 * id alone cannot say why. Each run file therefore records a `definition` fingerprint, taken when the run STARTS (a
 * failed run records it too), and the exact text it stands for is saved once under `<id>/definitions/<hash>.json`.
 * This script shows it with the same action id and changed instructions:
 *
 *   1. Run the action: the run file names definition A.
 *   2. Run it again, nothing changed: a second run file, the same definition, still one definition file.
 *   3. Change the instructions (same id) and run it: a new definition B; the file of A is still there.
 *   4. A run that fails still records the definition it started with.
 *   5. Compare two results: read the `definition` of each run file, then diff the two definition files.
 *
 * Run:  bun run examples/16-definition-history.ts
 * Needs: nothing. The model is a scripted stand-in (no network, no key, no cost) that answers one line or three bullets
 * depending on the instructions it receives. Files go to ./.agent-accel/demo-definitions/ (gitignored; wiped at the
 * start): `scheduled/<id>/` holds `task.json`, one `.md` per run and `definitions/`.
 *
 * Note: this example does not import `_shared.ts`, because that file sets the model list for the live examples.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, telemetryBus, resolveHome } from "agent-accelerator";

const C = "\x1b[36m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const DIM = "\x1b[90m";
const R = "\x1b[0m";
const head = (t: string) => console.log(`\n${C}━━━ ${t} ━━━${R}`);

const HOME = path.join(resolveHome(), "demo-definitions");
const ID = "daily-ai-brief";

// One-line failure report, like `fail` in _shared.ts (which this example does not import).
const fail = (err: unknown): never => {
  console.error(`\n\u2716 ${(err as { message?: string } | undefined)?.message ?? err}\n`);
  process.exit(1);
};

// A stand-in for the model: it reads the instructions the worker was given and answers in the style they ask for.
const scriptedFetch = (async (_url: string, init: { body: string }) => {
  const request = init.body;
  if (request.includes("FAIL-ON-PURPOSE")) {
    return new Response(JSON.stringify({ error: { message: "the provider is down (scripted)" } }), { status: 400 });
  }
  const bullets = request.includes("three bullets");
  const text = bullets
    ? "- Open-weight models close the gap\n- Agent frameworks stay small\n- Prompt caching cuts long-session costs"
    : "Open-weight models close the gap on frontier benchmarks.";
  return new Response(
    JSON.stringify({
      id: "demo",
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
    }),
    { status: 200 }
  );
}) as unknown as typeof fetch;

type Delivery = { id: string; file: string; status: string };

// Resolves with the next `scheduled_action.delivered` event of `id` (rejects after `ms`); in: a run-now, out: where the run file is.
function nextDelivery(id: string, ms = 30_000): Promise<Delivery> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for the delivery of ${id}`));
    }, ms);
    const off = telemetryBus.onEvent((e) => {
      const data = e.data as Delivery | undefined;
      if (e.code !== "scheduled_action.delivered" || data?.id !== id) return;
      clearTimeout(timer);
      off();
      resolve(data);
    });
  });
}

// A run file: a header between two "---" lines, then the result (the same few lines as in docs/scheduled-action-files.md).
function readRun(file: string): { header: Record<string, string>; body: string } {
  const text = fs.readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file} is not a run file`);
  const header = Object.fromEntries(
    m[1]!.split("\n").map((l) => [l.slice(0, l.indexOf(": ")), l.slice(l.indexOf(": ") + 2)])
  );
  return { header, body: m[2]!.trimEnd() };
}

// The folder of definition files of the action; the SDK appended random characters to its id.
let actionId = "";
const definitionsDir = () => path.join(HOME, "scheduled", actionId, "definitions");
const readDefinition = (hash: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(definitionsDir(), `${hash}.json`), "utf8"));

async function main(): Promise<void> {
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

  // The action: delivers tomorrow, so only our `run` calls start it.
  const action = agent.scheduled.create({
    instructions: "You write a one-line AI news brief.",
    task: "Write today's brief.",
    scheduled_action: { name: "Daily AI Brief", id: ID, timeToDeliver: "01:09:00", meridiem: "AM", retries: 0 },
  });
  actionId = action.id;
  console.log(`${G}Created ${action.id}${R} ${DIM}(delivers tomorrow; we start it by hand with run)${R}`);

  // Runs the action now, waits for its run file, prints what the header says; out: the run file's header and body.
  const runOnce = async (label: string) => {
    const delivery = nextDelivery(action.id);
    agent.scheduled.run(action.id);
    const { file, status } = await delivery;
    const run = readRun(file);
    console.log(
      `${Y}${label}${R} status=${status}  definition=${run.header["definition"]}  ${DIM}${path.basename(file)}${R}`
    );
    console.log(`${DIM}${run.body.replace(/^/gm, "    │ ")}${R}`);
    return run;
  };
  const definitionFiles = () => fs.readdirSync(definitionsDir()).sort();

  head("1. First run");
  const a = await runOnce("run 1");
  console.log(`  definition files: ${definitionFiles().join(", ")}`);

  head("2. Same action, nothing changed");
  const again = await runOnce("run 2");
  console.log(
    `  definition files: ${definitionFiles().join(", ")}  (still one: ${again.header["definition"] === a.header["definition"]})`
  );

  head("3. Change the instructions (the id stays the same)");
  agent.scheduled.update(action.id, { instructions: "You write a brief in exactly three bullets." });
  const b = await runOnce("run 3");
  console.log(`  definition files: ${definitionFiles().join(", ")}  (the old one is kept)`);

  head("4. A failing run still records its definition");
  agent.scheduled.update(action.id, { task: "Write today's brief. FAIL-ON-PURPOSE" });
  const failed = await runOnce("run 4");
  console.log(`  ${DIM}the run started with a third definition: ${failed.header["definition"]}${R}`);

  head("5. Why do run 1 and run 3 differ?");
  const hashA = a.header["definition"]!;
  const hashB = b.header["definition"]!;
  console.log(`  run 1 used ${hashA}, run 3 used ${hashB}. Comparing the two definition files:`);
  const defA = readDefinition(hashA);
  const defB = readDefinition(hashB);
  for (const key of Object.keys({ ...defA, ...defB })) {
    if (key === "hash" || JSON.stringify(defA[key]) === JSON.stringify(defB[key])) continue;
    console.log(`  ${key}:`);
    console.log(`    ${DIM}- ${JSON.stringify(defA[key])}${R}`);
    console.log(`    ${G}+ ${JSON.stringify(defB[key])}${R}`);
  }

  console.log(`\n${DIM}Look at the files in ${path.join(HOME, "scheduled", actionId)} (wiped at the next start).${R}`);
}

main().catch(fail);
