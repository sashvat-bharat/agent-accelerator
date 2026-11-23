# How it works

> The few ideas behind the SDK. Read this once and the guides will make sense.

## A run

You send a prompt. The model answers, or asks to call one of your tools. The SDK runs the tools, sends the results back, and the model continues. This repeats until the model gives a final answer.

```text
your prompt → model → tool calls → your functions → results → model → … → final answer
```

- Each model call is a **turn**. A run is all the turns until the final answer.
- A run ends with a `finishReason`: usually `"stop"`. It can also be `"max_turns"`, `"stopped"` (a tool ended it), `"length"` and a few others.
- An `Agent` does one run at a time. A second call while it is busy is steered into the run or queued behind it. See [Streaming and steering](guides/streaming-and-steering.md).

## The conversation

An agent keeps its conversation (the **session**) in memory. You can save it to disk and continue it later, even after a crash. See [Sessions](guides/sessions.md).

Most providers need the whole history on every turn, so the SDK sends it again each time. Google can keep the conversation on its side for a while, and the SDK uses that. The history is the same for every provider, so you can switch providers in the middle of a chat.

## Providers

You write a model as `provider/model`, such as `google/gemini-3.5-flash-lite`. The SDK talks to each provider over its own native API, with plain `fetch` and no provider libraries. Differences between providers stay inside the SDK. If an option does not exist on a provider, the SDK drops it and tells you on the telemetry bus. See [Models and providers](guides/models-and-providers.md).

## Workers

An agent can hand work to other agents:

- **Fixed workers** are agents you define. Each one becomes a tool.
- **Dynamic workers** are started by the model while it runs, with one built-in tool.
- **Scheduled actions** are workers that run later and save their answer to a file.

You decide the worker model, tools and limits. The model never chooses them. See [Workers](guides/workers.md) and [Scheduled actions](guides/scheduled-actions.md).

## The home folder

Everything the SDK saves lives in one folder, `.agent-accel/` by default: sessions, scheduled actions, logs and the model catalog. Move it with `setHome(dir)`. Nothing is written anywhere else unless you pass a path yourself.

## Limits

Nothing that costs money or stops your work is limited until you say so. The only defaults are three network timeouts, so a silent connection fails instead of hanging. Set `maxTurns`, `budget` and a `signal` for anything that runs unattended. See [Limits and retries](guides/limits-and-retries.md).

## Cost

The SDK reports cost per run and per agent. If a price is unknown, the cost is `undefined`. It is never reported as zero. See [Usage and cost](guides/usage-and-cost.md).

## Telemetry

The SDK prints nothing. Warnings, traces and lifecycle events go to `telemetryBus`. Attach a listener to see them, or turn on `telemetry: { persist: true }` to keep them in files. See [Errors and telemetry](guides/errors-and-telemetry.md).

## Errors

Every error is a typed class with a one-line message, a `code` and a `retryable` flag. Branch on the class, never on the message text.
