# Tools

> Let the model call your functions safely. Ask for approval, return images, and step in with hooks.

## Define a tool

A tool is a function plus a description. The model reads the description and decides when to call it.

```ts
import { Agent, tool } from "agent-accelerator";
import { z } from "zod";

const lookup_order = tool({
  description: "Look up an order by id. Read-only.",
  input: z.object({ orderId: z.string().describe("For example A-1001") }),
  idempotent: true, // safe to retry
  timeoutMs: 5_000, // best-effort deadline
  execute: async ({ orderId }, ctx) => {
    const res = await fetch(`https://api.example.com/orders/${orderId}`, {
      signal: ctx.signal, // stops the request when the run is cancelled
    });
    return res.json();
  },
});

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  tools: { lookup_order }, // the key is the tool's name
});

const res = await agent.run("Where is order A-1001?");
console.log(res.text, res.toolCalls.length);
```

Tool names match `^[a-zA-Z0-9_-]{1,64}$`, and `__proto__` is not allowed. You can also pass an array of tools and give each a `name`. The name a model asks for is looked up among your own tools only, so a call to `constructor` or `toString` is an unknown tool.

## Tool options

| Option | What it does |
|---|---|
| `description` | What the tool does. Write it like instructions to a colleague. |
| `input` | A Zod schema (or JSON Schema) for the arguments. Describe every field. |
| `execute(args, ctx)` | Your function. Its result goes back to the model. |
| `timeoutMs` | A best-effort deadline for one attempt. Honour `ctx.signal` to really stop. |
| `idempotent` | `true` if running it twice is harmless. It allows retries and safe replay. |
| `maxAttempts` | How many attempts a transient failure gets. |
| `maxConcurrency` | How many calls of this tool run at once. |
| `repeatable` | Allow the same call several times in a row. |
| `replay` | `"safe"` means it may run again after a crash. |
| `maxResultChars` | Longest string result kept for the model. Default 20,000. |
| `redactError` | Rewrites an error message before the model sees it. |
| `strict` | Passed on to providers that support strict schemas. |

Every option is in the [Reference](../reference.md#tool-definition). Your function also gets `ctx` with `toolCallId`, `agentName`, `sessionId`, `signal`, `emit`, `log` and `stop`.

## What happens when a tool is called

1. **The name** is matched exactly, then ignoring case and format. A near miss tells the model "Did you mean…?".
2. **The arguments** are checked against your schema. A failure goes back to the model so it can fix the call. A call whose streamed JSON was cut off never runs.
3. **Concurrency.** Up to 8 tools run at once, plus your `maxConcurrency` per tool.
4. **Attempts.** One attempt by default. `idempotent: true` allows up to 3 for transient failures, and an explicit `maxAttempts` wins. Timeouts are not retried unless you set `maxAttempts`.
5. **The result** is made JSON-safe and capped. Secrets and file paths are removed from errors. A failure becomes `Error executing <name>: …` plus a short JSON block (error code, attempts, the last progress, a "do not repeat" hint), so the model fixes only what is left. Every result has a `durationMs`, and every call emits `tool.*` events on the telemetry bus.
6. **A stop.** `ctx.stop(reason)` ends the run after the current batch. See [Ask for permission](#ask-for-permission).
7. **A log.** With `persist: { dir }`, each call also writes `tool-logs/<n>-<tool>.ndjson` in the session folder, including your `ctx.log(message, data?)` lines. The model never sees it.
8. **A repeat guard.** The third identical call in a row is answered with `repeat_blocked`. `idempotent` and `repeatable` tools are exempt.

## Return an image to the model

Return `toolContent([...])` when the model should see a file, such as a chart or a scanned page:

```ts
import { tool, toolContent } from "agent-accelerator";
import { z } from "zod";

const chart = tool({
  description: "Draws a chart and shows it to the model.",
  input: z.object({ metric: z.string() }),
  execute: async ({ metric }) =>
    toolContent([
      `Chart of ${metric}`,
      {
        type: "image",
        image: await Bun.file("chart.png").bytes(),
        mimeType: "image/png",
      },
    ]),
});
```

- Text parts become the call's result. Every provider sees them.
- Media can be bytes, a data URL, a path or a URL. It is read once and kept as inline data.
- **Google** (Gemini 3 and later) receives the media inside the result. Other providers get the text only, with one `provider_warning`.
- Only a value made by `toolContent` counts. JSON that a tool fetched from the web can never become media.
- The media is saved with the session, counts toward Google's inline size limit, and is not cut by `maxResultChars`.

## Choose which tool the model uses

`toolChoice` can be set on the agent or per run:

| Value | Meaning |
|---|---|
| `"auto"` | The model decides. |
| `"none"` | No tool is called, for the whole run. |
| `"required"` | The model must call a tool. First turn only. |
| `{ tool: "name" }` | The model must call that tool. First turn only. |
| `"validated"` | Google only. The model still decides, but every call it makes is kept valid against the schema. Other providers ignore it with one warning. |

`required` and `{ tool }` apply only to the first turn. Otherwise a run could never finish.

## Ask for permission

The SDK has no approval modes. Write the check inside `execute`, and refuse with `ctx.stop(reason)`:

```ts
import { tool } from "agent-accelerator";
import { z } from "zod";

