# Tools and streaming
[Docs](../README.md) › Guides › Tools and streaming

> Let the model call your functions safely, watch the answer arrive live, and redirect an agent that is busy.

## Tools

```ts
import { Agent, tool } from "agent-accelerator";
import { z } from "zod";

const lookup_order = tool({
  description: "Look up an order by id. Read-only.",
  input: z.object({ orderId: z.string().describe("e.g. A-1001") }),
  idempotent: true, // safe to retry on transient failures
  timeoutMs: 5_000, // best-effort deadline; honor ctx.signal for real cancellation
  execute: async ({ orderId }, ctx) => {
    const res = await fetch(`https://api.example.com/orders/${orderId}`, { signal: ctx.signal });
    return res.json();
  },
});

const agent = new Agent({
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  tools: { lookup_order }, // record key = tool name (or use an array with `name`)
});

const res = await agent.run("Where is order A-1001?");
console.log(res.text, res.toolCalls.length);
```

`tool()` options (all in [Reference](../reference.md)): `name`, `description`, `input` (Zod or JSON Schema), `parameters`, `strict`, `timeoutMs`, `maxTries` / `maxAttempts`, `maxConcurrency`, `idempotent`, `repeatable`, `maxResultChars`, `redactError` / `redact`, `retry`, `tags`, `output`, `execute`. The executor **enforces** `input`, `timeoutMs`, `maxTries`/`maxAttempts`, `maxConcurrency`, `idempotent`, `repeatable`, `maxResultChars`, `redactError`. `strict` is passed to providers. `retry`, `tags` and `output` are stored only. `execute` also receives a context with `toolCallId`, `agentName`, `signal`, `sessionId`, `onSubagentEvent`, `runId`, `emit`, `logger`, `log` and `stop` (see *Asking permission* below).

How a call is executed, in order:
1. **Name**: matched exactly, then case/format-insensitively; a near miss returns "Did you mean …?" to the model.
2. **Arguments**: validated with your schema; a failure is sent back to the model to fix (truncated streamed JSON never executes).
3. **Concurrency**: up to 8 tools at once, plus your per-tool `maxConcurrency`.
4. **Run**: default **one attempt**; `idempotent: true` allows up to 3 on transient failures; an explicit `maxTries` wins. Timeouts are not retried unless you set `maxTries`.
5. **Result**: made JSON-safe, secrets/paths scrubbed from errors, capped at `maxResultChars` (default 20000, with a `[Truncated…]` marker); `undefined` becomes `"null"`; failures become `Error executing <name>: …` plus a JSON block (error code/status, attempts, last `ctx.emit({ type: "progress", … })` snapshot, a do-not-repeat hint) so the model repairs only what remains; every call also emits `tool.*` events on `telemetryBus` (see [reference](../reference.md#telemetry-codes)). Every result has `durationMs`.
6. **Stop**: `ctx.stop(reason)` ends the run after this batch (`finishReason: "stopped"`, no further model turn); the reason is the call's result; never retried.
7. **Tool log**: with `persist: { dir }` the call also gets `tool-logs/<n>-<tool>.ndjson` in the session folder (input, attempts, retries, full result or error, duration, plus your `ctx.log(message, data?)` lines, each flushed as written; never sent to the model; the result carries `logFile`). Without `persist: { dir }`, `ctx.log` is a no-op.
8. **Repeat guard**: the 3rd identical call in a row is answered with `repeat_blocked`; `repeatable`/`idempotent` tools are exempt.

`toolChoice` (agent or per run): `"auto"`, `"none"` (whole run), `"required"` or `{ tool: "name" }` (these two apply to the **first turn only**, otherwise a run could never finish). Also exported: `executeToolCalls`, `toStandardToolDeclarations`, `zodToJsonSchema`, `cleanJsonSchema`, `stripSchemaForGoogle`, `assertValidToolName`. Tool names must match `^[a-zA-Z0-9_-]{1,64}$`; ambiguous names fail at construction.

**Recommendations**
- ✅ Write descriptions like instructions to a colleague; `.describe()` every field.
- ✅ Mark read-only tools `idempotent`; leave side-effecting tools at one attempt and make them idempotent with an id.
- ✅ Always pass `ctx.signal` to `fetch`/DB calls. ❌ Don't return huge payloads; return what the model needs.
- 💡 Built-in tools: `subagents`, `scheduled_actions`, `get_datetime`.

## Streaming

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({ model: process.env.MODEL ?? "google/gemini-3.5-flash-lite" });
const abort = new AbortController();

const res = await agent.run("Explain event loops.", {
  stream: true, // still awaitable; also async-iterable
  signal: abort.signal, // cancels provider, tools and sub-agents
  wrapThinking: true,
  onThinkingDelta: (d) => process.stdout.write(d),
  onDelta: (d) => process.stdout.write(d),
  onEvent: (e) => {
    if (e.type === "tool_result") console.log(`\n[tool ${e.toolResult?.name}]`);
  },
});
console.log(`\n${res.usage.outputTokens} output tokens`);
```

