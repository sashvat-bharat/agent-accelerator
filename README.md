# Agent Accelerator

**Lightweight, high-performance TypeScript SDK — unified AI provider layer with 80-90% prompt-cache hit.**

Use **one consistent API** across `google` / `opencode` / `openrouter` (and any `models.dev` model) — switch provider/model without changing app code, while keeping **full JSON** (request, response, usage, streaming, tool-calls, thought signatures, raw headers) for observability, routing, and analytics.

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "opencode/hy3-free", // or "google/gemini-3.5-flash" or "openrouter/z-ai/glm-5.2:free"
  instructions: "You are helpful.",
});
const { text, usage, raw } = await agent.run("Explain HBM pricing in 3 bullets");
console.log(text, usage);
// cachedTokens, cacheReadTokens, cost, raw.request/response available
```

---

## Why

- **Unified provider** — `resolveModel("google/gemini-3.5-flash")`, `opencode/hy3-free`, `openrouter/...` same code. `ModelProvider` helper for `apiKey`/`thinkingLevel`/`baseUrl`.
- **Complete JSON** — nothing stripped: `AgentResponse.toJSON()` exposes `text`, `thinking`, `thoughtSignature`, `toolCalls`, `toolResults`, `subagents`, `usage:{input,output,cached,thinking,cost}`, `raw`.
- **Cache-first** — `cache: {retention}` → **explicit** (`cachedContents` via `POST /v1beta/cachedContents`, `ttl` 300s/3600s/43200s) vs no `cache` → **implicit** (free 2048/4096 prefix, per `references/gemini-documentation/context-caching.md`) + stable `system+tools` + `prompt_cache_key(64)` + Anthropic `cache_control` (4-cap) → **72-93% hit on 2nd turn** (`medium`/`long`), 6.6x speedup.
- **Single source of truth** — `src/data/models.dev.json` (207 providers, 7487 models) via `src/models/catalog.ts` → `limit.context` is `hy3-free:190000`, `gemini:1048576`, not stale per-provider files.
- **Lean prompts** — pi-inspired `SYSTEM_PROMPT*.md` (~10 lines) in project root, editable.

---

## Install

```bash
bun add agent-accelerator
# or bun install from source
bun install
```

Env (any one per provider you use):
```bash
GEMINI_API_KEY=...        # google
OPENCODE_API_KEY=...      # opencode (zen)
OPENROUTER_API_KEY=...    # openrouter
MODEL=opencode/hy3-free
SUB_AGENT_MODEL=google/gemini-3.5-flash-lite
```

---

## Quick Start

### 1. Basic Chat
```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash",
  instructions: "Be concise.",
});

const res = await agent.run("Write a haiku about caching");
console.log(res.text);
console.log(res.usage); // {inputTokens, outputTokens, cachedTokens, thinkingTokens, cost}
console.log(res.raw.request, res.raw.response);
```

### 2. Streaming (text + thinking + subagents)
```ts
const stream = agent.stream("Research HBM pricing then synthesize");
for await (const ev of stream) {
  if (ev.type === "thinking_delta") process.stdout.write(`\x1b[90m${ev.thinkingDelta}\x1b[0m`);
  if (ev.type === "text_delta") process.stdout.write(ev.delta!);
  if (ev.type === "subagent_complete") console.log(`↳ ${ev.subagent!.name} ${ev.subagent!.usage.totalTokens}`);
}
const result = await stream.result(); // AgentResponse
```

Or `agent.ask(prompt, true)` yields `string` deltas:
```ts
for await (const chunk of agent.ask("Hi", true)) process.stdout.write(chunk);
```

### 3. Tools (parallel, zod → JSON Schema)
```ts
import { Agent, tool, z } from "agent-accelerator";

const agent = new Agent({
  model: "opencode/hy3-free",
  tools: {
    get_weather: tool({
      description: "Get weather for a city",
      input: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, temp: 21, condition: "Sunny" }),
    }),
  },
});

const res = await agent.run("Weather in Delhi and Tokyo in parallel?");
// model calls both tools in one turn (parallel)
console.log(res.toolCalls, res.toolResults);
```

Custom function:
```ts
const agent2 = new Agent({ model: "google/gemini-3.5-flash", functions: [myFn] });
```

### 4. Multi-Agent Orchestration (dynamic `spawn_subagents`)

`SYSTEM_PROMPT_ORCHESTRATOR.md` (lean 4-step: Triage → Delegate → Gather `<SUB-AGENTS-RESPONSE>` → Synthesize) is auto-loaded in `examples/chat.ts`:

```ts
import * as fs from "node:fs";
const agent = new Agent({
  name: "Chat Orchestrator",
  instructions: fs.readFileSync("SYSTEM_PROMPT_ORCHESTRATOR.md","utf8"),
  model: process.env.MODEL, // opencode/hy3-free
  SubAgentModel: process.env.SUB_AGENT_MODEL, // google/gemini-3.5-flash-lite
  ThinkingLevel: "low", // none|dynamic|minimal|low|medium|high|xhigh
  EnableSubagents: true, // adds spawn_subagents tool
  cache: { retention: "long" }, // short=5m, medium=1h, long=24h → 80-90% hit
  maxTurns: 10,
});

