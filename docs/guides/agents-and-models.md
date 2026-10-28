# Agents and models
[Docs](../README.md) › Guides › Agents and models

> Create an `Agent`, run it, choose any provider, tune reasoning and caching, and get schema-checked JSON.

## The Agent

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  name: "support",
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  instructions: "You are a friendly support agent. Be brief.",
  maxTurns: 10,
});

const res = await agent.run("My invoice is wrong.");
console.log(res.text);

// Per-turn context goes in the user turn, NOT in instructions (keeps the prompt cache warm).
const res2 = await agent.run("What is my plan?", { additionalContext: "Customer plan: Pro" });
console.log(res2.text);
```

| Method | Use it for |
|---|---|
| `run(prompt, opts?)` | One call, resolves to an `AgentResponse`. `prompt` is a string or `ContentPart[]`. |
| `stream(prompt, opts?)` | An event stream (see [Tools and streaming](tools-and-streaming.md)). |
| `ask(prompt, stream?)` | Convenience alias of `run`; with `true` yields text deltas. |
| `reset()` | Clear history, keep config. |
| `session(id?)`, `disposeSession(id)`, `clearSessions()` | In-memory named sessions: `run(prompt, { sessionId })` keeps a separate history per id. |
| `exportSession()`, `importSession()` | Snapshot/restore history (see [Data and media](data-and-media.md)). |

Useful config: `stateless: true` clears history around every run (one-shot judges); `headers`, `apiKey`, `baseUrl` per agent; `maxTurns` (`0`/omitted = unlimited); `agentFromEnv(config)` builds an agent from `MODEL`/`SUB_AGENT_MODEL`. Every key is in [Reference](../reference.md).

**Recommendations**
- ✅ Keep `instructions` and the tool set **stable** between calls; put anything that changes per turn in `additionalContext` or the user message.
- ✅ Set a finite `maxTurns` in services (see [Safety and operations](safety-and-ops.md)).
- ⚠️ `hooks`, `contextManagement` and `logger` config keys are **not implemented**; they only emit a warning. Use `telemetryBus` instead.
- 💡 An `Agent` runs one thing at a time. A second call while busy is steered or queued (see [Tools and streaming](tools-and-streaming.md)).

## Models and providers

| Model string | Goes to | Key |
|---|---|---|
| `google/<id>` (or `gemini/<id>`) | Google Interactions API | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| `openai/<id>` | OpenAI Responses API | `OPENAI_API_KEY` |
| `openrouter/<scope>/<id>` or `scope/id:variant` | OpenRouter Chat Completions | `OPENROUTER_API_KEY` |
| `<anything-else>/<id>` | Generic OpenAI-compatible Chat Completions | `<PREFIX>_API_KEY` + `<PREFIX>_BASE_URL` |
| bare `<id>` | Catalog lookup (google, openai, openrouter), else OpenRouter; with `OPENAI_BASE_URL` set it goes to OpenAI | |

Rules worth knowing: a custom prefix **never** falls back to another vendor's key or default URL (a missing base URL throws before any network call); local endpoints (localhost, LAN, `*.local`) may omit the key; Gemini older than version 3 is rejected before the network.

```ts
import { Agent, ModelProvider } from "agent-accelerator";

// Pin provider, key and options explicitly instead of using env fallbacks.
const gemini = new Agent({
  model: ModelProvider.GoogleGenAI("gemini-3.5-flash-lite", process.env.GEMINI_API_KEY, { thinkingLevel: "low" }),
});

// Any OpenAI-compatible server, no code change needed.
const groq = new Agent({
  model: ModelProvider.OpenAICompatible("groq/llama-3.3-70b-versatile", process.env.GROQ_API_KEY, {
    baseUrl: "https://api.groq.com/openai/v1",
  }),
});

console.log((await gemini.run("hi")).provider, (await groq.run("hi")).provider);
```

Provider behavior differences the SDK handles for you:

| Capability | Google | OpenAI | OpenRouter | Custom |
|---|---|---|---|---|
| History | stateful chaining (full history on reseed) | full history each turn | full history | full history |
| `maxOutputTokens` | sent | sent | sent | sent |
| `stop`, `seed` | warn + drop | warn + drop | sent | sent |
| `serviceTier` | `flex`/`priority` | `flex`/`priority` | `flex`/`priority` | warn + drop |
| `thinking` | `thinking_level` (max `high`) | `reasoning.effort` | `reasoning.effort` | warn + drop |
| Video / files | native | images + files | images, video, files | images + audio only |

Unsupported options are **warned on the telemetry bus and dropped**, never sent. Google keeps a conversation server-side for up to 23 h (`googleTier: "free"`, default) or 54 d (`"paid"`) and reseeds from full history when it expires. Attribution headers for OpenRouter are opt-in via `setAttribution({ referer, title })`.

**Recommendations**
- ✅ Use explicit `ModelProvider.*` or `apiKey`/`baseUrl` when running several providers in one process.
- ✅ Check what a string resolves to with `resolveModel("...")` before shipping.
- ❌ Do not rely on `stop`/`seed` with Google or OpenAI.
- 💡 Switching providers mid-session is supported; the conversation history is provider-neutral.

## Thinking (reasoning)

```ts
import { Agent, ThinkingLevelError } from "agent-accelerator";

