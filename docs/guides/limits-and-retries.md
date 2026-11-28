# Limits and retries

> Keep runs bounded and cheap, and recover from failures.

## Set limits

Nothing that costs money or stops your work is limited until you say so. This agent shows every limit with an example value:

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  maxTurns: 12, // model calls per run. 0 or omitted means unlimited.
  limits: {
    deadlineMs: 120_000, // the whole run
    maxToolCallsPerRun: 30,
    maxTotalTokens: 200_000,
    requestTimeoutMs: 60_000, // one provider call (default 300 s)
    firstByteTimeoutMs: 30_000, // streaming (default 120 s)
    streamIdleTimeoutMs: 60_000, // streaming (default 300 s)
  },
  budget: {
    maxCostUsd: 0.5,
    maxTotalTokens: 300_000,
    maxDurationMs: 180_000,
    maxTotalSubagents: 8,
  }, // per run, workers included
  retry: { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 5_000, budgetMs: 30_000 },
  runRetries: 3, // a run that failed for a transient reason is tried again
  onFailure: "auto",
});

console.log((await agent.run("Hello")).finishReason);
```

| Setting | What happens when it is hit |
|---|---|
| `maxTurns` | The run stops with `finishReason: "max_turns"`. If tools were still pending, a `agent.max_turns_truncated` warning is sent. |
| `limits.deadlineMs`, `maxToolCallsPerRun`, `maxTotalTokens` | `BudgetExceededError`, with the partial results attached. |
| The three timeouts | A retryable `TimeoutError`. |
| `budget` | `BudgetExceededError`, with partial usage. An unknown price counts as $0 toward `maxCostUsd`. |

To cancel at any time, use `{ signal }`, `agent.interrupt()` or `agent.interrupt(message)`. See [Streaming and steering](streaming-and-steering.md#steer-queue-or-interrupt). The error carries `err.partial`: usage, turns, text, and tool calls and results.

## What is limited by default

Every cap below is off by default, so a run never stops because of a limit you did not write.

| Setting | Caps |
|---|---|
| `maxTurns` | Model and tool turns in one run. |
| `limits.deadlineMs` | Wall-clock time of one run. |
| `limits.maxToolCallsPerRun` | Tool calls in one run. |
| `limits.maxTotalTokens` | Tokens in one run. |
| `budget` | One run of this agent, workers included. |
| `usageLimit` | The whole chat for its whole life, workers included. |
| `dynamicSubagents.workerBudget` | The run of each chat worker (a spawn or a message). |
| `dynamicSubagents.scheduledActionBudget` | The run of each scheduled action, retries included. |
| `dynamicSubagents.maxSpawn` | Workers open at the same time. |
| `dynamicSubagents.maxDepth` | Levels of workers below the agent. |
| `dynamicSubagents.workerTimeoutMs` | How long one scheduled-action run may take. An action's own `timeoutMs` can only be shorter. |

Unlimited also means unbounded cost and memory if a model keeps starting workers. For unattended runs, set `usageLimit`, `workerBudget`, `scheduledActionBudget`, `maxSpawn` or `maxDepth`.

The only other default cap is the buffer of waiting messages: `midSession.maxQueued` and `maxSteers` (20 each). It protects memory and you can raise it.

### Cap a whole chat with `usageLimit`

`usageLimit: { maxCostUsd?, maxTotalTokens? }` is the spending cap of a chat. It adds up every model call of the agent and of all its workers (the `subagents` tool, `agent.workers` at any depth, fixed `subagents`), and every picture their `imageTool`s make, and it never resets. Use it for "this conversation may cost at most $5".

- When the total reaches a cap, the next model call anywhere in the chat throws `BudgetExceededError` ("Usage limit reached"). A worker asked to run after that answers with the same message and never reaches the provider.
- A saved chat starts from what its saved sessions already spent, pictures and the copies of fixed workers included. Continue it the usual way (`importSession(loadSessionDir(...).session)`) and the count carries on.
- A model with an unknown price adds tokens but $0 to the cost.
- Scheduled actions are not part of the chat and never count. A scheduled run is capped by `scheduledActionBudget` only. It never borrows the agent's `budget`, the workers' `workerBudget` or the chat's `usageLimit`.

You can also set caps for every agent you build, once at startup, with the settings `usage_limit` and `scheduled_action_budget`:

```ts
import { setConfigs } from "agent-accelerator";

setConfigs({
  values: {
    usage_limit: { max_cost_usd: 5 },
    scheduled_action_budget: { max_cost_usd: 0.5 },
  },
});
```

For each field, the agent's own config wins, then the setting, then no cap. Workers and scheduled runs that the SDK builds itself never take these settings. A chat worker joins its parent's cap, and a scheduled run uses `scheduledActionBudget`.

## Network timeouts

These are the only limits that are on by default. They are not budgets. They make a silent connection fail instead of hanging for ever. Workers and scheduled runs inherit them.

| Option | Default | What it waits for |
|---|---|---|
| `limits.requestTimeoutMs` | 300,000 (300 s) | One provider call. For `run()` it is the whole call. For a stream it is the time to open the stream. |
| `limits.firstByteTimeoutMs` | 120,000 (120 s) | Streaming only: how long the stream may take to start. |
| `limits.streamIdleTimeoutMs` | 300,000 (300 s) | Streaming only: the longest silence between two events. |

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "openai/gpt-5.5",
  limits: {
    requestTimeoutMs: 600_000, // a slow reasoning model without streaming: 10 minutes
    firstByteTimeoutMs: 0, // 0 (or Infinity) turns this timeout off
    streamIdleTimeoutMs: 120_000, // fail a stream that is quiet for 2 minutes
  },
});
```

