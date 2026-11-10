# src/providers/

All HTTP and wire parsing. Canonical mappers (thinking, cache, tool choice, structured output) live in `../providers.ts`, never here.

| File               | Wire                               | Notes                                                                                                                                                                                             |
| :----------------- | :--------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `google.ts`        | Google Interactions                | Stateful chaining (TTL gate, self-heal on `not_found`), exact replay of raw `steps`, media consts at the top, Gemini 4 long decode as background interactions.                                    |
| `openai.ts`        | OpenAI Responses                   | Stateless (`store:false`), full history every turn.                                                                                                                                               |
| `openrouter.ts`    | OpenRouter Chat Completions        | Every request streams (so it can be cancelled); `generate()` collects its own stream. A turn's `reasoning_details` blocks are kept as `providerSteps` and sent back verbatim on the next request. |
| `openai-compat.ts` | OpenAI-compatible Chat Completions | Serves every custom prefix; strict subset of fields; no default base URL.                                                                                                                         |
| `registry.ts`      | -                                  | Routes `provider/model` to an adapter; the registry is immutable; `ModelProvider` helpers.                                                                                                        |
| `shared.ts`        | -                                  | Helpers every adapter uses: signals and timers, error payloads, ids, retry-after, SSE scaffold (`linkStreamAbort`, `withAbortTimer`, `readSseData`, `incompleteStreamCheck`, `failStream`).       |

## Contract (`Provider`, in `../types/model.ts`)

`generate(model, context, options)` returns a `ProviderGenerateResult`; `stream(...)` returns an `AssistantMessageEventStream` that ends with an `AgentResponse`; optional `isLongRunning()` tells the loop to skip its whole-call timeouts.

## Invariants

- Fix shared streaming behaviour in `shared.ts`, never per adapter. Event parsing and request building stay in each adapter.
- OpenRouter and compat chat chunk handlers are deliberately not merged.
- A custom prefix never gets another provider's key or base URL.
- A transient failure is retried only before the first byte of a stream.
- A stream that ends without a terminal event while a tool call is missing or cut fails as a retryable `incomplete_stream`.
- Adapters cancel a reader with `reader.cancel().catch(() => {})`, never a bare `void reader.cancel()`.
- To add a provider: implement `Provider` on native `fetch`, reuse `shared.ts`, add pure mappers to `../providers.ts`, register in `registry.ts`.
