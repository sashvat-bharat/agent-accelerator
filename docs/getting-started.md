# Getting started
[Docs](README.md) › Getting started

> Install, set one API key and run your first agent in about five minutes.

## 1. Install

```bash
bun add agent-accelerator
```

Built for Bun (it ships TypeScript source, no build step). The only runtime dependency is `zod`. Optional: `bun add @firecrawl/anydoc` lets models without native file input read PDF/Word/Excel files (see [Data and media](guides/data-and-media.md)).

## 2. Set a key and a model

Put one provider key in `.env` (Bun loads it automatically):

| Provider | Example model string | Key |
|---|---|---|
| Google Gemini | `google/gemini-3.5-flash-lite` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| OpenAI | `openai/gpt-4o` | `OPENAI_API_KEY` |
| OpenRouter | `openrouter/z-ai/glm-5.3-flash` | `OPENROUTER_API_KEY` |
| Any OpenAI-compatible (Groq, Ollama...) | `groq/llama-3.3-70b-versatile` | `GROQ_API_KEY` + `GROQ_BASE_URL` (local endpoints may omit the key) |

`MODEL` is used when you do not pass `model`; `SUB_AGENT_MODEL` is the default worker model. **Explicit config always beats environment variables.**

## 3. Your first agent

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  instructions: "You are a concise assistant.",
});

const res = await agent.run("Explain what a mutex is in two sentences.");
console.log(res.text); // the answer
console.log(res.usage.totalTokens); // tokens used
console.log(res.finishReason); // "stop" when it finished normally
```

## 4. Stream the answer

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({ model: process.env.MODEL ?? "google/gemini-3.5-flash-lite" });

const stream = agent.stream("Write a haiku about caching.");
for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta ?? "");
}
const final = await stream.result();
console.log(`\n${final.turns} turn(s)`);
```

## 5. Give it a tool

```ts
import { Agent, tool, z } from "agent-accelerator";

const get_weather = tool({
  description: "Get the current weather for a city.",
  input: z.object({ city: z.string().describe("City name") }),
  execute: async ({ city }) => ({ city, tempC: 21, sky: "clear" }),
});

const agent = new Agent({
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  tools: { get_weather },
});

const res = await agent.run("Is it warm in Lisbon right now?");
console.log(res.text);
console.log(res.toolResults.map((r) => `${r.name} took ${r.durationMs}ms`));
```

## Core ideas

| Idea | Plain English |
|---|---|
| **Agent** | One configured model plus its instructions, tools and conversation history. |
| **Run / turn** | `run()` loops: model answers, maybe calls tools, model continues, until it gives a final answer. Each model call is a *turn*. |
| **Tool** | A function you write; the model decides when to call it. |
| **Response** | `AgentResponse`: text, usage, tool calls, finish reason. |
| **Session** | The conversation history; keep it in memory, or save it to disk and resume. |
| **Sub-agent** | A helper agent the main agent can delegate to (fixed ones you define, or dynamic ones it spawns). |
| **Scheduled action** | A sub-agent that runs later and delivers a file. |
| **Telemetry bus** | `telemetryBus.onEvent(...)`: warnings and traces from inside the SDK. |

## Next

- Choose models, reasoning, caching, JSON output: [Agents and models](guides/agents-and-models.md)
- Tools, streaming, steering: [Tools and streaming](guides/tools-and-streaming.md)
- Helper agents and schedules: [Multi-agent and scheduling](guides/multi-agent.md)
- Production checklist: [Safety and operations](guides/safety-and-ops.md)
- Runnable demos: [`examples/`](../examples/)