const pay = tool({
  description: "Pay an invoice.",
  input: z.object({ invoiceId: z.string(), amount: z.number() }),
  // No timeoutMs here: it would count the time a person takes to answer.
  execute: async ({ invoiceId, amount }, ctx) => {
    if (!confirm(`Pay $${amount} for ${invoiceId}?`)) {
      ctx.stop("The user declined the payment.");
    }
    return { paid: invoiceId }; // never reached after a stop
  },
});
```

`ctx.stop` throws, so the code after it never runs.

- The reason becomes that call's result.
- Calls that run in parallel in the same batch still finish. None is skipped or aborted.
- The run then ends with `finishReason: "stopped"` and no further model turn. The agent waits for the next user message.
- A steer typed while the batch ran becomes the next run.
- The stop is saved with the call, so a crash cannot turn a "no" into a "yes". After a restart the run is closed as stopped without calling the model.

To guard a built-in tool, replace it on the agent after you create it:

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  dynamicSubagents: { model: "google/gemini-3.5-flash-lite" },
});

const inner = agent.tools["subagents"]!;
agent.tools["subagents"] = {
  ...inner,
  execute: async (input, ctx) =>
    confirm("Start workers?") ? inner.execute(input, ctx) : ctx.stop("Not approved."),
};
```

## Hooks

`hooks` lets your code step in at four points of a run. Every hook is optional and may be `async`. Each gets a `ctx` with `{ agentName, sessionId, signal, turn }`. The `signal` aborts when the run is interrupted, so an approval prompt should honour it.

```ts
import { Agent, tool } from "agent-accelerator";
import { z } from "zod";

const pay_invoice = tool({
  description: "Pay an invoice.",
  input: z.object({ invoiceId: z.string(), amount: z.number() }),
  execute: async ({ invoiceId }) => ({ paid: invoiceId }),
});

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  tools: { pay_invoice },
  hooks: {
    // Approve, refuse or change a tool call BEFORE it runs.
    beforeTool: async (call) => {
      const ok = confirm(`Run ${call.name} ${JSON.stringify(call.arguments)}?`);
      if (call.name === "pay_invoice" && !ok) {
        return { block: "The user declined the payment." };
      }
      // Or return { arguments: { ...call.arguments, currency: "USD" } }
    },
    // Change a result AFTER the tool ran.
    afterTool: (call, result) => ({
      result: String(result.result).replace(/sk-\w+/g, "[redacted]"),
    }),
    // Change what is SENT to the model this turn. Saved history is untouched.
    beforeRequest: (messages) => ({ messages: messages.slice(-20) }),
    // The model gave a final answer. Return { continue } to keep going.
    onYield: ({ text }) =>
      text.includes("TODO") ? { continue: "Finish the TODOs." } : undefined,
  },
});
```

- **`beforeTool` fails closed.** If the hook throws, the call is blocked and the error is the reason. It runs before a concurrency slot is taken, so a slow approval holds none. A blocked call emits `tool.call_blocked` with `reason: "hook_blocked"`. The model reads `Blocked: <reason>` as an error result. Rewritten arguments are checked against the tool's schema.
- **`afterTool`** gets a copy of the result and may return `{ result, isError }`. If it throws, the original result is kept and a `hook.error` warning goes to the bus.
- **`beforeRequest`** gets a copy of the message list and may return `{ messages, systemPrompt }`. Keep tool calls and their results together. Keep the start of the list stable if you want cache hits.
- **`onYield`** continues in the same run, with the same `maxTurns`, budget and `AgentResponse`. A hook that always continues never ends, so set `maxTurns` or a budget. A `beforeRequest` or `onYield` that throws fails the run.
- **Workers inherit hooks**, so delegating cannot get around an approval gate. `ctx.agentName` tells the agents apart.
- An unknown hook name, or a value that is not a function, is a `ConfigError`.

## After a crash

When a run is cut off, a tool call that already has a saved result is never run again. A call that has none runs again only if the tool is `idempotent: true` or `replay: "safe"`. Any other tool gets an "interrupted, may have partly run" result, and the model decides what to do. Mark a tool `replay: "safe"` only if running it twice is harmless, or if it guards itself with an id.

## Tips

- Describe every field with `.describe()`.
- Mark read-only tools `idempotent`. Leave tools with side effects at one attempt, and make them safe with an id.
- Always pass `ctx.signal` to `fetch` and database calls.
- Return what the model needs, not huge payloads.
- The SDK has three built-in tools: `subagents`, `scheduled_actions` and `get_datetime`. See [Workers](workers.md) and [Scheduled actions](scheduled-actions.md).
