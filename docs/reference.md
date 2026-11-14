# Reference
[Docs](README.md) › Reference

> Every config key, run option, response field, stream event, telemetry code, error class and environment variable. Explanations live in the [guides](README.md#pages). The exported type declarations in `src/types/` are the source of truth.

Contents: [AgentConfig](#agentconfig) · [Run options](#run-options) · [Response](#response) · [Stream events](#stream-events) · [Tool definition](#tool-definition) · [Telemetry codes](#telemetry-codes) · [Errors](#errors) · [Environment variables](#environment-variables)

## AgentConfig

| Key | Meaning | Guide |
|---|---|---|
| `name`, `description` | Identity; `description` is shown to a parent when this agent is a sub-agent | [Multi-agent](guides/multi-agent.md) |
| `instructions` | System prompt. Keep stable | [Agents](guides/agents-and-models.md) |
| `model` | Model string, `ModelSpec` or `ModelProvider.*` instance. Falls back to env `MODEL` | [Agents](guides/agents-and-models.md) |
| `subagentModel` | Default worker model (then env `SUB_AGENT_MODEL`) | [Multi-agent](guides/multi-agent.md) |
| `apiKey`, `baseUrl`, `headers` | Per-agent connection overrides | [Agents](guides/agents-and-models.md) |
| `tools` | Record `{ name: tool }` or array of tools | [Tools](guides/tools-and-streaming.md) |
| `subagents` | Fixed sub-agents (`Agent`s or `{ name, description, agent }`) | [Multi-agent](guides/multi-agent.md) |
| `dynamicSubagents` | The `subagents` tool, persistent workers and scheduled actions (keys below) | [Multi-agent](guides/multi-agent.md) |
| `thinking`, `thinkingLevel` | Reasoning level (`thinking` wins; `thinkingLevel` is legacy) | [Agents](guides/agents-and-models.md) |
| `cache`, `serviceTier`, `googleTier` | `"implicit"\|"5m"\|"30m"\|"1h"\|"12h"` cache lifetime, `flex`/`priority`, Google chain TTL (`free` 23 h, `paid` 54 d) | [Agents](guides/agents-and-models.md) |
| `sessionId` | Default session key (clamped to 64 chars) | [Data](guides/data-and-media.md) |
| `maxTurns` | Model calls per run; `0`/omitted = unlimited | [Safety](guides/safety-and-ops.md) |
| `stateless` | Clear history around every run | [Agents](guides/agents-and-models.md) |
| `midSession` | `{ mode \| whenBusy: "steer" \| "queue" \| "auto", maxQueued }` | [Tools](guides/tools-and-streaming.md) |
| `resume` | `"automatic"` (default) or `"explicit"`: whether a run a crash cut off continues when the Agent is constructed (needs `persist: { dir }` and the same `sessionId`). See `agent.resume()` / `agent.interrupted()` | [Data](guides/data-and-media.md) |
| `persist`, `home` | Session saving; base folder (`setHome(dir)` / `AGENT_ACCEL_HOME` / `.agent-accel/`). Layout: `sessions/`, `scheduled/`, `telemetry/` | [Data](guides/data-and-media.md) |
| `toolChoice` | `"auto"`, `"none"`, `"required"`, `"validated"` (Google), `{ tool }` | [Tools](guides/tools-and-streaming.md) |
| `maxOutputTokens` | Output-token cap for one model call | [Agents](guides/agents-and-models.md) |
| `output` | Structured output schema (Zod, JSON Schema or `{ name, schema, ... }`) | [Agents](guides/agents-and-models.md) |
| `retry`, `fetch`, `env` | Retry policy of one provider call, custom `fetch`, env-var overrides | [Safety](guides/safety-and-ops.md) |
| `runRetries` | Times a whole run that failed for a transient reason is tried again from where it stopped (default 3, `0` = off) | [Safety](guides/safety-and-ops.md) |
| `fileAccess`, `captureRaw`, `onFailure` | `{ roots }`, `"redacted"`/`true`/`false`, `"auto"`/`"rollback"`/`"keep"` | [Safety](guides/safety-and-ops.md) |
| `budget`, `limits` | Per-run ceilings (keys below) | [Safety](guides/safety-and-ops.md) |
| `prompts` | `{ [PromptName]: string }` replaces single SDK prompts; unset entries keep `DEFAULT_PROMPTS`. Unknown name or empty text throws `ConfigError`. Workers inherit it | [Prompts](guides/prompts.md) |
| `allowedModels` | `string[]` of `provider/model`, compared as written. Unset = any model. A model outside the list throws `ConfigError` when the Agent is built (also through `Agent.fromConfig`) | [Agents](guides/agents-and-models.md#self-improving-agents) |
| `telemetry: { persist: true }` | Appends every `telemetryBus` event (not reasoning text): a persisted session's events (`tool.*`, resume, retry) to `<home>/sessions/<id>/telemetry.ndjson`, everything else to `<home>/telemetry/<date>.ndjson`. Never outside the home. Off by default | [Safety](guides/safety-and-ops.md) |
| `logger`, `hooks`, `contextManagement` | **Not implemented**; emit `config.unsupported_option`. Use `telemetryBus` | |

**`dynamicSubagents`**: `enabled` (default true when present), `allowScheduledActions` (default false), `model`, `maxSpawn` (no limit by default; a number >= 1 caps the workers open at once), `maxDepth` (no limit by default; a whole number >= 1 caps the levels of workers below the agent), `workerBudget` (`{ maxCostUsd?, maxTotalTokens? }`, each chat worker's own per-run cap, default none), `scheduledActionBudget` (the same shape, the cap of each scheduled-action run, default none), `thinkingLevel`, `tools` (pool). Scheduled actions only: `workerTimeoutMs` (the longest a scheduled run may take, in ms; an action's own `timeoutMs` can only be shorter; no limit by default, `0` and `Infinity` mean none). The `subagents` tool and `agent.workers` have no timeouts. `timeout` and `modelMaySetTimeout` were removed (they throw a `ConfigError`).
**`midSession`**: `mode`, `whenBusy`, `maxQueued` (20).
**`usageLimit`** (the whole chat, for its whole life, workers included; survives restarts): `maxCostUsd`, `maxTotalTokens`. Reaching it throws `BudgetExceededError` ("Usage limit reached").

**`budget`** (per run, includes workers): `maxCostUsd`, `maxTotalTokens`, `maxDurationMs`, `maxTotalSubagents`.
**`limits`**: `maxTurns`, `deadlineMs`, `maxTotalTokens`, `maxToolCallsPerRun`, `requestTimeoutMs` (300 s), `firstByteTimeoutMs` (120 s), `streamIdleTimeoutMs` (300 s). Everything except these three network timeouts is unlimited until set; `0` or `Infinity` turns a timeout off (details: [Safety and operations](guides/safety-and-ops.md#what-is-limited-by-default)). A long-running call (Google long decode, or any `Provider` whose `isLongRunning()` returns true) times each HTTP request only, never the whole call or stream.

Precedence: explicit config > environment; per-run options > agent defaults (objects merge per key).

## Run options

`agent.run(prompt, opts)`, `agent.stream(prompt, opts)`, `agent.ask(prompt, stream?)`:

| Option | Meaning |
|---|---|
| `thinking`, `thinkingLevel` | Per-run reasoning level |
| `stream` | Make `run` return a stream-capable awaitable |
| `signal` | Cancels provider, tools and sub-agents |
| `sessionId` | Which in-memory session to use |
| `additionalContext` | Per-turn context added to the user turn (not to `instructions`) |
| `enqueue` | `"steer"`, `"queue"` or `"interrupt"` when the agent is busy. `"interrupt"` works in every `midSession` mode: it aborts the active run and starts this prompt next, ahead of queued follow-ups |
| `headers` | Extra request headers |
| `onDelta`, `onThinkingDelta`, `onEvent`, `onTurn` | Callbacks |
| `toolChoice`, `maxOutputTokens` | Same as config |
| `retry`, `fetch`, `env`, `logger` | Same as config |

## Response

`AgentResponse` fields: `text`, `parsed` (structured output), `thinking`, `thoughtSignature`, `toolCalls`, `toolResults`, `subagents`, `usage`, `responseId`, `model`, `provider`, `finishReason`, `rawFinishReason`, `durationMs`, `raw` (per `captureRaw`), `turns`. A failed run attaches the same shape as `err.partial`.

`finishReason`: `stop`, `tool_calls`, `length`, `content_filter`, `refusal`, `max_turns`, `stopped` (a tool called `ctx.stop`), `error` (or a provider string; the original stays in `rawFinishReason`).

`usage`: `inputTokens` (includes the cache reads and writes), `outputTokens` (includes `thinkingTokens`), `totalTokens`, `cachedTokens`, `cacheReadTokens`, `cacheWriteTokens`, `thinkingTokens`, optional `inputDetails` (`audioTokens`, `videoTokens`) and `outputDetails` (`audioTokens`, `imageTokens`) when OpenRouter reports media tokens (subsets of input and output, for reading only: they never change the cost), optional `cost`. Without a provider-reported cost, `cost` is estimated per turn from the catalog: fresh input, cache reads and cache writes each at their own price (a missing cache price bills at the input rate), scaled by `serviceTier`.

### Usage report

`agent.usageReport()` returns `{ agent, workers, total }` (types `UsageReport`, `AgentUsage`, `WorkerUsage`, `UsageLine`, `CostSource`). A line: `turns`; `tokens` (`input` incl. cache reads/writes, `freshInput`, `cacheRead`, `cacheWrite`, `output` incl. `thinking`, `thinking`, `total`); `cacheHitRate` (0-1 or `null`); `cost` (`source`: `provider | catalog | mixed | unknown`, `unpricedTurns`, `totalUsd` or `null`, `parts` in USD). `agent` is the agent's own calls, `workers` is a tree (`status`: `open | closed | fixed`, nested `workers`), `total` is everything. Each agent's totals are saved in its session as `usage` and kept current by `usage` journal records.

## Stream events

Every event has `type` and `schemaVersion`.

| `type` | When | Fields used |
|---|---|---|
| `start` | Request begins | `raw` |
| `text_start`, `text_delta`, `text_end` | Answer text | `delta`, `partialText` |
| `thinking_start`, `thinking_delta`, `thinking_end` | Reasoning | `thinkingDelta`, `partialThinking` |
| `tool_call_start`, `tool_call_delta`, `tool_call_complete` | Model builds a tool call | `toolCall` |
| `tool_start`, `tool_result`, `tool_end` | Your tool runs | `toolCall`, `toolResult`, `toolCalls`, `toolResults` |
| `subagent_delta`, `subagent_complete` | A worker streams / finishes | `subagent`, `subagentTrackingId` |
| `steer_injected` | A `steer()` was applied | `injectedPrompt` |
| `queued` | A follow-up was queued | `queuedPrompt`, `queueLength` |
| `usage` | Token counts | `usage` |
| `done` | Final | `finishReason`, `rawFinishReason`, `responseId`, `usage` |
| `error` | Failed | `error`, `partialText` |

## Tool definition

`tool({...})` keys: `name`, `description`, `input`, `parameters`, `strict`, `timeoutMs`, `maxTries`, `maxAttempts`, `maxConcurrency`, `idempotent`, `retry`, `repeatable`, `maxResultChars`, `redactError`, `redact`, `tags`, `output`, `execute`. `__brand` is internal; never set it.

| Enforced by the executor | Stored only (no effect today) |
|---|---|
| `input`/`parameters`, `timeoutMs`, `maxTries`/`maxAttempts`, `maxConcurrency`, `idempotent`, `repeatable`, `maxResultChars`, `redactError`/`redact`; `strict` goes to the provider | `retry`, `tags`, `output` |

`execute(args, ctx)` context: `toolCallId`, `agentName`, `signal`, `sessionId`, `onSubagentEvent`, `runId`, `emit`, `logger`, `stop(reason)` (ends the run after this batch with `finishReason: "stopped"`; the reason is the call's result; throws, never retried), `log(message, data?)` (writes to the call's log file `tool-logs/<n>-<tool>.ndjson` when the Agent persists to a folder, else a no-op). A result carries `logFile`. Defaults: 1 attempt (3 when `idempotent`), 20 000 result characters, 8 concurrent tools, the 3rd identical consecutive call answered with `repeat_blocked`.

## Telemetry codes

Subscribe with `telemetryBus.onEvent((e) => e.code)`. Events carry `level`, `code`, `message` and `data`.

| Code | Meaning |
|---|---|
| `config.unsupported_option` | A placeholder or unsupported option was given and dropped |
| `config.thinking_budget_ignored` | `thinking.budgetTokens` is not forwarded |
| `config.not_editable` | `Agent.fromConfig` got keys other than `model`, `instructions`, `tools`; they were ignored (`data.fields`) |
| `provider_warning` | A provider-specific option was dropped (e.g. `thinking: "none"` on Google) |
| `agent.max_turns_truncated` | Run stopped at `maxTurns` with tool work pending |
| `turn.thinking` | Full reasoning text of a turn (bus only) |
| `cache_clamp` | A session/affinity key was shortened to 64 chars |
| `interaction_chain_evicted`, `interaction_chain_ttl_expired`, `interaction_history_shrink` | Google chaining: server chain dropped, expired, or input tokens fell |
| `stream_buffer_overflow`, `stream_event_oversize` | Stream buffer limits hit |
| `catalog_cache_write_failed` | Model catalog could not be saved |
| `tool.call_stopped` (a tool called `ctx.stop`), `tool.call_started`, `tool.attempt_started`, `tool.progress`, `tool.attempt_failed`, `tool.retry_scheduled`, `tool.call_succeeded`, `tool.call_failed`, `tool.call_timed_out`, `tool.call_aborted`, `tool.call_blocked`, `tool.call_interrupted` | Tool call lifecycle. Each has `toolCallId`, `toolName`, `agentName`, `sessionId`; failures add the full error. A `call_started` with no ending event was in flight at a crash. Attach a sink to persist them |
| `session.local_media_paths` | An imported session references local files without `fileAccess.roots` |
| `agent.run_retry` | A failed run is being tried again (`attempt`, `of`, `delayMs`) |
| `agent.resumed`, `agent.resume_failed` | A cut-off run was resumed / resuming (or a prompt that was waiting) failed |
| `worker.invalid` | A saved `worker.json` is damaged and that worker is skipped |
| `session.journal_corrupt` | `journal.ndjson` is damaged before its last line; replay stopped there and kept what came before |
| `scheduled_action.created`, `scheduled_action.updated`, `scheduled_action.started`, `scheduled_action.ready`, `scheduled_action.failed`, `scheduled_action.delivered`, `scheduled_action.missed`, `scheduled_action.skipped`, `scheduled_action.deleted`, `scheduled_action.invalid`, `scheduled_action.store_corrupt`, `scheduled_action.error` | Scheduled action lifecycle; payloads in [Scheduled action files](scheduled-action-files.md#events) |

## Errors

All extend `AgentAccelError` (`code`, `retryable`, `context`).

| Class | Raised when |
|---|---|
| `ConfigError` | Missing key/base URL, no or bad model string, a removed provider, Gemini 1.x/2.x, invalid config, a `steer`/`queue`/`enqueue` call the `midSession.mode` forbids (before any network call) |
| `ProviderError` | The API failed; `code` is `"provider"` (`"incomplete_stream"` for a cut stream), `retryable` says whether a retry can help; `statusCode`, `provider`, `model`, `providerCode` (the provider's own code), `retryAfterMs` (non-enumerable) |
| `TimeoutError` | A request, first-byte or idle timeout (retryable) |
| `BudgetExceededError` | `budget` or `limits.maxTotalTokens` / `deadlineMs` / `maxToolCallsPerRun` exceeded; partial usage attached |
| `ToolError` | A tool failed in a way surfaced to the caller |
| `ValidationError` | Structured output or scheduled-action input did not validate; input the model cannot take (an unsupported modality), before any network call; an empty prompt; a call made the wrong way (a streaming option on `steer`/`queue`/`interrupt(message)`, `resume()` while busy, a full queue or steer inbox); a bad session id, `registerModel` spec or media input |
| `ThinkingLevelError` | Level not supported by the model (a `ConfigError`); `allowedLevels` lists valid ones |
| `SubAgentModelError` | Dynamic workers or scheduling without a worker model |
| `SessionLoadError` | A valid session file exceeds limits (never quarantined) |
| `SecurityPolicyError`, `RemoteFetchError` | File root or private-host policy refused a path or URL |

Abort detection: `isAbortError(err)` (`signal.aborted` or `name === "AbortError"`, never message text).

## Environment variables

| Variable | Purpose |
|---|---|
| `MODEL` (alias `MODEL_NAME`) | Default model when `model` is not passed |
| `SUB_AGENT_MODEL` | Default worker model |
| `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_API_KEY` | Google key (checked in this order of preference) |
| `GOOGLE_BASE_URL` | Override the Google endpoint |
| `OPENAI_API_KEY`, `OPENAI_BASE_API_KEY` | OpenAI key |
| `OPENAI_BASE_URL`, `OPENAI_API_BASE` | OpenAI endpoint; when set, a bare `MODEL` routes to OpenAI |
| `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` | OpenRouter key and endpoint |
| `OPENROUTER_ORDER`, `_ONLY`, `_IGNORE`, `_ALLOW_FALLBACKS`, `_REQUIRE_PARAMETERS`, `_ZDR`, `_DATA_COLLECTION`, `_SORT` | OpenRouter provider routing (`provider.*` in the request); see the OpenRouter section of the README |
| `OPENROUTER_PARALLEL_TOOL_CALLS`, `OPENROUTER_REASONING_EXCLUDE`, `OPENROUTER_USER` | OpenRouter `parallel_tool_calls`, `reasoning.exclude` and `user` |
| `<PREFIX>_API_KEY`, `<PREFIX>_BASE_URL` | Any OpenAI-compatible endpoint (for `PREFIX/model`), e.g. `GROQ_API_KEY` and `GROQ_BASE_URL`. Base URL is required |
| `COMPAT_NO_STREAM_OPTIONS=1` | Do not send `stream_options` to a generic endpoint |
| `COMPAT_NO_SESSION_HEADERS=1` | Do not send session/affinity headers to a generic endpoint |
| `AGENT_ACCEL_USAGE_LIMIT_USD`, `AGENT_ACCEL_USAGE_LIMIT_TOKENS` | Default `usageLimit` for every agent you build (see `configure()` and the safety guide) |
| `AGENT_ACCEL_SCHEDULED_BUDGET_USD`, `AGENT_ACCEL_SCHEDULED_BUDGET_TOKENS` | Default `dynamicSubagents.scheduledActionBudget` |
| `AGENT_CATALOG_REFRESH=off` | Disable automatic model-catalog refresh |
| `AGENT_ACCEL_HOME` | The single folder for everything the SDK stores (default `.agent-accel/`; `setHome(dir)` does the same in code) |
| `AGENT_CACHE_DIR` | Overrides only the model catalog cache folder (default `<home>/catalog`, one `<provider>/models.json` per provider plus `meta.json`) |
| `MODELS_DEV_SHA256` | Optional checksum pin for the downloaded catalog |

Library functions read `process.env` only. Pass `env: { ... }` in config or run options to override per agent.
