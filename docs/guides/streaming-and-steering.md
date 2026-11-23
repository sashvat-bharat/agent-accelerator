# Streaming and steering

> Watch the answer arrive, redirect an agent that is busy, and make retried messages safe.

## Stream an answer

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({ model: "google/gemini-3.5-flash-lite" });
const abort = new AbortController();

const res = await agent.run("Explain event loops.", {
  stream: true, // still awaitable, and also async-iterable
  signal: abort.signal, // cancels the provider call, tools and workers
  onThinkingDelta: (d) => process.stdout.write(d),
  onDelta: (d) => process.stdout.write(d),
  onEvent: (e) => {
    if (e.type === "tool_result") console.log(`\n[tool ${e.toolResult?.name}]`);
  },
});
console.log(`\n${res.usage.outputTokens} output tokens`);
```

There are three ways to stream:

| Way | You get |
|---|---|
| `agent.stream(prompt)` | An event stream you loop over with `for await`. |
| `agent.run(prompt, { stream: true, onDelta })` | Callbacks, and a promise for the final response. |
| `agent.ask(prompt, true)` | Plain text pieces. |

A stream also has `on(type, fn)`, `off`, `result()`, `cancel()`, `onCancel()` and `isCancelled()`. Always `await stream.result()` for the final `AgentResponse`. Breaking out of a `for await` loop cancels the HTTP request.

The main event types are `text_delta`, `thinking_delta`, `tool_start`, `tool_call_complete`, `tool_result`, `tool_end`, `subagent_delta`, `subagent_complete`, `steer_injected`, `queued`, `usage`, `done` and `error`. The full table is in the [Reference](../reference.md#stream-events).

- Buffers are bounded: 1,000 events and about 1 MB per delta. An overflow is reported on the telemetry bus.
- Streams have two timeouts: `limits.firstByteTimeoutMs` and `limits.streamIdleTimeoutMs`.
- A transient failure is retried only before the first byte arrives.
- Always pass a `signal` for streams that a user watches. To show a stream in a browser, forward the events as Server-Sent Events.

## Steer, queue or interrupt

While an agent is busy, a new message can join the run, wait for its turn, or replace the run.

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  midSession: { whenBusy: "auto", maxQueued: 10 },
});

const long = agent.run("Research the history of databases."); // running
const steered = agent.steer("Focus only on the 1990s."); // joins the SAME run
const next = agent.queue("Then give me a 3-bullet summary."); // runs after it

console.log((await long).text);
console.log((await steered).text); // the same response as the run it joined
console.log((await next).text); // its own run and response
```

| Call | What happens |
|---|---|
| `steer(prompt)` | Joins the active run after the current model or tool step. One response, the same turn budget. On an idle agent it works like `run`. |
| `queue(prompt)` | Starts a new run when the current one ends. Throws when `maxQueued` (default 20) is full. |
| `interrupt()` | Aborts the active run now. The run rejects with `AbortError` and keeps its partial result. Does nothing on an idle agent. |
| `interrupt(message)` | Aborts the active run and starts `message` as the next run, ahead of every queued message. Works in every mode, even when the queue is full. On an idle agent it works like `run`. |
| `clearQueue()` | Rejects every queued message. |
| `stream(prompt, { enqueue })` | The streaming versions. `enqueue` is `"steer"`, `"queue"` or `"interrupt"`. `run(prompt, { enqueue })` takes the same values. |

`midSession: { whenBusy: "steer" | "queue" | "auto" }` can allow only one of the two. The other call then throws. `isBusy`, `pendingCount` and `steerPendingCount` show the state.

- A steer that arrives after the run ended becomes a queued message. It goes to the front of the queue, because it was typed before anything queued later. Its promise resolves with the response of the run that picked it up.
- With `persist: { dir }`, messages that are still waiting are saved with the session, so a crash does not lose something the user already typed.

## Run a prompt only once

Webhooks and timers sometimes fire twice. Give each prompt an id, and the second call will not run again:

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({ model: "google/gemini-3.5-flash-lite" });