- `0` or `Infinity` turns a timeout off. A value that is not a number falls back to the default.
- A timeout throws `TimeoutError`, which counts as a transient failure. A failed `run()` is tried again by `runRetries`. A `stream()` is not retried.
- Raise `firstByteTimeoutMs` and `streamIdleTimeoutMs` for models that think for minutes before the first token.
- A long call (Gemini 4 long answers, or a provider whose `isLongRunning()` is true) times each HTTP request only, never the whole call or stream. A status check that times out is retried, and the job keeps running at the provider: only your own abort cancels it.
- Tools have their own `timeoutMs`. Workers started with `subagents` have no timeout.

## Retries

There are two layers.

**`retry`** retries one provider call.

- It retries transient failures: HTTP 408, 425, 429, 500, 502, 503 and 504, network error codes, a request that outlived `limits.requestTimeoutMs` (a `TimeoutError`; the provider may still bill the attempt that timed out), a reply that cannot be used (HTTP 200 with an empty object, a list or no `choices`), an error sent inside a reply or a stream whose code is a status number or names a temporary failure (`rate_limit_exceeded`, `resource_exhausted`, `unavailable`, `overloaded`, `internal`, `server_error`, `gateway_timeout`, `deadline_exceeded`, in any case), `finish_reason: "error"` (counted as a 502), and `transient` or `retryable` flags. It never looks at message text. Your own abort is never retried.
- `Retry-After` is honored within `budgetMs`. Streams are retried only before the first byte.
- On Anthropic, 529 (overloaded) is retried too. The monthly spend-cap 429 (`enforced_spend_limit_reached`, no `Retry-After`) never is.
- On OpenRouter, a 402 from the in-flight spending budget (`limit_source: openrouter_in_flight_budget`) is retried. A 402 for missing credits is not.

**`runRetries`** retries a whole run (default 3, `0` turns it off).

- It applies when a run failed for a transient reason after `retry` gave up: the provider is down, a timeout, a cut stream.
- The run continues from where it stopped, after 5 s, 15 s, 45 s and then 60 s. Each retry emits `agent.run_retry`.
- The prompt is not added again, and finished tool calls are not repeated. The final response includes the failed attempts' tool calls and usage.
- The agent stays busy meanwhile, so queued prompts wait. `interrupt()` or a signal ends the wait.
- Never retried: aborts, HTTP 400, 401, 403 and 404, bad config or input, budgets and limits.
- It works for `run()` and queued runs, not for `stream()`.

**`onFailure`** says what happens to the conversation when a run fails. `"auto"` rolls it back unless a tool already ran, because side effects stay on record. `"rollback"` always rolls back. `"keep"` never does. An abort never rolls back.

## Limit calls that run at once

Many agents, workers and scheduled runs can ask a provider for answers at the same moment, and providers answer a flood with HTTP 429. Set how many provider calls may run at once, once at startup:

```ts
import { setConfigs, getConcurrencyStatus } from "agent-accelerator";

setConfigs({
  values: { concurrency: { max_requests: 8, per_provider: { google: 4 } } },
});
console.log(getConcurrencyStatus()); // { limited, active, waiting, byProvider, paused }
```

- It is off until you set it. `max_requests` is the limit across all providers. `per_provider` sets one limit per provider id (`google`, `openai`, `openrouter` or a custom prefix). Use whole numbers of 1 or more. A wrong value throws `ConfigError` when you set it.
- It covers every model call of every agent in the process, workers and scheduled runs included. A call over the limit waits in line, in order. A call that waits only for its own provider's limit never holds back other providers.
- A slot is held from the request until the answer ends, the call fails or the stream is cancelled. Time spent waiting does not count toward the three timeouts, which start when the call really begins. Aborting a run also ends its wait.
- A call that fails with HTTP 429 and a `Retry-After` pauses that provider. No new call to it starts until the wait has passed, never more than 60 seconds. Calls already running are not touched, and other providers keep going.
- A new `setConfigs` replaces the old one, so leaving `concurrency` out removes the limit. If your program lets the user change it, `setConfig("concurrency", ...)` takes effect at once. It is one setting for the whole process, not per agent.
- Events on the telemetry bus: `concurrency.queued` (`provider`, `waiting`, `active`, `paused`) and `concurrency.paused` (`provider`, `ms`, `waiting`).

## Tips

- For production, set a finite `maxTurns`, a `deadlineMs`, a `budget.maxCostUsd`, and an `AbortSignal.timeout(...)` per request.
- Keep tool timeouts shorter than the run deadline.
- Do not blindly retry tools that have side effects.
