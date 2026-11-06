# Safety and operations
[Docs](../README.md) › Guides › Safety and operations

> Keep runs bounded and cheap, handle failures, see what the SDK is doing, and keep secrets, files and URLs safe.

## Limits, budgets and retries

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  maxTurns: 12, // 0 or omitted = unlimited
  limits: {
    deadlineMs: 120_000, // whole run
    maxToolCallsPerRun: 30,
    maxTotalTokens: 200_000,
    requestTimeoutMs: 60_000, // one provider call (default 300 s); for Google long decode: each HTTP request
    firstByteTimeoutMs: 30_000, // streaming (default 120 s)
    streamIdleTimeoutMs: 60_000, // streaming (default 300 s)
  },
  budget: { maxCostUsd: 0.5, maxTotalTokens: 300_000, maxDurationMs: 180_000, maxTotalSubagents: 8 }, // per run, includes workers
  retry: { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 5_000, budgetMs: 30_000 }, // defaults shown
  runRetries: 3, // default: a run that failed for a transient reason is tried again (5 s, 15 s, 45 s); 0 = off
  onFailure: "auto",
});

console.log((await agent.run("Hello")).finishReason);
```

| Setting | What happens when hit |
|---|---|
| `maxTurns` | Run stops with `finishReason: "max_turns"` and a bus warning (`agent.max_turns_truncated`) if tools were still pending. |
| `limits.*` | Deadline/tool-count: error with partial results; timeouts raise a retryable `TimeoutError`. |
| `budget.*` | Throws `BudgetExceededError` with partial usage. Unknown pricing counts as $0 toward `maxCostUsd`. |
| `retry` | Transient failures (HTTP 408/425/429/500/502/503/504, network codes, `transient`/`retryable` flags; never message text). `Retry-After` is honored within `budgetMs`; streams retry only before the first byte. On OpenRouter a 402 from the in-flight spending budget (`limit_source: openrouter_in_flight_budget`) is retried too; a 402 for missing credits is not. |
| `runRetries` | A whole run that failed for a transient reason (after `retry` gave up: provider down, timeouts, a cut stream) is tried again from where it stopped, after 5 s, 15 s, 45 s, then 60 s; each retry emits `agent.run_retry`. The prompt is not re-added and finished tool calls are not repeated; the final response includes the failed attempts' tool calls and usage. The agent stays busy meanwhile (queued prompts wait); `interrupt()` or a signal ends the wait. Never retried: aborts, 400/401/403/404, bad config or input, budgets and limits. `run()` and queued runs only, not `stream()`. |
| `onFailure` | `"auto"` rolls the conversation back unless a tool already ran (side effects stay on record); `"rollback"` always; `"keep"` never. Aborts never roll back. |

Cancel anytime with `{ signal }`, `agent.interrupt()` or `agent.interrupt(message)` (stop and start a new message, see [Tools and streaming](tools-and-streaming.md#steer-queue-interrupt)); the error carries `err.partial` (usage, turns, text, tool calls/results).

### What interrupting stops at the provider

When you cancel, the SDK aborts the HTTP request and, for a stream, cancels the response body: the connection to the provider is closed and nothing more is read. Whether the **provider** then stops generating, and stops billing, is the provider's own behavior. This is what each documents (checked 5 November 2026):

| Provider | What the SDK does | What the provider does |
|---|---|---|
| OpenAI (Responses; the SDK never uses background mode) | Aborts the request; cancels a streaming body. | Documented: "To cancel a synchronous response, terminate the connection." Generation stops. A community report says a few tokens already in flight can still be billed; OpenAI does not document billing for a cancelled response. |
| OpenRouter | Sends **every** request as a stream (`run()` and `generate()` too, the SDK collects the stream), so every call can be cancelled; aborts the request and cancels the body. | OpenRouter documents that only streaming requests can be cancelled: aborting the connection immediately stops processing and billing at supported providers (OpenAI, Azure, Anthropic, Fireworks, Together, DeepInfra, DeepSeek, xAI, Cohere and others). Not supported: Google, Google AI Studio, Groq, AWS Bedrock, Mistral and others; there the model keeps processing and you are billed for the complete response. |
| Google (Interactions) | Aborts the request; cancels a streaming body. For a background interaction (Gemini 4 long decode) it also calls the documented `POST /interactions/{id}/cancel`. | Google documents nothing about a dropped foreground connection. Only background interactions have a documented cancel (status `cancelled`; `usage` shows the billed tokens). If it matters, check your own usage numbers. |
| Custom OpenAI-compatible endpoint | Aborts the request; cancels a streaming body. | Depends on the server. Most inference servers stop on a closed connection, but it is not part of the Chat Completions contract. |

What follows from this:

- **`run()` and `stream()` cancel the same way.** OpenRouter can only cancel a streaming request, so the SDK always streams to it. Which upstream provider OpenRouter routes to still decides whether generation really stops (see the table); pin a supported one with provider routing if that matters to you.
- **A cancelled call reports no usage.** The provider never sends the final usage of a call you cancelled, so those tokens are not in `res.usage` or `usageReport()`, even if you are billed for part of them.
- The provider-side behavior above is theirs, not an SDK guarantee. The SDK's own part (aborting the request, cancelling the body so the tokens stop arriving, the Google background cancel, aborting tools and workers) is covered by tests in `test/interrupt.test.ts`.

Sources: [OpenAI, Background mode](https://developers.openai.com/api/docs/guides/background) · [OpenRouter, Stream cancellation](https://openrouter.ai/docs/api_reference/streaming) · [Google, Background execution: cancellation and deletion](https://aistudio.google.com/docs/background-execution).

### What is limited by default

**Nothing that costs you money or stops your work is limited until you say so.** Every cap below is off (unlimited) by default, so a run never stops because of a limit you did not write:

| Setting | Default | What it caps |
|---|---|---|
| `maxTurns` / `limits.maxTurns` | unlimited | model ↔ tool turns in one run |
| `limits.deadlineMs` | unlimited | wall-clock time of one run |
| `limits.maxToolCallsPerRun` | unlimited | tool calls in one run |
| `limits.maxTotalTokens` | unlimited | tokens in one run |
| `budget` (`maxCostUsd`, `maxTotalTokens`, `maxDurationMs`, `maxTotalSubagents`) | unlimited | one run of this agent, workers included |
| `dynamicSubagents.workerBudget` | unlimited | the run of each worker (and of each scheduled-action run) |
| `dynamicSubagents.maxSpawn` | unlimited | workers open at the same time (`maxSpawn: 3` caps it) |
| `dynamicSubagents.workerTimeoutMs` | unlimited | how long one scheduled-action run may take (an action's own `timeoutMs` can only be shorter) |
| `dynamicSubagents.maxDepth` | unlimited | levels of workers below the agent (`maxDepth: 2` lets a worker start workers, and no deeper) |

A scheduled-action run is capped by `workerBudget` only. It never borrows the agent's own `budget`, which is for the agent's own runs; with no `workerBudget` a scheduled run has no cap.

Unlimited also means unbounded cost and memory when a model keeps starting workers. For unattended runs set `workerBudget`, `maxSpawn` and/or `maxDepth`. The only other default cap is the waiting-prompt buffer: `midSession.maxQueued` / `maxSteers` (20 each), which protects memory and can be raised.

### Network timeouts

The only limits that are on by default are three network timeouts. They are not budgets: they exist so a silent connection fails instead of hanging forever. Change them in `limits` (agent level; workers and scheduled runs inherit them):

| Option | Default | What it waits for |
|---|---|---|
| `limits.requestTimeoutMs` | 300 000 (300 s) | One provider call. For `run()` that is the whole call, answer included; for a stream it is the time to open the stream. |
| `limits.firstByteTimeoutMs` | 120 000 (120 s) | Streaming only: how long after sending the request the stream may take to start. |
| `limits.streamIdleTimeoutMs` | 300 000 (300 s) | Streaming only: the longest silence allowed between two events once the stream has started. |

```ts
const agent = new Agent({
  model: "openai/gpt-5",
  limits: {
    requestTimeoutMs: 600_000, // a slow reasoning model answering without streaming: give it 10 minutes
    firstByteTimeoutMs: 0, // 0 (or Infinity) turns this timeout off
    streamIdleTimeoutMs: 120_000, // fail a stream that goes quiet for 2 minutes
  },
});
```

- **`0` or `Infinity` turns a timeout off** (no timer is started). A value that is not a number falls back to the default.
- **When one fires** you get a `TimeoutError`, which counts as a transient failure: a failed `run()` is tried again by `runRetries` (default 3, `runRetries: 0` turns that off). A `stream()` is not retried.
- Raise `firstByteTimeoutMs` and `streamIdleTimeoutMs` for models that think for minutes before the first token.
- A long-running call (Google long decode, or a provider whose `isLongRunning()` is true) times each HTTP request only, never the whole call or stream.
- Tools have their own `timeoutMs` (see [Tools](tools-and-streaming.md)); workers started with `subagents` have no timeout.

**Recommendations**
- ✅ Production defaults: finite `maxTurns`, a `deadlineMs`, a `budget.maxCostUsd`, and an `AbortSignal.timeout(...)` per request.
- ✅ Keep tool timeouts shorter than the run deadline. ❌ Don't retry side-effecting tools blindly.

## Usage and cost report

`res.usage` covers one run. `agent.usageReport()` returns what the agent and every worker below it spent so far, itemized: `{ agent, workers, total }`. Each line has `turns`, `tokens` (`input`, `freshInput`, `cacheRead`, `cacheWrite`, `output`, `thinking`, `total`), `cacheHitRate` and `cost` (`source`, `totalUsd`, `parts`, `unpricedTurns`).

```ts
const { agent: own, workers, total } = lead.usageReport();
console.log(own.cost.totalUsd, total.cost.totalUsd, total.cacheHitRate);
for (const w of workers) console.log(w.id, w.status, w.turns, w.tokens.thinking, w.cost.totalUsd);
```

- Each agent records only the calls it made itself, priced per turn (cache reads, cache writes, service tier), and saves them with its session, so the report works after a restart and nothing is counted twice. `total` matches the tokens in the responses.
- Unknown pricing shows as `totalUsd: null` (never 0) and `unpricedTurns > 0` marks a lower bound; `source` says whether the cost came from the `provider`, the `catalog`, or `mixed`.
- Not included: one-shot scheduled-action workers (their exact spending is in each run file's header) and workers started inside a fixed `subagents` worker's per-call copy.

## Errors

```ts
import { Agent, BudgetExceededError, ProviderError, TimeoutError, formatErrorPlain, isAbortError } from "agent-accelerator";

