# Generating embeddings

> Turn text, pictures, sounds and PDFs into vectors, to search by meaning, find duplicates or group similar items.

An embedding turns a piece of text (or, on some models, a picture, a sound clip, a video or a PDF) into a list of numbers. Things with a similar meaning get lists that are close to each other, so you can search by meaning, find duplicates, group similar items, or give an agent a memory of earlier notes.

`generateEmbedding` makes the vectors. It is one function and stateless: no `Agent`, no session. The SDK does not store or search the vectors for you; keep them in a vector database, a file, or memory, and compare them with `cosineSimilarity`.

```ts
import { generateEmbedding, cosineSimilarity } from "agent-accelerator";

const model = "openai/text-embedding-3-small";

const docs = await generateEmbedding({
  model,
  input: [
    "Cats purr when they are content.",
    "Dogs bark at strangers.",
    "Rust has a borrow checker.",
  ],
});
const question = await generateEmbedding({
  model,
  input: "Which animal purrs?",
});

// The first number is the highest:
console.log(docs.vectors.map((v) => cosineSimilarity(question.vector, v)));
// What it cost, or undefined when unknown:
console.log(docs.usage.cost);
```

A list always gives **one vector per item, in the same order**, on every model.

## What you can embed

`input` is one item or a list of items. An item is:

| Item | Makes |
|---|---|
| `"some text"` | one vector for the text |
| `{ type: "image", image: "photo.png" }` (also `audio`, `video`, `file` for a PDF) | one vector for that picture, sound, video or PDF; a path, URL, data URL, base64 string or bytes |
| `{ parts: [{ type: "text", text: "A red fox" }, { type: "image", image: "fox.png" }] }` | ONE combined vector for all its parts (only on models that read more than text) |

Only the models that read pictures, sounds, video or PDFs accept them; any other model fails before the network with a message that lists what it does read. Local paths must be inside `fileAccess.roots` when you set it.

## Models

`listEmbeddingModels(provider?)` returns every known model; `getEmbeddingModel("google/gemini-embedding-2")` returns one. Each entry says what the model reads, its limits, how long its vectors are and whether you can shorten them, how a task is expressed, and what it costs.

| Model | Reads | Vector length | Price per 1M tokens |
|---|---|---|---|
| `google/gemini-embedding-2` | text, images, audio, video, PDF | 3072, shortenable to 128 to 3072 (768, 1536 or 3072 recommended) | text $0.20 (images $0.45, audio $6.50, video $12) |
| `google/gemini-embedding-001` | text | 3072, shortenable to 128 to 3072 | $0.15 |
| `openai/text-embedding-3-small` | text | 1536, shortenable | $0.02 |
| `openai/text-embedding-3-large` | text | 3072, shortenable | $0.13 |
| `openai/text-embedding-ada-002` | text | 1536, fixed | $0.10 |
| `openrouter/<vendor>/<model>` | what the model reads | not stated: sent as asked | the list's price |

Google and OpenAI are checked by hand against the providers' pages.

**OpenRouter has dozens of embedding models that change often, so the SDK reads OpenRouter's own public list** (`GET https://openrouter.ai/api/v1/embeddings/models`, no key needed).

- It reads the list the first time you use an OpenRouter model, saves it in `<home>/catalog/openrouter-embeddings.json` and refreshes it every 12 hours.
- A failed refresh keeps the old copy and is not retried for 10 minutes. `catalog_refresh: "off"` never downloads, and the saved copy is used.
- `listEmbeddingModels("openrouter")` is empty until the list was read once. `await refreshOpenRouterEmbeddingModels()` reads it on demand.
- OpenRouter also lists free models (`...:free`). Their price is a known $0.

Vectors of different models are **not comparable**, and neither are two lengths of the same model: `gemini-embedding-001` and `gemini-embedding-2` live in different spaces, so embed everything you compare with the same model and `dimensions`. `cosineSimilarity` throws when the lengths differ.

## Options

