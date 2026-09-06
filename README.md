# Agent Accelerator

> A thin, typed transport SDK for Google GenAI, OpenCode, and OpenRouter - engineered for ~90-95% prompt-cache hit rates and complete observability.

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "opencode/hy3-free", // Switch seamlessly to google/gemini-3.5-flash-lite or openrouter
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

* **Zero-Leak Observability:** Access complete raw JSON, HTTP wire logs, provider reasoning traces, and thought signatures (`thoughtSignature`, `thinkingSignature`, `textSignature`).
* **Cache-First Architecture:** Automatic routing for Google Gemini 3 prefix caching with thought-signature isolation, OpenRouter/OpenCode sticky `session_id` worker affinity, and Anthropic ephemeral breakpoints—achieving 50%–65%+ prompt cache hit rates.
* **First-Class Sub-Agents (Pre-Defined & Dynamic):** Clean separation of concerns between tools (`tools: { ... }`) and dedicated sub-agents (`subagents: [researcher, critic]`), plus autonomous on-the-fly spawning (`EnableSubagents: true`) with full sub-agent telemetry rollups.
* **Bulletproof Thinking Stream Extraction:** Cross-chunk rolling buffer prevents split tokens (e.g. `</th` + `ink>` or markdown headers) from leaking between `<think>` reasoning traces and final answer text.
* **Unified Model Catalog & Preflight Validation:** Single source of truth driven by `models.dev` (`7,400+` models). Automatic context limits and preflight reasoning validation (`validateModelThinking`) that fails fast with available options if an unsupported thinking mode is selected.
* **Typed Tooling:** Automatic Zod-to-JSON Schema transpilation with parallel execution via `Promise.all`.
* **Universal Responses & Completions Routing:** Seamless support for OpenAI Responses API models (e.g. `muse-spark`) and standard Completions APIs without changing application code.

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

# OpenAI or any OpenAI cURL-compatible endpoint (Ollama, vLLM, Groq, Together, etc.)
OPENAI_BASE_API_KEY=your_openai_or_custom_key   # or OPENAI_API_KEY
OPENAI_BASE_URL=https://api.openai.com/v1       # or custom cURL endpoint (e.g. http://localhost:11434/v1)

MODEL=opencode/hy3-free
SUB_AGENT_MODEL=google/gemini-3.5-flash-lite

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

### 4. Multi-Agent Delegation

Agent Accelerator provides two first-class paradigms for multi-agent workflows:

#### 4a. Pre-Defined Sub-Agents (`SubAgent`)
Create specialized sub-agents with dedicated models, personas, and optional stateless evaluation mode. Pre-defined sub-agents are automatically registered as callable tools on the parent agent:

```ts
import { Agent, SubAgent, tool, z } from "agent-accelerator";

// 1. Specialized sub-agents
const researcher = new SubAgent({
  name: "deep_researcher",
  instructions: "You are an exhaustive research specialist. Investigate quantifiable technical metrics...",
  model: "google/gemini-3.5-flash",
  cache: { retention: "short" },
});

const critic = new SubAgent({
  name: "adversarial_critic",
  instructions: "You are a skeptical devil's advocate. Expose economic bottlenecks and failure points...",
  model: "openrouter/inclusionai/ling-3.0-flash-fin:free",
  stateless: true, // One-shot evaluation: does not persist history across turns
  cache: { retention: "short" },
});

// 2. Lead Agent with clean separation: tools in `tools`, subagents in `subagents`
const lead = new Agent({
  name: "Editorial Lead",
  instructions: "Delegate research to deep_researcher, then pass findings to adversarial_critic.",
  model: "google/gemini-3.7-flash",
  tools: {
    get_brief: tool({
      description: "Fetch topic briefing",
      input: z.object({ topic: z.string() }),
      execute: async ({ topic }) => ({ topic, status: "pilot phase" }),
    }),
  },
  subagents: [researcher, critic], // Converted into callable tools: deep_researcher, adversarial_critic
});

const res = await lead.run("Commercial deployment of Solid-State Batteries in consumer EVs", {
  stream: true,
  wrapThinking: true,
  onDelta: d => process.stdout.write(d),
  onEvent: e => {
    if (e.type === "subagent_complete") {
      const s = e.subagent!;
      console.log(`\n↳ [SubAgent Completed] ${s.name} (${s.durationMs}ms • ${s.provider}/${s.model})`);
    }
  },
});
```

