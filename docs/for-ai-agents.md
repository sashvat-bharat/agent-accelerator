# For AI agents
[Docs](README.md) › For AI agents

> A compact, rule-first page for coding agents that write code against `agent-accelerator`. Humans: the [guides](README.md#pages) explain the same things with more context.

## How to work

1. Import everything from `"agent-accelerator"`. Use `.ts` extensions only for relative imports inside the repo.
2. Read the **For AI agents** section at the bottom of each guide before writing code for that feature.
3. Run only what the task needs. Examples in `examples/` call real providers and cost money; the test suite is fully mocked.
4. Never print or hard-code API keys. Use `process.env` and placeholders.

## Decision table

| Task | Use | Guide |
|---|---|---|
| One answer | `await agent.run(prompt)` → `res.text` | [Agents](guides/agents-and-models.md) |
| Live output | `agent.stream(prompt)`, then `await stream.result()` | [Tools and streaming](guides/tools-and-streaming.md) |
| Call my code | `tool({ description, input: z.object(...), execute })` in `tools` | [Tools and streaming](guides/tools-and-streaming.md) |
| JSON result | `output: zodSchema`, read `res.parsed` | [Agents](guides/agents-and-models.md) |
| Specialist helpers | `subagents: [agentA, agentB]` | [Multi-agent](guides/multi-agent.md) |
| Model-invented helpers | `dynamicSubagents: { model, tools }` | [Multi-agent](guides/multi-agent.md) |
| Work later or on repeat | `dynamicSubagents.allowScheduledActions` + `agent.scheduled.create(...)` | [Multi-agent](guides/multi-agent.md) |
| Redirect a busy agent | `steer()`, `queue()`, `interrupt()`, `interrupt(message)` | [Tools and streaming](guides/tools-and-streaming.md) |
| Save / resume / survive a crash | `persist: { dir }` + same `sessionId` (cut-off runs resume by themselves), `loadSessionDir`, `importSession` | [Data and media](guides/data-and-media.md) |
| Images, PDFs | `ContentPart[]` prompt, `fileAccess.roots` | [Data and media](guides/data-and-media.md) |
| Change a prompt the SDK sends (tool refusal, worker header, tool manual) | `prompts: { name: "text with {{placeholders}}" }`; keep the original unless you must | [Prompts](guides/prompts.md) |
| Cost control | `budget`, `limits`, `res.usage` | [Safety](guides/safety-and-ops.md) |
| What it cost (per agent and worker, cache-aware) | `agent.usageReport()`; one run: `res.usage` | [Safety](guides/safety-and-ops.md) |
| Let an agent improve itself (model, instructions, tools only) | `agent.toConfig()`, `Agent.fromConfig(edited, base)`, `allowedModels` | [Agents](guides/agents-and-models.md#self-improving-agents) |
| Observe | `telemetryBus.onEvent` |
| Ask permission before a tool acts | check inside `execute`, refuse with `ctx.stop(reason)` (run ends `stopped`) | [Tools and streaming](guides/tools-and-streaming.md) | [Safety](guides/safety-and-ops.md) |

## Template: a safe production agent

```ts
import { Agent, tool } from "agent-accelerator";
import { z } from "zod";

const search_docs = tool({
  description: "Search internal docs. Read-only.",
  input: z.object({ query: z.string().describe("Search terms") }),
  idempotent: true,
  timeoutMs: 5_000,
  execute: async ({ query }) => ({ query, hits: [] as string[] }), // pass ctx.signal to real I/O
});

const agent = new Agent({
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  instructions: "You answer questions using the search_docs tool. Be concise.",
  tools: { search_docs },
  maxTurns: 8,
  limits: { deadlineMs: 120_000 },
  budget: { maxCostUsd: 0.25 },
  fileAccess: { roots: [process.cwd()] },
});

const res = await agent.run("How do I reset my password?", { signal: AbortSignal.timeout(130_000) });
console.log(res.text, res.usage.cost ?? "cost unknown");
```

## Hard rules

- **Stable prompts.** Never put timestamps or per-request data in `instructions` or change the tool set between calls; use `additionalContext`.
- **Explicit config wins** over env. A custom provider prefix needs its own `<PREFIX>_API_KEY` and `<PREFIX>_BASE_URL`; never reuse another vendor's key.
- **Bound everything unattended:** nothing is limited by default except three network timeouts, so set `maxTurns`, `limits.deadlineMs`, `budget`, a `signal`, and for workers `dynamicSubagents.workerBudget` / `maxSpawn` / `maxDepth` (all unlimited until set). `0` or `Infinity` turns a network timeout off.
- **Branch on error classes and `err.retryable`, never on message text.** Use `isAbortError(err)` for cancellation.
- **Unknown cost is `undefined`**, not zero.
- **Tool names** match `^[a-zA-Z0-9_-]{1,64}$`. Pass `ctx.signal` to I/O.
- **Workers are developer-configured.** The LLM never chooses a worker's model or reasoning level.
- **Keep a scheduled action's creating `Agent` referenced**; several processes may share a home, and the process that registered the Agent runs and delivers its actions.
- Never edit the model catalog cache; use `registerModel()`.
- **Everything the SDK stores lives in one folder** (`sessions/` with each session's own `telemetry.ndjson`, `scheduled/`, `telemetry/`, `catalog/`). Move it with `setHome(dir)` or `AGENT_ACCEL_HOME`; never write SDK state elsewhere.

## Things that do not exist (do not generate code for them)

| Do not use | Why / instead |
|---|---|
| `hooks`, `contextManagement`, `logger` config | Placeholders that only warn. Use `telemetryBus` |
| `needsApproval` | Removed. Ask inside `execute` and refuse with `ctx.stop(reason)` |
| Tool `retry` / `tags` / `output` | Stored but not enforced |
| `thinking.budgetTokens` | Not forwarded by any adapter |
| `stop`, `seed` | Removed in 0.6.0; do not pass them |
| `temperature` / `topP` / `sampling` | Removed on every provider; do not pass them |
| Gemini 1.x / 2.x | Rejected; minimum is Gemini 3 |
| `cache` TTLs (`5m`, `30m`, `1h`, `12h`) | Honoured only where the provider supports them (see README Cache table); others warn and fall back |
| Two processes opening the same persisted session | The session folder is locked: the second process gets a `ConfigError`. Use a different `sessionId` per process (they can share one `home`) |
| The `SubAgent` class | Deprecated; use `Agent` + `subagents` |
| OpenRouter Responses transport | Discontinued; OpenRouter uses Chat Completions |

## Error to fix

| Symptom | Likely cause and fix |
|---|---|
| `ConfigError` before any request | No key or base URL for that prefix. Set `<PREFIX>_API_KEY` and `<PREFIX>_BASE_URL` |
| `ThinkingLevelError` | Level unsupported by the model; use one from `err.allowedLevels` |
| `SubAgentModelError` | Set `dynamicSubagents.model` or `SUB_AGENT_MODEL` |
| `BudgetExceededError` | Raise `budget` or reduce work; `err.partial` has progress |
| `SecurityPolicyError` | Path outside `fileAccess.roots`, or a private/loopback URL |
| `SessionLoadError` | Session file over limits; split or raise `SessionLimits` |
| Tool result `repeat_blocked` | The model repeated an identical call 3 times; fix the tool output or mark it `repeatable` |
| `finishReason: "max_turns"` | Raise `maxTurns` or simplify the task |
| Scheduled action never fires | The creating `Agent` was garbage-collected, or the process exited |
| Repeated `provider_warning` | An option isn't supported by that provider; remove it |

## Where to look

[`llms.txt`](llms.txt) is a one-screen index. [Reference](reference.md) has every key and code. The authoritative source is `src/index.ts` (public exports) and `src/types/`.
