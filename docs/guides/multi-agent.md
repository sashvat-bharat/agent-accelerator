# Multi-agent and scheduling
[Docs](../README.md) › Guides › Multi-agent and scheduling

> Delegate work to helper agents now, or schedule it to run later and land in a file.

## Fixed sub-agents

Define specialists once; each becomes a tool `{ task: string }` on the parent.

```ts
import { Agent } from "agent-accelerator";

const model = process.env.MODEL ?? "google/gemini-3.5-flash-lite";

const researcher = new Agent({ name: "researcher", description: "Finds sourced facts.", model, instructions: "Return findings with sources." });
const critic = new Agent({ name: "critic", description: "Finds weaknesses in a draft.", model, instructions: "List the top 3 problems." });

const lead = new Agent({
  model,
  instructions: "Delegate research, have the critic review it, then answer.",
  subagents: [researcher, critic], // or { name, description, agent }
});

const res = await lead.run("Should we adopt SQLite for a small SaaS?");
console.log(res.text);
console.log(res.subagents.map((s) => `${s.name}: ${s.usage.totalTokens} tokens`));
```

Each call runs on its own isolated copy (`fork`), so parallel calls to one worker really run in parallel. `agentToTool(agent)` and `buildAgentTools([...])` expose the same idea manually. The `SubAgent` class still works but is **deprecated**: use a plain `Agent` plus `subagents`.

## Dynamic sub-agents

The main agent starts workers at runtime with the one `subagents` tool (`spawn`, `message`, `close`, `list`). **You** fix the worker model, reasoning level, tool pool and limits; the model never picks them.

```ts
import { Agent, tool } from "agent-accelerator";
import { z } from "zod";

const recent_news = tool({ description: "Recent headlines for a topic.", input: z.object({ topic: z.string() }), execute: async ({ topic }) => [`${topic}: headline 1`, `${topic}: headline 2`] });

const lead = new Agent({
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  budget: { maxTotalSubagents: 8, maxCostUsd: 0.5 }, // per run, includes workers
  dynamicSubagents: {
    model: process.env.SUB_AGENT_MODEL ?? "google/gemini-3.5-flash-lite",
    maxSpawn: 3, // open workers at once (default: no limit)
    thinkingLevel: "low",
    tools: { recent_news }, // pool: the model grants a subset by name per worker
  },
});

const res = await lead.run("Compare three database engines using parallel research.");
for (const id of lead.listTrackedSubAgents()) console.log(id, lead.track(id)?.status);
```

- **The tool.** `spawn` (`name`, `task`; optional `instructions`, `role`, `tools`, `history`), `message` (`id`, `task`), `close` (`id`), `list`. The manual is the tool description (`src/agent/subagents.md`) and the system prompt is not touched, so the prompt cache stays stable. Several `spawn` calls in one turn run in parallel.
- **Results** are plain text with one header line: `[worker researcher-1a2b3c4d] replied:` then the worker's text, or `[worker ...] failed: <reason>` (the worker stays open). A bad request returns an `Error: ...` line. Usage and cost are metered into the parent's usage and budget, and never shown to the model. Results are Symbol-branded, so a tool cannot forge them.
- **Workers keep their conversation** and have their own instructions and session; `history: N` starts one from a copy of the first N finished turns of the main conversation (`list` shows them; the running turn is never copied, so restate the request in `task`). With `persist: { dir }` they survive a restart. Details below under *Persistent workers*.
- **Depth.** `maxDepth` caps how many levels of workers may exist below the agent. **By default there is no cap**: a worker can start workers that start workers, as deep as the model goes. Set a whole number >= 1 to limit it (`1` keeps workers flat, `3` allows three levels); in production pair unlimited depth with `workerBudget`, or set a cap. A worker with levels left gets its own `subagents` tool, and its children can only be granted the tools the worker itself was granted (never more than its parent had). Each level is saved inside the one above it, so a restart rebuilds the whole tree.
- **Spending cap.** `workerBudget: { maxCostUsd?, maxTotalTokens? }` is each worker's own cap, applied as that worker's per-run `budget`: a spawn, a message or a scheduled run is one run, and the usage of the worker's own workers counts toward it. Going over fails that call (`[worker <id>] failed: Token budget exceeded…`), keeps the worker open and leaves the parent alone. It is passed down to the workers' workers; unknown pricing counts $0 toward `maxCostUsd`.
- **Limits.** `maxSpawn` caps the number of **open** workers (close one to open another); by default there is no cap, like every other budget and limit; `budget.maxTotalSubagents` counts spawns per run. Workers reuse the parent's key only when providers match, and inherit limits, retry, env, fetch, `googleTier`, `fileAccess` and `captureRaw`. The `subagents` tool and `agent.workers` have no timeouts (`workerTimeoutMs` and an action's `timeoutMs` are for scheduled actions). A missing worker model throws `SubAgentModelError` (set `dynamicSubagents.model` or `SUB_AGENT_MODEL`).

