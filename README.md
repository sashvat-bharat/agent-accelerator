# Agent Accelerator

[![npm version](https://img.shields.io/npm/v/agent-accelerator.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/agent-accelerator)
[![GitHub](https://img.shields.io/badge/GitHub-sashvat--bharat%2Fagent--accelerator-blue?logo=github)](https://github.com/sashvat-bharat/agent-accelerator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docs](https://img.shields.io/badge/docs-online-black?logo=vercel)](https://agent-accelerator-sdk.vercel.app/)

> **Stability notice:** Pre-1.0 and under active development. Public APIs, provider transports and configuration options may change in breaking ways between releases. Pin an exact version for production.

A small, typed SDK for building LLM agents in TypeScript. One `Agent` class works with Google Gemini, OpenAI, Anthropic, OpenRouter and any OpenAI-compatible service. It uses plain `fetch`. There are no provider SDKs, and the only dependency is `zod`.

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  instructions: "You are a concise research engineer.",
});

const res = await agent.run("Explain HBM pricing in 3 bullets.");
console.log(res.text);
console.log(res.usage); // tokens and cost
```

## What you get

- **One interface for every provider.** Write the model as `provider/model`. Provider differences stay inside the SDK.
- **Tools** that the model can call, with checked arguments, retries, approval and hooks.
- **Streaming and steering**, so you can change what a busy agent is doing.
- **Helper agents**, either fixed ones you define or ones the model starts, plus **scheduled actions** that run later.
- **Saved sessions** that survive a crash and continue where they stopped.
- **Spending control**: limits, budgets, and the cost of every run, per agent and per worker.
- **Pictures, video, embeddings and decisions** through the same providers.
- **Safe by default**: keys never reach another vendor, local files stay inside folders you choose, and nothing prints unless you listen.

## Install

```bash
bun add agent-accelerator zod
```

The SDK needs [Bun](https://bun.sh). It ships TypeScript source, so there is no build step. `zod` is a peer dependency: install it next to the SDK and import `z` from `"zod"`.

## Add a key

Put the key of the provider you use in your environment. Bun loads a `.env` file for you.

```bash
GEMINI_API_KEY=...       # google/...
OPENAI_API_KEY=...       # openai/...
ANTHROPIC_API_KEY=...    # anthropic/...
OPENROUTER_API_KEY=...   # openrouter/...
GROQ_API_KEY=...         # any other prefix, such as groq/..., plus its address
```

The environment holds keys and nothing else. Every other option is set in code. An OpenAI-compatible service also needs its address:

```ts
import { setConfigs } from "agent-accelerator";

setConfigs({ values: { base_urls: { groq: "https://api.groq.com/openai/v1" } } });
```

## Give the agent a tool

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
  maxTurns: 10,
});

const res = await agent.run("Is it warm in Lisbon right now?");
console.log(res.text);
```

## Read the docs

The full documentation is online at [agent-accelerator-sdk.vercel.app](https://agent-accelerator-sdk.vercel.app/) and in [`docs/`](docs/README.md) as plain Markdown. Start with [Getting started](docs/getting-started.md) and [How it works](docs/how-it-works.md).

| I want to… | Read |
|---|---|
| Create an agent and get JSON back | [Agents](docs/guides/agents.md) |
| Pick a model or provider | [Models and providers](docs/guides/models-and-providers.md) |
| Let the model call my functions | [Tools](docs/guides/tools.md) |
| Stream the answer or steer a busy agent | [Streaming and steering](docs/guides/streaming-and-steering.md) |
| Hand work to helper agents | [Sub-agents](docs/guides/workers.md) |
| Save and resume chats, survive a crash | [Sessions](docs/guides/sessions.md) |
| Set limits and see what a run cost | [Limits and retries](docs/guides/limits-and-retries.md), [Usage and cost](docs/guides/usage-and-cost.md) |
| Keep keys, files and URLs safe | [Security](docs/guides/security.md) |
| Test my agents with no network and no cost | [Testing](docs/guides/testing.md) |
| Look up an option, field, event or error | [Reference](docs/reference.md) |
| Upgrade from an older version | [Migration](docs/migration.md) |

Preview the docs as a site with `bun run docs:dev`.

## Examples

The [`examples/`](examples/) folder has runnable demos, such as `examples/05-chat.ts` (a chat in the terminal), `examples/02-function_calling.ts` and `examples/15-durable-agent.ts`. They call real providers and cost real tokens, except the generator demos, which run offline by default.

```bash
bun run examples/05-chat.ts
```

## Develop

```bash
bun install
bun run update-models   # once: downloads the model catalog cache
bun run typecheck       # tsc over everything, then over src/ with isolatedDeclarations
bun run lint            # Biome: 0 errors required
bun run format          # Biome formatter
bun test                # the whole suite, fully mocked, no network
bun run docs:check      # links, anchors and every docs example
```

How the source is organised is in [`src/architecture.md`](src/architecture.md). Every folder under `src/` has its own `architecture.md`.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Sashvat Bharat.
