# Usage and cost

> See how many tokens a run used and what it cost, for one run or for a whole agent and its workers.

## One run

```ts
import { Agent, SessionTelemetry } from "agent-accelerator";

const agent = new Agent({ model: "google/gemini-3.5-flash-lite" });
const telemetry = new SessionTelemetry();

const res = await agent.run("Summarize the plot of Hamlet.");
telemetry.add(res.usage, `${res.provider}/${res.model}`);

console.log(telemetry.formatBar(res)); // tokens, cache hit rates, cost, context use
// { input, output, cacheRead, cacheWrite, reasoning, cost }
console.log(telemetry.totals);
```

`res.usage` has these fields:

| Field | Meaning |
|---|---|
| `inputTokens` | Everything sent, including cache reads and writes. |
| `outputTokens` | Everything written, including thinking. |
| `totalTokens` | Input plus output. |
| `cachedTokens`, `cacheReadTokens`, `cacheWriteTokens` | Tokens served from, or written to, the prompt cache. |
| `thinkingTokens` | Tokens the model spent on reasoning. |
| `cost` | The cost, when it is known. |
| `inputDetails`, `outputDetails` | On OpenRouter only: audio, video or image tokens, when the route reports them. They are parts of input and output, for reading only. They never change the cost. |

Cached tokens are always a part of input. Anthropic reports them outside its own `input_tokens`, and the SDK adds them back. Usage of workers is added to the parent's total.

## How cost is worked out

- If the provider reports a total cost (OpenRouter does), that is the cost.
- Otherwise the SDK prices each turn from the catalog, in whole micro-dollars. Fresh input, cache reads and cache writes each use their own price. A missing cache price uses the input price. Tiered prices above 200,000 context tokens and service-tier multipliers (flex 0.5x, priority 2x) are included.
- **Unknown pricing stays unknown.** The cost is `undefined`, never a made-up zero. A model you describe with `registerModel` has a known price.

## An agent and its workers

`res.usage` covers one run. `agent.usageReport()` returns what the agent and every worker below it have spent so far, in detail.

```ts
import { Agent } from "agent-accelerator";

const lead = new Agent({
  model: "google/gemini-3.5-flash-lite",
  dynamicSubagents: { model: "google/gemini-3.5-flash-lite" },
});
await lead.run("Compare three database engines.");

const { agent: own, workers, total } = lead.usageReport();
console.log(own.cost.totalUsd, total.cost.totalUsd, total.cacheHitRate);
for (const w of workers) {
  console.log(w.id, w.status, w.turns, w.tokens.thinking, w.cost.totalUsd);
}
```

The report is `{ agent, workers, total }`. Each line has:

| Field | Meaning |
|---|---|
| `turns` | Model calls made. |
| `tokens` | `input`, `freshInput`, `cacheRead`, `cacheWrite`, `output`, `thinking`, `total`. |
| `cacheHitRate` | From 0 to 1, or `null`. |
| `cost` | `source`, `totalUsd`, `parts` and `unpricedTurns`. |

- `agent` is the agent's own calls. `workers` is a tree. Each worker has a `status` of `open`, `closed` or `fixed` and its own `workers`. `total` is everything.
- A fixed worker (`subagents: [...]`) lists the workers it started below it, however many calls it handled. Only the newest 1,000 of them are listed one by one. The older ones are added up into one line called `older-workers`, so the total stays exact.
- Each agent records only the calls it made itself, priced per turn. Nothing is counted twice, and `total` matches the tokens in the responses of the same run.
- Everything in the report is saved with the session, so it comes back after a restart (load the session with `importSession`): the agent's own calls, its workers from `agent.workers`, and its fixed workers with the workers their copies started. If you rename or remove a fixed worker between runs, its saved spending stays in the report under the old name, so the total never shrinks.
- An unknown price shows as `totalUsd: null`, never 0. When `unpricedTurns` is above 0, the total is a lower bound. `source` says where the cost came from: `provider`, `catalog` or `mixed`.
- Not included: one-shot scheduled-action workers. Their exact spending is in the header of each run file.

Never add up `AgentResponse.usage` of several runs to get a total. A parent's response already contains its workers. Use `usageReport()`.

## One total per conversation

An `Agent` keeps one spending total for everything it does, so give each conversation its own `Agent`. Its report is then that conversation's total, with every worker listed below it. One `Agent` that serves several `sessionId`s adds all of them into one total.

```ts
import { Agent } from "agent-accelerator";

const conversations = new Map<string, Agent>(); // in a real service, drop idle ones

function agentFor(userId: string): Agent {
  let agent = conversations.get(userId);
  if (!agent) {
    agent = new Agent({
      model: "google/gemini-3.5-flash-lite",
      sessionId: `chat-${userId}`,
      persist: { dir: "sessions" },
      dynamicSubagents: { model: "google/gemini-3.5-flash-lite" },
    });
    conversations.set(userId, agent);
  }
  return agent;
}

const agent = agentFor("alice");
await agent.run("Research this for me.");
const report = agent.usageReport();
console.log(report.total.cost.totalUsd); // this conversation, every worker included
for (const w of report.workers) console.log(w.id, w.status, w.turns, w.cost.totalUsd);
```

## Tips

- Cost can be `undefined`. Handle it.
- Use `SessionTelemetry` for running totals in a chat.
- To cap spending, see [Limits and retries](limits-and-retries.md).
