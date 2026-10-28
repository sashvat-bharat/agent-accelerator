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

The main agent invents workers at runtime with the `spawn_subagents` tool. **You** fix the worker model, reasoning level, tool pool and limits; the model never picks them.

```ts
import { Agent, tool, z } from "agent-accelerator";

const recent_news = tool({ description: "Recent headlines for a topic.", input: z.object({ topic: z.string() }), execute: async ({ topic }) => [`${topic}: headline 1`, `${topic}: headline 2`] });

const lead = new Agent({
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  budget: { maxTotalSubagents: 8, maxCostUsd: 0.5 }, // per run, includes workers
  dynamicSubagents: {
    model: process.env.SUB_AGENT_MODEL ?? "google/gemini-3.5-flash-lite",
    maxSpawn: 3, // workers per call (default 4); extras are trimmed
    thinkingLevel: "low",
    tools: { recent_news }, // pool: the model grants a subset by name per task
    workerTimeoutMs: 60_000, // 0 = none, -1 = model sets timeoutMs per task, >0 = fixed
  },
});

const res = await lead.run("Compare three database engines using parallel research.");
for (const id of lead.listTrackedSubAgents()) console.log(id, lead.track(id)?.status);
```

Workers are **stateless** (one task in, one result out), reuse the parent's key only when providers match, and inherit limits, retry, env, fetch, `googleTier`, `fileAccess` and `captureRaw`. Missing worker model throws `SubAgentModelError` (set `dynamicSubagents.model` or `SUB_AGENT_MODEL`). Results arrive wrapped in `<SUB-AGENTS-RESPONSE>` XML and are metered into the parent's usage and budget. Sub-agent results are Symbol-branded, so a tool cannot forge them.

Tracking: `agent.track(id)` (live snapshot with `status` and `steps`), `agent.listTrackedSubAgents()`, `agent.subscribeToSubAgent(id, fn)`; stream events `subagent_delta` and `subagent_complete`. Display ids look like `NAME-{32hex}`; traces are kept up to 500 / 1 h / 100 steps and are visible only to the agent that spawned them.

**Recommendations**
- ✅ Give each worker a distinct `description`; keep tool pools small (workers only receive what is granted).
- ✅ Use a cheaper `dynamicSubagents.model` and `thinkingLevel: "low"`; cap with `maxSpawn` and `budget`.
- ❌ Don't delegate trivial single-step tasks; each worker is a full model run.

## Scheduled actions

A scheduled action is a dynamic sub-agent that runs **later** (once or on repeat) and saves its answer to a file instead of replying in chat. It is off by default.

```ts
import { Agent, createScheduledAction, telemetryBus, tool, z } from "agent-accelerator";

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
  },
});
console.log(action.id, action.nextCookAt, action.nextDeliverAt);

telemetryBus.onEvent((e) => {
  if (e.code === "scheduled_action.delivered") console.log("ready:", (e.data as { file: string }).file);
});
```

Also exported: `listScheduledActions`, `updateScheduledAction`, `runScheduledAction` (run now), `skipScheduledAction`, `killScheduledAction(id, { force, purge })`, `getDatetimeTool`. The model gets the same power through the `scheduled_actions` tool (`create | list | get | update | kill | run_now | skip`) and reads the machine clock with `get_datetime`.

How it works:
- **Time format.** `timeToDeliver` is `DD:HH:MM`: `DD` days from today (`00` today, `01` tomorrow, no upper limit), `HH:MM` on a 12-hour clock with `meridiem`. `startCookingInAdvance` and `repeatEvery` are durations (`HH` 00–23). Delivery has **one-minute resolution**. Repeats use calendar days, so 7:00 AM stays 7:00 AM. The lead time must be shorter than the repeat gap.
- **Lifecycle.** `waiting` → `cooking` → result saved (`ready`) → `delivered` at the delivery time → `waiting` again or `done`. A failed run still writes a file saying why. A run still cooking when the next is due is skipped (`skipped`), never stacked.
- **Files** under `<home>/scheduled_actions/` (`home` defaults to `setHome(dir)`, `AGENT_ACCEL_HOME`, then `.agent-accel/`): `tasks.json`, `deliveries.json`, and one `.md` result file per run. Files are re-read and validated before each run, so editing `instructions`/`task` takes effect next run. No keys or tool code are stored.
- **Events** on `telemetryBus` (`scheduled_action.*`): `created`, `updated`, `started`, `ready`, `failed`, `delivered`, `missed`, `skipped`, `killed`, `invalid`, `store_corrupt`, `error`.
- **Missed runs.** If the process was down at the moment, the SDK emits `missed` once and runs nothing by itself: call `runScheduledAction` or `skipScheduledAction`. `killScheduledAction` refuses while an action is cooking unless `force: true`.
- **Honest limits.** Actions run only while your process is alive, and only if the creating Agent is still referenced (held weakly). Use **one process per home folder** (no cross-process lock yet). `run_now` results are flagged `late` and never retry; `update` cannot remove `repeatEvery`; there are no spending guardrails and the parent's `budget` is not inherited; no timezone/DST logic (the machine clock rules).

**Recommendations:** ✅ cheap worker model, small tool pool, lead time sized to the job, a notifier on `scheduled_action.delivered`. ✅ Keep the `Agent` variable alive. ❌ No secrets in `instructions` (stored as plain text).

## For AI agents

- Fixed: `new Agent({ subagents: [a, b] })`. Dynamic: `dynamicSubagents: { model, tools, maxSpawn }`. Scheduling: `dynamicSubagents.allowScheduledActions: true` + a worker model, else `SubAgentModelError`.
- `createScheduledAction(agent, input)` throws one `ValidationError` listing every problem; `scheduled_action.id` must be lowercase kebab-case (≤48 chars); `timeToDeliver` HH is 01–12.
- Never expose model/level choice to the LLM for workers; they are developer settings.
- Track workers with `track`/`listTrackedSubAgents`/`subscribeToSubAgent`; do not poll files.
- See also: [Safety and operations](safety-and-ops.md), [`examples/03-multi_agent.ts`](../../examples/03-multi_agent.ts), [`examples/04-sub-agents.ts`](../../examples/04-sub-agents.ts), [`examples/14-scheduled-actions.ts`](../../examples/14-scheduled-actions.ts).
