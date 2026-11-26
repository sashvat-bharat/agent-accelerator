// A durable agent that survives a crash. The tools have real side effects (reserve stock, send a report, pay an invoice).
// This script kills its own child process in the middle of a tool, starts a new process, and shows what the agent did NOT repeat:
//
//   1. A child process starts the work and is killed (SIGKILL) while a tool runs. `persist` had saved every step:
//      the conversation, the tool that already finished, and the follow-up the user queued meanwhile.
//   2. A new process opens the same session. `agent.interrupted()` lists the cut-off run and `agent.resume()` continues it:
//      the finished tool is NOT run again, and the cut one is not blindly repeated either (it may have partly run): the model
//      is told it was interrupted. A tool marked `idempotent: true` or `replay: "safe"` would run again. The first model call
//      fails once on purpose, so you see `runRetries` try the run again. Then the queued follow-up runs.
//   3. A tool asks for permission and refuses with `ctx.stop(reason)`: the run ends `stopped`, the next message goes on normally.
//   4. Every tool call left its own log file.
//
// Run: bun run examples/15-durable-agent.ts   (a few live model calls; waits about 5 s for the run retry)
// Files go to .agent-accel/demo-durable/ (gitignored, wiped at the start); ledger.txt lists the side effects the tools really did.
// `resume` is "explicit" here so each step is visible; the default, "automatic", continues the run inside the constructor.
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, tool, telemetryBus, resolveHome, loadSessionDir, sessionDirFor } from "agent-accelerator";
import { z } from "zod";
import { fail, MODEL } from "./_shared";

const HOME = path.join(resolveHome(), "demo-durable");
const SESSION_ID = "durable-demo";
const PAYMENT_LIMIT = 100;
const CRASH = process.env.DEMO_CRASH === "1"; // set only for the child process

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ledgerFile = path.join(HOME, "ledger.txt");
const ledger = (line: string) => fs.appendFileSync(ledgerFile, `${line}\n`);

const reserveStock = tool({
  name: "reserve_stock",
  description: "Reserve stock for an order. Changes the inventory.",
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }, ctx) => {
    ctx.log("reserving stock", { orderId }); // goes to this call's own log file
    ledger(`reserved stock for order ${orderId}`);
    return `Stock reserved for order ${orderId}.`;
  },
});

const sendReport = tool({
  name: "send_report",
  description: "Email the daily report to the team. Takes a few seconds.",
  input: z.object({}),
  execute: async (_input, ctx) => {
    ledger("report: started");
    for (const part of [1, 2, 3]) {
      ctx.log(`uploading part ${part} of 3`);
      await sleep(300);
      if (CRASH && part === 2) process.kill(process.pid, "SIGKILL"); // the crash: no cleanup, no goodbye
    }
    ledger("report: sent");
    return "Report sent.";
  },
});

const payInvoice = tool({
  name: "pay_invoice",
  description: `Pay an invoice. Payments above $${PAYMENT_LIMIT} need the user's approval.`,
  input: z.object({ invoiceId: z.string(), amount: z.number() }),
  execute: async ({ invoiceId, amount }, ctx) => {
    // Your own permission check goes here (a rule, a prompt to the user, ...). Refusing = ctx.stop.
    if (amount > PAYMENT_LIMIT) {
      ctx.stop(`Refused: $${amount} is above the $${PAYMENT_LIMIT} limit and the user has not approved it.`);
    }
    ledger(`paid invoice ${invoiceId}: $${amount}`);
    return `Invoice ${invoiceId} paid.`;
  },
});

// Makes the first model call fail with a 503, once, to show the whole run being tried again.
let failedOnce = false;
const failOnce = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (failedOnce) return fetch(input, init);
  failedOnce = true;
  return new Response(JSON.stringify({ error: { message: "overloaded (injected by the demo)" } }), { status: 503 });
}) as unknown as typeof fetch;

