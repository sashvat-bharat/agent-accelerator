# Agent Accelerator

> A thin, typed transport SDK for Google GenAI, OpenCode, and OpenRouter - engineered for ~90-95% prompt-cache hit rates and complete observability.

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "opencode/hy3-free", // Switch seamlessly to google/gemini-2.5-flash or openrouter
  instructions: "You are a concise research engineer.",
  cache: { retention: "long" }, // Deterministic 80-90% cache hits on multi-turn runs
});

const { text, usage, raw } = await agent.run("Explain HBM pricing in 3 bullets");
console.log(text);
console.log(`Cache Efficiency: ${usage.cachedTokens} / ${usage.inputTokens}`);
// Full access to raw.request & raw.response headers, payloads, and signatures

```

---
## Key Capabilities

* **Zero-Leak Observability:** Access complete raw JSON, HTTP wire logs, provider reasoning traces, and thought signatures (`thoughtSignature`).
* **Cache-First Architecture:** Automatic routing for Google explicit `cachedContents`, OpenCode session pinning, and Anthropic-style ephemeral breakpoints.
* **Unified Model Catalog:** Single source of truth driven by `models.dev` (`7,400+` models). Automatic context window verification and dynamic truncation without manual drift.
* **First-Class Sub-Agents:** Native parallel dispatch (`spawn_subagents`) with structured XML reconciliation (`<SUB-AGENTS-RESPONSE>`).
* **Typed Tooling:** Automatic Zod-to-JSON Schema transpilation with parallel execution via `Promise.all`.

---
## Architectural Comparison

| Feature                | Standard Provider SDKs              | Agent Accelerator                                         |
| ---------------------- | ----------------------------------- | --------------------------------------------------------- |
| **Multi-Provider API** | Fragmented interfaces & types       | Unified `Agent` interface across all targets              |
| **Observability**      | SDK abstracts/strips wire payloads  | Full access to `raw.request`, `raw.response`, and headers |
| **Prefix Caching**     | Manual header crafting per provider | Automatic cache-key management & session affinity         |
| **Context Limits**     | Hardcoded or runtime guesswork      | Live catalog resolution (`src/data/models.dev.json`)      |
| **System Prompts**     | Hardcoded strings in code           | Versioned root Markdown files for cache stability         |

---
## Installation & Setup

```bash
bun add agent-accelerator
# or via npm / pnpm
pnpm add agent-accelerator
```

Configure your environment variables:

```bash
# .env.local
GEMINI_API_KEY=your_gemini_key
OPENCODE_API_KEY=your_opencode_key
OPENROUTER_API_KEY=your_openrouter_key

MODEL=opencode/hy3-free
SUB_AGENT_MODEL=google/gemini-2.5-flash

```

---
## Core Usage

### 1. Basic Execution & Metadata

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash",
  instructions: "Be direct and technical.",
});

const res = await agent.run("Explain lock contention in concurrent systems.");

console.log(res.text);
console.log(res.usage); // { inputTokens, outputTokens, cachedTokens, thinkingTokens, cost }
console.log(res.raw.request.headers); // Audit wire headers
```

### 2. Streaming & Thought Traces

```ts
// One-liner — no manual loop, <think> auto-wrapped
const res = await agent.run("Design an append-only commit log", {
  stream: true,
  wrapThinking: true, // → <think>\n...\n</think>\n\n before answer
  onThinkingDelta: d => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
  onDelta: d => process.stdout.write(d),
  onEvent: e => { if (e.type === "subagent_complete") console.log(`\n↳ ${e.subagent!.name} done`); }
});
// thinking → res.thinking, answer → res.text (separate channels, any model)
```

### 2.5 Manual for-await (advanced)

