# Testing your agents

> Test your own agents with a scripted model: no network, no key, no cost.

`fauxProvider` is a scripted stand-in for a model: no network, no key, no cost. You write down what the model should answer, build an `Agent` with `faux.config`, and run your own code against it.

It is a `fetch` that speaks the OpenAI-compatible chat wire, so your agent still runs through the **real adapter**: history building, streaming, tool-call parsing, usage, retries and errors behave as in production. Only the model's answers are scripted.

```ts
import { Agent, tool, fauxProvider } from "agent-accelerator";
import { z } from "zod";

const getWeather = tool({
  description: "Weather for a city",
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => `Sunny in ${city}`,
});

const faux = fauxProvider([
  // 1st model call: asks for the tool.
  { toolCalls: [{ name: "getWeather", arguments: { city: "Paris" } }] },
  // 2nd model call: the final answer.
  "It is sunny in Paris.",
]);

const agent = new Agent({ ...faux.config, tools: { getWeather } });
const res = await agent.run("Weather in Paris?");

console.log(res.text); // "It is sunny in Paris."
// What the model got the second time, with the tool result:
console.log(faux.calls[1]?.body.messages);
```

## Steps

The script is a list; each call to the model uses the next step.

| Step | Meaning |
|---|---|
| `"text"` | The model answers with that text. |
| `{ text, thinking, toolCalls, usage, cost, finishReason, error, delayMs }` | A full reply (all keys optional). `toolCalls` is `[{ name, arguments?, id? }]`. `usage` is `{ inputTokens, outputTokens, cachedTokens }` (by default about a quarter of the characters sent and written). `cost` is a provider-reported USD cost. `finishReason` overrides `stop` (for example `"length"`). `delayMs` waits first and can be interrupted. |
| `{ error: { status, message, retryAfterSeconds } }` | The provider answers with an HTTP error (a 429 or 5xx is retried like a real one). |
| `(request) => string \| reply` | Decide from the request: `{ number, stream, body, lastUserText, toolNames }`. |

## What you get back

- `faux.config`: `{ model, apiKey, baseUrl, fetch }`: spread it into `new Agent({ ... })`.
- `faux.calls`: every model call so far (the parsed request body, the last user text, the tool names).
- `faux.remaining`: steps not used yet. `faux.push(...steps)` adds steps; `faux.reset()` forgets the calls and starts the script again.
- When the script runs out, the next call fails with a clear `ProviderError` ("no scripted reply left for call N"). Pass `{ repeatLast: true }` to answer with the last step again instead.
- `{ prefix }` changes the provider prefix of the model string (default `faux`, giving `faux/faux-model`).

## Good to know

- Streaming works: `agent.stream(...)` receives real text, thinking and tool-call deltas.
- If your program uses `setModels`, add `faux/faux-model` to the allowed list in your test setup.
- It tests your agent code, tools, hooks and error handling. It does not test what a real model would say.
