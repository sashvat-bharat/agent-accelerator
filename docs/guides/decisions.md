# Asking decision models

A decision model answers **typed questions about an input and returns probabilities, not text**. Your code can branch, sort or route on the numbers: "is this ticket about billing, and how sure are you?" costs a fraction of a chat call, answers in a moment, and gives a value you can put a threshold on.

`generateDecision` is one function and stateless: no `Agent`, no session. It works with Google (`gemini-decision-1`), OpenAI (`gpt-6-luna`) and every decision model OpenRouter lists.

```ts
import { generateDecision } from "agent-accelerator";

const r = await generateDecision({
  model: "google/gemini-decision-1",
  input: "I was charged twice for my order and I will cancel if nobody helps today.",
  questions: {
    upset: { type: "noul", instructions: "Is the customer upset?" },
    dept: {
      type: "choice",
      instructions: "Which department should handle this?",
      criteria: { billing: "Payments and refunds.", technical: "Problems using the product.", other: "" },
    },
    urgency: { type: "score", instructions: "How urgent is this?", criteria: ["Low", "Medium", "High"] },
  },
});

const { dept } = r.answers;
if (dept.type === "choice" && dept.confidence > 0.8) route(dept.choice);
else route("human_review"); // a low-confidence answer goes to a person
```

All the questions of one call share one request, so the input is paid for once however many questions you ask, and the questions cannot see each other.

## Questions

`questions` maps a name (`A-Z a-z 0-9 _ -`, up to 64 characters) to a question. The question types and their fields are the providers' own, so what you read in Google's or OpenRouter's documentation is what you write here:

| `type` | Asks | `criteria` | Answer |
|---|---|---|---|
| `"noul"` | A yes/no question | optional `{ true: "...", false: "..." }` saying what yes and no mean | `noul` (the probability of yes), `confidence` |
| `"choice"` | Pick one option | required: `{ optionName: "when it applies" }` (`""` when the name says it all), 2 or more options | `choice`, `probabilities` (they add up to 1), `confidence` |
| `"score"` | Rate on ordered levels | required: a list of level descriptions from lowest to highest, 2 or more, numbered from 0 | `score`, `probabilities` and `legend` (both by level number), `confidence` |

`instructions` is the whole question: the model never sees the question's name, so write it out in full. It is a string, or a list of strings, `{ type: "text", text }` parts and `{ type: "json", json }` parts that are joined in order **with no separator** (add your own spaces or newlines). Instructions are text only.

- `noul` is a probability from 0 to 1 of "yes"; "no" is `1 - noul`. Google keeps it between 0.01 and 0.99, so do not set a threshold above 0.99.
- `score` is the probability-weighted average of the level numbers, so it can fall between levels (1.12 is just above level 1). Look at `probabilities` and `confidence` too when an input can split across levels. To compare scales of different length, divide by the highest level number.
- `confidence` is the probability that the top answer is right: the top probability, or `max(noul, 1 - noul)` for yes/no. Some models do not send it; the SDK fills it the same way.
- A choice always spreads its probability over your options, even when none fits. Add a catch-all option with a clear description ("other"), threshold `confidence`, or pair it with a yes/no scope question.

Keep each question about one decision, and send only the fields the questions need: unrelated input lowers accuracy. Ask narrow questions and combine the answers in your own `if` statements.

An answer can also be `{ type: "refusal" }`: the model declined that question (the others still have answers). Treat it as "not answered" and fail closed. Always check `answer.type` before reading an answer: that is what makes TypeScript let you read `noul`, `choice` or `score`.

## The input

`input` is what every question is about: a string, one part or a list of parts.

| Part | Is |
|---|---|
| `"some text"` or `{ type: "text", text }` | text |
| `{ type: "json", json: { order: { id: 8821 } } }` | data, written as compact text (refer to its fields by key path in your instructions) |
| `{ type: "image", image: "photo.png" }` (also `audio`, `video`, `file` for a PDF) | a picture, sound, video or PDF: a path, URL, data URL, base64 string or bytes |

Only the models that read media accept it: an input kind the model does not read fails before the network with a message that lists what it does read. Local paths must be inside `fileAccess.roots` when you set it. Pass the real file type: the providers reject generic types. An image or video part can carry a `resolution` (`low`, `medium`, `high`, `ultra_high`) that sets how much detail the model spends on it (and its token cost); Google honours it.

## Models

