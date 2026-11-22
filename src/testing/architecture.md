# src/testing/

Helpers for testing code built on the SDK. Public (exported from `index.ts`), never used by the SDK itself.

| File      | What it is                                                                                                                                                                                                                                                                                                                                               |
| :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `faux.ts` | `fauxProvider(steps, options)`: a scripted `fetch` that speaks the OpenAI-compatible chat wire (JSON and SSE), with `config` to spread into `new Agent`, the recorded `calls`, `remaining`, `push`, `reset`. A step is a string, a `FauxReply` (text, thinking, tool calls, usage, cost, finish reason, HTTP error, delay) or a function of the request. |

## Invariants

- It is a `fetch`, not a `Provider`: the Agent runs through the real compat adapter, so streaming, tool-call parsing, usage and retries are the production code paths. The provider registry stays immutable.
- No network, no key, no cost. A script that runs out is a clear HTTP 400 (a `ProviderError`), never a silent empty answer, unless `repeatLast` is set.
- A change to the compat wire (`providers/openai-compat.ts`) must keep `test/faux.test.ts` green: it is the check that this fake still looks like the real thing.