| Option | Meaning |
|---|---|
| `model`, `input` | required |
| `dimensions` | Vector length. Checked against what the model accepts (`ada-002` is fixed). A shorter vector keeps most of the quality and is cheaper to store. |
| `task` | What the vectors are for: `search_query`, `search_document`, `question_answering`, `fact_checking`, `code_retrieval`, `classification`, `clustering`, `similarity`. Embed the questions as `search_query` and the passages as `search_document`; use the same task on both sides for the last three. |
| `title` | A document title, with `task: "search_document"` (Google models only). |
| `signal`, `timeoutMs` | Stop the call; per request, default 60 000 ms (`0` or `Infinity` turns it off). |
| `budget.maxCostUsd` | Stops once the reported or priced cost passes it. |
| `fileAccess.roots` | Local media paths must be inside these folders. |
| `apiKey`, `baseUrl`, `headers`, `env`, `fetch`, `retry` | Connection settings, as for `generateImage`. |
| `captureRaw` | What `result.raw` keeps of the wire exchange (default: no text, like `AgentConfig.captureRaw`). |

The same `task` works everywhere. The SDK turns it into what each model needs:

- `gemini-embedding-001`: a `taskType` field.
- `gemini-embedding-2`: the documented words in front of the text. For a query: `task: search result | query: ...`. For a document: `title: <title or none> | text: ...`. Media in the same item is never prefixed.
- OpenRouter: `input_type`.
- A model with no such control (OpenAI) gets a single `provider_warning`, and the option is dropped.

`gemini-embedding-001` vectors shorter than 3072 are not unit length, so the SDK normalizes them for you.

## Checks, warnings and long lists

Every option is checked before any network call. A value the model cannot take (an input kind it does not read, a length outside its range, too many images in one item) is one `ValidationError` that lists every problem. Token counts are not checked (the SDK has no tokenizer): the provider's error says when an input is too long.

A list longer than the model takes in one request (OpenAI: 2048; Google and OpenRouter: 100) is split into several requests, up to four at a time and each under the `concurrency` setting. The first failure stops the rest, and the vectors that did finish are on `error.partial.vectors`, aligned with your input (`undefined` where missing).

## The result

| Field | Meaning |
|---|---|
| `vectors` | One `number[]` per input item, in order |
| `vector` | The first vector |
| `dimensions` | How many numbers each vector has |
| `model`, `provider` | What served it |
| `usage` | Tokens as the provider reported them, and `usage.cost` |
| `requests` | Provider requests made |
| `raw` | The wire audit (bodies redacted unless `captureRaw: true`) |

`usage.cost` is the provider's reported cost when it sends one (OpenRouter). Otherwise the reported tokens are priced from the table in whole micro-dollars, so a tiny call rounds up to one micro-dollar.

- A reply with no usage, or media tokens with no per-kind split, leaves the cost **unknown (`undefined`), never $0**.
- `gemini-embedding-001` reports no usage at all, so its cost is always unknown.
- `gemini-embedding-2` reports tokens per kind (an image counts 258 tokens), so its cost is exact.

## Errors

| Error | When |
|---|---|
| `ConfigError` | Unknown model, missing key, an OpenRouter list that could not be read and was never saved |
| `ModelNotAllowedError` | The model is outside the `setModels` list |
| `ValidationError` | The request does not fit the model (every problem listed), or an unusable `budget` |
| `BudgetExceededError` | The cost passed `budget.maxCostUsd` |
| `ProviderError` | The provider failed, or sent back an unusable reply (wrong count, empty or non-numeric vectors) |
| `TimeoutError`, `AbortError` | A request took longer than `timeoutMs`; `signal` aborted |

## Not included

- No vector storage or search: use a vector database or compare with `cosineSimilarity`.
- The providers' Batch APIs (cheaper, slower) are not used.
- `gemini-embedding-2` combines a whole list into one vector when sent together; the SDK sends each item on its own so a list always gives one vector each. To combine on purpose, use `{ parts }`.

A runnable walkthrough is in [`examples/18-embeddings.ts`](../../examples/18-embeddings.ts): offline by default (scripted providers, no key), `--live <model>` for a real call.
