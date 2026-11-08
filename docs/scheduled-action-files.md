# Scheduled action files

> The on-disk format of scheduled actions: plain files you can read, back up, diff and (carefully) edit. **From v0.5.5 this format is a stable contract**: it changes only by the rules at the bottom of this page, and every change is listed in the [changelog](#changelog).

Everything lives under one folder, `<home>/scheduled/` (`home` is `Agent({ home })`, then `setHome(dir)`, then `AGENT_ACCEL_HOME`, then `.agent-accel/` in the working directory):

```text
<home>/scheduled/
  <action id>/
    task.json            the action (definition + schedule + state)
    delivery.json        its results saved but not yet delivered (only while there are any)
    27-october-2026.md   one file per run: a header, then the result
    .mutex               a short lock, present only while the SDK changes this action
    .heartbeat           present while a process is running the action: its pid, host and a token; the file's modification time is refreshed every 5 s
```

The SDK reads and writes these files itself; there is no database and no notification system. What happens when a result is delivered is your code (see the `scheduled_action.delivered` event).

## What you can rely on

- **Reading is always safe.** Every write is atomic (temp file, fsync, rename), so a reader sees the old file or the new one, never half of one. `task.json` and `delivery.json` also keep their last good version as `<file>.bak`.
- **Times are local clock strings** `YYYY-MM-DDTHH:mm:ss`, no offset, no timezone (the machine clock rules). Compare them as strings or parse them as local time.
- **Unknown fields are ignored on read and kept on rewrite.** An action record may carry extra keys of yours (`"owner": "ops"`); the SDK leaves them alone. Extra top-level keys beside `version` and `task` / `pending` are not kept.
- **A damaged or invalid file never stops the clock.** A file that is not valid JSON is renamed `<file>.corrupt-<timestamp>` and restored from its `.bak` (event `scheduled_action.store_corrupt`). A record or a delivery entry that fails validation is skipped, left untouched in the file, and reported once (`scheduled_action.invalid`).

## `<action id>/task.json`

One file per action: the record sits under the `task` key.

```json
{
  "version": 2,
  "task": {
    "id": "daily-ai-brief-d64aj2",
    "name": "Daily AI Research Brief",
    "agent": "Main",
    "role": "analyst",
    "instructions": "You write a short, sourced AI research brief.",
    "task": "Summarize the most important AI news of the last day in 5 bullets.",
    "tools": ["recent_news"],
    "timeoutMs": 600000,
    "schedule": {
      "timeToDeliver": "01:07:00",
      "meridiem": "AM",
      "startCookingInAdvance": "00:00:30",
      "repeatEvery": "01:00:00",
      "retries": 1,
      "onMissed": "run"
    },
    "state": "waiting",
    "nextCookAt": "2026-10-27T06:59:30",
    "nextDeliverAt": "2026-10-27T07:00:00",
    "createdAt": "2026-10-26T15:55:31",
    "lastRun": {
      "status": "ok",
      "file": "daily-ai-brief-d64aj2/26-october-2026.md",
      "deliverAt": "2026-10-26T07:00:00",
      "deliveredAt": "2026-10-26T07:00:01",
      "late": false
    }
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Lowercase kebab-case slug (at most 48 characters) + `-` + 6 random characters. Unique. Also the name of the action's run folder. |
| `name` | string | Human label. |
| `agent` | string | Name of the creating `Agent`; the live Agent with this name runs the action. |
| `role` | string, optional | Short persona for the worker. |
| `instructions`, `task` | string | The worker's system prompt and its assignment for every run. Non-empty. |
| `tools` | string[] | Worker tool **names**, resolved against the live Agent's tool pool at run time. No tool code is stored. |
| `timeoutMs` | number, optional | Longest one run may take, in ms. Never above `dynamicSubagents.workerTimeoutMs`. |
| `schedule.timeToDeliver`, `schedule.meridiem` | string | The delivery time as given: `DD:HH:MM` (`DD` days from creation day, `HH:MM` on a 12-hour clock) and `"AM"` / `"PM"`. Kept for reference: the stored truth is `nextDeliverAt`. |
| `schedule.startCookingInAdvance` | string | Duration `DD:HH:MM` before delivery at which the run starts. |
| `schedule.repeatEvery` | string, optional | Duration `DD:HH:MM` between deliveries; absent = run once. Greater than zero and longer than the lead time. |
| `schedule.retries` | integer >= 0, optional | Extra attempts after a failed run, only while time remains before delivery. |
| `schedule.onMissed` | `"skip"` \| `"run"`, optional | What to do when the program was not running at delivery time. Absent: the action becomes `missed` and waits for `runScheduledAction` / `skipScheduledAction`. |
| `state` | see below | Where the action is in its life. |
| `nextCookAt`, `nextDeliverAt` | time or `null` | When the next run starts and is delivered. `null` for a one-shot that is running or finished. |
| `current` | object, only while `cooking` | `{ cookStartedAt, deliverAt }` of the run in flight. Required while `state` is `cooking`. |
| `createdAt` | time | When the action was created. |
| `lastRun` | object, optional | The last delivered run: `status` (`"ok"` \| `"failed"`), `file` (relative to `scheduled/`), `deliverAt`, `deliveredAt`, `late`. |

States: `waiting` (a future run is scheduled), `cooking` (a run is in flight), `missed` (a run's time passed and nobody ran it; use `run_now` or `skip`), `done` (a one-shot that finished).

## `<action id>/delivery.json`

Results of this action that are saved but whose delivery time has not come yet. An entry is removed when it is delivered, and the file is removed when no entry is left.

```json
{
  "version": 2,
  "pending": [
    {
      "id": "daily-ai-brief-d64aj2",
      "file": "daily-ai-brief-d64aj2/27-october-2026.md",
      "status": "ok",
      "readyAt": "2026-10-27T06:59:48",
      "deliverAt": "2026-10-27T07:00:00"
    }
  ]
}
```

`file` is relative to `scheduled/`. `status` is `"ok"` or `"failed"`. An entry may carry `"late": true` (optional, a boolean): the run replaced a missed occurrence, so it is late whatever the clock says.

## Run files

One Markdown file per run, `<action id>/<DD>-<month>-<YYYY>.md` named after the delivery date (`27-october-2026.md`; `-2`, `-3` on a same-day clash; a `run_now` uses the day it started). A run file is written once and never rewritten.

```text
---
id: daily-ai-brief-d64aj2
name: Daily AI Research Brief
status: ok
startedAt: 2026-10-27T06:59:30
finishedAt: 2026-10-27T06:59:48
deliverAt: 2026-10-27T07:00:00
late: false
model: google/gemini-3.5-flash-lite
turns: 2
tokens: 5120
inputTokens: 4800
freshInputTokens: 1200
cacheReadTokens: 3600
cacheWriteTokens: 0
outputTokens: 320
thinkingTokens: 90
cacheHitRate: 0.75
costUsd: 0.00184
costSource: catalog
---

The result text, exactly as the worker returned it.
```

The header sits between two `---` lines, one `key: value` per line, values on a single line. Keys appear in this order; the ones marked optional are left out when they do not apply.

| Key | Meaning |
|---|---|
| `id`, `name` | The action. |
| `status` | `ok` or `failed`. |
| `startedAt`, `finishedAt`, `deliverAt` | Times. `deliverAt` of a `run_now` is its finish time. |
| `late` | `true` when the run finished after its delivery second or replaced a missed occurrence. |
| `model` (optional) | `provider/model` of the worker; only for `ok` runs. |
| `turns`, `tokens`, `inputTokens`, `freshInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `thinkingTokens` (optional) | Exact spending, the numbers `usageReport()` keeps for workers: model calls made, tokens (`tokens` = input + output; `inputTokens` = fresh + cache read + cache write; thinking is part of output). Cover **every attempt** of the run; also written for failed runs that spent something. |
| `cacheHitRate` (optional) | `cacheReadTokens / inputTokens`, 0 to 1; left out when nothing was sent. |
| `costUsd` (optional) | Number of dollars, priced per turn, or `unknown` when no price is known. Never `0` for an unknown price. |
| `costSource` (optional) | `provider` (the provider's own cost), `catalog`, `mixed` or `unknown`. |
| `unpricedTurns` (optional) | Turns with no known price; present only when above 0, then `costUsd` is a lower bound. |
| `error` (optional) | Why a `failed` run failed. |

The body after the header is the worker's text, `[The worker returned no text.]`, or `The run failed: <reason>`.

## Reading the files

Plain JSON and a tiny header parser are enough; no SDK import is needed:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(".agent-accel", "scheduled");

type Task = { id: string; state: string; nextDeliverAt: string | null; lastRun?: { file: string; status: string; late: boolean } };
const tasks: Task[] = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith("."))
  .flatMap((e) => {
    try {
      return [(JSON.parse(readFileSync(join(dir, e.name, "task.json"), "utf8")) as { version: 2; task: Task }).task];
    } catch {
      return []; // a folder with only run files has no task.json
    }
  });
for (const t of tasks) console.log(t.id, t.state, t.nextDeliverAt);

// A run file: a header between two "---" lines, then the result.
function readRun(file: string): { header: Record<string, string>; body: string } {
  const text = readFileSync(join(dir, file), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file} is not a run file`);
  const header = Object.fromEntries(m[1]!.split("\n").map((l) => [l.slice(0, l.indexOf(": ")), l.slice(l.indexOf(": ") + 2)]));
  return { header, body: m[2]!.trimEnd() };
}

const last = tasks.find((t) => t.lastRun)?.lastRun;
if (last) console.log(readRun(last.file).header.costUsd);
```

Any process may read. Only one process at a time may **write** a home folder: an `Agent` that uses it takes `<home>/.lock`, and a second process fails at once with a `ConfigError`.

## Editing the files

Prefer the API (`createScheduledAction`, `updateScheduledAction`, `deleteScheduledAction`, or the `scheduled_actions` tool): it validates and keeps `nextCookAt` / `nextDeliverAt` consistent. Editing by hand is supported for text and tools:

- **Safe while the program is stopped:** `name`, `role`, `instructions`, `task`, `tools`, `timeoutMs`, `schedule.retries`, `schedule.onMissed`, and deleting a whole record (its run folder stays unless you remove it).
- **Picked up by a running program** at the next run: the SDK re-reads and validates the file before every run. An edit made at the very moment the SDK writes the same file can be lost, so keep hand edits to a stopped program or to small, quick changes.
- **Do not hand-edit** `state`, `current`, `nextCookAt`, `nextDeliverAt`, `lastRun` or `delivery.json`: the SDK keeps them consistent with each other and repairs them after a crash. To reschedule, use `updateScheduledAction`.
- A hand edit that breaks validation does not break anything: that record is skipped and reported (`scheduled_action.invalid`) until you fix it.

## Events

The events on `telemetryBus` (`code`, then `data`) are part of the same contract:

| Code | `data` |
|---|---|
| `scheduled_action.created` | `{ id, name, nextCookAt, nextDeliverAt }` |
| `scheduled_action.updated` | `{ id, name, nextCookAt, nextDeliverAt }` |
| `scheduled_action.started` | `{ id, name, cookStartedAt, deliverAt }` |
| `scheduled_action.ready` | `{ id, name, file, readyAt, deliverAt }` (`file` is an absolute path) |
| `scheduled_action.failed` | the `ready` fields plus `error` |
| `scheduled_action.delivered` | `{ id, name, status, file, readyAt, deliverAt, late }` |
| `scheduled_action.missed` | `{ id, name, reason, onMissed? }`; `reason` is `process_down`, `interrupted` or `no_agent` |
| `scheduled_action.skipped` | `{ id, name, reason }`; `reason` is `overlap` (also `deliverAt`) or `skip` (also `nextDeliverAt`) |
| `scheduled_action.deleted` | `{ id, name, forced, purged }` |
| `scheduled_action.invalid` | `{ id, problem, file }` |
| `scheduled_action.store_corrupt` | `{ file, restored }` |
| `scheduled_action.error` | `{ id? }` |

## Compatibility rules and changelog

- Both JSON files carry `"version": 2`.
- **Additive changes keep the version:** a new optional field in a record, a delivery entry or the run header, and a new key in an event's `data`. Readers must ignore what they do not know (the SDK does).
- **Breaking changes bump `version`:** removing or renaming a field, changing its type, unit or meaning, a new value in an enum a reader may switch on (`state`, `status`, `costSource`, `onMissed`, `reason`), a new time format, or a new file layout. A breaking change ships with a migration of existing files and is listed below and in the release notes.
- Until v1.0 a breaking change can still happen, but never silently: it follows these rules.

### Changelog

| SDK version | Change |
|---|---|
| unreleased | **Format version 2: one folder per action.** `tasks.json` and `deliveries.json` are gone; each action has `<home>/scheduled/<id>/task.json` (`{ "version": 2, "task": { ... } }`, the record fields are unchanged) and, while results wait for their delivery time, `<id>/delivery.json` (`{ "version": 2, "pending": [...] }`, the entry fields are unchanged). Run files keep their path. While a run is in flight its owner keeps `<id>/.heartbeat` fresh, which is how other processes tell a live run from a dead one. **Nothing is converted for you:** actions saved in an old `tasks.json` are not read; create them again. |
| unreleased | The folder is renamed from `<home>/scheduled_actions/` to `<home>/scheduled/`. **Nothing is moved for you:** an existing folder must be renamed once by hand (`mv .agent-accel/scheduled_actions .agent-accel/scheduled`), otherwise the new folder starts empty. The automatic rename of the pre-0.5.0 `scheduled_tasks/` folder is gone. File formats, the tool name `scheduled_actions` and the `scheduled_action.*` events are unchanged. |
| 0.5.5 | The format becomes a stable contract (this page). Added: `schedule.onMissed` (record), `late` (delivery entry, optional), the spending fields of the run header (`turns`, `inputTokens`, `freshInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `thinkingTokens`, `cacheHitRate`, `costSource`, `unpricedTurns`; `tokens` is now input + output over all attempts; `costUsd` is priced per turn). Changed: `late` is `true` for a run that replaces a missed occurrence, never for an ordinary `run_now`, and is compared in whole seconds. Event `scheduled_action.killed` became `scheduled_action.deleted`. The timeout options were reduced to `workerTimeoutMs` and the action's own `timeoutMs`. |
| 0.5.3 | Writes became durable (fsync, `.bak` copy, atomic rename); a damaged `tasks.json` / `deliveries.json` is restored from its `.bak`. One process per home folder. |
| 0.5.0 | The folder moved from `scheduled_tasks/` to `<home>/scheduled_actions/`, under the single home folder; an old `scheduled_tasks/` folder is renamed on first use. |

## For AI agents

- Read each `<id>/task.json` and the run files with plain JSON and the header parser above; never write `state`, `current`, `next*`, `lastRun` or `delivery.json`.
- To change an action, call `updateScheduledAction` (or the `scheduled_actions` tool, `update` command), not the file.
- A run's cost is in its header: `costUsd` is `unknown` (never 0) when no price is known; check `unpricedTurns` before treating it as exact.
