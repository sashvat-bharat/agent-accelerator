# Workers

> Hand work to helper agents. Define them yourself, or let the model start them as it goes.

## Fixed workers

Define specialists once. Each one becomes a tool on the parent that takes `{ task: string }`.

```ts
import { Agent } from "agent-accelerator";

const model = "google/gemini-3.5-flash-lite";

const researcher = new Agent({
  name: "researcher",
  description: "Finds sourced facts.",
  model,
  instructions: "Return findings with sources.",
});
const critic = new Agent({
  name: "critic",
  description: "Finds weaknesses in a draft.",
  model,
  instructions: "List the top 3 problems.",
});

const lead = new Agent({
  model,
  instructions: "Delegate research, have the critic review it, then answer.",
  subagents: [researcher, critic], // or { name, description, agent }
});

const res = await lead.run("Should we adopt SQLite for a small SaaS?");
console.log(res.text);
console.log(res.subagents.map((s) => `${s.name}: ${s.usage.totalTokens} tokens`));
```

Each call runs on its own copy of the worker (`fork`), so parallel calls to one worker really run in parallel.

A fixed worker is a plain `Agent`: there is no separate class. To choose the tool's name or description yourself, use `agentToTool`. `buildAgentTools([...])` does the same for a list.

```ts
import { Agent, agentToTool } from "agent-accelerator";

const researcher = new Agent({
  name: "researcher",
  model: "google/gemini-3.5-flash-lite",
  instructions: "Return findings with sources.",
});

const lead = new Agent({
  model: "google/gemini-3.5-flash-lite",
  tools: {
    research: agentToTool({ name: "research", description: "Finds sourced facts.", agent: researcher }),
  },
});
```

## Workers the model starts

The main agent starts workers while it runs, with one built-in tool called `subagents`. You fix the worker model, reasoning level, tool pool and limits. The model never picks them.

```ts
import { Agent, tool } from "agent-accelerator";
import { z } from "zod";

const recent_news = tool({
  description: "Recent headlines for a topic.",
  input: z.object({ topic: z.string() }),
  execute: async ({ topic }) => [`${topic}: headline 1`, `${topic}: headline 2`],
});

const lead = new Agent({
  model: "google/gemini-3.5-flash-lite",
  budget: { maxTotalSubagents: 8, maxCostUsd: 0.5 }, // per run, workers included
  dynamicSubagents: {
    model: "google/gemini-3.5-flash-lite",
    maxSpawn: 3, // workers open at once. No limit by default.
    thinkingLevel: "low",
    tools: { recent_news }, // the pool. The model grants a subset per worker.
  },
});

const res = await lead.run("Compare three database engines using parallel research.");
for (const id of lead.listTrackedSubAgents()) console.log(id, lead.track(id)?.status);
```

**The tool.** The commands are `spawn` (`name`, `task`, and optionally `instructions`, `role`, `tools`, `history`), `message` (`id`, `task`), `close` (`id`) and `list`. The manual is the tool's description, and the system prompt is not touched, so the cache stays warm. Several `spawn` calls in one turn run in parallel.

**Results** are plain text with one header line: `[worker researcher-1a2b3c4d] replied:` and then the worker's text, or `[worker ...] failed: <reason>`. A failed worker stays open. A bad request returns an `Error: ...` line. Usage and cost are added to the parent's totals and are never shown to the model.

**Conversation.** Workers keep their conversation and have their own instructions and session. `history: N` starts a worker from a copy of the first N finished turns of the main conversation. The turn that is running is never copied, so repeat the request in `task`.

**Depth.** `maxDepth` caps how many levels of workers can exist below the agent.
- By default there is no cap. A worker can start workers that start workers.
- Set a whole number of 1 or more to limit it. `1` keeps workers flat.
- A worker that has levels left gets its own `subagents` tool. Its children get only tools that the worker itself was granted.
- Each level is saved inside the one above it, so a restart rebuilds the whole tree.

**Spending.** `workerBudget: { maxCostUsd?, maxTotalTokens? }` caps each worker's own run.
- A spawn or a message is one run. The usage of the worker's own workers counts toward it.
- Going over fails that call (`[worker <id>] failed: Token budget exceeded…`). The worker stays open and the parent is left alone.
- Scheduled runs have their own cap, `scheduledActionBudget`.
- An unknown price counts as $0 toward `maxCostUsd`.

