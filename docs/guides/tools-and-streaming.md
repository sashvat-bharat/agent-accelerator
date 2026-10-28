# Tools and streaming
[Docs](../README.md) › Guides › Tools and streaming

> Let the model call your functions safely, watch the answer arrive live, and redirect an agent that is busy.

## Tools

```ts
import { Agent, tool, z } from "agent-accelerator";

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

`tool()` options (all in [Reference](../reference.md)): `name`, `description`, `input` (Zod or JSON Schema), `parameters`, `strict`, `timeoutMs`, `maxTries` / `maxAttempts`, `maxConcurrency`, `idempotent`, `repeatable`, `maxResultChars`, `redactError` / `redact`, `retry`, `tags`, `needsApproval`, `output`, `execute`. The executor **enforces** `input`, `timeoutMs`, `maxTries`/`maxAttempts`, `maxConcurrency`, `idempotent`, `repeatable`, `maxResultChars`, `redactError`. `strict` is passed to providers. `retry`, `tags`, `needsApproval` and `output` are stored only (`needsApproval` is **not** enforced). `execute` also receives a context with `toolCallId`, `agentName`, `signal`, `sessionId`, `onSubagentEvent`, `runId`, `emit` and `logger`.

How a call is executed, in order:
1. **Name**: matched exactly, then case/format-insensitively; a near miss returns "Did you mean …?" to the model.
2. **Arguments**: validated with your schema; a failure is sent back to the model to fix (truncated streamed JSON never executes).
3. **Concurrency**: up to 8 tools at once, plus your per-tool `maxConcurrency`.
4. **Run**: default **one attempt**; `idempotent: true` allows up to 3 on transient failures; an explicit `maxTries` wins. Timeouts are not retried unless you set `maxTries`.
5. **Result**: made JSON-safe, secrets/paths scrubbed from errors, capped at `maxResultChars` (default 20000, with a `[Truncated…]` marker); `undefined` becomes `"null"`; failures become `Error executing <name>: …` plus a JSON block (error code/status, attempts, last `ctx.emit({ type: "progress", … })` snapshot, a do-not-repeat hint) so the model repairs only what remains; every call also emits `tool.*` events on `telemetryBus` (see [reference](../reference.md#telemetry-codes)). Every result has `durationMs`.
6. **Repeat guard**: the 3rd identical call in a row is answered with `repeat_blocked`; `repeatable`/`idempotent` tools are exempt.

`toolChoice` (agent or per run): `"auto"`, `"none"` (whole run), `"required"` or `{ tool: "name" }` (these two apply to the **first turn only**, otherwise a run could never finish). Also exported: `executeToolCalls`, `toStandardToolDeclarations`, `zodToJsonSchema`, `cleanJsonSchema`, `stripSchemaForGoogle`, `assertValidToolName`. Tool names must match `^[a-zA-Z0-9_-]{1,64}$`; ambiguous names fail at construction.

**Recommendations**
- ✅ Write descriptions like instructions to a colleague; `.describe()` every field.
- ✅ Mark read-only tools `idempotent`; leave side-effecting tools at one attempt and make them idempotent with an id.
- ✅ Always pass `ctx.signal` to `fetch`/DB calls. ❌ Don't return huge payloads; return what the model needs.
- 💡 Built-in tools: `convert_document_to_markdown`, `spawn_subagents`, `scheduled_actions`, `get_datetime`.

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
```

| Call | Effect |
|---|---|
| `steer(prompt)` | Joins the active run after the current model/tool step; one response, same turn budget. Idle agent: behaves like `run`. |
| `queue(prompt)` | Starts a new run when the current one ends. Throws when `maxQueued` (default 20) is full. |
| `interrupt()` | Aborts the active run (rejects with `AbortError`, partial result kept). |
| `clearQueue()` | Rejects all queued follow-ups. |
| `stream(prompt, { enqueue: "steer" \| "queue" })` | Streaming variants. |

`midSession: { mode \| whenBusy: "steer" \| "queue" \| "auto" }` can enforce one policy (the other verb then throws). `isBusy`, `pendingCount`, `steerPendingCount` expose state. A steer that arrives after the run ended becomes a queued follow-up, and its promise resolves with *that* run's response.

## For AI agents

- Define: `tool({ description, input: z.object({...}), execute })`; register: `tools: { name: def }` (record key becomes the name).
- Defaults: 1 attempt (3 if `idempotent`), result cap 20000 chars, global concurrency 8, repeat guard at the 3rd identical consecutive call.
- Do not assume `needsApproval`, `retry`, `tags` or `output` change behavior.
- Streaming: `agent.stream()` returns an `AssistantMessageEventStream`; always `await stream.result()` for the final `AgentResponse`.
- `steer`/`queue`/`interrupt` only make sense while `agent.isBusy`.
- See also: [Multi-agent and scheduling](multi-agent.md), [Safety and operations](safety-and-ops.md), [`examples/02-function_calling.ts`](../../examples/02-function_calling.ts), [`examples/12-mid-session.ts`](../../examples/12-mid-session.ts).
