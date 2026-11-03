/**
 * Agent Accelerator - A durable agent that survives a crash
 *
 * An ops assistant whose tools have real side effects (reserve stock, send a
 * report, pay an invoice). This script kills the process in the middle of
 * its work, starts a new one, and shows what the agent did NOT repeat:
 *
 *   1. A child process starts the work and is killed (SIGKILL) while a tool is
 *      running. `persist` had saved every step: the conversation, the tool that
 *      already finished, and the follow-up the user queued meanwhile.
 *   2. A new process opens the same session. `agent.interrupted()` lists the cut-off
 *      run, `agent.resume()` continues it: the finished tool is NOT run again, only
 *      the one that was cut. The first model call fails once on purpose, so you see
 *      `runRetries` try the run again; then the queued follow-up runs.
 *   3. A tool asks for permission and refuses with `ctx.stop(reason)`: the run ends
 *      `stopped`, and the next message goes on normally.
 *   4. Every tool call left its own log file (`ctx.log` lines included).
 *
 * Run:  bun run examples/15-durable-agent.ts
 * Needs: MODEL + provider key (see .env.example). Costs a few live model calls and
 * waits about 5 s for the run retry. Files go to ./.agent-accel/demo-durable/
 * (gitignored; wiped at the start): sessions/<id>/{session.json, journal.ndjson,
 * tool-logs/*} and ledger.txt, the side effects the tools really did.
 *
 * The same `sessionId` after a restart is what finds the cut-off run. `resume`
 * defaults to "automatic" (the constructor continues the run by itself); this demo
 * uses "explicit" so each step is visible.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, tool, telemetryBus, resolveHome, loadSessionDir, sessionDirFor } from "agent-accelerator";
import { z } from "zod";
import { fail } from "./_shared";

const HOME = path.join(resolveHome(), "demo-durable");
const SESSIONS = path.join(HOME, "sessions");
const LEDGER = path.join(HOME, "ledger.txt");
const SESSION_ID = "durable-demo";
const PAYMENT_LIMIT = 100;
const CRASH = process.env.DEMO_CRASH === "1"; // set only for the child process

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (line: string) => fs.appendFileSync(LEDGER, line + "\n");
const head = (title: string) => console.log(`\n\x1b[36m━━━ ${title} ━━━\x1b[0m`);
const say = (text: string) => console.log(`\x1b[34m${text}\x1b[0m`);

// ── Tools with real side effects (each one writes to the ledger) ─────────────

const reserve_stock = tool({
  description: "Reserve stock for an order. Changes the inventory.",
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }, ctx) => {
    ctx.log("reserving stock", { orderId }); // goes to this call's own log file
    note(`reserved stock for order ${orderId}`);
    return `Stock reserved for order ${orderId}.`;
  },
});

const send_report = tool({
  description: "Email the daily report to the team. Takes a few seconds.",
  input: z.object({}),
  execute: async (_input, ctx) => {
    note("report: started");
    for (const part of [1, 2, 3]) {
      ctx.log(`uploading part ${part} of 3`);
      await sleep(300);
      if (CRASH && part === 2) process.kill(process.pid, "SIGKILL"); // the crash: no cleanup, no goodbye
    }
    note("report: sent");
    return "Report sent.";
  },
});

const pay_invoice = tool({
  description: `Pay an invoice. Payments above $${PAYMENT_LIMIT} need the user's approval.`,
  input: z.object({ invoiceId: z.string(), amount: z.number() }),
  execute: async ({ invoiceId, amount }, ctx) => {
    // Your own permission check goes here (a rule, a prompt to the user, ...). Refusing = ctx.stop.
    if (amount > PAYMENT_LIMIT) ctx.stop(`Refused: $${amount} is above the $${PAYMENT_LIMIT} limit and the user has not approved it.`);
    note(`paid invoice ${invoiceId}: $${amount}`);
    return `Invoice ${invoiceId} paid.`;
  },
});

// ── The agent ────────────────────────────────────────────────────────────────

let failedOnce = false;
// Makes the first model call fail with a 503, once, to show the whole run being tried again.
const failOnce = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (failedOnce) return fetch(input, init);
  failedOnce = true;
  return new Response(JSON.stringify({ error: { message: "overloaded (injected by the demo)" } }), { status: 503 });
}) as unknown as typeof fetch;

const makeAgent = (flaky = false) =>
  new Agent({
    name: "Ops Assistant",
    instructions: "You run operations tasks with your tools. Call independent tools together. Be concise.",
    model: process.env.MODEL,
    tools: { reserve_stock, send_report, pay_invoice },
    home: HOME,
    persist: {}, // every step goes to <home>/sessions/<sessionId>/
    sessionId: SESSION_ID, // the same id after a restart finds the cut-off run
    resume: "explicit", // the default, "automatic", would continue the run inside the constructor
    retry: { maxRetries: 0 }, // no quick per-call retries here, so the run-level retry is what you see
    ...(flaky ? { fetch: failOnce } : {}),
  });

// Waits until the agent has nothing running and nothing queued.
const idle = async (agent: Agent) => {
  while (agent.isBusy || agent.pendingCount > 0) await sleep(100);
};

const lastText = (agent: Agent) => {
  const { content } = agent.context.messages.at(-1)!;
  return typeof content === "string" ? content : content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
};

// ── Child process: starts the work, then the tool kills it ───────────────────

if (process.argv.includes("--child")) {
  const agent = makeAgent();
  void agent.run("Reserve stock for order 42 and send the daily report. Do both now.").catch(fail);
  void agent.queue("When both are done, tell me in one sentence what was done.").catch(fail); // waits behind the run
  await sleep(60_000); // never reached: send_report kills this process
  process.exit(0);
}

// ── Parent process: the story ────────────────────────────────────────────────

async function main() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  head("1. A process starts the work and is killed in the middle of it");
  const child = Bun.spawn([process.execPath, import.meta.path, "--child"], {
    env: { ...process.env, DEMO_CRASH: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  await child.exited;
  say(`process ${child.pid} ended: ${child.signalCode ?? `exit code ${child.exitCode}`}`);
  say(`ledger so far:\n${fs.readFileSync(LEDGER, "utf8")}`);

  head("2. A new process picks the session up");
  telemetryBus.onEvent((e) => e.code === "agent.run_retry" && say(`↻ ${e.message}`));
  const agent = makeAgent(true); // takes over the dead process's folder lock by itself
  for (const run of agent.interrupted()) say(`cut-off run: "${run.prompt}" (tool calls without a result: ${run.pendingToolCalls.join(", ")})`);
  say(`prompts that were still waiting: ${agent.pendingCount}`);

  const resumed = await agent.resume();
  say(`resumed run finished: "${resumed?.finishReason}", ${resumed?.toolResults.length} tool result(s) in its response`);
  await idle(agent); // the queued follow-up runs after the resumed run
  say(`follow-up answer: ${lastText(agent)}`);
  say(`ledger now:\n${fs.readFileSync(LEDGER, "utf8")}`);
  say("→ the stock was reserved once (it finished before the crash); only the report ran again.");

  head("3. Asking permission with ctx.stop");
  const refused = await agent.run("Pay invoice INV-7 for $250.");
  say(`run ended "${refused.finishReason}" → ${refused.toolResults[0]?.result}`);
  const paid = await agent.run("Then pay invoice INV-8 for $40 instead.");
  say(`next message ended "${paid.finishReason}" (a normal finish) → ${paid.text}`);

  head("4. What was saved");
  const dir = sessionDirFor(SESSIONS, SESSION_ID);
  const runs = loadSessionDir(dir)?.session.runs ?? [];
  say(`runs: ${runs.map((r) => r.end ?? "cut off").join(", ")}`);
  for (const file of fs.readdirSync(path.join(dir, "tool-logs")).sort()) {
    const lines: Array<{ phase: string; message?: string }> = fs
      .readFileSync(path.join(dir, "tool-logs", file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    say(`tool-logs/${file}: ${lines.map((l) => (l.message ? `log "${l.message}"` : l.phase)).join(" → ")}`);
  }
  say(`\nFiles are in ${HOME}`);
}

main().catch(fail);