Three ways: `agent.stream(prompt)` (iterate events), `agent.run(prompt, { stream: true, onDelta… })` (callbacks, awaitable), `agent.ask(prompt, true)` (string deltas). The stream also has `on(type, fn)` / `off`, `result()`, `cancel()`, `onCancel()`, `isCancelled()`; breaking out of `for await` cancels the HTTP request. Event types: `text_delta`, `thinking_delta`, `tool_start`, `tool_call_complete`, `tool_result`, `tool_end`, `subagent_delta`, `subagent_complete`, `steer_injected`, `queued`, `usage`, `done`, `error` (full table in [Reference](../reference.md)). Buffers are bounded (1000 events, ~1 MB per delta; overflow is reported on the telemetry bus). Timeouts: `limits.firstByteTimeoutMs`, `limits.streamIdleTimeoutMs`; transient failures are retried only **before the first byte**.

**Recommendations:** ✅ always provide a `signal` for user-facing streams. ✅ Forward events to browsers with Server-Sent Events. ❌ Don't mutate `event` objects when `wrapThinking` is on (it edits display text in place).

## Steer, queue, interrupt

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  midSession: { whenBusy: "auto", maxQueued: 10 },
});

const long = agent.run("Research the history of databases."); // running
const steered = agent.steer("Focus only on the 1990s."); // injected into the SAME run
const next = agent.queue("Then give me a 3-bullet summary."); // starts after the run finishes

