/**
 * Agent Accelerator - Scheduled Actions walkthrough
 *
 * A scheduled action is a dynamic sub-agent that runs LATER (once or on
 * repeat), on its own, and saves its answer to a file instead of replying in
 * the chat. This walks through the whole lifecycle using YOUR computer's
 * clock, so you can watch a real scheduled run happen within a few minutes:
 *
 *   1. Turn it on: dynamicSubagents.allowScheduledActions (off by default).
 *   2. Read the clock and schedule an action from YOUR code
 *      (createScheduledAction): it starts working about 1 minute from now and
 *      delivers about 2 minutes from now.
 *   3. Look at it (listScheduledActions) and, while the clock runs, try
 *      runScheduledAction (run it right now).
 *   4. Let the MODEL schedule one: it reads the clock itself (get_datetime)
 *      and uses the same timing (scheduled_actions tool).
 *   5. Watch the REAL scheduled deliveries arrive and read the result files.
 *   6. Clean up (killScheduledAction).
 *
 * Run:
 *   bun run examples/14-scheduled-actions.ts           (about 3 minutes: waits for the real deliveries)
 *   bun run examples/14-scheduled-actions.ts --quick   (does not wait; removes the actions right after scheduling)
 *
 * Delivery times have one-minute resolution, so "2 minutes from now" is
 * rounded UP to the next whole minute: the run starts at least 1 minute from
 * now and delivers at least 2 minutes from now.
 *
 * Needs: MODEL + SUB_AGENT_MODEL + provider key (see .env.example). Costs live
 * tokens. Files go to ./.agent-accel/demo/scheduled_tasks/ (gitignored) and
 * the demo removes what it creates.
 *
 * Note: actions run only while this process is alive, and the Agent must stay
 * referenced (the scheduler holds it weakly).
 */

import * as fs from "node:fs";
import {
  Agent,
  tool,
  z,
  telemetryBus,
  createScheduledAction,
  listScheduledActions,
  runScheduledAction,
  killScheduledAction,
} from "agent-accelerator";
import { fail } from "./_shared";

const C = "\x1b[36m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const B = "\x1b[34m";
const DIM = "\x1b[90m";
const R = "\x1b[0m";
const head = (t: string) => console.log(`\n${C}━━━ ${t} ━━━${R}`);
const info = (t: string) => console.log(`${B}${t}${R}`);
const ok = (t: string) => console.log(`${G}${t}${R}`);

const QUICK = process.argv.includes("--quick");
const MODEL = process.env.MODEL ?? "google/gemini-3.5-flash-lite";
const WORKER_MODEL = process.env.SUB_AGENT_MODEL ?? MODEL;
// Isolated from any real .agent-accel/ folder you may have.
const HOME = ".agent-accel/demo";
const LEAD_MS = 60_000; // start working 1 minute before delivery

// A tool the scheduled worker may use. Workers get tools BY NAME from this pool.
const recent_news = tool({
  name: "recent_news",
  description: "Returns three recent AI headlines.",
  input: z.object({}),
  idempotent: true,
  execute: () => [
    "Open-weight models close the gap on frontier benchmarks",
    "Agent frameworks converge on small, composable primitives",
    "Prompt caching cuts long-session costs by more than half",
  ],
});

/** Your computer's clock, e.g. "08:13:53 PM". */
const clock = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * The first whole minute at or after `minutes` from now, as the scheduler wants it:
 * `timeToDeliver` = "DD:HH:MM" (DD = days from today, HH:MM on a 12-hour clock) + AM/PM.
 */
function inMinutes(minutes: number): { when: Date; timeToDeliver: string; meridiem: "AM" | "PM" } {
  const now = new Date();
  const when = new Date(now.getTime() + minutes * 60_000);
  if (when.getSeconds() > 0 || when.getMilliseconds() > 0) when.setMinutes(when.getMinutes() + 1);
  when.setSeconds(0, 0);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(when) - day(now)) / 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    when,
    timeToDeliver: `${p(days)}:${p(when.getHours() % 12 || 12)}:${p(when.getMinutes())}`,
    meridiem: when.getHours() < 12 ? "AM" : "PM",
  };
}

