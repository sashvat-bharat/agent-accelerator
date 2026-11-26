// Scheduled actions: a sub-agent that runs later (once or on repeat) and saves its answer to a file.
// This uses your computer's clock, so you can watch a real scheduled run within a few minutes.
//
// Run: bun run examples/14-scheduled-actions.ts           (about 3 minutes: waits for the real deliveries)
//      bun run examples/14-scheduled-actions.ts --quick   (does not wait; removes the actions right after scheduling)
//
// Files go to .agent-accel/demo/ (gitignored). Actions run only while this process is alive, and the Agent must stay referenced.
import * as fs from "node:fs";
import { Agent, tool, telemetryBus } from "agent-accelerator";
import { z } from "zod";
import { nextDelivery } from "./_helpers";
import type { Delivery } from "./_helpers";
import { fail, MODEL, SUB_AGENT_MODEL } from "./_shared";

const QUICK = process.argv.includes("--quick");

// A tool the scheduled worker may use: workers are granted tools by name from this pool.
const recentNews = tool({
  name: "recent_news",
  description: "Returns three recent AI headlines.",
  input: z.object({}),
  execute: () => [
    "Open-weight models close the gap on frontier benchmarks",
    "Agent frameworks converge on small, composable primitives",
    "Prompt caching cuts long-session costs by more than half",
  ],
});

// The scheduler wants `timeToDeliver` as "DD:HH:MM" (days from today, then a 12-hour clock) plus AM/PM, with
// one-minute resolution. This is the first whole minute at least `minutes` from now.
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

const agent = new Agent({
  name: "Planner",
  model: MODEL,
  instructions: "You are a planning assistant. When the user wants something done later, use the scheduling tools.",
  home: ".agent-accel/demo", // apart from any real .agent-accel/ folder you have
  dynamicSubagents: {
    enabled: false, // scheduling only: no `subagents` tool for work on the spot
    model: SUB_AGENT_MODEL, // the worker model is yours, never the model's choice
    tools: { recent_news: recentNews }, // the pool scheduled workers are granted from
    allowScheduledActions: true, // off by default
  },
});

// Everything the scheduler does is reported on the telemetry bus as `scheduled_action.*`.
telemetryBus.onEvent((e) => {
  if (e.code.startsWith("scheduled_action."))
    console.log(`  [${e.code}] ${e.message.replace("[Agent Accelerator] ", "")}`);
});

const show = (d: Delivery) =>
  console.log(`  ${d.status} -> ${d.file}\n${fs.readFileSync(d.file, "utf8").trim().replace(/^/gm, "    | ")}`);
// force: stop a run in flight; purge: delete its run files.
const removeAll = () =>
  Promise.all(agent.scheduled.list().map((a) => agent.scheduled.delete(a.id, { force: true, purge: true })));
await removeAll(); // leftovers of an earlier run you interrupted

console.log("1. Schedule an action from your code");
const slot = inMinutes(2);
const action = agent.scheduled.create({
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
console.log(`  ${action.id} delivers at ${slot.when.toLocaleTimeString()}`);
for (const a of agent.scheduled.list()) console.log(`  ${a.id}: state=${a.state}, next delivery ${a.nextDeliverAt}`);

console.log("\n2. Run it right now (its result arrives on the next clock tick)");
const nowDelivery = nextDelivery(action.id, 180_000);
agent.scheduled.run(action.id);
show(await nowDelivery);
const arrivals: Array<{ name: string; delivery: Promise<Delivery> }> = [];
if (!QUICK) arrivals.push({ name: action.id, delivery: nextDelivery(action.id, 6 * 60_000) }); // the real delivery is still ahead

console.log("\n3. Ask the model to schedule one (it reads the clock itself)");
const ask =
  "Deliver one short joke about databases 2 minutes from now, rounded up to a whole minute, and start working " +
  "on it 1 minute before that. Check the clock first. Keep the worker light.";
await agent.run(ask, { stream: true, onDelta: (d) => process.stdout.write(d) }).catch(fail);
for (const a of agent.scheduled.list().filter((x) => x.id !== action.id)) {
  console.log(`\n  the model scheduled ${a.id} for ${a.nextDeliverAt}`);
  const inMs = a.nextDeliverAt ? new Date(a.nextDeliverAt).getTime() - Date.now() : Infinity;
  if (!QUICK && inMs < 5 * 60_000) arrivals.push({ name: a.id, delivery: nextDelivery(a.id, 6 * 60_000) });
}

console.log("\n4. The real scheduled deliveries");
if (QUICK) console.log("  --quick: not waiting for the clock.");
for (const { name, delivery } of arrivals) {
  console.log(`  ${name} arrived:`);
  show(await delivery.catch(fail));
}

console.log("\n5. Clean up");
await removeAll();
console.log("  Done. In your own program, keep the Agent referenced and listen for scheduled_action.delivered.");
