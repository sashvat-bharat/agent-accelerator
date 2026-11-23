# Errors and telemetry

> Handle failures by their class, and watch what the SDK is doing.

## Errors

```ts
import {
  Agent,
  BudgetExceededError,
  ProviderError,
  TimeoutError,
  formatErrorPlain,
  isAbortError,
} from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  budget: { maxCostUsd: 0.01 },
});

try {
  await agent.run("Write a long essay.", { signal: AbortSignal.timeout(30_000) });
} catch (err) {
  if (isAbortError(err)) console.log("cancelled");
  else if (err instanceof BudgetExceededError) console.log("over budget");
  else if (err instanceof TimeoutError) console.log("try again later");
  else if (err instanceof ProviderError && err.retryable) {
    console.log("try again later");
  }
  else console.error(formatErrorPlain(err)); // one line, no colors
  console.log("partial:", (err as { partial?: unknown }).partial);
}
```

Every SDK error extends `AgentAccelError`, which has a `code`, a `retryable` flag and a `context`. Branch on the class, never on the message text.

| Class | When |
|---|---|
| `ConfigError` | Missing key or address, a bad model, invalid config. `ModelNotAllowedError`, `SettingNotEditableError`, `ThinkingLevelError` and `SubAgentModelError` are kinds of `ConfigError`. |
| `ProviderError` | The provider API failed, or sent a reply that cannot be used. |
| `TimeoutError` | A request, first-byte or idle timeout. Retryable. |
| `BudgetExceededError` | A budget or limit was exceeded. Partial usage is attached. |
| `ToolError` | A tool failed in a way that reaches the caller. |
| `ValidationError` | Input did not validate, before any network call. |
| `SessionLoadError` | A valid session file is over the load limits. |
| `SecurityPolicyError` | A path outside `fileAccess.roots`, or a private address. `RemoteFetchError` is related. |

The [Reference](../reference.md#errors) lists exactly when each is raised.

- **Abort** means `signal.aborted` or `name === "AbortError"` only. Use `isAbortError(err)`.
- **Provider failures** are one-line `ProviderError`s. `err.code` is `"provider"` (`"incomplete_stream"` for a cut stream). `err.retryable` is true for HTTP 408, 425, 429 and 5xx, network errors and a cut stream.
- **Details** such as `statusCode`, `provider`, `model`, `url`, `responseBody`, `errorType`, `providerCode`, `retryAfterMs` and `raw` are not enumerable, so logs stay small.
- A failed run attaches what it had as `err.partial`: usage, turns, text, and tool calls and results.

## Telemetry

The SDK prints nothing. Warnings and traces go to the telemetry bus. Attach a listener to see them:

```ts
import { telemetryBus } from "agent-accelerator";

const off = telemetryBus.onEvent((e) => {
  if (e.level === "warn") console.warn(`[${e.code}] ${e.message}`);
  if (e.code === "turn.thinking") console.log("reasoning:", e.data);
});
// later: off();
```

The bus runs inside your process and delivers events at once. A listener that throws does not affect the others.

Events include provider warnings (`provider_warning`), Google chain and stream anomalies, `cache_clamp`, catalog and session notices, `config.*` warnings, `agent.max_turns_truncated`, `turn.thinking`, `concurrency.*`, `config.file_*`, `tool.*` and `scheduled_action.*`. The full list is in the [Reference](../reference.md#telemetry-codes).

`AgentResponse.raw` and the stream's `start` event show the wire exchange, according to `captureRaw`.

### Keep events in files

Set `telemetry: { persist: true }` to keep a trace that survives a crash. Every event except reasoning text is appended, one line each:

- An event of a saved session goes to `<home>/sessions/<id>/telemetry.ndjson`, next to that session's journal and tool logs. This includes the `tool.*` events, `agent.resumed` and `agent.run_retry`. A worker's events go to its own folder.
- Everything else goes to `<home>/telemetry/<date>.ndjson`.
- Nothing is written outside the home. A session saved to a `persist.dir` outside it logs to the daily file.
- A `tool.call_started` with no ending event was running when the process died. The last `tool.progress` shows how far it got.

Nothing is written unless you turn it on.
