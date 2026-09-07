# Agent Accelerator

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
bun add agent-accelerator
# npm / pnpm also work
```

Requires `bun` or `node 22+`.

The only dependency is `zod`.

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

`MODEL` and `SUB_AGENT_MODEL` are used when `model` or `SubAgentModel` are omitted.

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
| `functions`       | `((...args: any[]) => any)[]`                        | Shorthand for exposing plain JavaScript functions as tools. Useful for quick prototypes.                                                                   |
| `subagents`       | `SubAgent[] \| Agent[]`                              | Pre-defined workers. Each worker becomes a callable tool. Useful for fixed roles such as researcher or critic.                                             |
| `CustomAgents`    | `Agent[]`                                            | Legacy alias for `subagents`. Prefer `subagents`.                                                                                                          |
| `EnableSubagents` | `boolean`                                            | When `true`, injects `spawn_subagents`, allowing the model to spawn 1–8 workers at runtime. Requires `SubAgentModel`.                                      |
| `SubAgentModel`   | `string \| ModelSpec \| ModelProviderInstance`       | Model used by dynamically spawned workers. Falls back to `SUB_AGENT_MODEL`.                                                                                |
| `ThinkingLevel`   | `ThinkingLevel`                                      | `none \| dynamic \| minimal \| low \| medium \| high \| xhigh`. Validated against the model catalog before a request.                                      |
| `cache`           | `CacheConfig`                                        | `{ retention, sessionId, cachedContentId, ttlSeconds }`. Controls cache reuse.                                                                             |
| `ServiceTier`     | `"flex" \| "priority"`                               | Cost / priority routing where supported. Omit for standard routing.                                                                                        |
| `maxTurns`        | `number`                                             | Maximum model → tool → model loops per `run`. Defaults to `10`.                                                                                            |
| `sessionId`       | `string`                                             | Stable identifier used for cache affinity. Auto-generated when omitted.                                                                                    |
| `headers`         | `Record<string,string>`                              | Additional headers merged into every request.                                                                                                              |
| `apiKey`          | `string`                                             | Overrides environment-based API-key lookup for this agent.                                                                                                 |
| `baseUrl`         | `string`                                             | Overrides the default endpoint for this agent.                                                                                                             |
| `stateless`       | `boolean`                                            | When `true`, history is cleared before and after each `run`. Useful for one-shot evaluators. Defaults to `false`.                                          |

When `EnableSubagents: true` is configured without a subagent model, construction throws `SubAgentModelError`.

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

Each subagent becomes `agentToTool(a)`, a tool that accepts:

```ts
{ task: string }
```

**Dynamic delegation**

Set `EnableSubagents: true` together with `SubAgentModel`.

A `spawn_subagents` tool is injected with the following task shape:

```ts
{
  tasks: {
    name,
    role?,
    instructions,
    task
  }[]
}
```

A maximum of 8 workers can be spawned, and they run in parallel.

Children inherit the parent's thinking, cache, tier, and headers. Each child receives its own session ID.

Results are returned as aggregated XML along with per-agent metadata in `res.subagents`.

```ts
const agent = new Agent({
  model: "google/gemini-3.7-flash",
  instructions: "Decompose and delegate in parallel.",
  EnableSubagents: true,
  SubAgentModel: "google/gemini-3.5-flash-lite",
  maxTurns: 10,
});

const res = await agent.run("Audit auth pipeline and write a threat model");