const agent = new Agent({ model: process.env.MODEL ?? "google/gemini-3.5-flash-lite", budget: { maxCostUsd: 0.01 } });

try {
  await agent.run("Write a long essay.", { signal: AbortSignal.timeout(30_000) });
} catch (err) {
  if (isAbortError(err)) console.log("cancelled");
  else if (err instanceof BudgetExceededError) console.log("over budget");
  else if (err instanceof TimeoutError || (err instanceof ProviderError && err.retryable)) console.log("try again later");
  else console.error(formatErrorPlain(err)); // one line, no ANSI
  console.log("partial:", (err as { partial?: unknown }).partial);
}
```

All SDK errors extend `AgentAccelError` (`code`, `retryable`, `context`): `ConfigError`, `ProviderError`, `TimeoutError`, `BudgetExceededError`, `ToolError`, `ValidationError`, `SessionLoadError`, `SecurityPolicyError` (and `RemoteFetchError`), plus `ThinkingLevelError`, `SubAgentModelError`. Abort means `signal.aborted` or `name === "AbortError"` only. Provider failures are one-line errors; details (`statusCode`, `provider`, `model`, `url`, `responseBody`, `errorType`, `code`, `retryAfterMs`, `raw`) are non-enumerable so logs stay small.

## Telemetry

```ts
import { telemetryBus } from "agent-accelerator";