console.log((await long).text);
console.log((await steered).text); // same response as the run it joined
console.log((await next).text); // its own run and response
// agent.interrupt() cancels the active run; queued follow-ups still run.
// agent.interrupt("Stop. Summarize what you have.") cancels it AND runs that message next, ahead of the queue.
```

| Call | Effect |
|---|---|
| `steer(prompt)` | Joins the active run after the current model/tool step; one response, same turn budget. Idle agent: behaves like `run`. |
| `queue(prompt)` | Starts a new run when the current one ends. Throws when `maxQueued` (default 20) is full. |
| `interrupt()` | Aborts the active run now (rejects with `AbortError`, partial result kept). Idle agent: nothing happens. `interrupt(error)` aborts with that error as the reason. |
| `interrupt(message)` | Aborts the active run **and** starts `message` as the next run, ahead of every queued follow-up and of a steer that missed the aborted run; resolves with that run's response. Works in every `midSession` mode and even when the queue is full. Idle agent: behaves like `run`. |
| `clearQueue()` | Rejects all queued follow-ups. |
| `stream(prompt, { enqueue: "steer" \| "queue" \| "interrupt" })` | Streaming variants (`run(prompt, { enqueue })` takes the same values). |

`midSession: { mode \| whenBusy: "steer" \| "queue" \| "auto" }` can enforce one policy (the other verb then throws). `isBusy`, `pendingCount`, `steerPendingCount` expose state. A steer that arrives after the run ended becomes a queued follow-up (placed at the FRONT of the queue, in arrival order, since it was typed before anything queued later), and its promise resolves with *that* run's response. With `persist: { dir }` the prompts still waiting (steers not yet injected, queued follow-ups, with their `additionalContext`) are saved with the session, so a crash does not lose a message the user already typed.

### What an interrupt really stops

`interrupt()` is immediate, and it cancels the work, not just your wait for it:

- **The model call.** The provider request is aborted, which closes the connection. A streaming response body is cancelled too, so the SDK stops reading and the tokens stop flowing. The provider stops generating **where it honors a closed connection**: see [what each provider does](safety-and-ops.md#what-interrupting-stops-at-the-provider).
- **Tools.** A running tool gets `ctx.signal` aborted (use it to stop real work). The run does not wait for a tool that ignores its signal: it continues at once and that tool finishes in the background with its result dropped. A call that never got a result is repaired in the history (an error result saying it was interrupted), so the next message starts from a valid conversation.
- **Workers.** A running `subagents` call or `agent.workers` call is aborted with the run; the worker's own provider request is cancelled the same way and the worker stays open.
- **History.** The prompt of the interrupted run and any finished tool work are kept; the unfinished answer is not stored.
- **Order with `interrupt(message)`.** The message runs first; a steer typed before the interrupt that missed the aborted run and queued follow-ups run after it, in their order. If the model or a tool is slow to give up, the message starts the moment the aborted run has settled.
- **Streaming.** `interrupt(message)` is non-streaming; for a stream use `stream(message, { enqueue: "interrupt" })`. The stream being interrupted fails with `AbortError`.

## Asking permission

The SDK has no approval modes. Write the check inside `execute` and refuse with `ctx.stop(reason)`:

```ts
import { tool } from "agent-accelerator";
import { z } from "zod";

const pay = tool({
  description: "Pay an invoice.",
  input: z.object({ invoiceId: z.string(), amount: z.number() }),
  // no timeoutMs: it would count the time a person takes to answer
  execute: async ({ invoiceId, amount }, ctx) => {
    if (!(await getPermission(`Pay $${amount} for ${invoiceId}?`))) ctx.stop("user declined the payment");
    return payInvoice(invoiceId, amount); // never reached after a stop
  },
});
```

`ctx.stop` throws, so the code after it never runs. The reason becomes that call's result; calls that were running in parallel in the same batch still finish (none is skipped or aborted); then the run ends with `finishReason: "stopped"` and no further model turn, and the agent waits for the next user message (the model then sees the reason as the tool's result). A steer typed while the batch ran becomes the next run. The stop is saved with the call, so a crash cannot turn a "no" into a "yes": after a restart the run is closed as stopped without calling the model.

To guard a built-in tool, replace it on the agent after construction:

```ts
const inner = agent.tools["subagents"]!;
agent.tools["subagents"] = {
  ...inner,
  execute: async (input, ctx) => ((await getPermission("Spawn workers?")) ? inner.execute(input, ctx) : ctx.stop("not approved")),
};
```

## For AI agents

- Define: `tool({ description, input: z.object({...}), execute })`; register: `tools: { name: def }` (record key becomes the name).
- Defaults: 1 attempt (3 if `idempotent`), result cap 20000 chars, global concurrency 8, repeat guard at the 3rd identical consecutive call.
- Do not assume `retry`, `tags` or `output` change behavior. There is no `needsApproval`: ask inside `execute` and call `ctx.stop(reason)` to refuse.
- `ctx.stop(reason)` throws (never returns), saves `reason` as the call's result, lets the rest of the batch finish, and ends the run with `finishReason: "stopped"` and no more model turns.
- Streaming: `agent.stream()` returns an `AssistantMessageEventStream`; always `await stream.result()` for the final `AgentResponse`.
- `steer`/`queue`/`interrupt` only make sense while `agent.isBusy`.
- See also: [Multi-agent and scheduling](multi-agent.md), [Safety and operations](safety-and-ops.md), [`examples/02-function_calling.ts`](../../examples/02-function_calling.ts), [`examples/12-mid-session.ts`](../../examples/12-mid-session.ts).