`listDecisionModels(provider?)` returns every known model; `getDecisionModel("google/gemini-decision-1")` returns one. Each entry says what the model reads, its limits and what it costs.

| Model | Reads | Questions per request | Price per 1M input tokens |
|---|---|---|---|
| `google/gemini-decision-1` | text, images, audio, video, PDF | 1000 | $0.10 for every kind (free tier available; Google may use free-tier data to improve its products) |
| `openai/gpt-6-luna` | text, images | 400 (score: up to 10 levels) | $0.10, cache reads $0.01, prompts over 272,000 tokens cost double; output is not charged |
| `openrouter/<vendor>/<model>` | what the model reads | not stated | the list's price |

Google and OpenAI are checked by hand against the providers' pages. **OpenRouter serves dozens of decision models that change often, so the SDK reads OpenRouter's own list** (`GET /api/v1/models?output_modalities=decisions`, which needs your OpenRouter key) the first time you use one, saves it in `<home>/catalog/openrouter-decisions.json` and refreshes it every 12 hours. A failed refresh keeps the old copy and is not retried for 10 minutes; `catalog_refresh: "off"` never downloads (the saved copy is used). `listDecisionModels("openrouter")` is empty until the list was read once; `await refreshOpenRouterDecisionModels()` reads it on demand. OpenRouter also lists free models (`...:free`); their price is a known $0. OpenRouter's decisions endpoint is in alpha ("the shape may change"), so a change on their side can break a call before it breaks this SDK's tests.

The same questions work on every model; the SDK writes each provider's own request. Models you can use through OpenRouter keep OpenRouter's limits (a media kind the model does not read is a 400 there, and the SDK says so first).

## Options

| Option | Meaning |
|---|---|
| `model`, `input`, `questions` | required |
| `signal`, `timeoutMs` | Stop the call; per request, default 60 000 ms (`0` or `Infinity` turns it off). |
| `budget.maxCostUsd` | Stops once the reported or priced cost passes it. |
| `fileAccess.roots` | Local media paths must be inside these folders. |
| `apiKey`, `baseUrl`, `headers`, `env`, `fetch`, `retry` | Connection settings, as for `generateImage`. |
| `captureRaw` | What `result.raw` keeps of the wire exchange (default: no text, like `AgentConfig.captureRaw`). |

Every request is checked before any network call. A problem (a name outside the allowed characters, a choice with one option, an input kind the model does not read, too many questions or levels for the model) is one `ValidationError` that lists every problem. Option names follow Google's rule (1 to 128 characters, no control characters, no leading or trailing space), which keeps a request valid on every model. A call runs under the `concurrency` setting like every provider call, and the SDK never splits one request into several: over a model's question limit is an error, because splitting would pay for the input again.

## The result

| Field | Meaning |
|---|---|
| `answers` | One answer per question, under its name |
| `model`, `provider` | What served it |
| `usage` | Tokens as the provider reported them, and `usage.cost` |
| `raw` | The wire audit (bodies redacted unless `captureRaw: true`) |

Every answer is checked before you get it (right type, probabilities from 0 to 1, a choice that was one of your options, a score inside the levels). A reply that fails the check is a `ProviderError` naming the question, never a guess. The `legend` of a score always comes from your own `criteria`.

`usage.cost` is the provider's reported cost when it sends one (OpenRouter), else the reported input tokens priced from the table in integer micro-USD (so a tiny call rounds to a whole micro-dollar). Output is never charged. A model with no known price, or cache writes with no stated rate, leaves the cost **unknown (`undefined`), never $0**.

## Errors

| Error | When |
|---|---|
| `ConfigError` | Unknown model, missing key, an OpenRouter list that could not be read and was never saved |
| `ModelNotAllowedError` | The model is outside the `setModels` list |
| `ValidationError` | The request does not fit the model (every problem listed), or an unusable `budget` |
| `BudgetExceededError` | The cost passed `budget.maxCostUsd` |
| `ProviderError` | The provider failed, or sent back an unusable answer |
| `TimeoutError`, `AbortError` | A request took longer than `timeoutMs`; `signal` aborted |

## Not included

- OpenRouter's `box` question (a bounding box on an image, Jev models only) is not supported; it may be added if other providers adopt it.
- Media inside the instructions, OpenAI's explicit cache breakpoints, and the providers' Batch and Flex modes.
- Choosing a threshold: set it from labeled examples of your own traffic and weigh a false positive against a false negative.
