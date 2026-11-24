# Getting started

> Install the SDK, add one API key and run your first agent in about five minutes.

## 1. Install

```bash
bun add agent-accelerator zod
```

The SDK needs [Bun](https://bun.sh). It ships TypeScript source, so there is no build step. `zod` is installed next to it because you use it to describe what your tools accept.

## 2. Add an API key

Create a `.env` file in your project. Bun loads it for you.

```bash
GEMINI_API_KEY=your-key-here
```

Every provider has its own key and its own way to write the model name. Always write the model as `provider/model`:

| Provider | Model example | Key |
|---|---|---|
| Google Gemini | `google/gemini-3.5-flash-lite` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| OpenAI | `openai/gpt-5.5` | `OPENAI_API_KEY` |
| Anthropic | `anthropic/claude-sonnet-5-5` | `ANTHROPIC_API_KEY` |
| OpenRouter | `openrouter/z-ai/glm-5.3-flash` | `OPENROUTER_API_KEY` |
| Any OpenAI-compatible service (Groq, Ollama…) | `groq/llama-3.3-70b-versatile` | `GROQ_API_KEY`, plus its address (see below) |

The environment holds API keys and nothing else. Every other setting is set in code. For an OpenAI-compatible service, tell the SDK where it lives:

```ts
import { setConfigs } from "agent-accelerator";

setConfigs({ values: { base_urls: { groq: "https://api.groq.com/openai/v1" } } });
```

## 3. Run your first agent

Save this as `agent.ts` and run it with `bun run agent.ts`:

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  instructions: "You are a concise assistant.",
});

const res = await agent.run("Explain what a mutex is in two sentences.");
console.log(res.text); // the answer
console.log(res.usage.totalTokens); // tokens used
console.log(res.finishReason); // "stop" when it finished normally
```

`instructions` tells the model how to behave. `run()` sends your message, waits for the whole answer and gives you an `AgentResponse`.

## 4. Stream the answer

To show the answer as it is written, use `stream()`:

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({ model: "google/gemini-3.5-flash-lite" });

const stream = agent.stream("Write a haiku about caching.");
for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta ?? "");
}
const final = await stream.result();
console.log(`\n${final.turns} turn(s)`);
```

Each `event` is one small piece of the run. `stream.result()` gives the same `AgentResponse` that `run()` gives.

## 5. Give the agent a tool

A tool is a function you write. The model reads its description and decides when to call it. Your function runs on your machine and its result goes back to the model.

```ts
import { Agent, tool } from "agent-accelerator";
import { z } from "zod";

const get_weather = tool({
  description: "Get the current weather for a city.",
  input: z.object({ city: z.string().describe("City name") }),
  execute: async ({ city }) => ({ city, tempC: 21, sky: "clear" }),
});

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  tools: { get_weather },
});

const res = await agent.run("Is it warm in Lisbon right now?");
console.log(res.text);
console.log(res.toolResults.map((r) => `${r.name} took ${r.durationMs}ms`));
```

`input` is a `zod` schema. The SDK checks the model's arguments against it before your function runs.

## 6. Try it without a key

You can run the same code with no key, no network and no cost. `fauxProvider` is a scripted model that answers with what you write:

```ts
import { Agent, fauxProvider } from "agent-accelerator";

const faux = fauxProvider(["Hello from a scripted model!"]);
const agent = new Agent({ ...faux.config });

const res = await agent.run("Hi");
console.log(res.text); // "Hello from a scripted model!"
```

It is made for tests: see [Testing your agents](guides/testing.md).

## If something goes wrong

| You see | What it means | Fix |
|---|---|---|
| `Missing Google API key. Set GEMINI_API_KEY…` | The key for that provider is missing. | Add it to `.env`, or pass `apiKey` to the `Agent`. |
| `No model specified…` | The `Agent` has no model. | Pass `model`, or set a default list with `setModels()`. |
| `Missing base URL for "groq"…` | An OpenAI-compatible service has no address. | Set `base_urls.groq` as in step 2, or pass `baseUrl`. |
| `ProviderError … request failed (404)` | The provider does not know that model name. | Check the spelling of the model. |

Every error the SDK throws is a typed class with a one-line message. See [Errors and telemetry](guides/errors-and-telemetry.md).

## The main ideas

| Idea | In plain English |
|---|---|
| **Agent** | One model with its instructions, its tools and its conversation. |
| **Run** | One call to `agent.run()`. The model may call tools and think again before it gives a final answer. |
| **Turn** | One model call inside a run. |
| **Tool** | A function you write. The model decides when to call it. |
| **Session** | The conversation so far. Keep it in memory, or save it and continue later. |
| **Worker** | A helper agent that your agent can hand work to. Also called a sub-agent. |
| **Scheduled action** | A worker that runs later and saves its answer to a file. |
| **Telemetry bus** | A place to listen for warnings and traces from inside the SDK. |

## Next

- Understand the pieces: [How it works](how-it-works.md)
- Choose a model, set reasoning or caching: [Models and providers](guides/models-and-providers.md), [Reasoning and caching](guides/reasoning-and-caching.md)
- Tools, streaming, steering a busy agent: [Tools](guides/tools.md), [Streaming and steering](guides/streaming-and-steering.md)
- Helper agents and schedules: [Sub-agents](guides/workers.md), [Scheduled actions](guides/scheduled-actions.md)
- Go to production: [Limits and retries](guides/limits-and-retries.md), [Security](guides/security.md)
- Runnable demos: [`examples/`](../examples/)
