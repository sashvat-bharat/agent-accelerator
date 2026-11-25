# Agent Accelerator documentation

> Build, run and look after AI agents in TypeScript with one small SDK.

Agent Accelerator (`agent-accelerator`) gives you one `Agent` class for Google Gemini, OpenAI, Anthropic, OpenRouter and any OpenAI-compatible service.

It adds tools, streaming, helper agents, scheduled actions, saved sessions, spending limits and safe file handling. There are no provider SDKs to install. The only dependency is `zod`.

> **Status:** the SDK is before version 1.0. Pin an exact version. The known limits are listed honestly in [Security](guides/security.md#known-limitations).

## Start here

| You are… | Read |
|---|---|
| New | [Getting started](getting-started.md), then [How it works](how-it-works.md) |
| Looking something up | [Reference](reference.md) |
| Upgrading | [Migration](migration.md) |
| An AI agent writing code with the SDK | [For AI agents](for-ai-agents.md) and [`llms.txt`](llms.txt) |

## A first look

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  instructions: "You are a concise assistant.",
});

const res = await agent.run("Explain what a mutex is in two sentences.");
console.log(res.text);
console.log(res.usage);
```

## I want to…

| Goal | Read |
|---|---|
| Create an agent, get JSON back, edit an agent from a program | [Agents](guides/agents.md) |
| Pick a model or provider, describe a private model | [Models and providers](guides/models-and-providers.md) |
| Fix the list of models a program may use | [Allowed models](guides/allowed-models.md) |
| Set reasoning, prompt caching or a service tier | [Reasoning and caching](guides/reasoning-and-caching.md) |
| Let the model call my functions, ask for approval, add hooks | [Tools](guides/tools.md) |
| Stream the answer, steer a busy agent, make retries safe | [Streaming and steering](guides/streaming-and-steering.md) |
| Hand work to helper agents | [Sub-agents](guides/workers.md) |
| Run work later, once or on repeat | [Scheduled actions](guides/scheduled-actions.md) |
| Save and resume chats, survive a crash | [Sessions](guides/sessions.md) |
| Send images, audio, video and PDFs | [Media input](guides/media-input.md) |
| See what a run cost | [Usage and cost](guides/usage-and-cost.md) |
| Set limits, budgets, timeouts and retries | [Limits and retries](guides/limits-and-retries.md) |
| Set options in code and choose what a user may change | [Settings](guides/settings.md) |
| Handle errors and watch what the SDK does | [Errors and telemetry](guides/errors-and-telemetry.md) |
| Keep keys, files and URLs safe | [Security](guides/security.md) |
| Change the prompts the SDK sends | [Prompts](guides/prompts.md) |
| Test my own agents with no network and no cost | [Testing](guides/testing.md) |
| Make pictures, edit them, or let an agent make them | [Images](guides/images.md) |
| Make video clips | [Videos](guides/videos.md) |
| Turn text, images or audio into vectors for search | [Embeddings](guides/embeddings.md) |
| Get probabilities for yes/no, choice and rating questions | [Decisions](guides/decisions.md) |

## More

- [Reference](reference.md) lists every option, field, event, error and environment variable.
- [Scheduled action files](scheduled-action-files.md) describes the files a scheduled action writes.
- [Migration](migration.md) lists what was removed or renamed.

Runnable demos live in [`examples/`](../examples/). They call real providers and cost real tokens, except the generator demos, which run offline by default.