Tracking: `agent.track(id)` (live snapshot with `status` and `steps`), `agent.listTrackedSubAgents()`, `agent.subscribeToSubAgent(id, fn)`; stream events `subagent_delta` and `subagent_complete`. Display ids look like `NAME-{32hex}` (one per run); traces are kept up to 500 / 1 h / 100 steps and are visible only to the agent that started them.

**Recommendations**
- ✅ Give each worker a distinct `name`; keep tool pools small (workers only receive what is granted).
- ✅ Use a cheaper `dynamicSubagents.model` and `thinkingLevel: "low"`; cap with `maxSpawn` and `budget`.
- ❌ Don't delegate trivial single-step tasks; each worker is a full model run.

## Persistent workers (`agent.workers`)

Besides one-shot delegation, an agent can run **workers that keep their conversation**: start one, message it again and again, close it. A worker is a plain `Agent` with its own instructions and tools, on the developer's worker model (`dynamicSubagents.model` or `SUB_AGENT_MODEL`). With `persist: { dir }` on the parent it is saved under `<parent session folder>/workers/<id>/` (own journal, tool logs and `worker.json`), so it is rebuilt with its history after a restart.

```ts
const reply = await lead.workers.spawn({
  name: "Researcher",
  instructions: "You research databases and cite sources.", // the worker's OWN prompt; the parent's is never copied
  task: "Compare SQLite and Postgres for a small SaaS.",
  tools: ["recent_news"], // subset of dynamicSubagents.tools; unknown names throw
  history: 1, // optional: start from a copy of the parent's first 1 finished turns (see lead.workers.turns()); default "none"
});
console.log(reply.id, reply.text); // e.g. "researcher-1a2b3c4d"

const next = await lead.workers.message(reply.id, "Now focus on write-heavy loads."); // same worker, same conversation
lead.workers.list(); // open workers: { id, name, role?, tools, busy }
lead.workers.close(reply.id); // can no longer be messaged; its session stays on disk
```

