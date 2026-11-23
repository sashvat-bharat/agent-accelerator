# Agents

> Create an `Agent`, run it, get structured JSON back, and let a program edit an agent's setup.

## Create and run an agent

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  name: "support",
  model: "google/gemini-3.5-flash-lite",
  instructions: "You are a friendly support agent. Be brief.",
  maxTurns: 10,
});

const res = await agent.run("My invoice is wrong.");
console.log(res.text);
```

`instructions` is the system prompt. `maxTurns` stops a run that keeps calling tools. Without it, the number of turns is unlimited.

## Change something for one turn

Put anything that changes from turn to turn in `additionalContext` or in the message itself, and keep `instructions` the same. A stable prompt lets the provider reuse its cache, which makes calls cheaper and faster.

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  instructions: "You are a friendly support agent. Be brief.",
});

const res = await agent.run("What is my plan?", {
  additionalContext: "Customer plan: Pro",
});
console.log(res.text);
```

## What you can call

| Method | Use it for |
|---|---|
| `run(prompt, options?)` | One call. Resolves to an `AgentResponse`. The prompt is a string or a list of `ContentPart`. |
| `stream(prompt, options?)` | The same run as a stream of events. See [Streaming and steering](streaming-and-steering.md). |
| `ask(prompt, stream?)` | A shorthand for `run`. With `true` it gives you the text pieces. |
| `Agent.fromEnv(config?)` | Like `new Agent(config)`. With no `model` it uses the saved choice, then the list default, then the saved worker model. Leaving out `model` in `new Agent(config)` does the first two. |
| `reset()` | Clears the conversation and keeps the settings. Spending totals are kept. |
| `session(id?)`, `disposeSession(id)`, `clearSessions()` | Separate in-memory conversations. `run(prompt, { sessionId })` keeps one history per id. |
| `exportSession()`, `importSession()` | Take a snapshot of the conversation and restore it. See [Sessions](sessions.md). |

Every option of `AgentConfig` and of a run is listed in the [Reference](../reference.md).

## One-shot agents

`stateless: true` clears the conversation around every run. Use it for a judge or a classifier that should never see earlier messages.

## Get JSON back

Give the agent a schema and read `res.parsed`:

```ts
import { Agent, ValidationError } from "agent-accelerator";
import { z } from "zod";

const Invoice = z.object({
  vendor: z.string(),
  total: z.number(),
  currency: z.string(),
});
const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  output: Invoice,
});

try {
  const res = await agent.run("Acme Ltd charged 120.50 EUR for hosting.");
  const invoice = Invoice.parse(res.parsed); // typed and checked
  console.log(invoice.vendor, invoice.total);
} catch (err) {
  if (err instanceof ValidationError) console.error("Answer did not match");
  else throw err;
}
```

- `output` accepts a Zod schema, a JSON Schema object, or `{ name, description, schema, strict }`.
- The final answer is constrained on every provider and checked into `res.parsed`. Turns that only call tools are skipped.
- If a model has no native JSON support, the SDK asks for JSON in the prompt, checks the answer itself, and warns once.
- Keep schemas small and describe each field.

## Let a program edit an agent

The SDK gives you the pieces for an agent that improves itself. The loop that decides what to change (tests, scoring, rolling back) is yours. A program may edit only three things: `model`, `instructions` and `tools`. Limits, budgets, keys and everything else stay with you.

```ts
import { Agent, tool } from "agent-accelerator";
import { z } from "zod";

const named = (name: string) =>
  tool({
    description: `The ${name} tool.`,
    input: z.object({}),
    execute: async () => name,
  });

// Your full config. `tools` is the pool the agent may pick from.
const base = {
  model: "openai/gpt-5.5",
  instructions: "You answer support questions.",
  tools: { search: named("search"), readFile: named("readFile") },
  budget: { maxCostUsd: 2 },
  maxTurns: 20,
};
const agent = new Agent(base);

// What can be edited, as plain JSON you can show to a model or store.
console.log(agent.toConfig());
// { model: "openai/gpt-5.5", instructions: "...", tools: ["search", "readFile"] }

// Build a new agent with the edits.
const next = Agent.fromConfig(
  { ...agent.toConfig(), instructions: "Be brief.", tools: ["search"] },
  base,
);
```

- **Tools are names.** They are picked from `base.tools`. A name that is not in the pool throws a `ConfigError` that lists the names that are. Leave `tools` out to keep all of them.
- **Any other key is ignored** and reported once as `config.not_editable` on the telemetry bus.
- **The model list limits the model.** A model outside your `setModels` list throws `ModelNotAllowedError` when the agent is built. See [Allowed models](allowed-models.md).
- **Keys never travel.** `toConfig()` has no keys. If `base.model` holds its own key, the new agent keeps it only for the same provider.
- **You get a new agent.** `fromConfig` never changes the old one. Give `base` the same `sessionId` and `persist` to continue the saved conversation with the new settings.
- **Tool code is yours.** To let a program edit a tool's code, keep each tool in its own file. Loading the edited file again is up to you.

## Tips

- Keep `instructions` and the order of your tools the same from call to call.
- Set a finite `maxTurns` in services. See [Limits and retries](limits-and-retries.md).
- An `Agent` does one run at a time. A second call while it is busy is steered or queued.
- To step in during a run, use `hooks`. See [Tools](tools.md#hooks).
