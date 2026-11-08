# src/scheduler/

Scheduled actions: a worker that runs later (once or repeating) and saves its answer to a file. Off unless `dynamicSubagents.allowScheduledActions` is set.

| File | What it is |
| :-- | :-- |
| `scheduler.ts` | One `Scheduler` per home folder: a 1 s unref'd clock that runs only while something is pending, startup sweep, cook/deliver state machine, and the public functions (`createScheduledAction`, `list/update/run/skip/deleteScheduledAction`). |
| `store.ts` | Disk layer under `<home>/scheduled/`: `<id>/task.json`, `<id>/delivery.json`, run files, one short mutex per action; validation of records. |
| `time.ts` | Pure `DD:HH:MM` and local-clock maths. No timezone, DST or `Intl`; `now` is always passed in. |
| `tool.ts` + `scheduled-actions.md` | The model-facing `scheduled_actions` tool and `get_datetime`; the `.md` is the tool description. |

## Invariants
- The files are the truth: every write re-reads first and goes through the durable writer. The file format is a stable public contract: see `docs/scheduled-action-files.md` and add a changelog row for any change.
- Write order when a run ends: run file, then `<id>/delivery.json`, then `<id>/task.json`. The startup sweep repairs a crash in between.
- `startCook` advances the next times BEFORE the run starts; a run still cooking when the next is due is skipped, never stacked.
- Runs are fresh stateless workers built by `buildDynamicWorkerConfig`; their spending guardrail is `workerBudget` only.
- The Agent registry holds `WeakRef`s by name: keep every Agent that owns actions referenced, or its runs become `missed`.
- Times come from `Date`, local clock only. Tests inject `scheduler.now` / `tickMs` and call `tick()`.
- Events: `scheduled_action.{created,updated,started,ready,failed,delivered,missed,skipped,deleted,invalid,store_corrupt,error}`.