#### 4b. Dynamic On-the-Fly Spawning (`EnableSubagents: true`)
When tasks are open-ended, the Lead Agent can autonomously author custom instructions and spawn parallel worker sub-agents at runtime:

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  name: "Autonomous Architect",
  instructions: "Decompose complex system queries and delegate to specialized sub-agents in parallel.",
  model: process.env.MODEL,
  SubAgentModel: process.env.SUB_AGENT_MODEL, // Strictly enforces isolated worker model
  EnableSubagents: true, // Injects the `spawn_subagents` dynamic tool
  cache: { retention: "short" },
  maxTurns: 10,
});

const res = await agent.run("Audit our authentication pipeline and generate a threat model", {
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

| Provider                  | Strategy                       | Mechanism                                    | Minimum Token Gate | Verified Hit Rate |
| ------------------------- | ------------------------------ | -------------------------------------------- | ------------------ | ----------------- |
| **OpenRouter**            | Sticky Worker Affinity         | Payload `session_id` + Paged KV cache        | ~16–64 tokens      | **55% – 65%+**    |
| **OpenCode**              | Sticky Session Routing         | Payload `session_id` + `x-opencode-session`  | ~16–64 tokens      | **45% – 50%+**    |
| **Google GenAI (Gemini 3)**| Implicit Prefix Caching        | Thought Signature Isolation + Prefix Match   | ≥4,096 tokens      | **25% – 70%+**    |
| **Google GenAI (Explicit)**| Dedicated Object (`"long"`)    | `POST /v1beta/cachedContents` (TTL: 1h–12h)  | ≥32,768 tokens     | **Cost Guaranteed** |
| **Anthropic**             | Ephemeral Breakpoints          | `cache_control: { type: "ephemeral" }`       | ≥1,024 tokens      | **80% – 90%+**    |

> **Prefix Caching Note on Google Gemini 3.x:**
> Gemini 3 models (`gemini-3.7-flash`, `gemini-3.5-flash-lite`) architecturally require prompts to reach $\ge 4,096$ tokens before implicit caching engages. Agent Accelerator strictly isolates thought signatures (`thinkingSignature`, `textSignature`, `tc.thoughtSignature`) to ensure byte-for-byte prefix stability across turns without invalidating the KV cache. In production multi-agent runs starting with rich domain context, Gemini 3 achieves 65–75% hit rates. On OpenRouter/OpenCode, smaller block sizes (16–64 tokens) allow multi-turn agent loops to hit cache starting immediately on Turn 2.

---
## Model Catalog & Preflight Validation

Agent Accelerator uses `models.dev` as its catalog database to inspect model specs, pricing, context windows, and reasoning capabilities:

```ts
import { validateModelThinking, getModelThinkingInfo, ThinkingLevelError } from "agent-accelerator";

// Inspect model thinking capabilities
const info = getModelThinkingInfo("google", "gemini-3.7-flash");
console.log(info.allowedLevels); // ["low", "medium", "high"]

// Preflight validation (fails fast before network requests)
try {
  validateModelThinking("google", "gemini-3.7-flash", "low"); // Valid!
  validateModelThinking("openai", "gpt-4o", "high"); // Throws ThinkingLevelError with actionable remedy
} catch (err) {
  if (err instanceof ThinkingLevelError) {
    console.error(`Invalid thinking mode for ${err.modelId}. Allowed:`, err.allowedLevels);
  }
}
```

To update the local catalog snapshot anytime to the latest upstream model specs and pricing:
```bash
bun run update-models
```

---
## Interactive Chat CLI

Try the fully persistent multi-turn chat CLI with subagent delegation and live metrics:

```bash
bun run examples/chat.ts
```

Interactive commands during chat:
* `/model "provider/model-id"` — Switch model on the fly in double quotes (e.g. `/model "opencode/ling-3.0-flash-fin-free"`).
* `/level <lvl>` — Switch reasoning level (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `dynamic`).
* `/help` — Show available commands.
* `/exit` / `/quit` — Exit chat session.

Session state automatically persists to `.session.jsonl` after every turn and configuration change, resuming seamlessly on launch. Unified real-time telemetry (`↑in`, `↓out`, `CR`, `CW`, `CH%`, cost, context window utilization) is displayed on every turn.

---
## API Reference

### `new Agent(options)`

| Parameter                                      | Type                                                                       | Description                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `model`                                        | `string, ModelSpec, ModelProviderInstance`                                 | e.g. `"google/model-id"` or `ModelProvider.GoogleGenAI(...)`                             |
| `instructions`                                 | `string`                                                                   | System prompt — keep stable for cache                                                    |
| `subagents`                                    | `SubAgent[], Agent[]`                                                      | Pre-defined sub-agents registered as distinct callable tools                             |
| `tools`                                        | `Record<string, ToolDefinition>, ToolDefinition[]`                         | Deterministic tools (Zod → JSON Schema, parallel `Promise.all`)                           |
| `stateless`                                    | `boolean`                                                                  | Default `false`. When `true`, does not persist conversational history across turns        |
| `SubAgentModel`                                | `string, ModelSpec`                                                        | Strictly required if `EnableSubagents: true` (or via `SUB_AGENT_MODEL` env). Enforces model isolation. |
| `ThinkingLevel`                                | `"none", "dynamic", "minimal", "low", "medium", "high", "xhigh"`           | Reasoning level (generic via catalog preflight)                                          |
| `cache`                                        | `{ retention?: "implicit", "short", "medium", "long", sessionId?: string }` | `"implicit"` ($0 storage fee prefix cache), `short=5m`, `medium=1h`, `long=12h`          |
| `ServiceTier`                                  | `"flex", "priority"`                                             | `standard` = default                                                                     |
| `EnableSubagents`                              | `boolean`                                                        | Adds `spawn_subagents` tool for dynamic runtime spawning (strictly runs on `SubAgentModel`)|
| `CustomAgents`                                 | `Agent[]`                                                        | Exposed as tools (legacy alias)                                                          |
| `maxTurns`                                     | `number`                                                         | Default `10`                                                                             |
| `sessionId` / `headers` / `apiKey` / `baseUrl` | `string`                                                         | Overrides                                                                                |

**`agent.run(prompt, opts)`** `stream?: boolean` `wrapThinking?: boolean` (`<think>…</think>` + blank line) `onDelta?` `onThinkingDelta?` `onEvent?` `signal?` `sessionId?` `additionalContext?`

---
### `new SubAgent(options)`

Extends `Agent` with defaults optimized for modular sub-agent pipelines:
* Resolves `model` from `config.model ?? process.env.SUB_AGENT_MODEL ?? process.env.MODEL`. Strictly throws an actionable error if no model is provided (zero silent fallback models).
* Defaults `cache` to `{ retention: "short" }` with child session affinity.
* Exposes `.asTool(name?, desc?)` and `.toTool()` for fluent registration.

---
### `AgentResponse` Properties

* **`text`**: Complete decoded output string.
* **`thinking`**: Extracted reasoning tokens and trace.
* **`thoughtSignature`**: Provider reasoning signatures (persisted automatically for Gemini 3.x multi-turn replay).
* **`thinkingSignature` / `textSignature`**: Part-level signatures preserved for KV cache stability.
* **`toolCalls` / `toolResults`**: Structured logs of all tool interactions.
* **`subagents`**: Array of `SubAgentExecutionMetadata` (name, task, model, provider, durationMs, usage, cost, turns, text, thinking).
* **`model` / `provider`**: Resolved model identifier and provider string.
* **`usage`**: `{ inputTokens, outputTokens, cachedTokens, cacheReadTokens, thinkingTokens, cost }`.
* **`raw`**: Unmodified HTTP request and response envelopes `{ request, response }`.

---
## Repository Structure

```
src/
├── agent/       # Agent context, main execution loop, subagent class, and delegation tools
├── providers/   # Single-file provider modules (google.ts, openai.ts, opencode.ts, openrouter.ts, custom.ts)
├── models/      # Catalog parser and context resolution
├── data/        # models.dev database snapshot (gitignored, updated via bun run update-models)
├── tools/       # Zod schemas, wrappers, and parallel executor
├── streaming/   # SSE parser and typed event stream emitters (cross-chunk rolling buffer)
├── tokens/      # Context window and token utilization counters
└── utils/       # Cache control, wire headers, and session handlers
```

---
## Development & Testing

```bash
bun run typecheck              # Typecheck
bun test                       # Run full test suite (64 unit tests)
bun run update-models          # Refresh models.dev catalog snapshot
bun run examples/sub-agents.ts # Multi-agent research & critique pipeline with cache telemetry
bun run examples/chat.ts       # Run interactive CLI session
bun run examples/multi_agent.ts# Run dynamic sub-agent delegation demo
bun run examples/metadata.ts   # Full metadata & wire inspection demo
```

---
## License

Not yet decided :)

---