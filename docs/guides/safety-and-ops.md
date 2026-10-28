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
    requestTimeoutMs: 60_000, // one provider call (default 300 s)
    firstByteTimeoutMs: 30_000, // streaming (default 120 s)
    streamIdleTimeoutMs: 60_000, // streaming (default 300 s)
  },
  budget: { maxCostUsd: 0.5, maxTotalTokens: 300_000, maxDurationMs: 180_000, maxTotalSubagents: 8 }, // per run, includes workers
  retry: { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 5_000, budgetMs: 30_000 }, // defaults shown
  onFailure: "auto",
});

console.log((await agent.run("Hello")).finishReason);
```

| Setting | What happens when hit |
|---|---|
| `maxTurns` | Run stops with `finishReason: "max_turns"` and a bus warning (`agent.max_turns_truncated`) if tools were still pending. |
| `limits.*` | Deadline/tool-count: error with partial results; timeouts raise a retryable `TimeoutError`. |
| `budget.*` | Throws `BudgetExceededError` with partial usage. Unknown pricing counts as $0 toward `maxCostUsd`. |
| `retry` | Transient failures (HTTP 408/425/429/500/502/503/504, network codes, `transient`/`retryable` flags; never message text). `Retry-After` is honored within `budgetMs`; streams retry only before the first byte. |
| `onFailure` | `"auto"` rolls the conversation back unless a tool already ran (side effects stay on record); `"rollback"` always; `"keep"` never. Aborts never roll back. |

Cancel anytime with `{ signal }` or `agent.interrupt()`; the error carries `err.partial` (usage, turns, text, tool calls/results).

**Recommendations**
- ✅ Production defaults: finite `maxTurns`, a `deadlineMs`, a `budget.maxCostUsd`, and an `AbortSignal.timeout(...)` per request.
- ✅ Keep tool timeouts shorter than the run deadline. ❌ Don't retry side-effecting tools blindly.

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

All SDK errors extend `AgentAccelError` (`code`, `retryable`, `context`): `ConfigError`, `ProviderError`, `TimeoutError`, `BudgetExceededError`, `ToolError`, `ValidationError`, `SessionLoadError`, `SecurityPolicyError` (and `RemoteFetchError`), plus `ThinkingLevelError`, `SubAgentModelError`, `DocumentConversionError`. Abort means `signal.aborted` or `name === "AbortError"` only. Provider failures are one-line errors; details (`statusCode`, `provider`, `model`, `url`, `responseBody`, `errorType`, `code`, `retryAfterMs`, `raw`) are non-enumerable so logs stay small.

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
| Local files | Media paths and the built-in document tool must resolve inside `roots`; `[]` denies all; unset = your own parts unrestricted, model-callable document tool limited to the working directory | `fileAccess: { roots }` |
| URLs | Model-controlled URLs refuse private/loopback/link-local hosts (including DNS results), re-check redirects, cap size | automatic |
| Tool errors | Stack frames dropped; absolute paths and URL credentials scrubbed | `redactError` |
| Sub-agent traces | Visible only to the agent that spawned them; results are Symbol-branded | automatic |
| Sessions | Shape-validated on load; files `0600`, folders `0700` | `fileAccess` |

**Hardening checklist:** finite `maxTurns` + `deadlineMs` + `budget`; `fileAccess.roots` set; `captureRaw` left at `"redacted"`; tools validate their own inputs and honor `ctx.signal`; no secrets in `instructions`; treat web content fetched by tools as untrusted (prompt injection); log with `telemetryBus`. `needsApproval` is **not** enforced: add your own approval step.

## Known limitations

Be aware (pre-1.0):
- **One process per home folder.** There is no cross-process lock; concurrent writers can lose updates. No `fsync` yet (a process crash is safe; a power loss is not guaranteed).
- Scheduled actions: creating Agent held weakly; `run_now` flagged `late` and never retries; no spending guardrails; no timezone/DST logic; run only while the process lives.
- Not implemented: `hooks`, `contextManagement`, `logger` config keys; `thinking.budgetTokens` forwarding; `stop`/`seed` on Google/OpenAI.
- Stateless adapters resend the full history every turn; whole-session snapshots are rewritten each step.
- The model catalog uses about 18 MB of memory when loaded; the SDK as a whole is not yet tuned for tiny-memory hosts.
- The SSRF guard resolves DNS before `fetch` (a DNS-rebinding window remains). Local disk only; no network drives.
- A major robustness and scale refactor (multi-process safety, durability, memory diet) is planned.

## For AI agents

- Set `maxTurns`, `limits.deadlineMs` and `budget` for anything that runs unattended; pass `signal` per call.
- Branch on error classes, not message text; `err.partial` holds progress; `err.retryable` tells you whether to retry.
- Do not rely on `needsApproval`, `hooks` or `logger`; subscribe to `telemetryBus` instead.
- Keep `captureRaw` at `"redacted"` unless debugging locally.
- Default to `fileAccess: { roots: [...] }` whenever file paths or sessions come from outside your program.
- See also: [Tools and streaming](tools-and-streaming.md), [Multi-agent and scheduling](multi-agent.md), [Reference](../reference.md).