const agent = new Agent({ model: process.env.MODEL ?? "google/gemini-3.5-flash-lite", thinking: "medium" });

try {
  const res = await agent.run("Plan a 3-step database migration.", { thinking: "high" }); // per-run override
  console.log(res.thinking); // reasoning summary, if the model returned one
  console.log(res.text);
} catch (err) {
  if (err instanceof ThinkingLevelError) console.error("Allowed levels:", err.allowedLevels);
  else throw err;
}
```

Levels: `none`, `dynamic` (server default), `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `thinking` wins over the legacy `thinkingLevel`; `{ level, budgetTokens }` is accepted but `budgetTokens` only warns (no adapter forwards it). Levels are validated against the model catalog before any request. Pass `wrapThinking: true` in streaming to print reasoning as `<think>…</think>` (display only; history is untouched). Every thinking turn is also emitted as a `turn.thinking` telemetry event.

**Recommendations:** ✅ start at `low`/`medium`; reasoning costs output tokens. ❌ Do not hard-code a level for a model you have not checked: use `getModelThinkingInfo(provider, model)`.

## Caching and service tiers

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: process.env.MODEL ?? "openai/gpt-4o",
  instructions: "Long, stable system prompt...",
  cache: { retention: "implicit" }, // automatic prefix caching (the only mode acted on)
  serviceTier: "flex", // cheaper, slower; or "priority"
});

const res = await agent.run("Hello");
console.log(res.usage.cachedTokens, "of", res.usage.inputTokens, "input tokens were cached");
```

Prefix caching is automatic; you earn hits by keeping the start of the prompt identical. Only `implicit` retention is acted on (OpenAI `long` maps to a 24 h cache when the catalog supports it); other values are warned and dropped, and `cachedContentId` is ignored. Session ids are clamped to 64 characters for affinity headers/keys. For Google explicit caches use `createExplicitCache`.

**Recommendations:** ✅ stable `instructions` + stable tool order + stable `sessionId`; ✅ measure with `cachedTokens` or `SessionTelemetry` ([Data and media](data-and-media.md)). ❌ No timestamps or random text in `instructions`.

## Structured output

```ts
import { Agent, ValidationError, z } from "agent-accelerator";

const Invoice = z.object({ vendor: z.string(), total: z.number(), currency: z.string() });
const agent = new Agent({ model: process.env.MODEL ?? "google/gemini-3.5-flash-lite", output: Invoice });

try {
  const res = await agent.run("Acme Ltd charged 120.50 EUR for hosting.");
  const invoice = Invoice.parse(res.parsed); // typed, validated
  console.log(invoice.vendor, invoice.total);
} catch (err) {
  if (err instanceof ValidationError) console.error("Model answer did not match the schema");
  else throw err;
}
```

`output` accepts a Zod schema, a JSON Schema object, or `{ name, description, schema, strict }`. The final answer is constrained on every provider and validated into `res.parsed` (tool turns are skipped). If the catalog says a model lacks native support, the SDK **emulates** it with an instruction plus client-side validation and warns. Keep schemas small and describe fields.

## For AI agents

- Constructor: `new Agent(config: AgentConfig)`; run: `await agent.run(prompt: string | ContentPart[], opts?: AgentRunOptions): Promise<AgentResponse>`.
- Precedence: explicit config > env; `thinking` > `thinkingLevel`; per-run options > agent defaults (objects merge per key).
- Never put changing data in `instructions`; use `additionalContext`.
- `maxTurns: 0` means unlimited. Unknown/unsupported options are warned and dropped, not errors.
- Resolve routing in code: `resolveModel(modelString)` → `{ provider, modelId, modelSpec }`.
- Errors you can branch on: `ThinkingLevelError`, `ValidationError`, `ConfigError`, `ProviderError` (see [Reference](../reference.md)).
- See also: [Tools and streaming](tools-and-streaming.md), [Data and media](data-and-media.md), [`examples/01-metadata.ts`](../../examples/01-metadata.ts), [`examples/13-structured-output.ts`](../../examples/13-structured-output.ts).