const stream = agent.stream("Research HBM pricing + AI surge, merge into editorial report");
for await (const ev of stream) {
  if (ev.type === "subagent_complete") console.log(`↳ ${ev.subagent!.name} done`);
}
const { subagents, usage } = await stream.result();
// subagents: [{name, role, task, model, provider, durationMs, usage, text}]
```

Manual `CustomAgents` → tools:
```ts
const worker = new Agent({ name:"Worker", instructions:"You are worker", model:"opencode/hy3-free" });
const boss = new Agent({ name:"Boss", model:"opencode/hy3-free", CustomAgents: [worker] });
```

### 5. Switch Providers Without Code Change
```ts
import { ModelProvider, resolveModel } from "agent-accelerator";

// Same Agent code, different provider
const g = new Agent({ model: ModelProvider.GoogleGenAI("gemini-3.5-flash", process.env.GEMINI_API_KEY) });
const o = new Agent({ model: ModelProvider.OpenCode("hy3-free", process.env.OPENCODE_API_KEY) });
const r = new Agent({ model: ModelProvider.OpenRouter("z-ai/glm-5.2:free", process.env.OPENROUTER_API_KEY) });

// Or string
resolveModel("google/gemini-3.5-flash").modelSpec?.limit.context // 1048576
```

### 6. Prompt Caching (80-90% hit) — explicit vs implicit per `cache.retention`

```ts
// Google: explicit iff retention set, else implicit (free)
// Docs: references/gemini-documentation/context-caching.md — POST /v1beta/cachedContents {model, contents, systemInstruction, tools, ttl:"3600s"}
//       + GET/PATCH/DELETE /v1beta/cachedContents, GenerateContent {cachedContent: "cachedContents/..."}
import { createExplicitCache, getExplicitCache, listExplicitCaches, updateExplicitCache } from "agent-accelerator";

// Explicit (small prompts <4096 hit) — auto-created when retention set
const agentExplicit = new Agent({
  model: "google/gemini-3.5-flash",
  cache: { retention: "long" }, // → cachedContents (system+tools, ttl 12h, displayName accel-...), hit even for <4096
  instructions: fs.readFileSync("SYSTEM_PROMPT.md","utf8"),
});
// Implicit (free, no storage) — when no cache field
const agentImplicit = new Agent({
  model: "google/gemini-3.5-flash",
  // no cache → keeps systemInstruction+tools stable for 4096 (Gemini 3.x) / 2048 (2.5) implicit hit
});

// Unified (opencode/openrouter still explicit via cache_control + prompt_cache_key)
const agent = new Agent({
  model: "opencode/hy3-free",
  cache: { retention: "long" }, // + stable sessionId auto-generated
  instructions: fs.readFileSync("SYSTEM_PROMPT.md","utf8"),
});
await agent.run("Research HBM..."); // cold, R ~5%
const r2 = await agent.run("Summarize takeaways"); // warm
console.log(r2.usage.cachedTokens, r2.usage.inputTokens); // 8512/11763 = 72% → 93% on 3rd turn
// Internals: system+tools+history cached via cache_control (4-cap) + prompt_cache_key(64) + x-opencode-session / x-session-id
// Google explicit: cachedContent: cachedContents/... (deleted system/tools), implicit: systemInstruction+tools stable
```

### 7. Complete JSON Exposure
```ts
const json = res.toJSON();
// { text, thinking, thoughtSignature, toolCalls, toolResults, subagents, usage, responseId, model, provider, finishReason, durationMs, raw, turns }

import { countTokens } from "agent-accelerator";
countTokens({ systemPrompt: agent.instructions, messages: agent.context.messages });
```

---

## Providers

| Provider | Ids | Env | Example Models (via catalog) | Context |
|---|---|---|---|---|
| Google AI Studio | `google` | `GEMINI_API_KEY` | `gemini-3.5-flash` (1,048,576), `gemini-2.5-flash` (1,048,576) | via `limit.context` |
| OpenCode Zen/Go | `opencode`, `opencode-zen`, `opencode-go` | `OPENCODE_API_KEY` | `hy3-free` (190,000), `glm-5.2` (128,000) | via catalog |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `z-ai/glm-5.2:free` (256,000) | via catalog |

Add any `models.dev` model — no per-model code:
```ts
new Agent({ model: "openrouter/tencent/hy-mt2-30b-a3b" }) // 8192 context, auto
```

---

## Model Catalog (single source)

`src/data/models.dev.json` (minified 4.3M, 207 providers, 7487 models, `curl https://models.dev/api.json -o src/data/models.dev.json`)