**Other limits.**
- `maxSpawn` caps the workers open at once. Close one to open another.
- `budget.maxTotalSubagents` counts the spawns in one run.
- Workers use the parent's key only when the provider is the same. They inherit limits, retry, env, fetch, `googleTier`, `fileAccess`, `captureRaw` and `hooks`.
- Workers started with the `subagents` tool and `agent.workers` have no timeouts.
- A missing worker model throws `SubAgentModelError`. Set `dynamicSubagents.model`, or a default worker model with `setModels` and `setSubAgentModel`.

## Workers that keep their conversation

`agent.workers` lets your own code start a worker, message it again and again, and close it. A worker is a plain `Agent` with its own instructions and tools, on the worker model (`dynamicSubagents.model`, or else the saved or default worker model).

```ts
import { Agent, tool } from "agent-accelerator";
import { z } from "zod";

const recent_news = tool({
  description: "Recent headlines for a topic.",
  input: z.object({ topic: z.string() }),
  execute: async ({ topic }) => [`${topic}: headline 1`],
});

const lead = new Agent({
  model: "google/gemini-3.5-flash-lite",
  persist: { dir: "sessions" }, // workers are saved and survive a restart
  dynamicSubagents: {
    model: "google/gemini-3.5-flash-lite",
    tools: { recent_news },
  },
});

const reply = await lead.workers.spawn({
  name: "Researcher",
  instructions: "You research databases and cite sources.", // the worker's OWN prompt
  task: "Compare SQLite and Postgres for a small SaaS.",
  tools: ["recent_news"], // a subset of dynamicSubagents.tools. Unknown names throw.
  history: 1, // optional: start from the parent's first finished turn
});
console.log(reply.id, reply.text); // for example "researcher-1a2b3c4d"

// Same worker, same conversation:
const next = await lead.workers.message(reply.id, "Now focus on write-heavy loads.");
console.log(next.text);

console.log(lead.workers.list()); // open workers: { id, name, role?, tools, busy }
// It can no longer be messaged. Its session stays on disk.
lead.workers.close(reply.id);
```

With `persist: { dir }` on the parent, a worker is saved under `<parent session folder>/workers/<id>/` with its own journal, tool logs and `worker.json`. After a restart it is rebuilt with its history. Without `persist`, workers live in memory only.

- A **turn** is one finished run (done, or ended by `ctx.stop`). A running turn, and failed or aborted runs, are never copied, so a worker never gets a prompt without its answer. `lead.workers.turns()` shows them.
- `spawn` and `message` wait for the reply. They do not throw when a worker fails. The `WorkerReply` carries `error` and a text that says so. They throw `ValidationError` for a bad request: an unknown tool or id, a closed or busy worker, or too many open workers.
- A worker handles one call at a time. Pass `{ signal }` to abort its run. The worker stays open.
- **Exactly once across a crash.** Pass `{ callId }`, the id of the calling tool call. A replayed `spawn` finds the worker it already started. A run that was cut off is continued with `resume()` instead of sending the text twice. A call that was already answered returns the saved answer.
- A damaged `worker.json` is skipped, with a `worker.invalid` event.
- The reply's `metadata` (usage, steps, lineage) has the same shape as `AgentResponse.subagents`. `agent.track(metadata.trackingId)` shows the run live.

## Watch your workers

| Call | Gives you |
|---|---|
| `agent.track(id)` | A live snapshot with `status` and `steps`. |
| `agent.listTrackedSubAgents()` | The ids you can track. |
| `agent.subscribeToSubAgent(id, fn)` | Live updates. Returns a function that stops them. |

The stream events `subagent_delta` and `subagent_complete` carry the same information. Display ids look like `NAME-{32hex}`, one per run. Traces are kept up to 500 traces, 1 hour and 100 steps, and only the agent that started a worker can see its trace.

## Tips

- Give each worker a distinct `name`, and keep tool pools small. Workers get only what you grant.
- Use a cheaper `dynamicSubagents.model` and `thinkingLevel: "low"`. Cap them with `maxSpawn` and `budget`.
- Do not delegate a trivial one-step task. Every worker is a full model run.
- Track workers with `track`, not by reading files.
