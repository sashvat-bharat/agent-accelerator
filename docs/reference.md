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
| `dynamicSubagents` | Runtime-spawned workers and scheduled actions (keys below) | [Multi-agent](guides/multi-agent.md) |
| `thinking`, `thinkingLevel` | Reasoning level (`thinking` wins; `thinkingLevel` is legacy) | [Agents](guides/agents-and-models.md) |
| `cache`, `serviceTier`, `googleTier` | Caching, `flex`/`priority`, Google chain TTL (`free` 23 h, `paid` 54 d) | [Agents](guides/agents-and-models.md) |
| `bypassInputFileModality` | Convert `file` parts to Markdown for models without file input | [Data](guides/data-and-media.md) |
| `sessionId` | Default session key (clamped to 64 chars) | [Data](guides/data-and-media.md) |
| `maxTurns` | Model calls per run; `0`/omitted = unlimited | [Safety](guides/safety-and-ops.md) |
| `stateless` | Clear history around every run | [Agents](guides/agents-and-models.md) |
| `midSession` | `{ mode \| whenBusy: "steer" \| "queue" \| "auto", maxQueued }` | [Tools](guides/tools-and-streaming.md) |
| `persist`, `home` | Session saving; base folder (`setHome(dir)` / `AGENT_ACCEL_HOME` / `.agent-accel/`). Layout: `sessions/`, `scheduled_actions/`, `telemetry/` | [Data](guides/data-and-media.md) |
| `toolChoice` | `"auto"`, `"none"`, `"required"`, `{ tool }` | [Tools](guides/tools-and-streaming.md) |
| `maxOutputTokens`, `stop`, `seed` | Generation controls (`stop`/`seed`: Chat Completions only) | [Agents](guides/agents-and-models.md) |
| `output` | Structured output schema (Zod, JSON Schema or `{ name, schema, ... }`) | [Agents](guides/agents-and-models.md) |
| `retry`, `fetch`, `env` | Retry policy, custom `fetch`, env-var overrides | [Safety](guides/safety-and-ops.md) |
| `fileAccess`, `captureRaw`, `onFailure` | `{ roots }`, `"redacted"`/`true`/`false`, `"auto"`/`"rollback"`/`"keep"` | [Safety](guides/safety-and-ops.md) |
| `budget`, `limits` | Per-run ceilings (keys below) | [Safety](guides/safety-and-ops.md) |
| `telemetry: { persist: true }` | Appends every `telemetryBus` event (not reasoning text) to `<home>/telemetry/<date>.ndjson`. Off by default | [Safety](guides/safety-and-ops.md) |
| `logger`, `hooks`, `contextManagement` | **Not implemented**; emit `config.unsupported_option`. Use `telemetryBus` | |

**`dynamicSubagents`**: `enabled` (default true when present), `allowScheduledActions` (default false), `model`, `maxSpawn` (4), `thinkingLevel`, `tools` (pool), `workerTimeoutMs` (canonical; `0` none, `-1` model sets per task, `>0` fixed), `timeout` (legacy), `modelMaySetTimeout`.
**`midSession`**: `mode`, `whenBusy`, `maxQueued` (20).
**`budget`** (per run, includes workers): `maxCostUsd`, `maxTotalTokens`, `maxDurationMs`, `maxTotalSubagents`.
**`limits`**: `maxTurns`, `deadlineMs`, `maxTotalTokens`, `maxToolCallsPerRun`, `requestTimeoutMs` (300 s), `firstByteTimeoutMs` (120 s), `streamIdleTimeoutMs` (300 s).

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
| `enqueue` | `"steer"` or `"queue"` when the agent is busy |
| `headers` | Extra request headers |
| `onDelta`, `onThinkingDelta`, `onEvent`, `onTurn` | Callbacks |
| `wrapThinking` | Display reasoning inside `<think>…</think>` |
| `toolChoice`, `maxOutputTokens`, `stop`, `seed` | Same as config |
| `retry`, `fetch`, `env`, `logger` | Same as config |

## Response

`AgentResponse` fields: `text`, `parsed` (structured output), `thinking`, `thoughtSignature`, `toolCalls`, `toolResults`, `subagents`, `usage`, `responseId`, `model`, `provider`, `finishReason`, `rawFinishReason`, `durationMs`, `raw` (per `captureRaw`), `turns`. A failed run attaches the same shape as `err.partial`.

`finishReason`: `stop`, `tool_calls`, `length`, `content_filter`, `refusal`, `max_turns`, `error` (or a provider string; the original stays in `rawFinishReason`).

`usage`: `inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`, `cacheReadTokens`, `cacheWriteTokens`, `thinkingTokens`, optional `cost`.

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

`tool({...})` keys: `name`, `description`, `input`, `parameters`, `strict`, `timeoutMs`, `maxTries`, `maxAttempts`, `maxConcurrency`, `idempotent`, `retry`, `repeatable`, `maxResultChars`, `redactError`, `redact`, `tags`, `needsApproval`, `output`, `execute`. `__brand` is internal; never set it.