```ts
import { getModelFromCatalog, getContextWindow } from "./src/models/catalog.ts";
getContextWindow("opencode","hy3-free") // 190000
getModelFromCatalog("google","gemini-3.5-flash")?.limit // {context:1048576, output:65536}
getModelFromCatalog("google","gemini-3.5-flash")?.pricing // {inputPerMillion:0.1,...}
```

`src/types/model.ts` is battle-tested 1:1 with `models.dev` (`RawModelData`, `limit`, `cost`, `reasoning_options`, `modalities`). Per-provider `src/providers/*/models.ts` are thin proxies to catalog (fallback only).

---

## Prompts (lean, pi-inspired)

Project-root `.md` (editable, stable prefix for cache):

- `SYSTEM_PROMPT.md` — default assistant (Available tools, Guidelines, stable prefix)
- `SYSTEM_PROMPT_TOOLS.md` — precise parallel tool-calling
- `SYSTEM_PROMPT_ORCHESTRATOR.md` — 4-step Triage→Delegate→Gather→Synthesize with `<SUB-AGENTS-RESPONSE>` (used by `examples/chat.ts` via `fs.readFileSync`)

`examples/chat.ts` now loads `SYSTEM_PROMPT_ORCHESTRATOR.md` instead of inline.

---

## Examples

```bash
bun run examples/multi_agent.ts  # 2-turn research → 72% hit, 6.6x speedup
bun run examples/chat.ts          # interactive, pi-style footer ↑input ↓output Rcache CH% ctx%/window
bun run examples/streaming.ts
bun run examples/function_calling.ts
bun run examples/ultimate.ts
```

`multi_agent.ts` vs `chat.ts` same prompt: both `CH72%` on 2nd turn, `93%` on 3rd (fixed metric `cached/input`).

---

## API

```ts
new Agent({
  name?, description?, instructions?, // SYSTEM_PROMPT*.md
  model?: string | ModelSpec | ModelProviderInstance, // "google/..." | "opencode/..." | "openrouter/..."
  SubAgentModel?, // inherits for spawn_subagents
  ThinkingLevel?: "none"|"dynamic"|"minimal"|"low"|"medium"|"high"|"xhigh",
  cache?: { retention?: "short"|"medium"|"long", sessionId? },
  ServiceTier?: "flex"|"priority", // standard = undefined
  EnableSubagents?: boolean,
  CustomAgents?: Agent[],
  tools?, functions?, skills?,
  maxTurns?, sessionId?, headers?, apiKey?, baseUrl?
})

agent.run(prompt, { stream?:boolean, sessionId?, additionalContext?, signal?, headers? }): Promise<AgentResponse> & AssistantMessageEventStream
agent.stream(prompt, options?): AssistantMessageEventStream // yields {type:"text_delta"|"thinking_delta"|"tool_call_complete"|"subagent_complete"|"done"}
agent.ask(prompt, true): AsyncIterable<string>
agent.reset(): void
agent.context: AgentContext // messages, systemPrompt

tool({ name?, description, input: z.object(), execute: (args, ctx) => result })
defineSkill({ name, description, instructions, tools })
countTokens(context), estimateTokensFromText(text)
createSessionId(), buildSessionHeaders(provider, cache, headers, sessionId)
```

---

## Architecture

```
Agent (instructions → systemPrompt stable)
  → AgentContext (messages, thoughtSignatures)
  → resolveModel() → catalog limit.context (190k/1M)
  → loop (maxTurns, parallel tools, subagent XML)
  → Provider (generate/stream)
      → google (parametersJsonSchema, thinkingLevel/thinkingBudget, explicit `cachedContents` if retention else implicit 4096)
      → opencode/openrouter (cache_control 4-cap + prompt_cache_key 64 + reasoning_effort)
  → AgentResponse {text, thinking, toolCalls, subagents, usage, raw}
```

`references/` is gitignored (pi copy, not pushed).

---

## Cache Performance

- **Google:** `cache: {retention:"long"}` → explicit `POST /v1beta/cachedContents` (`ttl:"43200s"`, `displayName`) → `cachedContent: cachedContents/...` (hit even <4096); no `cache` → implicit `systemInstruction`+`tools` stable for 4096/2048 hit (free, per `context-caching.md`). `createExplicitCache`/`get`/`list`/`update`/`delete` via `src/providers/google/cache.ts`.
- **OpenCode/OpenRouter:** `retention: "long"` → `cache_control ttl 1h` + `prompt_cache_retention 24h` + `prompt_cache_key` stable → 80-90% on 2nd+ turn.
- `src/utils/cache.ts` single helper, deterministic earliest large assistant (8k editorial) for stable prefix.
- `loop.ts` trims to `0.9*contextWindow - maxOutput` keep head+tail, preserve cached prefix.

---

## Typecheck & Test

```bash
npx tsc --noEmit --skipLibCheck
bun test
```

---

## License

MIT