// Everything the scheduler does is reported on the telemetry bus as `scheduled_action.*`.
const t0 = Date.now();
telemetryBus.onEvent((e) => {
  if (!e.code.startsWith("scheduled_action.")) return;
  const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
  console.log(`${DIM}+${secs}s${R} ${Y}${e.code.slice("scheduled_action.".length).padEnd(9)}${R} ${DIM}${e.message.replace("[Agent Accelerator] ", "")}${R}`);
});

type Delivery = { id: string; file: string; status: string; late: boolean };

/** Resolves with the data of the next `scheduled_action.delivered` event for `id` (rejects after `ms`). */
function nextDelivery(id: string, ms: number): Promise<Delivery> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out after ${ms / 1000}s waiting for the delivery of ${id}`));
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

/** Removes every action in the demo-only folder (force: abort a run in flight; purge: delete its run files). */
async function removeDemoActions(say: (t: string) => void): Promise<void> {
  for (const a of listScheduledActions({ home: HOME })) {
    const r = await killScheduledAction(a.id, { home: HOME, force: true, purge: true });
    say(`  kill ${a.id}: ${r.ok ? "removed" : JSON.stringify(r)}`);
  }
}

const showResult = (file: string) => console.log(`${DIM}${fs.readFileSync(file, "utf8").trim().replace(/^/gm, "  │ ")}${R}`);

async function main(): Promise<void> {
  // 1. Turn it on ----------------------------------------------------------
  head("1. Turn it on");
  const agent = new Agent({
    name: "Planner",
    model: MODEL,
    instructions: "You are a planning assistant. When the user wants something done later or on a schedule, use the scheduling tools.",
    home: HOME,
    dynamicSubagents: {
      enabled: false, // we only want scheduling, not on-the-spot spawn_subagents
      model: WORKER_MODEL, // the fixed worker model: the Main Agent can never choose it
      tools: { recent_news }, // the pool scheduled workers can be granted from
      allowScheduledActions: true, // default false
    },
  });
  info(`Tools the model sees: ${Object.keys(agent.tools).join(", ")}`);
  // This folder is only for the demo: drop leftovers of an earlier run you interrupted,
  // and clean up if you press Ctrl+C during the wait.
  await removeDemoActions(() => {});
  process.once("SIGINT", () => {
    console.log(`\n${Y}Interrupted: removing the demo's actions...${R}`);
    removeDemoActions(info).finally(() => process.exit(130));
  });

  // 2. Read the clock, schedule from your code ---------------------------------
  head("2. Read the clock and schedule an action from code");
  const now = new Date();
  info(`Your computer's clock says ${clock(now)}.`);
  const slot = inMinutes(2); // deliver at least 2 minutes from now
  const action = createScheduledAction(agent, {
    instructions: "You write a very short, sourced AI news brief.",
    task: "Call recent_news, then write a 3-bullet brief from it.",
    tools: ["recent_news"],
    scheduled_action: {
      name: "Demo AI Brief",
      id: "demo-ai-brief", // the SDK appends 6 random characters
      timeToDeliver: slot.timeToDeliver,
      meridiem: slot.meridiem,
      startCookingInAdvance: "00:00:01", // the run starts 1 minute before delivery
      retries: 1,
    },
  });
  const secsFromNow = (d: Date) => Math.round((d.getTime() - Date.now()) / 1000);
  ok(`Scheduled ${action.id}`);
  info(`  starts working at ${clock(new Date(slot.when.getTime() - LEAD_MS))} (in ${secsFromNow(new Date(slot.when.getTime() - LEAD_MS))}s)`);
  info(`  delivers at       ${clock(slot.when)} (in ${secsFromNow(slot.when)}s)`);

  // 3. Look at it, run it now -------------------------------------------------
  head("3. List it, and try run-now while the clock runs");
  for (const a of listScheduledActions({ home: HOME })) {
    info(`  ${a.id}  state=${a.state}  running=${a.running}  next delivery ${a.nextDeliverAt}`);
  }
  info("run_now does not move the schedule; its result is delivered on the next clock tick...");
  const nowDelivery = nextDelivery(action.id, 180_000);
  runScheduledAction(action.id, { home: HOME });
  const first = await nowDelivery;
  // Known quirk: a run_now result is reported "late" (it finishes after its "due now" time).
  // The flag is meaningful for scheduled deliveries (see step 5).
  ok(`Delivered (${first.status}${first.late ? ", late" : ""}) -> ${first.file}`);
  showResult(first.file);

  // The REAL scheduled delivery of this same action is still ahead. Start listening now.
  const waiting: Array<{ name: string; delivery: Promise<Delivery> }> = [];
  if (!QUICK) waiting.push({ name: "Demo AI Brief (scheduled from code)", delivery: nextDelivery(action.id, 6 * 60_000) });

  // 4. Let the model schedule, using the clock ---------------------------------
  head("4. Ask the model to schedule one (it reads the clock itself)");
  const ask =
    "Deliver one short joke about databases 2 minutes from now, rounded up to a whole minute, " +
    "and start working on it 1 minute before that. Check the clock first. Keep the worker light.";
  info(`You: ${ask}\n`);
  const res = await agent.run(ask, {
    stream: true,
    onDelta: (d) => process.stdout.write(d),
    onEvent: (e) => {
      if (e.type === "tool_start") console.log(`\n${Y}→ model calls ${e.toolCalls?.map((c) => c.name).join(", ")}${R}`);
      if (e.type === "tool_result" && e.toolResult) {
        console.log(`${DIM}  ${e.toolResult.name} ${e.toolResult.isError ? "ERROR" : "ok"}: ${String(JSON.stringify(e.toolResult.result)).slice(0, 160)}${R}`);
      }
    },
  });
  console.log(`\n${DIM}(${res.turns} turns, ${res.usage.inputTokens} in / ${res.usage.outputTokens} out)${R}`);
  const mine = listScheduledActions({ home: HOME }).filter((a) => a.id !== action.id);
  if (mine.length === 0) info("The model did not schedule anything this time. Try running again or rephrase the request.");
  for (const a of mine) {
    ok(`The model scheduled "${a.name}" (${a.id}), delivery at ${a.nextDeliverAt}`);
    // Only wait for deliveries that are near (the model could have picked any time).
    const inMs = a.nextDeliverAt ? new Date(a.nextDeliverAt).getTime() - Date.now() : Infinity;
    if (!QUICK && inMs < 5 * 60_000) waiting.push({ name: `${a.name} (scheduled by the model)`, delivery: nextDelivery(a.id, 6 * 60_000) });
    else if (!QUICK) info("  (too far away to wait for; it is removed in the clean-up step)");
  }

  // 5. Watch the real deliveries ---------------------------------------------
  head("5. The real scheduled deliveries");
  if (QUICK) info("--quick: not waiting for the clock.");
  else info(`Waiting for ${waiting.length} scheduled ${waiting.length === 1 ? "delivery" : "deliveries"} (about 2-3 minutes from the start)...`);
  for (const w of waiting) {
    const d = await w.delivery;
    ok(`${w.name} arrived (${d.status}${d.late ? ", late" : ""}) -> ${d.file}`);
    showResult(d.file);
  }

  // 6. Clean up -----------------------------------------------------------------
  head("6. Clean up");
  await removeDemoActions(info);
  ok("\nDone. In your own program, keep the Agent referenced and listen for scheduled_action.delivered.");
}

main().catch(fail);
