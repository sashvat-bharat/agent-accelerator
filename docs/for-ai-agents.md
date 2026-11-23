# For AI agents

> A compact, rule-first page for coding agents that write code with `agent-accelerator`. People can read the [guides](README.md#i-want-to), which explain the same things in more detail.

## How to work

1. Import everything from `"agent-accelerator"`. Use `.ts` extensions only for relative imports inside a repo.
2. Read the guide for a feature before you write code for it. The notes by feature at the bottom of this page list exact signatures and traps.
3. Run only what the task needs. The programs in `examples/` call real providers and cost money. The test suite is fully mocked.
4. Never print or hard-code API keys. Use `process.env` and placeholders.

## Decision table

| Task | Use | Guide |
|---|---|---|
| One answer | `await agent.run(prompt)`, then `res.text` | [Agents](guides/agents.md) |
| Live output | `agent.stream(prompt)`, then `await stream.result()` | [Streaming and steering](guides/streaming-and-steering.md) |
| Call my code | `tool({ description, input: z.object(...), execute })` in `tools` | [Tools](guides/tools.md) |
| JSON result | `output: zodSchema`, then read `res.parsed` | [Agents](guides/agents.md) |
| Specialist helpers | `subagents: [agentA, agentB]` | [Workers](guides/workers.md) |
| Helpers the model starts | `dynamicSubagents: { model, tools }` | [Workers](guides/workers.md) |
| Work later or on repeat | `dynamicSubagents.allowScheduledActions` and `agent.scheduled.create(...)` | [Scheduled actions](guides/scheduled-actions.md) |
| Redirect a busy agent | `steer()`, `queue()`, `interrupt()`, `interrupt(message)` | [Streaming and steering](guides/streaming-and-steering.md) |
| Do not run a repeated message twice | `{ requestId }` on `run`, `queue`, `steer` or `ask` | [Streaming and steering](guides/streaming-and-steering.md#run-a-prompt-only-once) |
| Save, resume, survive a crash | `persist: { dir }` and the same `sessionId`. Also `loadSessionDir` and `importSession`. | [Sessions](guides/sessions.md) |
| Images, audio, video, PDFs | A `ContentPart[]` prompt, and `fileAccess.roots` | [Media input](guides/media-input.md) |
| Change a prompt the SDK sends | `prompts: { name: "text with {{placeholders}}" }`. Keep the original unless you must. | [Prompts](guides/prompts.md) |
| Cost control | `budget`, `limits`, `usageLimit`, `res.usage` | [Limits and retries](guides/limits-and-retries.md) |
| Limit provider calls at once | The `concurrency` setting and `getConcurrencyStatus()` | [Limits and retries](guides/limits-and-retries.md#limit-calls-that-run-at-once) |
| Set options in code, choose what a user may change | `setConfigs({ values, editable })`, `getConfigs()`, `setConfig(key, value)` | [Settings](guides/settings.md) |
| Fix the models a program may use | `setModels(list)`, `listModels()`, `setModel(id)`, `setSubAgentModel(id)` | [Allowed models](guides/allowed-models.md) |
| What it cost | `agent.usageReport()`. For one run, `res.usage`. | [Usage and cost](guides/usage-and-cost.md) |
| Let a program edit an agent | `agent.toConfig()` and `Agent.fromConfig(edited, base)` | [Agents](guides/agents.md#let-a-program-edit-an-agent) |
| Approve or change a tool call | The `beforeTool` hook, or `ctx.stop(reason)` inside `execute` | [Tools](guides/tools.md#ask-for-permission) |
| Watch what the SDK does | `telemetryBus.onEvent` | [Errors and telemetry](guides/errors-and-telemetry.md) |
| Test an agent offline | `fauxProvider(steps)` | [Testing](guides/testing.md) |

## Template: a safe production agent

```ts
import { Agent, tool } from "agent-accelerator";
import { z } from "zod";

const search_docs = tool({
  description: "Search internal docs. Read-only.",
  input: z.object({ query: z.string().describe("Search terms") }),
  idempotent: true,
  timeoutMs: 5_000,
  // Pass ctx.signal to real I/O.
  execute: async ({ query }) => ({ query, hits: [] as string[] }),
});

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  instructions: "You answer questions using the search_docs tool. Be concise.",
  tools: { search_docs },
  maxTurns: 8,
  limits: { deadlineMs: 120_000 },
  budget: { maxCostUsd: 0.25 },
  fileAccess: { roots: [process.cwd()] },
});

const res = await agent.run("How do I reset my password?", {
  signal: AbortSignal.timeout(130_000),
});
console.log(res.text, res.usage.cost ?? "cost unknown");
```

## Hard rules

- **Stable prompts.** Never put timestamps or per-request data in `instructions`, and never change the tool set between calls. Use `additionalContext`.
- **Explicit config wins** over the environment. A custom provider prefix needs its own `<PREFIX>_API_KEY` and its address in the `base_urls.<prefix>` setting. Never reuse another vendor's key.
- **Bound everything that runs unattended.** Nothing is limited by default except three network timeouts. Set `maxTurns`, `limits.deadlineMs`, `budget` and a `signal`. For workers, set `usageLimit`, `dynamicSubagents.workerBudget`, `scheduledActionBudget`, `maxSpawn` and `maxDepth`. `0` or `Infinity` turns a network timeout off.
- **Branch on error classes and `err.retryable`, never on message text.** Use `isAbortError(err)` for cancellation.
- **Unknown cost is `undefined`**, not zero.
- **Tool names** match `^[a-zA-Z0-9_-]{1,64}$`. Pass `ctx.signal` to I/O.
- **Workers are set by the developer.** The model never chooses a worker's model or reasoning level.
- **Keep a scheduled action's creating `Agent` referenced.** Several processes may share a home. The process that registered the agent runs and delivers its actions.
- **Never edit the model catalog cache** (`<home>/catalog/<provider>/models.json`). Use `registerModel()`. The catalog keeps only gemini-3+, gpt-5+, claude-5+ and text-output OpenRouter models. Anything else is unknown: no price and permissive thinking.
- **Everything the SDK stores lives in one folder.** Move it with `setHome(dir)` or an agent's `home`. Never write SDK state anywhere else.

## Things that do not exist

Do not generate code for these.

| Do not use | Why, and what to use instead |
|---|---|
| `needsApproval` | Removed. Ask inside `execute` and refuse with `ctx.stop(reason)`, or use the `beforeTool` hook. |
| A `hooks` name other than `beforeTool`, `afterTool`, `beforeRequest`, `onYield` | It throws `ConfigError`. |
| Tool `retry`, `tags`, `output` | Removed. They did nothing. |
| `thinking.budgetTokens` | Not forwarded to any provider. |
| `stop`, `seed` | Removed. Do not pass them. |
| `temperature`, `topP`, `sampling` | Removed on every provider. |
| Gemini 1.x or 2.x | Rejected. The minimum is Gemini 3. |
| `cache` values a provider lacks | They warn and fall back. See [Reasoning and caching](guides/reasoning-and-caching.md). |
| Two processes on one saved session | The folder is locked. The second process gets a `ConfigError`. Use a different `sessionId` per process. They can share a `home`. |
| The `SubAgent` class, `agentFromEnv()`, `Agent.fromEnv()`, `.asTool()`, `.toTool()` | Removed. Use `new Agent({ name, model, instructions })` in `subagents: [...]`, or `agentToTool({ name, agent })`. To use the saved or default model, leave out `model`. See [Migration](migration.md). |
| The OpenRouter Responses transport | Gone. OpenRouter uses Chat Completions. |

## Error to fix

| Symptom | Likely cause and fix |
|---|---|
| `ConfigError` before any request | No key or address for that prefix. Set `<PREFIX>_API_KEY` and the `base_urls.<prefix>` setting. |
| `SettingNotEditableError` | `setConfig` on a hidden setting. Only keys in `getConfigs()` can be changed. |
| `ModelNotAllowedError` | The model is not in your `setModels` list. Pick one from `err.allowed`. |
| `ThinkingLevelError` | The model does not support that level. Use one from `err.allowedLevels`. |
| `SubAgentModelError` | Set `dynamicSubagents.model`, or a default worker model with `setModels` or `setSubAgentModel`. |
| `BudgetExceededError` | Raise `budget`, or reduce the work. `err.partial` has the progress. |
| `SecurityPolicyError` | A path outside `fileAccess.roots`, or a private or loopback URL. |
| `SessionLoadError` | A session file is over the limits. Split it, or raise `SessionLimits`. |
| A tool result `repeat_blocked` | The model repeated an identical call 3 times. Fix the tool's output, or mark it `repeatable`. |
| `finishReason: "max_turns"` | Raise `maxTurns`, or simplify the task. |
| A scheduled action never fires | Its creating `Agent` was garbage-collected, or the process exited. |
| Repeated `provider_warning` | An option is not supported by that provider. Remove it. |

## Notes by feature

**Agents and models**
- Create: `new Agent(config: AgentConfig)`. Run: `await agent.run(prompt: string | ContentPart[], options?: AgentRunOptions): Promise<AgentResponse>`.
- Precedence: explicit config beats the environment. `thinking` beats `thinkingLevel`. A per-run option beats the agent's default, and objects merge key by key.
- `maxTurns: 0` means unlimited. An unknown or unsupported option is warned about and dropped. It is not an error.
- To see where a model string goes: `resolveModel(modelString)` returns `{ provider, modelId, modelSpec }`.
- Errors you can branch on: `ThinkingLevelError`, `ValidationError`, `ConfigError`, `ProviderError`. See the [Reference](reference.md#errors).

**Tools and streaming**
- Define a tool with `tool({ description, input: z.object({...}), execute })`. Register it with `tools: { name: def }`. The record key is the name.
- Defaults: 1 attempt (3 if `idempotent`), a 20,000 character result cap, 8 tools at once, and the third identical consecutive call is blocked.
- `ctx.stop(reason)` throws and never returns. It saves `reason` as the call's result, lets the rest of the batch finish, and ends the run with `finishReason: "stopped"` and no more model turns.
- `agent.stream()` returns an `AssistantMessageEventStream`. Always `await stream.result()` for the final `AgentResponse`.
- `steer`, `queue` and `interrupt` only make sense while `agent.isBusy`.

**Workers and scheduling**
- Fixed: `new Agent({ subagents: [a, b] })`. Dynamic: `dynamicSubagents: { model, tools, maxSpawn }`, and the model gets the `subagents` tool. Scheduling: `dynamicSubagents.allowScheduledActions: true` and a worker model, or you get `SubAgentModelError`.
- `agent.scheduled.create(input)` throws one `ValidationError` that lists every problem. `scheduled_action.id` must be lowercase kebab-case, at most 48 characters. `timeToDeliver` has `HH` from 01 to 12.
- Workers that keep a conversation: `agent.workers.spawn`, `message`, `close` and `list`. Pass `callId` for exactly-once after a crash. They need a worker model, and `persist: { dir }` on the parent to survive a restart.
- Track workers with `track`, `listTrackedSubAgents` and `subscribeToSubAgent`. Do not poll files.
- Scheduled action files: read each `<id>/task.json` and the run files as plain JSON. Never write `state`, `current`, `next*`, `lastRun` or `delivery.json`. To change an action, call `agent.scheduled.update`, not the file. A run's cost is in its header. `costUsd` is `unknown` (never 0) when no price is known, so check `unpricedTurns` before you treat it as exact.

**Sessions, media and cost**
- Crash recovery: `persist: { dir }` and the same `sessionId`. Use `resume: "automatic"` or `"explicit"`, `agent.interrupted()` and `agent.resume()`. To continue a finished chat by hand: `findLatestSessionDir`, then `loadSessionDir`, then `agent.importSession(saved.session)`.
- A prompt is `string | ContentPart[]`. Part keys are `image`, `audio`, `video` and `file`, plus `filename` and `mimeType`.
- Cost may be `undefined`. Handle it. Use `SessionTelemetry` for running totals.
- Older models (gemini-2, gpt-4, claude-4 and so on) are not in the catalog.

**Safety**
- For anything unattended, set `maxTurns`, `limits.deadlineMs` and `budget`, and pass a `signal` per call.
- `err.partial` holds progress. `err.retryable` tells you whether to retry.
- Keep `captureRaw` at `"redacted"` unless you are debugging locally.
- Use `fileAccess: { roots: [...] }` whenever file paths or sessions come from outside your program.

**Generators**
- Images: import `generateImage`. The model is a `provider/model` string from `listImageModels()`. Do not invent model ids. Never combine `size` with `aspectRatio` or `resolution`. Read `getImageModel(model)` for what a model accepts.
- `result.image` is never undefined. Save it with `await result.image.save(path)`. To change a picture, call `image.edit(prompt)`.
- To let a text agent make pictures, use `imageTool({ model, allow, maxImages })` in `tools`. Set `allow` only for options the model has.
- A runnable offline demo for each generator is in `examples/` (17 to 20).

**Prompts**
- `prompts` is `Partial<Record<PromptName, string>>`. `DEFAULT_PROMPTS` is a frozen `Record<PromptName, string>`. `PromptName` and `PromptOverrides` are exported types.
- An agent cannot edit prompts through `toConfig` or `fromConfig`. Only `model`, `instructions` and `tools` are editable.
- Machine-readable parts stay out of the prompt text: `repeat_blocked` is also an `errorCode`, and the `[worker <id>]` header is only text for the model.
- Do not rely on a prompt change for safety. It is advice to the model, not enforcement.

## Where to look

[`llms.txt`](llms.txt) is a one-screen index. The [Reference](reference.md) has every key and code. The authoritative source is `src/index.ts` (the public exports) and `src/types/`.
