# Migration

> What was removed or renamed, and what to use now. Everything that still works but has a better name is marked.

## Upgrading to 0.9.5

0.9.5 reports provider failures that used to come back as an empty answer. Nothing was removed. If you use a model behind a proxy, read the list below.

**Behavior that changed**

- On OpenAI, a reply that carries an `error` now fails with a `ProviderError` that has the provider's message and code, also when it came with HTTP 200 (some proxies do that) and in the last event of a stream. Before, the run ended with an empty answer (`text: ""`, `finishReason: "stop"`), as if it had worked. Like other OpenAI errors, it is retried when its code is `server_error` or `rate_limit_exceeded`. An `error` that holds nothing (`null`, `""` or `{}`) next to a real answer is still ignored.
- A stream request answered with one whole JSON reply instead of a stream is now read as `run()` reads it, on every provider. An error in it fails the stream with the same `ProviderError` as `run()`, and a temporary one is retried before the stream starts. A real answer gives its text, thinking and tool calls (the text arrives as one `text_delta`). Before, the stream ended with an empty answer. On OpenRouter this also covers `run()`, which streams.
- A stream that ends with no answer and no end event now fails as a retryable `incomplete_stream` whatever its content type. Before, it passed as an empty answer when the body was not labelled as a stream or as text.
- On Google, a stream that stops before `interaction.completed` while a tool call is still being written now fails as a retryable `incomplete_stream`. Before, it returned the cut call as a success (Google checked only for an empty stream, and took the usage sent after each step for the end). A cut stream no longer saves the chain: the next turn sends the full history. A call cut off by the output limit is saved with `{}` as its arguments, so the SDK's internal marker is never sent back to Google.
- On OpenAI-compatible services and OpenRouter, a tool call whose arguments come as an object instead of JSON text now runs with those arguments, on `run()` and `stream()`. Before, it ran with none (`{}`), so a tool with only optional fields did nothing useful; with a required field, the model got a validation error.
- A provider request that outlives its time limit now fails with a retryable `TimeoutError` (`code: "timeout"`) and is retried by `retry`. Before, it was an `AbortError`, as if you had cancelled it: it was never retried, a run treated it as an interruption, and on a stream the first timed-out attempt stopped the whole stream. This shows where the agent's own timer does not fire first: Gemini 4 long answers, OpenRouter's `run()`, and generators called directly. If you caught `AbortError` to spot a timeout, catch `TimeoutError`. On Gemini 4 long answers, a status check that times out no longer cancels the job at Google.
- An error a provider reports inside a reply or a stream (HTTP 200) is now retryable when its code is a status number or names a temporary failure: Google's `gateway_timeout`, `UNAVAILABLE`, `RESOURCE_EXHAUSTED` or `INTERNAL`, an OpenAI-compatible `overloaded` or `429`, and so on. `finish_reason: "error"` on OpenRouter and OpenAI-compatible services is a retryable 502 too (in a whole reply it used to give the answer with `finishReason: "error"`). Before, all of these failed for good. OpenAI's own codes keep their statuses, and OpenRouter's `error_type` still wins over the name in `code`.
- More thinking text arrives as `thinking` and `thinking_delta`: OpenRouter summary blocks (`reasoning.summary`, how OpenAI models send it), a `reasoning` field next to an empty or encrypted-only `reasoning_details` list, and `reasoning_content` on `run()` with OpenAI-compatible services (DeepSeek, vLLM, Qwen). Before, all three were dropped. A stream now sends one `thinking_delta` per chunk rather than one per block.

## Upgrading to 0.9.4

0.9.4 closes safety gaps. Keys, addresses and headers stay with the provider they were written for. Local files and media URLs obey their guards. A crash, a cut stream, parallel calls of one worker and several sessions on one agent no longer mix up results. Pictures count toward the spending caps. Nothing was removed. If you rely on one key for several providers, steer prompts across sessions, or download media on a network where only a proxy resolves names, read the list below.

**Behavior that changed**

