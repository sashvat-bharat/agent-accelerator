# Reasoning and caching

> Control how much the model thinks, and get cheaper calls from prompt caching.

## Reasoning

Set `thinking` on the agent, or for one run:

```ts
import { Agent, ThinkingLevelError } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  thinking: "medium",
});

try {
  const res = await agent.run("Plan a 3-step database migration.", {
    thinking: "high", // for this run only
  });
  console.log(res.thinking); // a reasoning summary, if the model sent one
  console.log(res.text);
} catch (err) {
  if (err instanceof ThinkingLevelError) {
    console.error("Allowed levels:", err.allowedLevels);
  } else {
    throw err;
  }
}
```

| Level | Meaning |
|---|---|
| `none` | No reasoning. |
| `dynamic` | The provider decides. |
| `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Increasing effort. Each model supports some of them. |

- The level is checked against the model catalog before anything is sent. An unsupported level throws `ThinkingLevelError`, and `err.allowedLevels` lists the valid ones.
- `{ level, budgetTokens }` is accepted, but `budgetTokens` is not forwarded to any provider. It only warns.
- Every thinking turn is also sent to the telemetry bus as a `turn.thinking` event.

Tips:

- Start at `low` or `medium`. Reasoning costs output tokens.
- Do not hard-code a level for a model you have not checked. Ask with `getModelThinkingInfo(provider, model)`.

## Prompt caching

Providers cache the start of your prompt and charge less for it on the next call. You earn cache hits by keeping the start of the prompt the same.

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "openai/gpt-5.5",
  instructions: "A long, stable system prompt...",
  cache: "implicit",
  serviceTier: "flex", // cheaper and slower. Or "priority".
});

const res = await agent.run("Hello");
console.log(res.usage.cachedTokens, "of", res.usage.inputTokens, "cached");
```

`cache` takes one value. A provider honours only the values it supports. Any other value falls back to the provider's default and warns once, naming the values that work.

| Provider | Values | What is sent |
|---|---|---|
| Google | `implicit` | Nothing. Implicit caching is always on. |
| OpenRouter, `anthropic/*` models | `implicit`, `5m`, `1h` | `cache_control: { type: "ephemeral", ttl }` |
| OpenRouter, other models | `implicit` | Nothing. Caching is automatic. |
| OpenAI, GPT-5.6 and later (`gpt-5.6-*`, `gpt-6*`) | `implicit`, `30m`, `12h` | `prompt_cache_options: { ttl }` for `30m` and `12h`. `30m` is OpenAI's default. |
| OpenAI, older models | `implicit`, `12h` | `prompt_cache_retention: "24h"` for `12h`, when the catalog allows long retention. |
| Anthropic | `implicit`, `5m`, `1h` | `cache_control: { type: "ephemeral" }`, with a `ttl` for `5m` and `1h`. |
| Custom services | `implicit` | Nothing. Strict services reject unknown fields. |

`serviceTier` is `"flex"` or `"priority"` where the provider supports it. Leave it out for standard routing. `flex` suits work that can wait. `priority` suits work that needs a fast answer.

### Session affinity

Providers route repeat calls of one conversation to the same cache when you send a stable `sessionId`. The SDK sends it in the way each provider expects:

- `x-session-id` and `x-client-request-id` headers, to every provider, as a best effort.
- A `session_id` field in the body, to OpenRouter. It takes precedence over the header.
- `prompt_cache_key`, to OpenAI only. Custom services get the headers only.

Use the same `sessionId` across turns. Session ids are shortened to 64 characters, the length providers accept. In a browser, custom `x-*` headers are removed to avoid extra CORS requests. OpenAI keeps its affinity through the body key, and custom services lose it.

Tips:

- Keep `instructions`, the tool order and the `sessionId` the same between calls.
- Put anything that changes in `additionalContext` or the message, never in `instructions`.
- Measure with `cachedTokens` or with `SessionTelemetry` ([Usage and cost](usage-and-cost.md)).
- An older session file with `cache: { retention }` still loads. Passing that object to `new Agent()` throws a `ConfigError`.
