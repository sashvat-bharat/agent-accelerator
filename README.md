# Agent Accelerator

[![npm version](https://img.shields.io/npm/v/agent-accelerator.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/agent-accelerator)
[![GitHub](https://img.shields.io/badge/GitHub-sashvat--bharat%2Fagent--accelerator-blue?logo=github)](https://github.com/sashvat-bharat/agent-accelerator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A thin, typed transport SDK for calling LLMs through a single `Agent` interface.

Agent Accelerator supports `google`, `opencode`, `openrouter`, `openai`, and any OpenAI-compatible endpoint using `{PREFIX}_API_KEY` and `{PREFIX}_BASE_URL`.


```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  instructions: "You are a concise research engineer.",
  cache: { retention: "short" },
});

const res = await agent.run("Explain HBM pricing in 3 bullets");

console.log(res.text);
console.log(res.usage);
```

---

## Install

```bash
# Bun (recommended)
bun add agent-accelerator

# npm
npm install agent-accelerator

# pnpm
pnpm add agent-accelerator

# Yarn
yarn add agent-accelerator
```

Requires `bun` or `node 22+`.

Core dependencies are `zod`, `ai`, and selected `@ai-sdk/*` provider packages used as the backend transport.

---

## Setup

```bash
GEMINI_API_KEY=...
OPENCODE_API_KEY=...
OPENROUTER_API_KEY=...
OPENAI_API_KEY=...
# or OPENAI_BASE_API_KEY=...

MODEL="google/gemini-3.5-flash-lite"
SUB_AGENT_MODEL="google/gemini-3.5-flash-lite"

# Any OpenAI-compatible endpoint, no code change:
# MODEL="groq/llama-3.3-70b-versatile"
# GROQ_API_KEY="..."
# GROQ_BASE_URL="https://api.groq.com/openai/v1"

# Local, no key needed:
# MODEL="ollama/qwen2.5-coder"
# OLLAMA_BASE_URL="http://localhost:11434/v1"
```

`MODEL` and `SUB_AGENT_MODEL` are used when `model` or the dynamic worker model are omitted.

Explicit configuration always takes precedence over environment variables.

---

## Quick Start

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  instructions: "Be direct and technical.",
});

const res = await agent.run("Explain lock contention.");

console.log(res.text); // final answer
console.log(res.thinking); // reasoning trace, if any
console.log(res.usage); // input / output / cached / thinking / cost
console.log(res.raw.request.headers); // wire audit
```

Use `instructions` for the system prompt.

Keep `instructions` stable across turns to improve prefix-cache reuse.

---

## Agent

`new Agent(config: AgentConfig)` is the main entry point.

An `Agent` holds :

* `instructions`
* `tools`
* resolved model
* thinking configuration
* cache configuration
* service tier
* `sessionId`
* conversation `context`

### AgentConfig

| Field             | Type                                                 | Meaning / Use Case                                                                                                                                         |
| ----------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`           | `string \| ModelSpec \| ModelProviderInstance`       | Model identifier, such as `"google/gemini-3.5-flash-lite"`. Use `ModelProvider.*` or `ModelSpec` to pin a provider and credentials. Falls back to `MODEL`. |
| `instructions`    | `string`                                             | System prompt. Keep it stable; place per-turn additions in `additionalContext`.                                                                            |
| `tools`           | `Record<string, ToolDefinition> \| ToolDefinition[]` | Deterministic functions the model can call. See [Tools](#tools).                                                                                          |
| `subagents`       | `SubAgent[] \| Agent[]`                              | Pre-defined workers. Each worker becomes a callable tool. Useful for fixed roles such as researcher or critic.                                             |
| `subagentModel`   | `string \| ModelSpec \| ModelProviderInstance`       | Developer-only model for dynamically spawned workers. Never choosable by the Main Agent. Overridden by `dynamicSubagents.model`. Falls back to `SUB_AGENT_MODEL`. |
| `dynamicSubagents` | `DynamicSubagentsConfig`                            | Enables and constrains LLM-spawned stateless workers: `{ enabled, model?, maxSpawn?, thinkingLevel?, tools?, timeout? }`. See [Dynamic delegation](#dynamic-delegation). |
| `thinkingLevel`   | `ThinkingLevel`                                      | `none \| dynamic \| minimal \| low \| medium \| high \| xhigh`. Validated against the model catalog before a request.                                      |
| `cache`           | `CacheConfig`                                        | `{ retention, sessionId, cachedContentId, ttlSeconds }`. Controls cache reuse.                                                                             |
| `serviceTier`     | `"flex" \| "priority"`                               | Cost / priority routing where supported. Omit for standard routing.                                                                                        |
| `maxTurns`        | `number`                                             | Maximum model → tool → model loops per `run`. Defaults to `10`.                                                                                            |
| `sessionId`       | `string`                                             | Stable identifier used for cache affinity. Auto-generated when omitted.                                                                                    |
| `headers`         | `Record<string,string>`                              | Additional headers merged into every request.                                                                                                              |
| `apiKey`          | `string`                                             | Overrides environment-based API-key lookup for this agent.                                                                                                 |
| `baseUrl`         | `string`                                             | Overrides the default endpoint for this agent.                                                                                                             |
| `stateless`       | `boolean`                                            | When `true`, history is cleared before and after each `run`. Useful for one-shot evaluators. Defaults to `false`.                                          |

When `dynamicSubagents.enabled` is set without a resolvable worker model, construction throws `SubAgentModelError`.

### Agent Methods

```ts
await agent.run(prompt, opts?) // non-streaming, or streaming when opts.stream is true
agent.ask(prompt, optsOrBool?) // string deltas when streaming, otherwise same as run
agent.stream(prompt, opts?) // AssistantMessageEventStream
agent.reset() // clears messages + signatures, keeps config
```

`prompt` accepts `string | ContentPart[]`.

Use `ContentPart[]` when sending images, audio, or video alongside text.

### AgentRunOptions

| Field                           | Meaning / Use Case                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream`                        | When `true`, returns a stream instead of a regular response promise.                                                                            |
| `onDelta(delta, event)`         | Called for each text chunk. Use to render answers live.                                                                                         |
| `onThinkingDelta(delta, event)` | Called for each reasoning chunk. Use to render reasoning separately.                                                                            |
| `onEvent(event)`                | Called for every event: `text_delta`, `thinking_delta`, `tool_call_complete`, `tool_result`, `subagent_complete`, `usage`, `done`, and `error`. |
| `wrapThinking`                  | Wraps reasoning as `<think>\n...\n</think>\n\n`, allowing UIs to render it without maintaining separate state.                                  |
| `additionalContext`             | Added only to the current user turn. Keeps the system prompt stable for better caching.                                                         |
| `sessionId`                     | Per-run session override.                                                                                                                       |
| `headers`                       | Per-run header merge.                                                                                                                           |
| `signal`                        | `AbortSignal` used to cancel generation, tools, and subagents.                                                                                  |

### Streaming

```ts
const res = await agent.run("Design an append-only log", {
  stream: true,
  wrapThinking: true,
  onThinkingDelta: (d) => process.stdout.write(d),
  onDelta: (d) => process.stdout.write(d),
  onEvent: (e) => {
    if (e.type === "subagent_complete") {
      console.log(`done: ${e.subagent!.name}`);
    }

    if (e.type === "tool_result") {
      console.log(`tool: ${e.toolResult!.name}`);
    }
  },
});
```

### Manual Iteration

```ts
const stream = agent.stream("Hello");

for await (const e of stream) {
  if (e.type === "text_delta") {
    process.stdout.write(e.delta!);
  }

  if (e.type === "thinking_delta") {
    process.stdout.write(e.thinkingDelta!);
  }
}

const final = await stream.result();

stream.on("text_delta", (e) => console.log(e.delta));
stream.off("text_delta", handler);
```

---

## SubAgent

`SubAgent extends Agent` and is designed for fixed worker roles.

```ts
import { Agent, SubAgent } from "agent-accelerator";

const researcher = new SubAgent({
  name: "researcher",
  instructions: "You collect quantifiable metrics.",
  model: "google/gemini-3.5-flash-lite",
});

const lead = new Agent({
  model: "google/gemini-3.7-flash",
  instructions: "Delegate research, then synthesize.",
  subagents: [researcher],
});
```

### Differences from Agent

* `model` resolves as `config.model ?? SUB_AGENT_MODEL ?? MODEL` and throws if empty.
* `cache` defaults to `{ retention: "short" }`.
* `.asTool(name?, desc?)` / `.toTool(name?, desc?)` converts the subagent into a `ToolDefinition` for manual registration.
* `stateless: true` is supported for one-shot judges that must not retain history.

`SubAgentConfig` is identical to `AgentConfig`.

### Pre-defined vs Dynamic Delegation

**Pre-defined delegation**

Pass `subagents: [a, b]`.

Each subagent is automatically registered as an internal tool on the parent that accepts:

```ts
{ task: string }
```

**Dynamic delegation**

`subagents` lists pre-defined workers (each becomes a callable tool). For
LLM-spawned workers, configure `dynamicSubagents`:

```ts
const agent = new Agent({
  name: "Main Agent",
  model: process.env.MODEL,
  tools: { get_topic_brief },
  instructions: "You are the Main Agent",
  dynamicSubagents: {
    enabled: true,
    maxSpawn: 4,
    thinkingLevel: "low",
    tools: { get_weather, recent_news },
    timeout: 60000,
  },
});
```

A `spawn_subagents` tool is injected with the following task shape:

```ts
{
  tasks: {
    name,
    role?,
    instructions,
    task,
    tools?: string[],
    timeoutMs?: number
  }[]
}
```

- `maxSpawn` — max workers per call. Extras are trimmed safely, and the limit is stated in the tool description plus the Main Agent's system prompt so the model knows it.
- `tools` — developer-owned pool. Workers get zero tools unless the Main Agent grants a per-task `tools` subset by name (unknown names are ignored), keeping worker context small.
- `timeout` (ms) — `0` = no limit, `-1` = the Main Agent sets a per-task `timeoutMs`, `>0` = fixed limit for every worker. Timed-out workers report an error entry; the rest of the batch still completes.
- Workers are stateless: one task in, one result out, then shut down. No history, no recursion. The Main Agent cannot choose worker models or reasoning levels.

```ts
const res = await agent.run("Audit auth pipeline and write a threat model");

console.log(res.subagents.map((s) => s.name));
```

### Delegation Helpers

* `buildAgentTools(list)` — wraps multiple agents and deduplicates names. Used internally by `subagents`.
* `createSubagentSpawnTool(parentAgent)` — builds the dynamic subagent spawner. Rarely needed directly.
* `DynamicSubagentTask` — `{ name, role?, instructions, task, tools?, timeoutMs? }`, the shape produced for dynamic delegation. No `model` — workers run on the developer-configured model.

---
## Tools

```ts
import { Agent, tool, z } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  tools: {
    fetch_metrics: tool({
      description: "Fetch cluster metrics",
      input: z.object({
        clusterId: z.string(),
      }),
      execute: async ({ clusterId }) => ({
        clusterId,
        load: 0.42,
      }),
    }),
  },
});
```

### Tool Helpers

* `tool({ name?, description, input?, parameters?, strict?, timeoutMs?, maxTries?, maxConcurrency?, execute })` — creates a `ToolDefinition`. Provide either a Zod `input` schema or raw JSON `parameters`. `execute(input, ctx)` may return arbitrary values; results are converted safely for model context. `timeoutMs` defaults to `0` (no time limit) and is a best-effort event-loop deadline; `ctx.signal` enables cooperative cancellation. `maxTries` accepts a number or numeric string; a positive value is the total attempt limit, while `0`/omitted means no configured limit for transient retries. `maxConcurrency` limits simultaneous calls for that tool (default pool: 8).
* `toStandardToolDeclarations(record | array)` — converts tools to `{ name, description, parameters }` for providers.
* `zodToJsonSchema(schema)` — converts Zod schemas using native conversion with a fallback extractor.
* `cleanJsonSchema(schema)` — removes `$schema`, `$defs`, and `definitions`, resolves `$ref`, and preserves explicit `additionalProperties`.
* `executeToolCalls({ tools, toolCalls, agentName?, parallel?, signal?, sessionId? })` — executes tool calls. Calls validate Zod input, use bounded parallelism, enforce per-tool timeouts, retry transient failures, recover namespace/camel-case tool-name aliases, and return `ToolResultRecord[]`. Missing tools and aborts are represented as error results rather than thrown.

The agent loop also blocks an identical tool name and argument set when the model requests it in the immediately following turn. The synthetic error is returned to the model so it can reuse the prior result or change its arguments.

### Tool Timing and Deadlines

Every `ToolResultRecord` includes `durationMs`, measured in whole milliseconds with a minimum displayed value of `1ms`. The value covers the tool execution attempt (including retry/backoff time), but excludes queue wait and input-schema validation.

`timeoutMs` is specified in milliseconds:

```ts
const get_status = tool({
  name: "get_status",
  description: "Check user authentication status.",
  timeoutMs: 1,
  input: z.object({ username: z.string() }),
  execute: async ({ username }, ctx) => {
    // Pass ctx.signal to cancellable APIs such as fetch.
    return username === "Akshat Dwivedi" ? "Valid" : "Invalid";
  },
});
```

`timeoutMs: 0` or an omitted value disables the deadline. Positive values are best-effort event-loop deadlines: JavaScript cannot forcibly stop arbitrary synchronous code, so asynchronous implementations should honor `ctx.signal`. A timeout is returned as an error tool result and is not retried indefinitely unless a positive `maxTries` is configured.

Tool timing is available after a run:

```ts
const response = await agent.run("Check status");
for (const result of response.toolResults) {
  console.log(`${result.name}: ${result.durationMs}ms`);
}
```

### Tool Types

`ToolExecutionContext`:

```ts
{
  toolCallId,
  agentName?,
  signal?,
  sessionId?
}
```

`ToolCallRecord`:

```ts
{
  id,
  name,
  arguments,
  rawArguments?,
  thoughtSignature?
}
```

`ToolResultRecord`:

```ts
{
  id,
  name,
  result,
  isError?,
  durationMs?
}
```

---
## Providers

First-class provider IDs are:

* `google`
* `opencode`
* `openrouter`
* `openai`

Any other provider prefix is treated as an OpenAI-compatible custom provider.

### Model Strings

* `"google/<id>"` → Google AI Studio at `generativelanguage.googleapis.com`.
* `"opencode/<id>"` → OpenCode Zen at `opencode.ai/zen/v1`.
* `"opencode-go/<id>"` → OpenCode Go endpoint.
* OpenCode automatically selects Chat vs Responses API. Claude models and models using `api=openai-responses` use Responses.
* `"openrouter/<scope>/<model>"` or `"scope/model:variant"` → OpenRouter.
* `"openai/<id>"` → OpenAI.
* `"groq/<id>"`, `"ollama/<id>"`, etc. → custom providers using `{PREFIX}_API_KEY` and `{PREFIX}_BASE_URL`. The API key is optional for local endpoints.
* A bare `"some-model"` uses `OPENAI_BASE_URL` when configured. Otherwise, catalog lookup is attempted, followed by an `openrouter` fallback.

Model resolution never silently selects a default model.

An empty model throws.

An unknown prefix with no catalog match still routes to a custom provider, allowing private model IDs and endpoints.

### Registry

* `resolveModel("google/x" | ModelSpec)` → `{ provider, modelId, modelSpec? }`. Use to inspect routing before execution.
* `getProvider("groq")` → returns a cached provider and automatically creates a custom provider for unknown prefixes.
* `ensureCustomProvider(prefix, { baseUrl?, apiKey?, name? })` → gets or creates a custom provider. Useful for multiple endpoints in one process.
* `normalizeProviderPrefix(s)` → lowercases and trims a provider prefix.
* `ModelProvider.GoogleGenAI(model, apiKey?, { thinkingLevel?, baseUrl? })` — same shape is available for `.OpenCode`, `.OpenRouter`, `.OpenAI`, `.Custom`, `.OpenAICompatible`, and `.Generic`.

Each returns a `ModelProviderInstance`:

```ts
{
  model,
  apiKey?,
  baseUrl?,
  thinkingLevel?
}
```

The result can be passed directly to `Agent.model`.

Use `Custom` for Groq, Together, Ollama, vLLM, and similar endpoints.

```ts
import { Agent, ModelProvider } from "agent-accelerator";

new Agent({
  model: ModelProvider.GoogleGenAI("gemini-3.5-flash-lite"),
});

new Agent({
  model: ModelProvider.Custom(
    "groq/llama-3.3-70b-versatile",
    process.env.GROQ_API_KEY,
    {
      baseUrl: process.env.GROQ_BASE_URL,
    },
  ),
});
```

`BaseProvider` is the abstract provider base containing `id`, `name`, `models`, `getModel`, `generate`, and `stream`.

Its catalog-first `getModel` behavior includes a hardcoded fallback.

Extend `BaseProvider` when implementing a fully custom transport.

`ProviderRequestOptions { apiKey?, baseUrl?, headers?, thinking?, cache?, serviceTier?, tools?, toolChoice?, signal?, sessionId?, env? }` is the per-call options object passed to `generate`/`stream`. Agent builds it automatically.

### Google

`GoogleAIStudioProvider` and `GOOGLE_MODELS` provide Google AI Studio support.

The catalog is filtered with fallback support for lite and flash models.

Google models matching `gemini-1.x` or `gemini-2.x` are rejected.

Thinking levels map to:

```text
OFF | MINIMAL | LOW | MEDIUM | HIGH
```

Google-specific handling includes:

* Isolating `thoughtSignature` per part for prefix stability.
* Converting JSON Schema to OpenAPI 3.0 through `stripSchemaForGoogle`.
* Supporting explicit `cachedContents` when `retention != implicit` and the prompt is large.

Helpers:

* `createExplicitCache({ model, systemInstruction?, contents?, tools?, displayName?, ttlSeconds?, expireTime?, apiKey?, baseUrl? })`
* `isValidThoughtSignature(sig)`
* `retainThoughtSignature(existing, incoming)`
* `stripSchemaForGoogle(schema)`

### OpenAI

`OpenAIProvider` and `OPENAI_MODELS` provide OpenAI support.

`OpenAIProvider` is also the base class for OpenAI-wire transports.

Thinking levels map to:

```text
reasoning_effort: low | medium | high
```

It also:

* passes `service_tier`;
* derives `max_completion_tokens` from the configured budget;
* preserves Google thought signatures through `extra_content.google.thought_signature`;
* exposes `extractGoogleThoughtSignature(obj)`.

### OpenCode

`OpenCodeProvider` and `OPENCODE_MODELS` provide OpenCode support.

Requests include:

* `session_id`
* `prompt_cache_key`
* headers used for sticky routing

The provider handles both Chat and Responses payloads.

Transient `500`, `502`, `503`, and `529` errors are retried with thinking disabled, followed by an attempt using the alternate endpoint.

### OpenRouter

`OpenRouterProvider` and `OPENROUTER_MODELS` provide OpenRouter support.

Requests include:

* `session_id`
* `prompt_cache_key`

Thinking is mapped to:

```text
reasoning { effort | enabled }
include_reasoning
```

based on catalog capabilities.

`serviceTier` is mapped to provider routing.

### Custom

`OpenAICompatibleProvider` is also exposed through the `CustomProvider`, `createCustomProvider`, and `createOpenAICompatibleProvider(prefix, opts?)` aliases.

`CustomProviderOptions`:

```ts
{
  name?,
  baseUrl?,
  apiKey?,
  defaultBaseUrl?
}
```

`createGenericModelSpec(provider, modelId)` creates a permissive placeholder so private model IDs can pass validation and window checks.

Provider wire types are exported for inspecting raw requests and responses through:

```ts
res.raw.request.body
res.raw.response.body
```

Examples include:

* `OpenAIChatCompletionRequest`
* `GoogleGenerateContentRequest`
* `OpenCodeChatRequest`
* `OpenRouterChatRequest`

---
## Thinking

Thinking uses a single `thinkingLevel` flag:

```ts
ThinkingLevel =
  | "none"
  | "dynamic"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
```

### Thinking Levels

* `none` — disables thinking where supported.
* `dynamic` — allows the model to decide.
* `minimal`, `low`, `medium`, `high`, `xhigh` — request increasing levels of reasoning where supported.

Thinking can be configured on the `Agent` or through `ModelProvider.*(..., { thinkingLevel })`.

The per-run `thinkingLevel` option can override the agent default for one request.

Internally, thinking is normalized to:

```ts
ThinkingConfig {
  enabled?,
  level?,
  budgetTokens?,
  includeThoughts?
}
```

### Catalog Helpers

* `getModelThinkingInfo(provider, modelId)` → `{ supportsThinking, reasoningOptions?, allowedLevels, supportsDisable, description }`. Useful for building UI selectors.
* `validateModelThinking(provider, modelId, level)` → throws `ThinkingLevelError { provider, modelId, requestedLevel, allowedLevels, supportsThinking }` with a fix hint. Automatically called by `run` and `stream`. Catch it and use `err.allowedLevels` to offer valid options.
* `getModelsForProvider("google")` → returns known model specifications.

Unknown models allow all thinking levels.

Fixed-reasoning models reject `none`.

---
## Cache

```ts
CacheConfig {
  retention?,
  cachedContentId?,
  sessionId?,
  ttlSeconds?
}
```

```ts
CacheRetention =
  | "implicit"
  | "short"
  | "medium"
  | "long";
```

### Retention

* `implicit` — automatic prefix reuse without an explicit cache object or storage fee.
* `short` — approximately 5 minutes.
* `medium` — approximately 1 hour.
* `long` — approximately 12 hours for Google explicit caches and approximately 24 hours for prompt caching where supported.

### Session Affinity

`sessionId` pins provider affinity using mechanisms such as:

* `x-session-id`
* `x-opencode-session`
* `prompt_cache_key` (openai/openrouter/opencode only — strict endpoints such as groq reject it, so custom providers get headers only)

Reuse the same session ID across turns when cache affinity is desired.

In browser runtimes only CORS-safe attribution headers are sent; affinity
still flows via `promptCacheKey` provider options, never via headers.

### Explicit Caches

`cachedContentId` reuses a previously created Google `cachedContents/...` resource.

`ttlSeconds` overrides the retention mapping.

### Provider Cache Mechanisms

* **Google** keeps system prompts and tools stable and isolates signatures.
* **OpenCode / OpenRouter** use sticky session keys.

The following cache helpers are exported:

* `applyAnthropicCacheControl`
* `getCacheControlForRetention`
* `getPromptCacheRetention`
* `clampCacheKey`

For the best cache reuse, keep `instructions` and the tool set stable. Put changing data in user messages or `additionalContext`.

---
## serviceTier

```ts
serviceTier = "flex" | "priority";
```

Omit `serviceTier` for standard routing.

Where supported, it is passed as `service_tier` or translated into provider-specific routing.

* `flex` — suitable for batch-tolerant workloads.
* `priority` — suitable for latency-sensitive workloads.

---
## Streaming and Events

`AssistantMessageEventStream` implements `AsyncIterable<StreamEvent>`.

It provides:

```ts
.result(): Promise<AgentResponse>
.push(...)
.end(...)
.fail(...)
.on(...)
.off(...)
.cancel()
.onCancel(...)
.isCancelled()
```

### StreamEvent

```ts
StreamEvent {
  type,
  delta?,
  thinkingDelta?,
  toolCall?,
  toolResult?,
  subagent?,
  usage?,
  responseId?,
  finishReason?,
  error?,
  partialText?,
  partialThinking?,
  raw?
}
```

Event types:

```text
start
text_start
text_delta
text_end
thinking_start
thinking_delta
thinking_end
tool_call_start
tool_call_delta
tool_call_complete
tool_result
subagent_complete
usage
done
error
```

Emitted in practice: `start`, `text_delta`, `thinking_delta`, `tool_call_complete`, `tool_result`, `subagent_complete`, `usage`, `done`, `error`. The rest exist in the type for forward compatibility.

Use:

* `text_delta` for answer output.
* `thinking_delta` for reasoning output.
* `tool_call_complete` / `tool_result` for tool progress.
* `subagent_complete` for each completed worker during streaming multi-agent runs.
* `usage` for interim usage counts.
* `done` for final usage and completion information.

Breaking out of `for await` auto-cancels. Cancellation joins your
`AbortSignal` and stream cancellation into one linked controller, so
`controller.abort()` and `stream.cancel()` both stop the HTTP request.
Abort rejects with `AbortError` (never retried) and never resolves partial
results. `agent.run(prompt, { stream: true, signal })` exposes the same
`cancel` handle.

`SSEParser` provides:

```ts
feed(chunk)
flush()
```

It parses provider SSE streams and is only needed when implementing custom transports.

---
## Response, Usage, and Raw Data

### AgentResponse

```ts
AgentResponse {
  text,
  thinking?,
  thoughtSignature?,
  thinkingSignature?,
  textSignature?,
  toolCalls,
  toolResults,
  subagents,
  usage,
  responseId?,
  model,
  provider,
  finishReason?,
  durationMs,
  raw,
  turns
}
```

`AgentResponse` also provides:

```ts
.toString()
.toJSON()
```

### SubAgentExecutionMetadata

```ts
SubAgentExecutionMetadata {
  name,
  role?,
  task,
  model,
  provider,
  durationMs,
  usage,
  turns,
  finishReason?,
  responseId?,
  text,
  thinking?,
  toolCalls?,
  raw?,
  isError?,
  error?
}
```

### TokenUsage

```ts
TokenUsage {
  inputTokens,
  outputTokens,
  totalTokens,
  cachedTokens?,
  cacheReadTokens?,
  cacheWriteTokens?,
  thinkingTokens?,
  cost?: {
    inputCost?,
    outputCost?,
    cacheReadCost?,
    cacheWriteCost?,
    totalCost?
  }
}
```

Cost calculation prefers provider-reported totals. When unavailable, costs are computed using catalog pricing.

Subagent usage is rolled into the parent totals.
### ProviderRawData

```ts
ProviderRawData {
  request: {
    url,
    method,
    headers,
    body
  },
  response?: {
    status,
    statusText,
    headers,
    body
  }
}
```

Sensitive keys are redacted.

---
## Errors

Provider failures throw `AgentAccelProviderError` — one actionable line,
never a wire dump:

```text
[openrouter/nvidia/nemotron-3.5-lightning:free] request failed (404): No endpoints found that support input video
```

Raw details (`statusCode`, `url`, truncated body) stay attached as
non-enumerable properties: available programmatically, invisible in runtime
dumps. URL query strings are stripped (keys sometimes live there); headers
and cookies are never attached. Helpers:

* `toConciseProviderError(err, providerId, modelId)` — collapse any provider error.
* `assertModalitiesSupported(context, providerId, modelId)` — pre-request modality gate.

Examples print failures as exactly one line via `examples/_shared.ts`:

```ts
const res = await agent.run([...]).catch(fail);
// ✖ [provider/model] request failed (404): ...
// exit 1, no stack dump
```

---
## Model Catalog & Dynamic 12-Hour TTL Sync

Agent Accelerator features an adaptive, dynamically synchronized model catalog powered by [models.dev](https://models.dev). To avoid shipping a bloated 4.4 MB static JSON file with production builds, the SDK employs a high-performance **12-hour TTL local caching architecture**:

- **Automated 12-Hour Cache Validation**: When `.run()`, `.ask()`, or `.stream()` executes, the runtime checks `src/data/models.dev.json`. If the cache timestamp is within 12 hours, it reads from disk with zero network delay. When the TTL expires, it transparently synchronizes with `https://models.dev/api.json`.
- **Git & Package Safety**: The dynamic cache file (`src/data/models.dev.json`) is gitignored and excluded from production packages.

### Developer Catalog Controls

```ts
import {
  refreshModelCatalog,
  getCatalogStatus,
  setCatalogTTL,
  getModelFromCatalog,
  getModelThinkingInfo,
} from "agent-accelerator";

// Force an immediate refresh from models.dev:
await refreshModelCatalog({ force: true });

// Customize default TTL (e.g. 24 hours):
setCatalogTTL(24 * 60 * 60 * 1000);

// Inspect cache health and metadata:
const status = getCatalogStatus();
console.log(status.modelCount, status.providerCount, status.isExpired);
```

### CLI Refresh

```bash
bun run update-models              # Refresh model catalog (force or expired)
bun src/update-models.ts --force  # Force re-download
bun src/update-models.ts --ttl=24h # Refresh with custom TTL
```

Upstream data lags on some inputs (e.g. `gpt-4o` accepts audio). Record
verified corrections in `MODALITY_OVERRIDES` in `src/models/catalog.ts`
(keyed `provider/model`, merged over the snapshot) — never edit the JSON
directly, a refresh would wipe it.

### Catalog Helpers

* `getModelFromCatalog(provider, modelId)` → `ModelSpec | undefined`, including alias and global fallback handling. Use it for context-window, pricing, and modality checks.
* `getModelsForProvider(provider)` → returns `ModelSpec[]`.
* `getModelThinkingInfo(provider, modelId)` → inspect permitted thinking levels.
* `refreshModelCatalog(options?)` → programmatically sync with upstream models.dev.
* `getCatalogStatus()` → diagnostic info on active catalog, provider count, and TTL expiry.

### ModelSpec

```ts
ModelSpec {
  id,
  provider,
  name,
  description?,
  family?,
  api?,
  contextWindow,
  maxOutputTokens,
  limit?,
  cost?,
  modalities?,
  reasoning?,
  reasoning_options?,
  tool_call?,
  capabilities,
  pricing?,
  raw?
}
```

`contextWindow` and `maxOutputTokens` mirror:

```ts
limit.context
limit.output
```

### ModelCapabilities

```ts
ModelCapabilities {
  supportsThinking?,
  supportsThinkingBudget?,
  supportsThinkingLevel?,
  supportsImplicitCaching?,
  supportsExplicitCaching?,
  supportsLongCacheRetention?,
  supportsParallelToolCalls?,
  supportsStreaming?,
  modalities?,
  supportsReasoningToggle?,
  supportsReasoningEffort?
}
```

---

## Messages and Media

### Message

```ts
Message {
  role: "system" | "user" | "assistant" | "tool",
  content: string | ContentPart[],
  name?,
  thoughtSignature?
}
```

### ProviderContext

```ts
ProviderContext {
  systemPrompt?,
  messages,
  tools?,
  cachedContentId?
}
```

### ContentPart

Supported content parts include:

* `TextPart { type:"text", text, thoughtSignature? }` — plain text.
* `ThinkingPart { type:"thinking", thinking, thoughtSignature? }` — preserved reasoning.
* `ToolCallPart { type:"tool_call", id, name, arguments, rawArguments?, thoughtSignature? }`
* `ToolResultPart { type:"tool_result", id, name, result, isError? }`
* `ImagePart { type:"image", image, mimeType? }`
* `AudioPart { type:"audio", audio, mimeType? }`
* `VideoPart { type:"video", video, mimeType? }`
* `FilePart { type:"file", file, mimeType?, filename? }` — PDFs/documents.

`image`, `audio`, `video`, and `file` inputs accept:

* data URLs
* remote `http(s)` URLs
* local paths
* raw base64
* `Uint8Array`
* `ArrayBuffer`

`normalizeMediaInput(input, mime?)` returns:

```ts
{
  mimeType,
  base64Data,
  dataUrl
}
```

`inferMimeType(path)` infers the MIME type from a file extension.

Media normalization is handled automatically by providers (mapped to Vercel V4 `file` parts). Thinking traces are echoed in follow-up turns only where accepted — strict endpoints receive tool calls without `reasoning_content`.

Provider matrix: text + image + wav/mp3 audio + PDF work on all supported
providers. Video works on Gemini only.

Before any network call, the executor checks `image` / `audio` / `video` /
`file`-as-PDF parts against the catalog's `modalities.input` for that
provider/model and fails fast with a one-line error naming the gap
(`assertModalitiesSupported`). Models absent from the catalog (custom
providers, dynamic routers) are skipped — the provider endpoint decides and
its verdict surfaces as a concise error (see [Errors](#errors)). Verified
catalog corrections live in `MODALITY_OVERRIDES` (`src/models/catalog.ts`),
never in the gitignored snapshot.

---
## Utils

* `createSessionId(prefix="accel")` — creates a UUID-based session ID clamped to 64 characters for affinity.
* `getEnv(key, fallback?)` — resolves an environment variable.
* `getApiKey(provider, explicit?, env?)` — resolves API keys using the configured environment lookup order.
* `buildSessionHeaders(provider, cache?, custom?, sessionId?)` — builds provider-specific affinity headers. Normally handled automatically.
* `z` — re-exported from Zod so tools do not require a separate Zod import.

---
## Examples

```bash
bun run examples/06-chat.ts
# persistent CLI, /model "..." /level <lvl> /help /exit

bun run examples/05-sub-agents.ts
# fixed researcher + critic pipeline

bun run examples/04-multi_agent.ts
# dynamic spawn_subagents demo

bun run examples/01-metadata.ts
# usage + raw inspection

bun run examples/02-function_calling.ts
# single tool call

bun run examples/03-multimodal_image.ts [./photo.png]
# image input (remote URL default, local path optional)

bun run examples/07-multimodal_audio.ts
# audio input

bun run examples/08-multimodal_document.ts
# PDF/file input

bun run examples/09-multimodal_video.ts
# video input (video-capable model required)
```

Every example ends its `run()` with `.catch(fail)` (`examples/_shared.ts`),
so failures print one line and exit `1` — no stack dumps.

The chat example persists conversations to:

```text
.session.jsonl
```

It resumes from that file on next launch.

It also displays per-turn:

```text
input / output / cached / cost / context %
```

---
## Scripts and Structure

### Scripts

```bash
bun run typecheck     # tsc --noEmit
bun test              # bun test test/
bun run update-models # refresh model catalog cache (supports --force, --ttl=24h)
```
### Project Structure

```text
src/
├── agent/      # Agent, context, loop, delegation, subagent
├── ai-sdk/     # Provider backend: provider factories, converters, executor, registry
├── models/     # Dynamic catalog cache, parser, verified overrides
├── data/       # Dynamic model catalog cache (gitignored, excluded from bundle)
├── tools/      # tool(), schema, executor
├── streaming/  # event stream, SSE parser
├── types/      # agent, core, message, model, response, tool
└── utils/      # base64, cache, env, headers, media, serialization, session
examples/
├── 01-metadata.ts  02-function_calling.ts  03-multimodal_image.ts
├── 04-multi_agent.ts  05-sub-agents.ts  06-chat.ts
├── 07-multimodal_audio.ts  08-multimodal_document.ts
├── 09-multimodal_video.ts  _shared.ts
test/            # 104 tests mirroring the above
```

---
## License

MIT License — see [LICENSE](file:///data/projects/Agent-Accelerator/LICENSE) for details.

Copyright (c) 2026 Sashvat Bharat.

---