const off = telemetryBus.onEvent((e) => {
  if (e.level === "warn") console.warn(`[${e.code}] ${e.message}`);
  if (e.code === "turn.thinking") console.log("reasoning:", e.data);
});
// later: off();
```

Tool calls emit `tool.*` lifecycle events (`call_started`, `progress`, `call_failed`, ...). To keep a crash-proof trace, set `telemetry: { persist: true }`: every event (except reasoning text) is appended to `<home>/telemetry/<date>.ndjson`, one line each. A `tool.call_started` with no ending event was in flight when the process died; the last `tool.progress` shows how far it got. Nothing is written unless you opt in.

The bus is in-process, delivers synchronously, isolates listener errors and prints nothing by default. Events: provider warnings (`provider_warning`), Google chain anomalies, stream anomalies, `cache_clamp`, catalog and session notices, `config.*` warnings, `agent.max_turns_truncated`, `turn.thinking`, and `scheduled_action.*` (full list in [Reference](../reference.md)). `AgentResponse.raw` and the stream `start` event show the wire exchange according to `captureRaw`.

## Security

| Area | Behavior | Control |
|---|---|---|
| API keys | Never sent to another vendor; custom prefixes need their own key and base URL; not enumerable on errors | `apiKey`, `env` |
| Request audit | Header names containing key/token/secret/cookie/authorization and credential-looking values are redacted | `captureRaw`: `"redacted"` (default, no bodies), `true` (full bodies, debugging), `false` |
| Local files | Local media paths must resolve inside `roots`; `[]` denies all; unset = unrestricted | `fileAccess: { roots }` |
| URLs | Model-controlled URLs refuse private/loopback/link-local hosts (including DNS results), re-check redirects, cap size | automatic |
| Tool errors | Stack frames dropped; absolute paths and URL credentials scrubbed | `redactError` |
| Sub-agent traces | Visible only to the agent that spawned them; results are Symbol-branded | automatic |
| Sessions | Shape-validated on load; files `0600`, folders `0700` | `fileAccess` |

**Hardening checklist:** finite `maxTurns` + `deadlineMs` + `budget`; `fileAccess.roots` set; `captureRaw` left at `"redacted"`; tools validate their own inputs and honor `ctx.signal`; no secrets in `instructions`; treat web content fetched by tools as untrusted (prompt injection); log with `telemetryBus`. To require approval for a tool, ask inside `execute` and refuse with `ctx.stop(reason)` (the run ends `stopped`).

## Known limitations

Be aware (pre-1.0):
- **One process per home folder.** A folder you persist to is locked (`<folder>/.lock`): a second process fails fast with a `ConfigError` instead of silently losing updates; a lock left by a killed process is taken over, and local disks only. Writes are durable (fsync + `.bak` + atomic rename), so a crash or power cut never leaves a torn file; a damaged `tasks.json`, `deliveries.json` or `session.json` is restored from its `.bak`. Telemetry NDJSON is appended without fsync.
- Scheduled actions: creating Agent held weakly; `run_now` never retries; no spending guardrail except `dynamicSubagents.workerBudget`; no timezone/DST logic; run only while the process lives.
- Not implemented: `hooks`, `contextManagement`, `logger` config keys; `thinking.budgetTokens` forwarding; `stop`/`seed` on Google/OpenAI.
- Stateless adapters resend the full history every turn; whole-session snapshots are rewritten each step.
- The model catalog uses about 18 MB of memory when loaded; the SDK as a whole is not yet tuned for tiny-memory hosts.
- The SSRF guard resolves DNS before `fetch` (a DNS-rebinding window remains). Local disk only; no network drives.
- A major robustness and scale refactor (multi-process safety, durability, memory diet) is planned.

## For AI agents

- Set `maxTurns`, `limits.deadlineMs` and `budget` for anything that runs unattended; pass `signal` per call.
- Branch on error classes, not message text; `err.partial` holds progress; `err.retryable` tells you whether to retry.
- Do not rely on `hooks` or `logger`; subscribe to `telemetryBus` instead. To require approval for a tool, ask inside `execute` and refuse with `ctx.stop(reason)`.
- Keep `captureRaw` at `"redacted"` unless debugging locally.
- Default to `fileAccess: { roots: [...] }` whenever file paths or sessions come from outside your program.
- See also: [Tools and streaming](tools-and-streaming.md), [Multi-agent and scheduling](multi-agent.md), [Reference](../reference.md).