const makeAgent = (flaky = false) =>
  new Agent({
    name: "Ops Assistant",
    instructions: "You run operations tasks with your tools. Call independent tools together. Be concise.",
    model: MODEL,
    tools: { reserve_stock: reserveStock, send_report: sendReport, pay_invoice: payInvoice },
    home: HOME,
    persist: {}, // every step goes to <home>/sessions/<sessionId>/
    sessionId: SESSION_ID, // the same id after a restart finds the cut-off run
    resume: "explicit",
    retry: { maxRetries: 0 }, // no quick per-call retries here, so the run-level retry is what you see
    ...(flaky ? { fetch: failOnce } : {}),
  });

// The child process starts the work, then send_report kills it.
if (process.argv.includes("--child")) {
  const agent = makeAgent();
  void agent.run("Reserve stock for order 42 and send the daily report. Do both now.").catch(fail);
  void agent.queue("When both are done, tell me in one sentence what was done.").catch(fail); // waits behind the run
  await sleep(60_000); // never reached
  process.exit(0);
}

fs.rmSync(HOME, { recursive: true, force: true }); // the demo owns this folder
fs.mkdirSync(HOME, { recursive: true });

console.log("1. A process starts the work and is killed in the middle of it");
const child = Bun.spawn([process.execPath, import.meta.path, "--child"], {
  env: { ...process.env, DEMO_CRASH: "1" },
  stdout: "inherit",
  stderr: "inherit",
});
await child.exited;
console.log(`  process ${child.pid} ended: ${child.signalCode ?? `exit code ${child.exitCode}`}`);
console.log(`  ledger so far:\n${fs.readFileSync(ledgerFile, "utf8")}`);

console.log("2. A new process picks the session up");
telemetryBus.onEvent((e) => e.code === "agent.run_retry" && console.log(`  retry: ${e.message}`));
const agent = makeAgent(true); // takes over the dead process's folder lock by itself
for (const run of agent.interrupted()) {
  console.log(`  cut-off run: "${run.prompt}" (calls without a result: ${run.pendingToolCalls.join(", ")})`);
}
console.log(`  prompts still waiting: ${agent.pendingCount}`);
const resumed = await agent.resume();
console.log(`  resumed run: "${resumed?.finishReason}"`);
for (const r of resumed?.toolResults ?? [])
  console.log(`    ${r.name}${r.isError ? " (error)" : ""}: ${String(r.result).slice(0, 90)}`);
while (agent.isBusy || agent.pendingCount > 0) await sleep(100); // the queued follow-up runs after it
const answer = agent.context.messages.at(-1)?.content;
console.log(
  `  follow-up: ${typeof answer === "string" ? answer : answer?.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")}`
);
console.log(`  ledger now:\n${fs.readFileSync(ledgerFile, "utf8")}`);
console.log(
  "  -> the stock was reserved once (it finished before the crash); the report was not sent a second time.\n"
);

console.log("3. Asking permission with ctx.stop");
const refused = await agent.run("Pay invoice INV-7 for $250.");
console.log(`  run ended "${refused.finishReason}" -> ${refused.toolResults[0]?.result}`);
const paid = await agent.run("Then pay invoice INV-8 for $40 instead.");
console.log(`  next message ended "${paid.finishReason}" (a normal finish) -> ${paid.text}\n`);

console.log("4. What was saved");
const dir = sessionDirFor(path.join(HOME, "sessions"), SESSION_ID);
console.log(`  runs: ${(loadSessionDir(dir)?.session.runs ?? []).map((r) => r.end ?? "cut off").join(", ")}`);
for (const file of fs.readdirSync(path.join(dir, "tool-logs")).sort()) {
  const lines: Array<{ phase: string; message?: string }> = fs
    .readFileSync(path.join(dir, "tool-logs", file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  console.log(`  tool-logs/${file}: ${lines.map((l) => (l.message ? `log "${l.message}"` : l.phase)).join(" -> ")}`);
}
console.log(`\nFiles are in ${HOME}`);
