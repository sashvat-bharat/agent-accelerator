# Generating images

> Make pictures with Google or OpenAI image models, edit them, and let an agent make them.

`generateImage` is one function and stateless. No `Agent` is involved. Pass a prompt, get an `ImageResult`, save the picture.

```ts
import { generateImage } from "agent-accelerator";

const result = await generateImage({
  model: "google/gemini-nano-banana-2.1",
  prompt: "A nano banana dish in a fancy restaurant with a Gemini theme",
  aspectRatio: "16:9",
  resolution: "2K",
});

// Folders are created, the write is atomic, and a name with no
// extension gets the right one.
await result.image.save("banana.png");
console.log(result.usage, result.model, result.provider);
```

## Which models

Only the models in `listImageModels()` are supported. Each entry says what the model accepts: aspect ratios, resolution tiers or exact sizes, quality levels, output formats, the reference-image limit, thinking levels, token limits and prices. `getImageModel("google/gemini-nano-banana-2.1")` returns one.

| Model | Provider | Aspect ratios | Sizes | Reference images | Thinking | Image output |
| --- | --- | --- | --- | --- | --- | --- |
| `gemini-nano-banana-2.1` | `google` | 14 (1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, 16:9, 21:9) | 1K, 2K, 4K | up to 14 | minimal, medium (default), high | $30 / 1M tokens ($0.0336 at 1K) |
| `gemini-3.1-flash-lite-image` | `google` | 10 (1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9) | 1K | not optimized for several | minimal (default), high | $30 / 1M tokens ($0.0336 at 1K) |
| `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2.6-sunburst`, `gpt-image-2.6-flare` | `openai` | any from 1:3 to 3:1 | exact `WIDTHxHEIGHT` (multiples of 16, at most 3840 px, 0.65 to 8.3 megapixels) | up to 16 | none | $30 / 1M tokens |
| the same four, as `openrouter/openai/gpt-image-...` | `openrouter` | 14 (1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 21:9, 4:5, 5:4, 2:1, 1:2, 3:1, 1:3) | by aspect ratio only | up to 16 | none | $30 / 1M tokens |

- Through OpenRouter, a model has the same prices and limits but takes an `aspectRatio` and no `size` or `resolution`.
- Any other model throws a `ConfigError` that says why and lists the supported ones. For example, OpenAI shut down `gpt-image-1` on 23 Oct 2026.
- Other Google image models, and OpenAI's deprecated ones (`gpt-image-2`, `gpt-image-1.5`, `gpt-image-1-mini`, `chatgpt-image-latest`), are not supported.
- Google's Search grounding is never used.
- A model outside a `setModels` list is refused like any other model.

## Options

Only `model` and `prompt` are required (the prompt may be up to 32,000 characters on OpenAI models).

| Option | Meaning |
| --- | --- |
| `images` | Pictures to edit or combine (path, URL, data URL, base64, bytes, or a `GeneratedImage`). The prompt then says what to change. |
| `aspectRatio` | `"16:9"`, `"1:1"` ... Each model lists its ratios (Nano Banana 2.1: 14, Flash Lite: 10; OpenAI: any from 1:3 to 3:1). |
| `resolution` | `"512"`, `"1K"`, `"2K"` or `"4K"`. Google models make the tiers they list (Flash Lite: `1K` only). OpenAI turns the tier and ratio into pixels: 1K is about 1 megapixel, 2K about 4, and 4K up to the model's 8.3 megapixel maximum, with sides in multiples of 16. |
| `size` | An exact `"1536x864"` (OpenAI models only; not together with `aspectRatio` or `resolution`). |
| `quality` | `low` ... `max`, `auto` (OpenAI models). |
| `format` | `png`, `jpeg`, `webp` (Google models: `png`, `jpeg`). |
| `background` | `transparent` (needs `png` or `webp`), `opaque`, `auto` (OpenAI models). |
| `n` | 1 to 10 pictures. A model that makes fewer per request (Google: one) is called several times in parallel, under the concurrency limit. |
| `thinking` | A thinking level (Google models: Nano Banana 2.1 `minimal`, `medium` (default), `high`; Flash Lite `minimal`, `high`). |
| `signal`, `timeoutMs`, `retry` | Abort, per-request timeout (default 300 000 ms; `0` turns it off) and retries of transient failures. |
| `budget` | `{ maxCostUsd }` for this call: Google models are estimated before anything is sent, and any call is stopped once the reported cost passes it. An unknown price counts as 0, never a guess. |
| `fileAccess` | `{ roots }`: local reference images must be inside these folders. |
| `apiKey`, `baseUrl`, `headers`, `env`, `fetch`, `captureRaw` | As on `AgentConfig`. |

## How each provider is called

### Google

- The Interactions endpoint, `POST /interactions`. The key is `GEMINI_API_KEY` or `GOOGLE_API_KEY`. Move the endpoint with the `base_urls.google` setting or `baseUrl`.
- The ratio, size tier and file type go in `response_format`. The thinking level goes in `generation_config`. Reference images are input blocks.
- One request makes one picture, so `n` runs one request per picture.
- The picture is the image of the `model_output` step. The interim "thought images" are never returned, and Google does not charge for them. Thinking tokens are billed, and they are part of the cost the SDK reports.
- Search grounding is never requested. Google stores interactions by default, as for chat.

### OpenRouter

- OpenRouter's Image API, `POST /images`, with the OpenAI model id (`openrouter/openai/gpt-image-*`). The key is `OPENROUTER_API_KEY`.
- Reference images go in `input_references`. `aspect_ratio`, `quality`, `output_format`, `background` and `n` (up to 10 in one request) are sent as you set them.
- Your provider routing (`order`, `only`, `ignore`, `allow_fallbacks`, `require_parameters`, `zdr`, `data_collection`, `sort`) and `user` come from the `openrouter` setting, exactly as for chat.
- OpenRouter reports the USD cost of the call, and the SDK uses it as the price.
- A failed generation is a 502 that OpenRouter does not bill, and the SDK retries it. A 402 means too little credit.