console.log(res.subagents.map((s) => s.name));
```

### Delegation Helpers

* `agentToTool(agent | { name, description, agent })` — wraps one agent as a tool for manual wiring.
* `buildAgentTools(list)` — wraps multiple agents and deduplicates names. Used internally by `subagents` and `CustomAgents`.
* `createSubagentSpawnTool(parentAgent)` — builds the dynamic subagent spawner. Rarely needed directly.
* `DynamicSubagentTask` — `{ name, role?, instructions, task, model? }`, the shape produced for dynamic delegation.

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

* `tool({ name?, description, input?, parameters?, strict?, execute })` — creates a `ToolDefinition`. Provide either a Zod `input` schema or raw JSON `parameters`. `execute(input, ctx)` may return any JSON-serializable value.
* `toStandardToolDeclarations(record | array)` — converts tools to `{ name, description, parameters }` for providers.
* `zodToJsonSchema(schema)` — converts Zod schemas using native conversion with a fallback extractor.
* `cleanJsonSchema(schema)` — removes `$schema`, `$defs`, and `definitions`, resolves `$ref`, and preserves explicit `additionalProperties`.
* `executeToolCalls({ tools, toolCalls, agentName?, parallel?, signal?, sessionId? })` — executes tool calls. Calls run through `Promise.all` when `>1`, validate Zod input, and return `ToolResultRecord[]`. Missing tools and aborts are represented as error results rather than thrown.

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
* `ModelProvider.GoogleGenAI(model, apiKey?, { thinking_level?, baseUrl? })` — same shape is available for `.OpenCode`, `.OpenRouter`, `.OpenAI`, `.Custom`, `.OpenAICompatible`, and `.Generic`.

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

`BaseProvider` is the abstract provider base containing `id`, `name`, `models`, `getModel`, `generate`, `stream`, and `countTokens`.

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

`ServiceTier` is mapped to provider routing.

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

Thinking uses a single flag:

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

Thinking can be configured on the `Agent` or through `ModelProvider.*(..., { thinking_level })`.

Per-run overrides are not supported. Create an agent per thinking level or switch the `agent` instance.

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
* `prompt_cache_key`

Reuse the same session ID across turns when cache affinity is desired.

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
## ServiceTier

```ts
ServiceTier = "flex" | "priority";
```

Omit `ServiceTier` for standard routing.

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
## Model Catalog

The model catalog is backed by:

```text
src/data/models.dev.json
```

The file is fetched from:

```text
https://models.dev/api.json
```

and is gitignored.

Refresh the catalog with:

```bash
bun run update-models
```
### Catalog Helpers

* `getModelFromCatalog(provider, modelId)` → `ModelSpec | undefined`, including alias and global fallback handling. Use it for context-window, pricing, and modality checks.
* `getModelsForProvider(provider)` → returns `ModelSpec[]`.

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

When estimated input exceeds the available context budget, `Agent` trims the oldest middle history using:

```text
context * 0.9 - maxOutput
```

The beginning of the conversation and the most recent tail are preserved.

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
* `AudioPart`
* `VideoPart`

`image`, `audio`, and `video` inputs accept:

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

Media normalization is handled automatically by providers.

---
## Tokens

Token counting is heuristic only.

Actual billing information comes from `res.usage`.

Available helpers:

* `countTokens(string | Message[] | ProviderContext)` — useful for preflight sizing and history trimming.
* `estimateTokensFromText(text)`
* `estimateTokensFromMessage(msg)`
* `estimateTokensFromPart(part)`

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
bun run examples/chat.ts
# persistent CLI, /model "..." /level <lvl> /help /exit

bun run examples/sub-agents.ts
# fixed researcher + critic pipeline

bun run examples/multi_agent.ts
# dynamic spawn_subagents demo

bun run examples/metadata.ts
# usage + raw inspection
```

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
bun run update-models # refresh src/data/models.dev.json
```
### Project Structure

```text
src/
├── agent/      # Agent, context, loop, delegation, subagent
├── providers/  # google, openai, opencode, openrouter, custom, registry, base
├── models/     # catalog parser
├── data/       # models.dev snapshot (gitignored)
├── tools/      # tool(), schema, executor
├── streaming/  # event stream, SSE parser
├── tokens/     # estimator
├── types/      # agent, core, message, model, response, tool
└── utils/      # cache, env, headers, media, session
```

---
## License

TBD

---
