# src/decision/

Decision models: `generateDecision` and its pieces. The supported models and their facts are in `../models/decision-models.ts` (Google and OpenAI by hand) and `../models/openrouter-decisions.ts` (OpenRouter's own list, cached); the wire code of each provider is in `../providers/<provider>.ts` (`Provider.decide`).

| File          | What it is                                                                                                                                                                                                                                                                                              |
| :------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request.ts`  | `resolveDecisionRequest`: checks a `DecisionOptions` against the model's entry (input kinds, question and option and level counts, names, criteria), turns JSON into text and every instructions value into one string, and returns the final request. Pure. One `ValidationError` lists every problem. |
| `generate.ts` | `generateDecision`: makes sure OpenRouter's list is loaded (for `openrouter/...`), model lookup (`ConfigError` with the reason), `setModels` check, request check, media read (`fileAccess`), ONE provider request under `withProviderSlot`, timeout and abort, answer checks, pricing, budget.         |
| `pricing.ts`  | `priceDecisionUsage`: the table's input price in integer micro-USD (cache reads at their rate, the long-context multiplier); `undefined` when it cannot be priced exactly (no price, no usage, cache writes with no stated rate).                                                                       |
| `result.ts`   | `DecisionResult`: `answers`, `usage`, `model`, `provider`, `raw`.                                                                                                                                                                                                                                       |

## Invariants

- The public question and answer shapes are the providers' own vocabulary (`noul`, `choice`, `score`, `criteria`, `probabilities`, `confidence`, `legend`); an adapter translates to and from its wire (OpenAI uses predicate, choices and levels) and never leaks that difference.
- One call is one provider request: all questions share the input, so it is paid for once. Over a model's question limit is an error, never a split.
- The adapter receives a checked request and returns one answer per question by name; the core checks every answer (type, numbers, option names), fills what a provider leaves out (a yes/no `confidence`, a score `legend` from the criteria) and throws a non-retryable `ProviderError` naming the question for an unusable one. A `refusal` is a valid answer.
- Cost: the provider's reported cost wins, else the table prices the reported input tokens, else it is unknown (never 0). Output is never charged.
- `box` questions (OpenRouter, Jev models) are not supported on purpose.
