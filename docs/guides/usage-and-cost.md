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
- Each agent records only the calls it made itself, priced per turn, and saves them with its session. The report works after a restart, and nothing is counted twice. `total` matches the tokens in the responses.
- An unknown price shows as `totalUsd: null`, never 0. When `unpricedTurns` is above 0, the total is a lower bound. `source` says where the cost came from: `provider`, `catalog` or `mixed`.
- Not included: one-shot scheduled-action workers (their exact spending is in the header of each run file) and workers started inside a fixed worker's per-call copy.

Never add up `AgentResponse.usage` of several runs to get a total. A parent's response already contains its workers. Use `usageReport()`.

## Tips

- Cost can be `undefined`. Handle it.
- Use `SessionTelemetry` for running totals in a chat.
- To cap spending, see [Limits and retries](limits-and-retries.md).