await agent.run("Summarize today's tickets", { requestId: "daily-2026-11-22" });
await agent.run("Summarize today's tickets", { requestId: "daily-2026-11-22" });
// The second call returns the first result. No new model call is made.
```

- `requestId` works with `run`, `queue`, `steer` and `ask`. It does not work with `stream`.
- It is a string of 1 to 200 characters.
- A failed or aborted call is forgotten, so retrying it with the same id runs again.
- The agent remembers the last 1,000 ids, and only while the process is running. After a restart, use `resume()` for a run that was cut off. See [Sessions](sessions.md).
- The same id with a different prompt still returns the first result, and warns with `agent.request_id_reused`. Every repeat emits `agent.duplicate_request`.

## What an interrupt stops

An interrupt cancels the work, not only your wait for it.

- **The model call.** The provider request is aborted, which closes the connection. A streaming body is cancelled too, so the SDK stops reading and tokens stop arriving.
- **Tools.** A running tool gets `ctx.signal` aborted. The run does not wait for a tool that ignores the signal. It continues at once, and that tool finishes in the background with its result dropped. A call that never got a result is repaired in the history with an error result that says it was interrupted.
- **Workers.** A running `subagents` or `agent.workers` call is aborted with the run, and the worker stays open.
- **History.** The prompt of the interrupted run and any finished tool work are kept. The unfinished answer is not stored.
- **Order with `interrupt(message)`.** The message runs first. A steer typed before the interrupt that missed the aborted run, and queued messages, run after it in their order.
- **Streaming.** `interrupt(message)` is not streaming. For a stream, use `stream(message, { enqueue: "interrupt" })`. The stream that was interrupted fails with `AbortError`.

### What each provider does when you cancel

The SDK aborts the HTTP request and, for a stream, cancels the response body. The connection closes and nothing more is read. Whether the provider then stops generating, and stops billing, is the provider's own behavior. This is what each documents (checked 5 November 2026):

| Provider | What the SDK does | What the provider does |
|---|---|---|
| OpenAI (Responses; background mode is never used) | Aborts the request and cancels a streaming body. | Documented: "To cancel a synchronous response, terminate the connection." Generation stops. A community report says a few tokens already in flight can still be billed. OpenAI does not document billing for a cancelled response. |
| OpenRouter | Sends every request as a stream (`run()` too, and the SDK collects it), so every call can be cancelled. | Only streaming requests can be cancelled. Aborting stops processing and billing at supported providers (OpenAI, Azure, Anthropic, Fireworks, Together, DeepInfra, DeepSeek, xAI, Cohere and others). It is not supported by Google, Google AI Studio, Groq, AWS Bedrock, Mistral and others. There the model keeps processing and you are billed for the whole response. |
| Anthropic (Messages) | Aborts the request and cancels a streaming body. | Anthropic's docs do not say what happens to a dropped connection. Check your own usage numbers if it matters. |
| Google (Interactions) | Aborts the request and cancels a streaming body. For a background interaction (Gemini 4 long answers) it also calls the documented `POST /interactions/{id}/cancel`. | Google documents nothing about a dropped foreground connection. Only background interactions have a documented cancel. If it matters, check your own usage numbers. |
| Custom OpenAI-compatible service | Aborts the request and cancels a streaming body. | Depends on the server. Most stop on a closed connection, but it is not part of the Chat Completions contract. |

What follows from this:

- `run()` and `stream()` cancel the same way. Which upstream provider OpenRouter routes to still decides whether generation really stops. Pin a supported one with provider routing if that matters to you.
- **A cancelled call reports no usage.** The provider never sends the final usage of a call you cancelled, so those tokens are missing from `res.usage` and `usageReport()`, even if you are billed for part of them.
- The provider's behavior is theirs, not an SDK guarantee. The SDK's own part (aborting the request, cancelling the body, the Google background cancel, aborting tools and workers) is covered by tests in `test/interrupt.test.ts`.

Sources: [OpenAI, Background mode](https://developers.openai.com/api/docs/guides/background) · [OpenRouter, Stream cancellation](https://openrouter.ai/docs/api_reference/streaming) · [Google, Background execution](https://aistudio.google.com/docs/background-execution).