- `Agent.fromConfig` keeps the `apiKey`, `baseUrl` and `headers` of `base` only when the new model names the same provider as `base.model` (`gemini/` and `google/` count as one). This now covers the top-level ones too, not only a key inside a model helper. For another provider, or a model written without a provider, they are dropped and the key comes from that provider's environment variable. Before, the top-level key, address and headers went to the new provider. If an edited agent may switch providers, set each provider's key in its environment variable.
- A worker gets the parent's `apiKey`, `baseUrl` and `headers` only when both models name the same provider. A model object (`{ provider, id }`) now counts by its `provider`: before, `{ provider: "openrouter", id: "openai/gpt-5.5" }` counted as OpenAI and got an OpenAI parent's key. When either model is written without a provider, the worker now gets none of them. A dynamic worker on another provider no longer gets the parent's `headers`. Give such a worker its provider's key in the environment.
- A per-call `env` now reads the same key names, in the same order, as `process.env`. A custom provider whose prefix starts with `google` (such as `googleproxy/`) no longer gets `GEMINI_API_KEY` or `GOOGLE_API_KEY` from it; set `<PREFIX>_API_KEY`. With several Google names in it, `GEMINI_API_KEY` now wins, as in `process.env` (it was `GOOGLE_API_KEY`), and `GOOGLE_GENAI_API_KEY` is read too. With both OpenAI names in it, `OPENAI_BASE_API_KEY` now wins, as in `process.env`.
- A custom service's `<PREFIX>_BASE_API_KEY` is now read from `process.env` too, after `<PREFIX>_API_KEY`, as the reference said. Before, only a per-call `env` was read for it.
- With `fileAccess.roots` set, a local path in media a tool returns with `toolContent` must be inside the roots too. Before, the executor read it from anywhere on disk, so a tool that took a path from the model could show the model any file. A path outside the roots now makes that call an error result (the model sees a `SecurityPolicyError` message) and the run goes on. Read such a file yourself and return its bytes, or add its folder to the roots.
- A media URL that the SDK downloads itself is refused (`RemoteFetchError`, a `SecurityPolicyError`) when the address of its host cannot be looked up. Before, the check let it through and `fetch` resolved the name unchecked. This matters on a network where only a proxy resolves names: read such a file yourself and pass the bytes, a data URL or base64. An IPv6 address of the form `::ffff:0:a.b.c.d` (IPv4-translated) now counts by the IPv4 address in it, like the other forms.
- A media URL that the SDK downloads itself now goes through the `fetch` of the agent or the call (it used the global `fetch`) and stops when the run is aborted or interrupted (it kept downloading, up to 512 MB). `normalizeMediaInput` takes the same as an optional third argument, `{ signal, fetch }`.
- With `resume: "explicit"`, a new `run()` after a crash (instead of `resume()`) gives the model the saved result of every tool call that finished before the crash. Before, every open call was answered "interrupted", so the model could repeat work that was already done.
- A streamed tool call whose arguments were cut off (for example at `maxOutputTokens`) after the provider opened it with `{}` (Google, and OpenAI when it sends `{}`) is now a cut-off call that never runs. Before, it ran with empty arguments, so a tool whose fields are all optional ran with nothing.
- Each call of a fixed sub-agent now gets its own session id (`<parent>-sub-<name>-<random>`), so two calls in one model turn no longer share one. On Google the copies used to continue each other's conversation, and the first to finish cleared the other's. If you matched the old id `<parent>-sub-<name>` in your telemetry, match the prefix.
- A busy agent no longer steers a prompt for another session into the running conversation. `run()` and `stream()` with a different `sessionId` now wait for their own run (also with `midSession.whenBusy: "steer"` or `enqueue: "steer"`), and `steer()` for another session throws a `ValidationError`. Before, user B's text went into user A's conversation and B got A's answer.
- The spending of an `imageTool` now belongs to the agent that runs it. It counts toward `usageLimit` and `budget`: once a cap is reached, the next picture is refused and the run ends with `BudgetExceededError`. Before, pictures were listed in `usageReport()` but no cap saw them. It is also saved with the session (in `fixedUsage`, as a node with `role: "image"`) and comes back after a restart. One tool object given to two agents no longer adds their pictures together. `maxImages` still counts per tool object in one process.
- After a restart, the starting point of `usageLimit` now includes what the copies of fixed workers spent. Before, it counted only the agent and its `agent.workers` workers.
- `Agent.fromConfig` also finds a tool by the name the model sees (the tool's `name`), not only by its key in `base.tools`.

## Upgrading to 0.9.3

0.9.3 changes no API and no behavior. No change is needed.

- The package no longer ships the folder `examples/prompts/` (three example prompt files that only the examples read). Copy them from 0.9.2 if you used them.
- A 401 from Google now names the `base_urls.google` setting. It used to name `GOOGLE_BASE_URL`, an environment variable removed in 0.7.0.
- The [reference](reference.md#stream-events) now lists only the stream events the SDK sends. `text_start`, `text_end`, `thinking_start`, `thinking_end`, `tool_call_start`, `tool_call_delta` and the `schemaVersion` field stay in the types as reserved names. They were never sent.

## Upgrading to 0.9.2

0.9.2 adds one thing and changes nothing that worked. No change is needed.

**New**

- A fixed sub-agent can be written as data in `subagents: [...]`: `{ name, description, instructions, model?, tools? }` (the type is `SubAgentSpec`). The SDK builds the `Agent`. Without `model` it runs on the worker model (`dynamicSubagents.model`, else `sub_agent_model` from `setModels` or `setSubAgentModel`), as the removed `SubAgent` class did. A plain `new Agent(...)` without `model` still uses the main model. See [Sub-agents](guides/workers.md#fixed-workers).

## Upgrading to 0.9.1

0.9.1 closes a gap in how the SDK downloads media links. If you pass public links, bytes, data URLs, base64 or local paths, you need no change.

**Behavior that changed**

- A media URL that the SDK downloads itself must now point to a public host. `localhost`, `127.x`, `10.x`, `172.16.x` to `172.31.x`, `192.168.x`, `169.254.x` (cloud metadata), `100.64.x` to `100.127.x`, `.local` and `.internal` names, a name that DNS resolves to one of them and a redirect to one all throw `SecurityPolicyError` (a `RemoteFetchError`). Before, they were downloaded. To use such a file, read it yourself and pass a `Uint8Array`, a data URL or base64. A link that a provider fetches itself (for example an image URL sent to OpenAI) was never downloaded by the SDK and is unchanged.
- The check now sees an IPv4 address inside an IPv6 one (`[::ffff:127.0.0.1]`, `[::127.0.0.1]`, NAT64) and treats an IPv6 address it cannot read as private.
- A browser runtime is not checked, because its requests start on the user's own machine.

## Upgrading to 0.9.0

0.9.0 removes the old worker class, makes the public API smaller and makes a few failures louder. If you use nothing listed here, you need no change.

**Removed**

- The `SubAgent` class, `SubAgentConfig`, `agentFromEnv()`, `Agent.fromEnv()`, `.asTool()` and `.toTool()`. A fixed worker is a plain `Agent`. See the first table below.
- 92 names that were exported but are internal: session plumbing, provider classes and tables, schema and signature helpers, wire-level provider types and inner types. See [Names that are no longer exported](#names-that-are-no-longer-exported).
- The callback `globalThis.__agentAccelAnomaly`. Warnings go to `telemetryBus`.

**Behavior that changed**

- `saveSessionDir` and `saveSessionFile` throw when they cannot write. An agent with `persist` still reports a failed save to `persist.onPersistError`, which now also works with `persist: { file }`.
- A tool named `__proto__` is refused. The name a model asks for is looked up among your own tools only, so a call to `constructor` is an unknown tool.
- A provider that answers HTTP 200 with something that is not a reply (an empty object, a list, no `choices`) now fails as a retryable 502 `ProviderError`, not as an empty answer.
- A provider reply over its size cap is refused with a `ProviderError` that is not retried: 64 MB for chat, 256 MB for pictures, vectors and decisions, 1 MB for an error body and 512 MB for a downloaded video.
- `agent.usageReport()` lists the workers that a fixed worker started, so its total matches the response. The session saves the spending of fixed workers as `fixedUsage`, so it survives a restart.
- The `User-Agent` header names the SDK's own version, not the version of the app that runs it.

## Options and APIs

| Was | Now | Since |
|---|---|---|
| `stop`, `seed` agent options | Removed. Do not pass them. | 0.6.0 |
| `temperature`, `topP`, `sampling` | Removed on every provider. | earlier |
| `allowedModels` | `setModels(list)`. See [Allowed models](guides/allowed-models.md). | 0.7.0 |
| `configure()` and the settings env vars | `setConfigs({ values })`. See [Settings](guides/settings.md). | 0.7.0 |
| Tool `retry`, `tags`, `output` | Removed. They were stored and never used. | 0.7.0 |
| `needsApproval` | Ask inside `execute` and refuse with `ctx.stop(reason)`, or use the `beforeTool` hook. | earlier |
| `dynamicSubagents.timeout`, `modelMaySetTimeout` | `dynamicSubagents.workerTimeoutMs` and the action's own `timeoutMs`. | 0.5.5 |
| Event `scheduled_action.killed` | `scheduled_action.deleted` | 0.5.5 |
| The `SubAgent` class, `SubAgentConfig`, `agentFromEnv()`, `Agent.fromEnv()`, `.asTool()` and `.toTool()` | Removed. A fixed worker is a plain `new Agent({ name, model, instructions })` in `subagents: [...]`, or `agentToTool({ name, agent })`. For `agentFromEnv()` and `Agent.fromEnv()`, leave out `model`: an `Agent` without one uses the saved choice, then the list default (see [Allowed models](guides/allowed-models.md)). `fromEnv` also fell back to the saved worker model when nothing else was set, so name the model in that case. Name the model of every worker: the old class used the saved worker model when you named none, but a plain `Agent` looks for the saved main model first. From 0.9.2 an entry written as data, `{ name, description, instructions }`, uses the saved worker model when it names none. See [Sub-agents](guides/workers.md#fixed-workers). | 0.9.0 |
| `hooks` (a placeholder that only warned) | A working option: `beforeTool`, `afterTool`, `beforeRequest`, `onYield`. An unknown hook name throws a `ConfigError`. | 0.8.9 |

## Names that still work

These older names are still accepted. When both are set, the winner is the one in the last column.

| Older name | Newer name | Wins |
|---|---|---|
| `thinkingLevel` | `thinking` | `thinking` |
| `subagentModel` | `dynamicSubagents.model` | `dynamicSubagents.model` |
| `midSession.mode` | `midSession.whenBusy` | `whenBusy` |

Two tool options have two names for the same thing: `maxTries` and `maxAttempts` (`maxTries` wins), and `redactError` and `redact` (`redactError` wins).

## Names that are no longer exported

These were internal helpers that happened to be exported. They are still in the source, but they are not part of the public API.

| Name | Use instead | Since |
|---|---|---|
| `buildSessionData`, `serializeSession`, `deserializeSession`, `inspectSessionPayload`, `SessionAgentLike`, `SessionPayloadStatus` | `agent.exportSession()` and `agent.importSession()`, or `saveSessionFile` and `loadSessionFile`. | 0.9.0 |
| `extractMediaToDir`, `resolveMediaPaths` | `saveSessionDir` and `loadSessionDir` move the media for you. | 0.9.0 |
| `computeSessionTurnCost` | `agent.usageReport()`, or `res.usage.cost` for one run. | 0.9.0 |
| `writeFileAtomic` | Nothing. It was the SDK's own crash-safe writer: write a temp file, then rename it. | 0.9.0 |
| The provider classes `GoogleInteractionsProvider`, `OpenAIResponsesProvider`, `AnthropicMessagesProvider`, `OpenRouterChatCompletionsProvider`, `OpenAICompatibleChatProvider`, the tables `GOOGLE_MODELS`, `OPENAI_MODELS`, `ANTHROPIC_MODELS`, `OPENROUTER_MODELS`, and `createOpenAICompatibleProvider`, `createCustomProvider`, `CustomProvider`, `CustomProviderOptions` | Use an `Agent`. `getProvider(id)` and `ensureCustomProvider(prefix, { baseUrl })` still give you a provider. | 0.9.0 |
| `zodToJsonSchema`, `cleanJsonSchema`, `toStandardToolDeclarations`, `StandardToolDeclaration`, `stripSchemaForGoogle`, `assertValidToolName`, `TOOL_NAME_PATTERN` | `tool({ input })` converts and checks the schema and the name for you. | 0.9.0 |
| `isValidThoughtSignature`, `retainThoughtSignature`, `extractGoogleThoughtSignature`, `clearInteractionChains` | Nothing. The SDK keeps thought signatures and Google chains itself. | 0.9.0 |
| `clampCacheKey`, `resolveEffectiveThinking`, `CACHE_OPTIONS` | Nothing. Set `cache` and `thinking` on the agent or on a run. | 0.9.0 |
| `toConciseProviderError`, `assertModalitiesSupported` | Nothing. Errors already reach you as one-line typed errors, and unsupported input fails before the network. | 0.9.0 |
| `getAttribution` | Keep the values you gave to `setAttribution`. | 0.9.0 |
| `buildSessionHeaders` | Nothing. Agents send their session headers themselves. | 0.9.0 |
| `createTrackingId`, `createChildSessionId`, `createFixedChildSessionId`, `isSessionDescendant` | The `trackingId`, `sessionId` and `parentSessionId` in a worker's result metadata. | 0.9.0 |
| `getCacheDir`, `getCacheFilePath`, `getCatalogTTL`, `isValidCatalogPayload`, `DEFAULT_CATALOG_TTL_MS`, `CATALOG_PROVIDERS` | `getCatalogStatus()` (cache path, age and TTL) and the `catalog_cache_dir` setting. | 0.9.0 |
| `formatSessionBanner`, `formatSessionTokens`, `formatSessionCost`, `getSessionContextWindow` | Copy the small helpers from `examples/_shared.ts`. `SessionTelemetry.formatBar()` stays. | 0.9.0 |
| `ProviderRequestOptions`, `ProviderGenerateResult`, `ProviderSteps` | Nothing. They are what an adapter receives and returns, and you cannot plug in your own. Set options on the agent or the run, and read an `AgentResponse`. | 0.9.0 |
| `PersistedSubAgentTrace`, `SessionRunMark`, `SessionRunEnd`, `SessionPending`, `SessionPendingPrompt`, `SessionToolRecord` | Read them off `PersistedAgentSession`, for example `NonNullable<PersistedAgentSession["runs"]>[number]`. | 0.9.0 |
| `NoulQuestion`, `ChoiceQuestion`, `ScoreQuestion`, `NoulAnswer`, `ChoiceAnswer`, `ScoreAnswer`, `RefusalAnswer`, `ResolvedDecisionQuestion` | `DecisionQuestion` and `DecisionAnswer`, narrowed on `type`: `Extract<DecisionAnswer, { type: "choice" }>`. | 0.9.0 |
| `ImageTokenPrices`, `ImageSizeRules`, `VideoTokenPrices`, `VideoClipReferences`, `VideoFrameRole`, `EmbeddingPrices`, `EmbeddingInputKind`, `EmbeddingTaskStyle`, `DecisionPrices`, `DecisionInputKind` | Read them off the model-info type that holds them, for example `ImageModelInfo["prices"]` or `DecisionModelInfo["prices"]`. | 0.9.0 |
| `ProviderImageRequest`, `ProviderImageResult`, `ProviderEmbeddingRequest`, `ProviderEmbeddingResult`, `ProviderDecisionRequest`, `ProviderDecisionAnswer`, `ProviderDecisionResult`, `ProviderVideoRequest`, `ProviderVideoResult`, `ProviderVideoResumeRequest` | `ImageOptions`, `EmbeddingOptions`, `DecisionOptions` and `VideoOptions` for what you pass in, and `ImageResult`, `EmbeddingResult`, `DecisionResult` and `VideoResult` for what comes back. | 0.9.0 |

## Providers and models

- The OpenRouter Responses transport is gone. OpenRouter uses Chat Completions.
- Gemini 1.x and 2.x are rejected. The minimum is Gemini 3.

## Environment variables

The environment holds API keys and nothing else. The older variables are no longer read:

| Was | Now |
|---|---|
| `MODEL`, `MODEL_NAME`, `SUB_AGENT_MODEL` | `setModels({ default: { model, sub_agent_model }, providers })`. The user's choice: `setModel(id)` and `setSubAgentModel(id)`. |
| `GOOGLE_BASE_URL`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `OPENROUTER_BASE_URL`, `<PREFIX>_BASE_URL` | The `base_urls` setting: `{ google, openai, anthropic, openrouter, <prefix> }`. |
| `OPENROUTER_ORDER`, `_ONLY`, `_IGNORE`, `_ALLOW_FALLBACKS`, `_REQUIRE_PARAMETERS`, `_ZDR`, `_DATA_COLLECTION`, `_SORT`, `_PARALLEL_TOOL_CALLS`, `_REASONING_EXCLUDE`, `_USER` | The `openrouter` setting: `{ order, only, ignore, allow_fallbacks, require_parameters, zdr, data_collection, sort, parallel_tool_calls, reasoning_exclude, user }`. |
| `COMPAT_NO_STREAM_OPTIONS`, `COMPAT_NO_SESSION_HEADERS` | The `compat` setting: `{ no_stream_options, no_session_headers }`. |
| `AGENT_ACCEL_USAGE_LIMIT_USD` and `_TOKENS`, `AGENT_ACCEL_SCHEDULED_BUDGET_USD` and `_TOKENS` | The `usage_limit` and `scheduled_action_budget` settings: `{ max_cost_usd, max_total_tokens }`. |
| `configure({ concurrency })` | The `concurrency` setting: `{ max_requests, per_provider }`. |
| `AGENT_CATALOG_REFRESH=off`, `AGENT_CACHE_DIR`, `MODELS_DEV_SHA256` | The settings `catalog_refresh: "off"`, `catalog_cache_dir` and `models_dev_sha256`. |
| `AGENT_ACCEL_HOME` | `setHome(dir)`, or an Agent's `home`. Code only. |

## Scheduled action files

The on-disk format has its own changelog: [Scheduled action files](scheduled-action-files.md#compatibility-rules-and-changelog).
