# Agent Accelerator Documentation

> Build, run and operate AI agents with one small TypeScript SDK. Written to be read by humans and implemented from by AI agents.

Agent Accelerator (`agent-accelerator`) gives you **one `Agent` class** over Google Gemini, OpenAI, OpenRouter and any OpenAI-compatible endpoint, plus tools, streaming, sub-agents, scheduled actions, durable sessions, budgets, telemetry and safe file/URL handling. No provider SDKs; the only runtime dependency is `zod`.

> **Status:** pre-1.0. Pin an exact version. Current limits are listed honestly in [Safety and operations](guides/safety-and-ops.md#known-limitations).

## Start here

| You are... | Read |
|---|---|
| New | [Getting started](getting-started.md) |
| An AI agent | [For AI agents](for-ai-agents.md) and [`llms.txt`](llms.txt) |
| Looking something up | [Reference](reference.md) |

## 60 seconds

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  instructions: "You are a concise assistant.",
});

const res = await agent.run("Explain what a mutex is in two sentences.");
console.log(res.text);
console.log(res.usage);
```

## I want to...

| Goal | Page |
|---|---|
| Run a model, pick a provider or endpoint, set reasoning, caching, JSON output | [Agents and models](guides/agents-and-models.md) |
| Let the model call my functions, stream the answer, redirect a busy agent | [Tools and streaming](guides/tools-and-streaming.md) |
| Split work across helper agents, or run work later on a schedule | [Multi-agent and scheduling](guides/multi-agent.md) |
| Save/resume chats, send images and PDFs, track cost, manage the model catalog | [Data and media](guides/data-and-media.md) |
| Set limits, budgets, retries; handle errors; observe; keep things safe | [Safety and operations](guides/safety-and-ops.md) |

## Pages

- [Getting started](getting-started.md): install, keys, first agent, core ideas.
- Guides: [Agents and models](guides/agents-and-models.md) · [Tools and streaming](guides/tools-and-streaming.md) · [Multi-agent and scheduling](guides/multi-agent.md) · [Data and media](guides/data-and-media.md) · [Safety and operations](guides/safety-and-ops.md)
- [Reference](reference.md): every config key, run option, response field, event, error and environment variable.
- [For AI agents](for-ai-agents.md): decision table, hard rules, what does not exist, error-to-fix lookup.

Each guide ends with a **For AI agents** section (exact signatures, defaults, gotchas). All TypeScript snippets are complete programs and are type-checked against the SDK; ones that call a model need a provider key and cost real tokens. Runnable demos live in [`examples/`](../examples/).
