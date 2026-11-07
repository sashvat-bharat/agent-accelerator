# src/agent/

The agent and everything that runs under it.

| File | What it is | Used by |
| :-- | :-- | :-- |
| `agent.ts` | `Agent`: `run`/`stream`/`ask`, `steer`/`queue`/`interrupt`, persistence hooks, `resume()`/`interrupted()`, `usageReport()`, `fork()`, `toConfig()`/`fromConfig()`, the `workers` getter. | callers, workers, scheduler |
| `loop.ts` | `runAgentLoop` / `streamAgentLoop`: per turn budget, pairing repair, file access, provider call, tool execution, repeat guard. Also `ensureToolPairing`, `accumulateUsage`. | `Agent` |
| `context.ts` | `AgentContext`: the validated message list with checkpoint/rollback. | `Agent`, loops |
| `delegation.ts` | Fixed workers (`agentToTool`, `buildAgentTools`), the live worker trace store, session-id helpers, budget helpers, `openWorkerTrace`/`workerMetadata`. | `Agent`, `workers.ts` |
| `worker.ts` | Worker core: model/tool normalization, `buildDynamicWorkerConfig` (shared preset), `createLiveWorker`. | `Agent`, registry, scheduler |
| `workers.ts` | `WorkerRegistry` (`agent.workers`): persistent multi-turn workers. | `Agent`, `subagents` tool |
| `subagents-tool.ts` + `subagents.md` | The one model-facing `subagents` tool; the `.md` is its description. | `Agent` constructor |
| `subagent.ts` | `SubAgent` class and `agentFromEnv` (thin, kept for compatibility). | callers |
| `turns.ts` | Pure grouping of messages into finished turns (history cut for workers). | `workers.ts` |
| `config-blocks.ts` | RSI blocks: only `model`, `instructions`, `tools` are editable; `allowedModels` check. | `Agent` |

## Invariants
- `runAgentLoop` and `streamAgentLoop` duplicate their turn logic: every loop change goes into both.
- An `Agent` runs one thing at a time; delegation forks a copy per call so parallel calls never queue.
- A worker is a plain `Agent` with a parent link and presets. Never duplicate logic between Agent and worker.
- A worker is never less constrained than its parent (`inheritableConfig()`); its children draw only from the tools it was granted.
- Exactly-once worker calls rest on the call key (parent run mark id + tool call id) and `meta.last`.
- Only results branded by `makeSubagentResult` have their usage metadata trusted.
- Each Agent records only its own model turns; never sum `AgentResponse.usage` for totals.
