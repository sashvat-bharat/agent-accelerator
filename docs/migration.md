# Migration

> What was removed or renamed, and what to use now. Everything that still works but has a better name is marked.

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
| The `SubAgent` class, `SubAgentConfig`, `agentFromEnv()`, `Agent.fromEnv()`, `.asTool()` and `.toTool()` | Removed. A fixed worker is a plain `new Agent({ name, model, instructions })` in `subagents: [...]`, or `agentToTool({ name, agent })`. For `agentFromEnv()` and `Agent.fromEnv()`, leave out `model`: an `Agent` without one uses the saved choice, then the list default (see [Allowed models](guides/allowed-models.md)). `fromEnv` also fell back to the saved worker model when nothing else was set, so name the model in that case. Name the model of every worker: the old class used the saved worker model when you named none, but a plain `Agent` looks for the saved main model first. See [Workers](guides/workers.md#fixed-workers). | 0.9.0 |
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