- A turn is one **finished** run (`done` or ended by `ctx.stop`); the running turn and failed or aborted runs are never copied, so a worker never gets a prompt without its answer.
- `spawn` and `message` wait for the reply and never throw for a failing worker: the `WorkerReply` then carries `error` and a text that says so. They throw `ValidationError` for a bad request (unknown tool or id, closed or busy worker, too many open workers: `dynamicSubagents.maxSpawn` is the open-worker limit, `budget.maxTotalSubagents` still counts spawns per run).
- A worker handles one call at a time. Pass `{ signal }` to abort its run; the worker stays open.
- Exactly once across a crash: pass `{ callId }` (the calling tool call's id). A replayed `spawn` finds the worker it already started, a cut-off run is continued with `resume()` instead of sending the text twice, and a call that had already been answered returns that saved answer.
- Without `persist` the workers live in memory only. A damaged `worker.json` is skipped with a `worker.invalid` event.
- The reply's `metadata` (usage, steps, lineage) has the same shape as `AgentResponse.subagents`; `agent.track(metadata.trackingId)` shows the run live.

## Scheduled actions

A scheduled action is a dynamic sub-agent that runs **later** (once or on repeat) and saves its answer to a file instead of replying in chat. It is off by default.

```ts
import { Agent, createScheduledAction, telemetryBus, tool } from "agent-accelerator";
import { z } from "zod";

const recent_news = tool({ description: "Three AI headlines.", input: z.object({}), execute: () => ["a", "b", "c"] });

const agent = new Agent({
  name: "Planner", // the creating Agent (by name) runs the action: keep it referenced
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  dynamicSubagents: {
    enabled: false, // scheduling only; no on-the-spot spawning
    model: process.env.SUB_AGENT_MODEL ?? "google/gemini-3.5-flash-lite",
    tools: { recent_news },
    allowScheduledActions: true, // adds the scheduled_actions + get_datetime tools
  },
});

const action = createScheduledAction(agent, {
  instructions: "You write a short, sourced AI news brief.",
  task: "Call recent_news and write 3 bullets.",
  tools: ["recent_news"],
  scheduled_action: {
    name: "Daily AI Brief",
    id: "daily-ai-brief", // the SDK appends 6 random chars
    timeToDeliver: "01:07:00", // DD:HH:MM = 1 day from today, 07:00 on a 12-hour clock...
    meridiem: "AM", // ...so tomorrow 7:00 AM
    startCookingInAdvance: "00:00:30", // duration: start 30 minutes early
    repeatEvery: "01:00:00", // duration: every day; omit to run once
    retries: 1,
    onMissed: "run", // optional: "skip" | "run" if your program was down at delivery time
  },
});
console.log(action.id, action.nextCookAt, action.nextDeliverAt);

telemetryBus.onEvent((e) => {
  if (e.code === "scheduled_action.delivered") console.log("ready:", (e.data as { file: string }).file);
});
```

Also exported: `listScheduledActions`, `updateScheduledAction`, `runScheduledAction` (run now), `skipScheduledAction`, `deleteScheduledAction(id, { force, purge })`, `getDatetimeTool`. The model gets the same power through the `scheduled_actions` tool (`create | list | get | update | delete | run_now | skip`) and reads the machine clock with `get_datetime`.

How it works:
- **Time format.** `timeToDeliver` is `DD:HH:MM`: `DD` days from today (`00` today, `01` tomorrow, no upper limit), `HH:MM` on a 12-hour clock with `meridiem`. `startCookingInAdvance` and `repeatEvery` are durations (`HH` 00–23). Delivery has **one-minute resolution**. Repeats use calendar days, so 7:00 AM stays 7:00 AM. The lead time must be shorter than the repeat gap.
- **Lifecycle.** `waiting` → `cooking` → result saved (`ready`) → `delivered` at the delivery time → `waiting` again or `done`. A failed run still writes a file saying why. A run still cooking when the next is due is skipped (`skipped`), never stacked.
- **Files** under `<home>/scheduled_actions/` (`home` defaults to `setHome(dir)`, `AGENT_ACCEL_HOME`, then `.agent-accel/`): `tasks.json`, `deliveries.json`, and one `.md` result file per run (its header records the run's exact spending: `turns`, the `tokens` split into fresh input, cache reads and writes, output and thinking, `cacheHitRate`, `costUsd` (`unknown`, never 0, when no price is known) and `costSource`; retries included, failed runs too). Files are re-read and validated before each run, so editing `instructions`/`task` takes effect next run. No keys or tool code are stored.
- **Events** on `telemetryBus` (`scheduled_action.*`): `created`, `updated`, `started`, `ready`, `failed`, `delivered`, `missed`, `skipped`, `deleted`, `invalid`, `store_corrupt`, `error`.
- **Time limit of a run.** A scheduled action may carry `timeoutMs` (top level of the action, not inside `scheduled_action`): a run that takes longer is stopped and recorded as failed. By default there is no limit. `dynamicSubagents.workerTimeoutMs` is an optional ceiling: an action cannot ask for more, and it is the limit for actions that set none (`0` and `Infinity` mean no ceiling). The old `dynamicSubagents.timeout`, `modelMaySetTimeout` and the `-1` mode were removed.
- **Missed runs.** If the process was down at the moment, the SDK emits `missed` once. By default nothing runs by itself: call `runScheduledAction` or `skipScheduledAction`. Set `onMissed` per action to decide in advance: `"skip"` moves to the next time (a one-shot is `done`), `"run"` runs it when the program is back. It also covers a run a crash cut off; an action whose creating Agent is gone stays `missed`. `deleteScheduledAction` refuses while an action is cooking unless `force: true`.
- **Honest limits.** Actions run only while your process is alive, and only if the creating Agent is still referenced (held weakly). Use **one process per home folder** (a second process fails at once: the home is locked). `run_now` never retries (it is delivered when it finishes, and is `late` only when it replaces a missed run); `update` cannot remove `repeatEvery`; the only spending guardrail is `dynamicSubagents.workerBudget` (each run's own cap); the parent's `budget` is not inherited; no timezone/DST logic (the machine clock rules).

**Recommendations:** ✅ cheap worker model, small tool pool, lead time sized to the job, a notifier on `scheduled_action.delivered`. ✅ Keep the `Agent` variable alive. ❌ No secrets in `instructions` (stored as plain text).

## For AI agents

- Fixed: `new Agent({ subagents: [a, b] })`. Dynamic: `dynamicSubagents: { model, tools, maxSpawn }` (the model gets the `subagents` tool). Scheduling: `dynamicSubagents.allowScheduledActions: true` + a worker model, else `SubAgentModelError`.
- `createScheduledAction(agent, input)` throws one `ValidationError` listing every problem; `scheduled_action.id` must be lowercase kebab-case (≤48 chars); `timeToDeliver` HH is 01–12.
- Never expose model/level choice to the LLM for workers; they are developer settings.
- Workers that keep a conversation: `agent.workers.spawn / message / close / list` (pass `callId` for exactly-once after a crash); they need a worker model, and `persist: { dir }` on the parent to survive a restart.
- Track workers with `track`/`listTrackedSubAgents`/`subscribeToSubAgent`; do not poll files.
- See also: [Safety and operations](safety-and-ops.md), [`examples/03-multi_agent.ts`](../../examples/03-multi_agent.ts), [`examples/04-sub-agents.ts`](../../examples/04-sub-agents.ts), [`examples/14-scheduled-actions.ts`](../../examples/14-scheduled-actions.ts).
