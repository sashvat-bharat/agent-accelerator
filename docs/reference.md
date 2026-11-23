# Reference

> Every config key, run option, response field, stream event, telemetry code, error class and environment variable. The guides explain; this page lists.

On this page: [AgentConfig](#agentconfig) · [Run options](#run-options) · [Response](#response) · [Stream events](#stream-events) · [Tool definition](#tool-definition) · [Telemetry codes](#telemetry-codes) · [Errors](#errors) · [Environment variables](#environment-variables)

The exported type declarations in `src/types/` are the source of truth.

## AgentConfig

| Key | Meaning | Guide |
|---|---|---|
| `name`, `description` | Identity. A parent sees `description` when this agent is a worker. | [Workers](guides/workers.md) |
| `instructions` | The system prompt. Keep it stable. | [Agents](guides/agents.md) |
| `model` | A model string, a `ModelSpec` or a `ModelProvider.*` value. Without it, the saved choice or the list default. | [Models and providers](guides/models-and-providers.md) |
| `subagentModel` | Older name of `dynamicSubagents.model`. | [Migration](migration.md) |
| `apiKey`, `baseUrl`, `headers` | Connection overrides for this agent. | [Models and providers](guides/models-and-providers.md) |
| `tools` | A record `{ name: tool }`, or an array of tools. | [Tools](guides/tools.md) |
| `subagents` | Fixed workers: `Agent`s, or `{ name, description, agent }`. | [Workers](guides/workers.md) |
| `dynamicSubagents` | Workers the model starts, persistent workers, scheduled actions. Keys below. | [Workers](guides/workers.md) |
| `thinking` | The reasoning level, or `{ level, budgetTokens }`. `thinkingLevel` is the older name. | [Reasoning and caching](guides/reasoning-and-caching.md) |
| `cache` | `"implicit"`, `"5m"`, `"30m"`, `"1h"` or `"12h"`, where the provider supports it. | [Reasoning and caching](guides/reasoning-and-caching.md) |
| `serviceTier` | `"flex"` or `"priority"`. | [Reasoning and caching](guides/reasoning-and-caching.md) |
| `googleTier` | How long Google keeps a conversation: `"free"` (23 h, default) or `"paid"` (54 days). | [Models and providers](guides/models-and-providers.md) |
| `sessionId` | The session key. Must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` when saved to a folder. | [Sessions](guides/sessions.md) |
| `maxTurns` | Model calls per run. `0` or omitted means unlimited. | [Limits and retries](guides/limits-and-retries.md) |
| `stateless` | Clear the conversation around every run. | [Agents](guides/agents.md) |
| `midSession` | What to do with a message while busy. Keys below. | [Streaming and steering](guides/streaming-and-steering.md) |
| `persist` | Where to save sessions. `{ dir?, file?, onPersistError?, allowStateless? }`. | [Sessions](guides/sessions.md) |
| `resume` | `"automatic"` (default) or `"explicit"`: whether a run that a crash cut off continues when the agent is created. | [Sessions](guides/sessions.md) |
| `home` | The folder for everything the SDK stores. Code only. | [Sessions](guides/sessions.md) |
| `toolChoice` | `"auto"`, `"none"`, `"required"`, `"validated"` or `{ tool }`. | [Tools](guides/tools.md) |
| `maxOutputTokens` | A cap on the output of one model call. | [Models and providers](guides/models-and-providers.md) |
| `output` | A schema for structured output: Zod, JSON Schema or `{ name, schema, ... }`. | [Agents](guides/agents.md) |
| `retry` | How one provider call is retried. | [Limits and retries](guides/limits-and-retries.md) |
| `runRetries` | How often a whole run that failed for a transient reason is tried again. Default 3, `0` is off. | [Limits and retries](guides/limits-and-retries.md) |
| `onFailure` | `"auto"`, `"rollback"` or `"keep"`. | [Limits and retries](guides/limits-and-retries.md) |
| `fetch`, `env` | A custom `fetch`, and per-agent environment overrides for keys. | [Models and providers](guides/models-and-providers.md) |
| `fileAccess` | `{ roots }`. Where local files may be read. | [Security](guides/security.md) |
| `captureRaw` | `"redacted"` (default), `true` or `false`. What `res.raw` keeps. | [Security](guides/security.md) |
| `budget`, `limits`, `usageLimit` | Caps. Keys below. | [Limits and retries](guides/limits-and-retries.md) |
| `prompts` | Replace single SDK prompts. An unknown name or empty text throws `ConfigError`. Workers inherit it. | [Prompts](guides/prompts.md) |
| `telemetry` | `{ persist: true }` appends telemetry events to files. Off by default. | [Errors and telemetry](guides/errors-and-telemetry.md) |
| `hooks` | `{ beforeTool, afterTool, beforeRequest, onYield }`. Workers inherit them. | [Tools](guides/tools.md#hooks) |

Precedence: explicit config beats the environment. A per-run option beats the agent's default, and objects are merged key by key.

### `dynamicSubagents`

| Key | Meaning |
|---|---|
| `enabled` | Default `true` when the object is present. |
| `allowScheduledActions` | Default `false`. Turns on scheduled actions. |
| `model` | The worker model. |
| `maxSpawn` | Workers open at once. No limit by default. A number of 1 or more is a cap. |
| `maxDepth` | Levels of workers below the agent. No limit by default. A whole number of 1 or more is a cap. |
| `workerBudget` | `{ maxCostUsd?, maxTotalTokens? }`. The cap of each chat worker's run. None by default. |
| `scheduledActionBudget` | The same shape. The cap of each scheduled run. None by default. |
| `thinkingLevel` | The workers' reasoning level. |
| `tools` | The pool of tools workers may be granted. |
| `workerTimeoutMs` | Scheduled actions only: the longest a run may take. No limit by default. `0` and `Infinity` mean none. |

`timeout` and `modelMaySetTimeout` were removed and throw `ConfigError`.

### `midSession`

| Key | Meaning |
|---|---|
| `whenBusy` | `"steer"`, `"queue"` or `"auto"` (default). `mode` is the older name. |
| `maxQueued` | Waiting follow-ups. Default 20. |
| `maxSteers` | Waiting steers. Default 20. |

### Limits and caps

| Key | Meaning |
|---|---|
| `budget` | Per run, workers included: `maxCostUsd`, `maxTotalTokens`, `maxDurationMs`, `maxTotalSubagents`. |
| `limits` | `maxTurns`, `deadlineMs`, `maxTotalTokens`, `maxToolCallsPerRun`, `requestTimeoutMs` (300 s), `firstByteTimeoutMs` (120 s), `streamIdleTimeoutMs` (300 s). |
| `usageLimit` | The whole chat for its whole life, workers included: `maxCostUsd`, `maxTotalTokens`. Throws `BudgetExceededError` ("Usage limit reached"). |

Everything is unlimited until you set it, except the three network timeouts. `0` or `Infinity` turns a timeout off. See [Limits and retries](guides/limits-and-retries.md).

## Run options

Used by `agent.run(prompt, options)`, `agent.stream(prompt, options)` and `agent.ask(prompt, stream?)`.

| Option | Meaning |
|---|---|
| `thinking` | The reasoning level for this run. |
| `stream` | Make `run` return a stream that you can also await. |
| `signal` | Cancels the provider call, tools and workers. |
| `sessionId` | Which in-memory session to use. |
| `additionalContext` | Context added to this user turn. It is not added to `instructions`. |
| `requestId` | Makes the call safe to repeat. See [Streaming and steering](guides/streaming-and-steering.md#run-a-prompt-only-once). |
| `enqueue` | `"steer"`, `"queue"` or `"interrupt"` while the agent is busy. |
| `headers` | Extra request headers. |
| `onDelta`, `onThinkingDelta`, `onEvent`, `onTurn` | Callbacks. |
| `toolChoice`, `maxOutputTokens`, `retry`, `fetch`, `env` | The same as in the config. |
| `thinkingAsAnswerFallback` | `true` makes reasoning-only output the answer when a model sends no answer text. Default `false`. |

## Response

An `AgentResponse` has: `text`, `parsed` (structured output), `thinking`, `thoughtSignature`, `toolCalls`, `toolResults`, `subagents`, `usage`, `responseId`, `model`, `provider`, `finishReason`, `rawFinishReason`, `durationMs`, `raw` (according to `captureRaw`) and `turns`. A failed run attaches the same shape as `err.partial`.

`finishReason` is one of `stop`, `tool_calls`, `length`, `content_filter`, `refusal`, `max_turns`, `stopped` (a tool called `ctx.stop`) or `error`. A finish reason the SDK does not know becomes `error`, and the original stays in `rawFinishReason`.

The fields of `usage` and the report from `agent.usageReport()` are in [Usage and cost](guides/usage-and-cost.md).

## Stream events

Every event has a `type` and a `schemaVersion`.

| `type` | When | Fields used |
|---|---|---|
| `start` | The request begins. | `raw` |
| `text_start`, `text_delta`, `text_end` | Answer text. | `delta`, `partialText` |
| `thinking_start`, `thinking_delta`, `thinking_end` | Reasoning. | `thinkingDelta`, `partialThinking` |
| `tool_call_start`, `tool_call_delta`, `tool_call_complete` | The model builds a tool call. | `toolCall` |
| `tool_start`, `tool_result`, `tool_end` | Your tool runs. | `toolCall`, `toolResult`, `toolCalls`, `toolResults` |
| `subagent_delta`, `subagent_complete` | A worker streams or finishes. | `subagent`, `subagentTrackingId` |
| `steer_injected` | A `steer()` was applied. | `injectedPrompt` |
| `queued` | A follow-up was queued. | `queuedPrompt`, `queueLength` |
| `usage` | Token counts. | `usage` |
| `done` | The end. | `finishReason`, `rawFinishReason`, `responseId`, `usage` |
| `error` | The run failed. | `error`, `partialText` |

## Tool definition

`tool({...})` takes these keys: `name`, `description`, `input`, `parameters`, `strict`, `timeoutMs`, `maxTries`, `maxAttempts`, `maxConcurrency`, `idempotent`, `repeatable`, `replay`, `maxResultChars`, `redactError`, `redact` and `execute`. `__brand` is internal. Never set it.

Every option does something. The executor enforces `input` or `parameters` (`parameters` wins if both are set), `timeoutMs`, `maxTries` or `maxAttempts`, `maxConcurrency`, `idempotent`, `repeatable`, `replay` (read by crash recovery), `maxResultChars` and `redactError` or `redact`. `strict` goes to the provider.

`execute(args, ctx)` gets a context with:

| Field | Meaning |
|---|---|
| `toolCallId`, `agentName`, `sessionId` | Identity of the call. |
| `signal` | Aborts when the run is cancelled. Pass it to I/O. |
| `emit` | Sends progress events. |
| `onSubagentEvent` | Receives events from workers. |
| `stop(reason)` | Ends the run after this batch with `finishReason: "stopped"`. The reason is the call's result. It throws and is never retried. |
| `log(message, data?)` | Writes to the call's log file `tool-logs/<n>-<tool>.ndjson` when the agent saves to a folder. Otherwise it does nothing. |

A result carries `logFile`. Defaults: 1 attempt (3 when `idempotent`), 20,000 result characters, 8 tools at once, and the third identical call in a row is answered with `repeat_blocked`.

## Telemetry codes

Subscribe with `telemetryBus.onEvent((e) => e.code)`. Each event has `level`, `code`, `message` and `data`.

### Configuration and providers

| Code | Meaning |
|---|---|
| `config.thinking_budget_ignored` | `thinking.budgetTokens` is not forwarded. |
| `config.not_editable` | `Agent.fromConfig` got keys other than `model`, `instructions` and `tools`. They were ignored (`data.fields`). |
| `config.file_invalid`, `config.file_restored`, `config.file_ignored_key`, `config.saved_model_ignored` | Problems with `<home>/configs.json`: invalid or another version (`data.reason`), restored from its backup, an entry that is unknown, invalid or hidden (`data.key`, `data.reason`), or a saved model that left your list. |
| `provider_warning` | A provider option was dropped, for example `thinking: "none"` on Google. |
| `cache_clamp` | A provider's cached-token count was larger than its input count and was reduced to it. |
| `interaction_chain_evicted`, `interaction_chain_ttl_expired`, `interaction_history_shrink` | Google chaining: the server chain was dropped or expired, or the input tokens fell. |
| `stream_buffer_overflow`, `stream_event_oversize` | A stream buffer limit was hit. |
| `catalog_cache_write_failed` | The model catalog could not be saved. |
| `embedding_models_refresh_failed`, `embedding_models_cache_write_failed` | OpenRouter's embedding model list could not be refreshed (the saved copy is used) or saved (it stays in memory). |
| `decision_models_refresh_failed`, `decision_models_cache_write_failed` | The same, for decision models. |

### Runs

| Code | Meaning |
|---|---|
| `agent.max_turns_truncated` | A run stopped at `maxTurns` with tool work pending. |
| `turn.thinking` | The full reasoning text of a turn. Bus only. |
| `agent.run_retry` | A failed run is being tried again (`attempt`, `of`, `delayMs`). |
| `agent.resumed`, `agent.resume_failed` | A cut-off run was resumed, or resuming it (or a waiting prompt) failed. |
| `agent.duplicate_request` | A `requestId` that was already submitted came again. |
| `agent.request_id_reused` | The same `requestId` came with a different prompt. |
| `agent.yield_continued` | An `onYield` hook continued the run. |
| `hook.error` | An `afterTool` hook threw. The original result was kept. |
| `worker.invalid` | A saved `worker.json` is damaged. That worker is skipped. |
| `session.local_media_paths` | An imported session points at local files and `fileAccess.roots` is not set. |
| `session.media_write_failed` | `saveSessionDir` could not write a media file. The media stays inside the session file. |
| `session.journal_corrupt` | `journal.ndjson` is damaged before its last line. Replay stopped there and kept what came before. |

### Tools

`tool.call_started`, `tool.attempt_started`, `tool.progress`, `tool.attempt_failed`, `tool.retry_scheduled`, `tool.call_succeeded`, `tool.call_failed`, `tool.call_timed_out`, `tool.call_aborted`, `tool.call_stopped` (a tool called `ctx.stop`), `tool.call_blocked` (a hook blocked it) and `tool.call_interrupted` (crash recovery did not run it again).

Each has `toolCallId`, `toolName`, `agentName` and `sessionId`. Failures add the full error. A `call_started` with no ending event was running when the process died. Attach a sink to keep them.

### Concurrency and scheduled actions

| Code | Meaning |
|---|---|
| `concurrency.queued` | A provider call waited for a free slot (`provider`, `waiting`, `active`, `paused`). Only with the `concurrency` setting. |
| `concurrency.paused` | A provider answered 429 with a `Retry-After`. No new calls to it for `ms`. |
| `scheduled_action.created`, `scheduled_action.updated`, `scheduled_action.started`, `scheduled_action.ready`, `scheduled_action.failed`, `scheduled_action.delivered`, `scheduled_action.missed`, `scheduled_action.skipped`, `scheduled_action.deleted`, `scheduled_action.invalid`, `scheduled_action.store_corrupt`, `scheduled_action.error` | The life of a scheduled action. Payloads are in [Scheduled action files](scheduled-action-files.md#events). |

## Errors

All extend `AgentAccelError`, which has `code`, `retryable` and `context`.

| Class | Raised when |
|---|---|
| `ConfigError` | A missing key or address, no model or a bad model string, a removed provider, Gemini 1.x or 2.x, invalid config, or a `steer`, `queue` or `enqueue` call that `midSession` forbids (before any network call). |
| `ProviderError` | The API failed, or it answered HTTP 200 with something that is not a reply (an empty object, a list, no `choices`). That is treated like a 502 and is retryable. A reply over the size cap (64 MB for chat) is not retryable. `code` is `"provider"` (`"incomplete_stream"` for a cut stream). `retryable` says whether a retry can help. Also `statusCode`, `provider`, `model`, `providerCode` (the provider's own code) and `retryAfterMs`, which are not enumerable. |
| `TimeoutError` | A request, first-byte or idle timeout. Retryable. |
| `BudgetExceededError` | `budget`, or `limits.maxTotalTokens`, `deadlineMs` or `maxToolCallsPerRun`, was exceeded. Partial usage is attached. |
| `ToolError` | A tool failed in a way that reaches the caller. |
| `ValidationError` | Structured output or scheduled-action input did not validate. An input the model cannot take, before any network call. An empty prompt. A call made the wrong way: a streaming option on `steer`, `queue` or `interrupt(message)`, `resume()` while busy, or a full queue. A bad session id, `registerModel` spec or media input. |
| `SettingNotEditableError` | `setConfig` on a hidden setting. A `ConfigError`, never retried. `key` names it. |
| `ModelNotAllowedError` | A model outside your `setModels` list. A `ConfigError`, never retried. `model` and `allowed` say what was asked and what is available. |
| `ThinkingLevelError` | A level the model does not support. A `ConfigError`. `allowedLevels` lists the valid ones. |
| `SubAgentModelError` | Workers or scheduling without a worker model. |
| `SessionLoadError` | A valid session file is over the load limits. It is never quarantined. |
| `SecurityPolicyError`, `RemoteFetchError` | A file root or private-address policy refused a path or URL. |

`isAbortError(err)` is true only when `name === "AbortError"`. It never reads message text, and a signal's `aborted` flag alone is not checked.

## Environment variables

The environment holds API keys and nothing else. Every other option is a setting in code: see [Settings](guides/settings.md). The older variables are listed in [Migration](migration.md#environment-variables).

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_API_KEY` | The Google key. Checked in this order. |
| `OPENAI_API_KEY`, `OPENAI_BASE_API_KEY` | The OpenAI key. |
| `ANTHROPIC_API_KEY` | The Anthropic key. |
| `OPENROUTER_API_KEY` | The OpenRouter key. |
| `<PREFIX>_API_KEY`, `<PREFIX>_BASE_API_KEY` | The key of any OpenAI-compatible service (for `PREFIX/model`), such as `GROQ_API_KEY`. Local services may have none. |

The library reads `process.env` only for keys. Pass `env: { ... }` in the config or a run option to override a key for one agent.

## Generators

| Function | Returns | Guide |
|---|---|---|
| `generateImage(options)` | `ImageResult`. Also `listImageModels`, `getImageModel`, `image.edit` and `imageTool`. | [Images](guides/images.md) |
| `generateVideo(options)` | `VideoResult`. Also `listVideoModels`, `getVideoModel`, `refreshOpenRouterVideoModels`, `video.edit` and `resumeVideo`. | [Videos](guides/videos.md) |
| `generateEmbedding(options)` | `EmbeddingResult`. Also `listEmbeddingModels`, `getEmbeddingModel`, `refreshOpenRouterEmbeddingModels`, `cosineSimilarity` and `EMBEDDING_TASKS`. | [Embeddings](guides/embeddings.md) |
| `generateDecision(options)` | `DecisionResult`. Also `listDecisionModels`, `getDecisionModel`, `refreshOpenRouterDecisionModels` and `DECISION_QUESTION_TYPES`. | [Decisions](guides/decisions.md) |
