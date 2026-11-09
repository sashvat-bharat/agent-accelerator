# src/scheduler/

Scheduled actions: a worker that runs later (once or repeating) and saves its answer to a file. Off unless `dynamicSubagents.allowScheduledActions` is set.

| File | What it is |
| :-- | :-- |
| `scheduler.ts` | One `Scheduler` per home folder: a 1 s unref'd clock that runs only while something is pending, startup sweep, dead-owner recovery, heartbeats, cook/deliver state machine, and the public functions (`createScheduledAction`, `list/update/run/skip/deleteScheduledAction`). |
| `store.ts` | Disk layer under `<home>/scheduled/`: `<id>/task.json`, `<id>/delivery.json`, run files, one short mutex per action; validation of records. |
| `time.ts` | Pure `DD:HH:MM` and local-clock maths. No timezone, DST or `Intl`; `now` is always passed in. |
| `tool.ts` + `scheduled-actions.md` | The model-facing `scheduled_actions` tool and `get_datetime`; the `.md` is the tool description. |

## Invariants
- The files are the truth: every write re-reads first and goes through the durable writer. The file format is a stable public contract: see `docs/scheduled-action-files.md` and add a changelog row for any change.
- Write order when a run ends: run file, then `<id>/delivery.json`, then `<id>/task.json`. A crash in between is repaired by the dead-owner recovery (`recoverCooking`, at start and every 15 s): the delivery is rebuilt from the run file, or the run is marked `missed` when no run file exists.
- `startCook` advances the next times BEFORE the run starts; a run still cooking when the next is due is skipped, never stacked.
- Runs are fresh stateless workers built by `buildDynamicWorkerConfig`; their spending guardrail is `workerBudget` only.
- The Agent registry holds `WeakRef`s by name: keep every Agent that owns actions referenced, or its runs become `missed`.
- Several processes may share a home: scheduled actions take no home lock, only the short per-action mutex (`<id>/.mutex`); the one-process lock is on session folders only. Ownership: a process only starts, delivers or recovers actions whose Agent it registered. An action nobody here owns is left alone until its delivery time passed with no run started, then marked `missed` (`no_agent`).
- Exactly once: a scheduled start re-checks under the action's mutex that it is still `waiting` and due; `markMissed` only changes the state the caller saw; a delivery is emitted only by the process that removed its entry from `delivery.json`.
- A run in flight keeps `<id>/.heartbeat` (pid, host, token; mtime refreshed every 5 s, stale after 60 s), written before the record shows `cooking`. A cooking action whose owner is dead (pid gone, stale, or none) is recovered by a live process that owns its Agent, at start and every 15 s. `delete` of a run another live process is cooking is refused, even with `force`.
- Times come from `Date`, local clock only. Tests inject `scheduler.now` / `tickMs` and call `tick()`.
- Events: `scheduled_action.{created,updated,started,ready,failed,delivered,missed,skipped,deleted,invalid,store_corrupt,error}`.