### OpenAI

- The Image API, `POST /images/generations`, or `/images/edits` when you give `images` (they travel as data URLs). One request returns up to 10 pictures.
- The key is `OPENAI_API_KEY` (or `OPENAI_BASE_API_KEY`). Move the endpoint with the `base_urls.openai` setting or `baseUrl`.
- A moderation block (`moderation_blocked`) is never retried. The error says at which stage and in which categories, and that the prompt or images must change.
- Streaming partial images, masks, markup, SVG and GIF output are not used.

## Editing a picture

`await image.edit("Make it night")` changes a picture and returns a new `ImageResult`.

- It uses the model and the connection settings (key, endpoint, headers, `fetch`, retry, timeout) of the call that made the picture. Pass options to override them, including `model`.
- Nothing else carries over, so ask again for a ratio, size, quality or `n`.
- On the same Google model, the call continues the stored conversation. The model remembers the picture, and edits chain.
- On any other model, including a different Google model, the picture is sent as the first reference image and counts against the model's reference limit.
- `generateImage({ ..., continueFrom: image })` does the same by hand.
- A picture that did not come from `generateImage` (for example `new GeneratedImage(bytes, "image/png")`) needs `{ model }`.

## Letting an agent make pictures: `imageTool`

```ts
import { Agent, imageTool } from "agent-accelerator";

const designer = new Agent({
  model: "google/gemini-3.5-flash-lite",
  tools: {
    make_image: imageTool({
      model: "openai/gpt-image-2.6-flare", // the developer's choice, never the LLM's
      dir: "./out", // default: <home>/images
      // Fixed values. They also take apiKey, fetch, retry and more.
      defaults: { aspectRatio: "1:1", quality: "medium" },
      allow: ["aspectRatio"], // what the LLM may set besides the prompt (default: none)
      // A cap for the life of this tool object (default 8).
      // Every picture costs money.
      maxImages: 4,
    }),
  },
});
```

- The tool saves each picture as `<words-of-the-prompt>-<n>.<ext>`, never overwriting, and tells the model the paths.
- An `allow` option becomes an enum of what that model accepts.
- A wrong setup (an unsupported model, an `allow` entry the model lacks, `defaults` it cannot take) throws when the tool is created.
- Past `maxImages`, the model is told the limit is used up, and nothing more is requested.
- With `show: true`, the model also sees the pictures. This works for Google agents. Other providers get the text only, with one warning.
- The spend is a worker line (`role: "image"`) in `agent.usageReport()` and in its total.

## Cost

`result.usage` is what the provider reported, and `result.usage.cost` is filled in for you.

- It is the provider's own cost when it sends one. Otherwise it is worked out from the reported tokens and the model's table entry. `listImageModels()` has every price.
- Image output bills at the image rate ($30 per 1M tokens on all supported models). Everything else the model writes, such as text and thinking, bills at the text rate. A Google call is priced from its image and text split.
- An OpenAI call that sent reference images is priced from its text and image input split.
- A cost the table cannot work out exactly stays unknown (`usage.cost` is unset), never a made-up number. When you ask for several pictures, one unpriced request makes the total unknown instead of a partial sum.
- Cache hits are not priced. The Image API and the Google image models report none.
- Example: one 1K Nano Banana 2.1 picture is 1,120 image tokens, which is $0.0336.

## What a model cannot do

The request is checked against the model before anything is sent.

- A value outside the model's list (an aspect ratio, tier, quality, format, thinking level or too many reference images) is one `ValidationError` that lists every problem and what the model does accept, so one fix round is enough.
- A control the model does not have at all (`quality`, `background` or `size` on a Google model; `thinking` on an OpenAI model; `size` or `resolution` through OpenRouter) is dropped with a single `provider_warning` on the telemetry bus, so the same code keeps working across models.
- Flash Lite warns when you send several reference images (Google says it is not optimized for them); OpenAI sizes above 2560x1440 on the 2.5 models warn that OpenAI calls them experimental.

## The result

An `ImageResult` has `images` (a list of `GeneratedImage`), `image` (the first one: a result always has one), `text` (words the model wrote next to the picture), `usage`, `model`, `provider`, `finishReason`, `raw`, `durationMs` and `requests` (the provider requests made).

A `GeneratedImage` has `bytes`, `mimeType`, `base64`, `dataUrl`, `extension`, `save(file)` and `toPart()` (an `ImagePart`, to send the picture to an agent). `JSON.stringify` of a result or an image never contains the bytes.

## Errors

| Error | When |
| --- | --- |
| `ConfigError` | An unsupported model, a missing key. |
| `ModelNotAllowedError` | A model outside the `setModels` list. |
| `ValidationError` | An option outside the model's lists (all problems at once), an empty prompt, a reference that is not an image. |
| `SecurityPolicyError` | A local reference image outside `fileAccess.roots`. |
| `BudgetExceededError` | Over `budget.maxCostUsd`. |
| `ProviderError` | The provider failed, or returned no picture (the reason is in the message). A call that returns always has at least one picture. |
| `TimeoutError`, `AbortError` | `timeoutMs` passed, or `signal` aborted. |

When one of several parallel requests fails, the others are aborted (so they stop billing), the original error is thrown, and the pictures that had finished are on `error.partial.images`.

A runnable demo (offline, no key) is in [`examples/17-image-generation.ts`](../../examples/17-image-generation.ts).