```ts
const stream = agent.stream("Design an append-only commit log");
for await (const event of stream) {
  if (event.type === "thinking_delta") process.stdout.write(`\x1b[90m${event.thinkingDelta}\x1b[0m`);
  if (event.type === "text_delta") process.stdout.write(event.delta!);
}
const finalResponse = await stream.result();
```

### 3. Parallel Tool Execution

```ts
import { Agent, tool, z } from "agent-accelerator";

const agent = new Agent({
  model: "opencode/hy3-free",
  tools: {
    fetch_metrics: tool({
      description: "Fetch real-time cluster metrics",
      input: z.object({ clusterId: z.string() }),
      execute: async ({ clusterId }) => ({ clusterId, load: 0.42, status: "healthy" }),
    }),
  },
});

const res = await agent.run("Fetch metrics for cluster-a and cluster-b simultaneously");
console.log(res.toolCalls, res.toolResults);
```

### 4. Multi-Agent Orchestration

```ts
import * as fs from "node:fs";
import { Agent } from "agent-accelerator";

const orchestrator = new Agent({
  name: "Orchestrator",
  instructions: fs.readFileSync("SYSTEM_PROMPT_ORCHESTRATOR.md", "utf8"),
  model: process.env.MODEL,
  SubAgentModel: process.env.SUB_AGENT_MODEL,
  ThinkingLevel: "low",
  EnableSubagents: true,
  cache: { retention: "long" },
  maxTurns: 10,
});

const res = await orchestrator.run("Audit our authentication pipeline and generate a threat model", {
  stream: true,
  wrapThinking: true,
  onDelta: d => process.stdout.write(d),
});
const { subagents, usage } = res;
```

---
## Caching Mechanics

Agent Accelerator organizes prompt prefixes to maximize key stability:

```
Turn 1 (Cold Initialization)
┌─────────────────────────────────────────────────────────┐
│ System Prompt + Tool Definitions (Stable Prefix)        │
│ User Prompt: Analyze architecture performance           │
│ Assistant Output: Analysis payload                      │
└─────────────────────────────────────────────────────────┘
  ↳ Cache Hit: ~5%

Turn 2 (Warm Context)
┌─────────────────────────────────────────────────────────┐
│ System Prompt + Tool Definitions (Stable Prefix)        │ ← [CACHED]
│ Assistant Output: Analysis payload                      │ ← [CACHED ANCHOR]
│ User Prompt: Drill down into step 2                     │ ← [NEW DELTA]
└─────────────────────────────────────────────────────────┘
  ↳ Cache Hit: 72% – 93%
```

| Provider                  | Strategy                       | Mechanism                                    | Small Prompt Support       |
| ------------------------- | ------------------------------ | -------------------------------------------- | -------------------------- |
| **Google GenAI**          | Explicit (`retention: "long"`) | `POST /v1beta/cachedContents` (TTL: 12h)     | Yes                        |
| **Google GenAI**          | Implicit (Default)             | In-memory prefix matching                    | Requires ≥2048–4096 tokens |
| **OpenCode / OpenRouter** | Ephemeral Breakpoints          | `cache_control` headers + `prompt_cache_key` | Yes                        |

---
## API Reference

### `new Agent(options)`

| Parameter                                      | Type                                                             | Description                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `model`                                        | `string, ModelSpec, ModelProviderInstance`                       | e.g. `"google/model-id"` or `ModelProvider.GoogleGenAI(...)`   |
| `instructions`                                 | `string`                                                         | System prompt — keep stable for cache                          |
| `SubAgentModel`                                | `string, ModelSpec`                                              | Model for `spawn_subagents` (inherits `ThinkingLevel`/`cache`) |
| `ThinkingLevel`                                | `"none", "dynamic", "minimal", "low", "medium", "high", "xhigh"` | Reasoning level (generic via catalog)                          |
| `cache`                                        | `{ retention?: "short", "medium", "long", sessionId?: string }`  | `short=5m` `medium=1h` `long=12h`                              |
| `ServiceTier`                                  | `"flex", "priority"`                                             | `standard` = default                                           |
| `EnableSubagents`                              | `boolean`                                                        | Adds `spawn_subagents` tool                                    |
| `CustomAgents`                                 | `Agent[]`                                                        | Exposed as tools                                               |
| `tools` / `functions` / `skills`               | `ToolDefinition[]`                                               | Zod → JSON Schema, parallel `Promise.all`                      |
| `maxTurns`                                     | `number`                                                         | Default `10`                                                   |
| `sessionId` / `headers` / `apiKey` / `baseUrl` | `string`                                                         | Overrides                                                      |

**`agent.run(prompt, opts)`** `stream?: boolean` `wrapThinking?: boolean` (`<think>…</think>` + blank line) `onDelta?` `onThinkingDelta?` `onEvent?` `signal?` `sessionId?` `additionalContext?`

---
### `AgentResponse` Properties

* **`text`**: Complete decoded output string.
* **`thinking`**: Extracted reasoning tokens and trace.
* **`thoughtSignature`**: Provider reasoning signatures (persisted automatically for Gemini 2.5/3.x).
* **`toolCalls` / `toolResults**`: Structured logs of all tool interactions.
* **`subagents`**: Metadata array of sub-agent durations, tokens, and outputs.
* **`usage`**: `{ inputTokens, outputTokens, cachedTokens, thinkingTokens, cost }`.
* **`raw`**: Unmodified HTTP request and response envelopes `{ request, response }`.

---
## Repository Structure

```
src/
├── agent/       # Agent context, main execution loop, and orchestrator
├── providers/   # Provider adapters (Google, OpenCode, OpenRouter)
├── models/      # Catalog parser and context resolution
├── data/        # models.dev database snapshot
├── tools/       # Zod schemas, wrappers, and parallel executor
├── streaming/   # SSE parser and typed event stream emitters
├── tokens/      # Context window and token utilization counters
└── utils/       # Cache control, wire headers, and session handlers

```

---
## Development & Testing

```bash
npx tsc --noEmit --skipLibCheck # Typecheck
bun test # Run test suite
bun run examples/chat.ts # Run interactive CLI session
```

---
## License

Not yet decided :)

---