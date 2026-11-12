# src/agent/

The agent and everything that runs under it.

| File                | What it is                                                                                                                                                                                                                              | Used by                                |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------- |
| `agent.ts`          | `Agent`: `run`/`stream`/`ask`, `steer`/`queue`/`interrupt`, persistence hooks, `resume()`/`interrupted()`, `usageReport()`, `fork()`, `toConfig()`/`fromConfig()`, the `workers` getter.                                                | callers, workers, scheduler            |
| `run-control.ts`    | `RunControl`: the active run, the waiting queue and the machinery behind `steer`/`queue`/`interrupt` (`pumpQueue`, `finishCurrentRun`, urgent queueing). `Agent` keeps the public methods and calls it.                                 | `Agent`                                |
| `options.ts`        | `buildProviderOptions` (agent config + per-run options in one place), `resolveAgentLimits`, `normalizeThinking`, `resolveEffectiveThinking`, `normalizeToolChoiceOption`.                                                               | `Agent`, barrel                        |
| `named-sessions.ts` | `NamedSessions`: the in-memory contexts of `run(..., { sessionId })` (LRU 100, 1 h idle TTL).                                                                                                                                           | `Agent`                                |
| `loop.ts`           | `runAgentLoop` / `streamAgentLoop`: per turn budget, pairing repair, file access, provider call, tool execution, repeat guard. Also `ensureToolPairing`, `accumulateUsage`.                                                             | `Agent`                                |
| `context.ts`        | `AgentContext`: the validated message list with checkpoint/rollback.                                                                                                                                                                    | `Agent`, loops                         |
| `delegation.ts`     | Fixed workers (`agentToTool`, `buildAgentTools`), the live worker trace store, session-id helpers, budget helpers, `openWorkerTrace`/`workerMetadata`.                                                                                  | `Agent`, `workers.ts`                  |
| `worker.ts`         | Worker core: model/tool normalization, `buildDynamicWorkerConfig` (shared preset), `createLiveWorker`.                                                                                                                                  | `Agent`, registry, scheduler           |
| `workers.ts`        | `WorkerRegistry` (`agent.workers`): persistent multi-turn workers.                                                                                                                                                                      | `Agent`, `subagents` tool              |
| `subagents-tool.ts` | The one model-facing `subagents` tool; its description is the `subagentsTool` prompt (`../prompts/subagents-tool.md`).                                                                                                                  | `Agent` constructor                    |
| `subagent.ts`       | `SubAgent` class and `agentFromEnv` (thin, kept for compatibility).                                                                                                                                                                     | callers                                |
| `turns.ts`          | Pure grouping of messages into finished turns (history cut for workers).                                                                                                                                                                | `workers.ts`                           |
| `defaults.ts`       | `configure()` and the `AGENT_ACCEL_*` env vars: developer defaults for `usageLimit` and `dynamicSubagents.scheduledActionBudget`, per field (Agent config > `configure()` > env). SDK-built workers never take them (`isWorkerConfig`). | `Agent`, barrel                        |
| `usage-limit.ts`    | `UsageLimit`: the chat-wide cap (`AgentConfig.usageLimit`). The root agent owns it, registry and fixed workers share it (`agent.chat`); every model turn adds to it and is checked against it.                                          | `Agent`, `workers.ts`, `delegation.ts` |
| `config-blocks.ts`  | RSI blocks: only `model`, `instructions`, `tools` are editable; `allowedModels` check.                                                                                                                                                  | `Agent`                                |

## Invariants

- `runAgentLoop` and `streamAgentLoop` still duplicate the shape of a turn, but the repeated parts live once in helpers at the top of `loop.ts` (`buildTurnOptions`, `promoteThinkingIfAllowed`, `recordModelTurn`, `emitThinkingTrace`, `rollUpToolResults`, `partialProgress`, `newTurnUsage`): change those there, and any change to the turn order itself goes into both loops.
- An `Agent` runs one thing at a time; delegation forks a copy per call so parallel calls never queue.
- A worker is a plain `Agent` with a parent link and presets. Never duplicate logic between Agent and worker.
- A worker is never less constrained than its parent (`inheritableConfig()`); its children draw only from the tools it was granted.
- Exactly-once worker calls rest on the call key (parent run mark id + tool call id) and `meta.last`.
- Only results branded by `makeSubagentResult` have their usage metadata trusted.
- A chat-wide cap (`usageLimit`) counts every model turn of the root and of all workers through one shared `UsageLimit`; its starting point is read once per process from the saved sessions. Scheduled workers never get it.
- Each Agent records only its own model turns; never sum `AgentResponse.usage` for totals.
- `reset()` clears the conversation (messages, run marks, the run's saved tool results) but never the spending totals.