| Enforced by the executor | Stored only (no effect today) |
|---|---|
| `input`/`parameters`, `timeoutMs`, `maxTries`/`maxAttempts`, `maxConcurrency`, `idempotent`, `repeatable`, `maxResultChars`, `redactError`/`redact`; `strict` goes to the provider | `retry`, `tags`, `needsApproval`, `output` |

`execute(args, ctx)` context: `toolCallId`, `agentName`, `signal`, `sessionId`, `onSubagentEvent`, `runId`, `emit`, `logger`. Defaults: 1 attempt (3 when `idempotent`), 20 000 result characters, 8 concurrent tools, the 3rd identical consecutive call answered with `repeat_blocked`.

## Telemetry codes

Subscribe with `telemetryBus.onEvent((e) => e.code)`. Events carry `level`, `code`, `message` and `data`.

| Code | Meaning |
|---|---|
| `config.unsupported_option` | A placeholder or unsupported option was given and dropped |
| `config.thinking_budget_ignored` | `thinking.budgetTokens` is not forwarded |
| `provider_warning` | A provider-specific option was dropped (e.g. `stop` on Google) |
| `agent.max_turns_truncated` | Run stopped at `maxTurns` with tool work pending |
| `turn.thinking` | Full reasoning text of a turn (bus only) |
| `cache_clamp` | A session/affinity key was shortened to 64 chars |
| `interaction_chain_evicted`, `interaction_chain_ttl_expired`, `interaction_history_shrink` | Google chaining: server chain dropped, expired, or input tokens fell |
| `stream_buffer_overflow`, `stream_event_oversize` | Stream buffer limits hit |
| `catalog_cache_write_failed` | Model catalog could not be saved |
| `tool.call_started`, `tool.attempt_started`, `tool.progress`, `tool.attempt_failed`, `tool.retry_scheduled`, `tool.call_succeeded`, `tool.call_failed`, `tool.call_timed_out`, `tool.call_aborted`, `tool.call_blocked`, `tool.call_interrupted` | Tool call lifecycle. Each has `toolCallId`, `toolName`, `agentName`, `sessionId`; failures add the full error. A `call_started` with no ending event was in flight at a crash. Attach a sink to persist them |
| `session.local_media_paths` | An imported session references local files without `fileAccess.roots` |
| `scheduled_action.created`, `scheduled_action.updated`, `scheduled_action.started`, `scheduled_action.ready`, `scheduled_action.failed`, `scheduled_action.delivered`, `scheduled_action.missed`, `scheduled_action.skipped`, `scheduled_action.killed`, `scheduled_action.invalid`, `scheduled_action.store_corrupt`, `scheduled_action.error` | Scheduled action lifecycle |

## Errors

All extend `AgentAccelError` (`code`, `retryable`, `context`).

| Class | Raised when |
|---|---|
| `ConfigError` | Missing key/base URL, bad model string, invalid config (before any network call) |
| `ProviderError` | The API failed; `statusCode`, `provider`, `model`, `retryAfterMs` (non-enumerable) |
| `TimeoutError` | A request, first-byte, idle or deadline limit hit (retryable) |
| `BudgetExceededError` | `budget` / `limits.maxTotalTokens` exceeded; partial usage attached |
| `ToolError` | A tool failed in a way surfaced to the caller |
| `ValidationError` | Structured output or scheduled-action input did not validate |
| `ThinkingLevelError` | Level not supported by the model; `allowedLevels` lists valid ones |
| `SubAgentModelError` | Dynamic workers or scheduling without a worker model |
| `SessionLoadError` | A valid session file exceeds limits (never quarantined) |
| `SecurityPolicyError`, `RemoteFetchError` | File root or private-host policy refused a path or URL |
| `DocumentConversionError` | Document to Markdown conversion failed |

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
| `<PREFIX>_API_KEY`, `<PREFIX>_BASE_URL` | Any OpenAI-compatible endpoint (for `PREFIX/model`), e.g. `GROQ_API_KEY` and `GROQ_BASE_URL`. Base URL is required |
| `COMPAT_NO_STREAM_OPTIONS=1` | Do not send `stream_options` to a generic endpoint |
| `COMPAT_NO_SESSION_HEADERS=1` | Do not send session/affinity headers to a generic endpoint |
| `AGENT_CATALOG_REFRESH=off` | Disable automatic model-catalog refresh |
| `AGENT_ACCEL_HOME` | The single folder for everything the SDK stores (default `.agent-accel/`; `setHome(dir)` does the same in code) |
| `AGENT_CACHE_DIR` | Overrides only the model catalog cache folder (default `<home>/catalog`) |
| `MODELS_DEV_SHA256` | Optional checksum pin for the downloaded catalog |

Library functions read `process.env` only. Pass `env: { ... }` in config or run options to override per agent.
