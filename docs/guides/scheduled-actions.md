# Scheduled actions

> Run work later, once or on repeat, and get the answer in a file.

A scheduled action is a worker that runs later and saves its answer to a file instead of replying in the chat. It is off until you turn it on with `dynamicSubagents.allowScheduledActions`.

```ts
import { Agent, telemetryBus, tool } from "agent-accelerator";
import { z } from "zod";

const recent_news = tool({
  description: "Three AI headlines.",
  input: z.object({}),
  execute: () => ["a", "b", "c"],
});

const agent = new Agent({
  name: "Planner", // the creating agent runs the action: keep it referenced
  model: "google/gemini-3.5-flash-lite",
  dynamicSubagents: {
    enabled: false, // scheduling only, no workers on the spot
    model: "google/gemini-3.5-flash-lite",
    tools: { recent_news },
    allowScheduledActions: true, // adds the scheduled_actions and get_datetime tools
  },
});

const action = agent.scheduled.create({
  instructions: "You write a short, sourced AI news brief.",
  task: "Call recent_news and write 3 bullets.",
  tools: ["recent_news"],
  scheduled_action: {
    name: "Daily AI Brief",
    id: "daily-ai-brief", // the SDK adds 6 random characters
    timeToDeliver: "01:07:00", // tomorrow (1 day), 07:00...
    meridiem: "AM", // ...on a 12-hour clock
    startCookingInAdvance: "00:00:30", // start 30 minutes early
    repeatEvery: "01:00:00", // every day. Leave it out to run once.
    retries: 1,
    onMissed: "run", // "skip" or "run" if your program was down at delivery time
  },
});
console.log(action.id, action.nextCookAt, action.nextDeliverAt);

telemetryBus.onEvent((e) => {
  if (e.code === "scheduled_action.delivered") {
    console.log("ready:", (e.data as { file: string }).file);
  }
});
```

`agent.scheduled` has these methods. They work on the agent's own home, so you pass no `home`.

| Method | Does |
|---|---|
| `create(input)` | Makes an action. Throws one `ValidationError` that lists every problem. |
| `list()` | Lists the actions. |
| `update(id, patch)` | Changes an action. |
| `run(id)` | Runs it now. |
| `skip(id)` | Moves it to its next time. |
| `delete(id, { force, purge })` | Deletes it. Refuses while it is running unless `force: true`. |

`getDatetimeTool` is also exported.

## Time format

- `timeToDeliver` is `DD:HH:MM`. `DD` is the number of days from today (`00` today, `01` tomorrow, no upper limit). `HH:MM` is on a 12-hour clock, with `meridiem` set to `"AM"` or `"PM"`. `HH` is 01 to 12.
- `startCookingInAdvance` and `repeatEvery` are durations, with `HH` from 00 to 23.
- Delivery has one-minute resolution. Repeats use calendar days, so 7:00 AM stays 7:00 AM.
- The lead time must be shorter than the repeat gap.
- There is no time zone or daylight saving logic. The machine's clock rules.

## How it runs

- **Lifecycle.** `waiting`, then `cooking`, then the result is saved (`ready`), then `delivered` at the delivery time, then `waiting` again or `done`. A failed run still writes a file that says why. A run that is still going when the next is due is skipped, never stacked.
- **Files.** Everything is under `<home>/scheduled/`, with one folder per action. It holds the action's `task.json` and one `.md` file per run. The header of each run file records what the run spent.
  - Files are read and checked again before each run, so editing `instructions` or `task` takes effect on the next run.
  - No keys and no tool code are stored.
  - The format is stable. See [Scheduled action files](../scheduled-action-files.md).
- **Events.** `scheduled_action.created`, `updated`, `started`, `ready`, `failed`, `delivered`, `missed`, `skipped`, `deleted`, `invalid`, `store_corrupt` and `error` on the telemetry bus.
- **Time limit.** An action can carry its own `timeoutMs`, at the top level of the action (not inside `scheduled_action`). A run that takes longer is stopped and recorded as failed. There is no limit by default.
  - `dynamicSubagents.workerTimeoutMs` is an optional ceiling. An action cannot ask for more, and it is the limit for actions that set none.
  - `0` and `Infinity` mean no ceiling.
- **Missed runs.** If your process was down at the time, the SDK emits `missed` once. By default nothing runs by itself. Call `agent.scheduled.run(id)` or `agent.scheduled.skip(id)`.
  - Set `onMissed` on an action to decide in advance. `"skip"` moves to the next time (a one-shot becomes `done`). `"run"` runs it when the program is back.
  - This also covers a run that a crash cut off.
  - An action whose creating agent is gone stays `missed`.

## Limits to know about

- Actions run only while your process is alive, and only if the creating `Agent` is still referenced. It is held weakly, so keep the variable alive.
- Several processes can share one home. The process that registered an action's `Agent` starts, delivers and recovers it. A process that does not own the `Agent` leaves the action alone. See [Scheduled action files](../scheduled-action-files.md).
- `run(id)` never retries. It is delivered when it finishes, and counts as late only when it replaces a missed run.
- `update` cannot remove `repeatEvery`.
- The only spending cap is `dynamicSubagents.scheduledActionBudget`, the cap of each run. The parent's `budget` is not inherited.

## Tips

- Use a cheap worker model, a small tool pool and a lead time that fits the job.
- Add a listener for `scheduled_action.delivered`.
- Do not put secrets in `instructions`. They are stored as plain text.
- `scheduled_action.id` must be lowercase kebab-case, at most 48 characters.
