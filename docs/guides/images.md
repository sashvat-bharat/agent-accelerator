# Generating images

`generateImage` makes pictures with a supported image-generation model. It is one function and stateless: no `Agent` is involved. Pass a prompt, get an `ImageResult`, save the picture.

```ts
import { generateImage } from "agent-accelerator";

const result = await generateImage({
  model: "google/gemini-nano-banana-2.1",
  prompt: "A nano banana dish in a fancy restaurant with a Gemini theme",
  aspectRatio: "16:9",
  resolution: "2K",
});

await result.image.save("banana.png"); // folders are created, the write is atomic, a name with no extension gets the right one
console.log(result.usage, result.model, result.provider);
```

## Which models

Only the models in `listImageModels()` are supported: Google `gemini-nano-banana-2.1` and `gemini-3.1-flash-lite-image`, OpenAI `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2.6-sunburst` and `gpt-image-2.6-flare`, and the same four OpenAI models through OpenRouter (`openrouter/openai/gpt-image-2.6-sunburst` ...). Through OpenRouter a model has the same prices and limits but takes an `aspectRatio` and no `size` or `resolution`. Any other model is a `ConfigError` that says why (for example `gpt-image-1` was shut down by OpenAI on 23 Oct 2026) and lists the supported ones. Each entry of `listImageModels()` says what that model accepts: aspect ratios, resolution tiers or exact-size rules, quality levels, output formats, reference-image limit, thinking levels, token limits and prices. Google's Search grounding is never used. A model outside a `setModels` list is refused like any other model.

## Options

Only `model` and `prompt` are required (the prompt may be up to 32,000 characters on OpenAI models).

| Option | Meaning |
| --- | --- |
| `images` | Pictures to edit or combine (path, URL, data URL, base64, bytes, or a `GeneratedImage`). The prompt then says what to change. |
| `aspectRatio` | `"16:9"`, `"1:1"` ... Each model lists its ratios (Nano Banana 2.1: 14, Flash Lite: 10; OpenAI: any from 1:3 to 3:1). |
| `resolution` | `"512"`, `"1K"`, `"2K"`, `"4K"`. Google models make their listed tiers (Flash Lite: `1K` only). OpenAI turns the tier and ratio into pixels (1K is about 1 megapixel, 2K about 4, 4K up to the model's 8.3 megapixel maximum, sides in multiples of 16). |
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

- **Google** (`gemini-nano-banana-2.1`, `gemini-3.1-flash-lite-image`): the Interactions endpoint, `POST /interactions`. The ratio, size tier and file type go in `response_format`, the thinking level in `generation_config`, reference images are input blocks. One request makes one picture, so `n` runs one request per picture. The picture is the `model_output` step's image; the interim "thought images" are never returned and Google does not charge for them, but thinking tokens are billed (they are part of the cost the SDK reports). Search grounding is never requested. The key is `GEMINI_API_KEY` or `GOOGLE_API_KEY`; the endpoint can be moved with the `base_urls.google` setting or `baseUrl`. Google stores interactions by default, as for chat.
- **OpenRouter** (`openrouter/openai/gpt-image-*`): OpenRouter's Image API, `POST /images`, with the OpenAI model id. Reference images go in `input_references`. The `aspect_ratio`, `quality`, `output_format`, `background` and `n` (up to 10 in one request) are sent as set; the developer's provider routing (`order`, `only`, `ignore`, `allow_fallbacks`, `require_parameters`, `zdr`, `data_collection`, `sort`) and `user` come from the `openrouter` setting, exactly as for chat. OpenRouter reports the USD cost of the call and the SDK uses it as the price. A failed generation is a 502 that OpenRouter does not bill and the SDK retries; a 402 means too little credit. The key is `OPENROUTER_API_KEY`.
- **OpenAI** (`gpt-image-*`): the Image API, `POST /images/generations`, or `/images/edits` when `images` are given (they travel as data URLs). One request returns up to 10 pictures; the key is `OPENAI_API_KEY` (or `OPENAI_BASE_API_KEY`) and the endpoint can be moved with the `base_urls.openai` setting or `baseUrl`. A moderation block (`moderation_blocked`) is never retried: the error says at which stage and in which categories, and that the prompt or images must change. Streaming partial images, masks, markup, SVG and GIF output are not used.

## Editing a picture

`await image.edit("Make it night")` changes a picture and returns a new `ImageResult`. It uses the model and the connection settings (key, endpoint, headers, `fetch`, retry, timeout) of the call that made the picture; pass options to override them, including `model`. Nothing else carries over, so ask again for a ratio, size, quality or `n`. On the same Google model the call continues the stored conversation (the model remembers the picture, and edits chain); on any other model, including a different Google model, the picture is sent as the first reference image and counts against the model's reference limit. `generateImage({ ..., continueFrom: image })` does the same by hand. A picture that did not come from `generateImage` (for example `new GeneratedImage(bytes, "image/png")`) needs `{ model }`.

## Cost

`result.usage` is what the provider reported, and `result.usage.cost` is filled in for you: the provider's own cost when it sends one, else the price worked out from the reported tokens and the model's table entry (`listImageModels()` has every price). Image output bills at the image rate ($30 per 1M tokens on all supported models) and everything else the model writes (text, thinking) at the text rate, so a Google call is priced from its image/text split. An OpenAI call that sent reference images is priced from its text/image input split. A cost the table cannot work out exactly stays unknown (`usage.cost` is unset), never a made-up number, and when you ask for several pictures one unpriced request makes the total unknown instead of a partial sum. Cache hits are not priced (the Image API and the Google image models report none). Example: one 1K Nano Banana 2.1 picture is 1,120 image tokens, $0.0336.

## What a model cannot do

The request is checked against the model before anything is sent.

- A value outside the model's list (an aspect ratio, tier, quality, format, thinking level or too many reference images) is one `ValidationError` that lists every problem and what the model does accept, so one fix round is enough.
- A control the model does not have at all (`quality`, `background` or `size` on a Google model; `thinking` on an OpenAI model; `size` or `resolution` through OpenRouter) is dropped with a single `provider_warning` on the telemetry bus, so the same code keeps working across models.
- Flash Lite warns when you send several reference images (Google says it is not optimized for them); OpenAI sizes above 2560x1440 on the 2.5 models warn that OpenAI calls them experimental.

## The result

`ImageResult` has `images` (a list of `GeneratedImage`), `image` (the first; a result always has one), `text` (words the model wrote next to the picture), `usage`, `model`, `provider`, `finishReason`, `raw`, `durationMs` and `requests` (provider requests made). A `GeneratedImage` has `bytes`, `mimeType`, `base64`, `dataUrl`, `extension`, `save(file)` and `toPart()` (an `ImagePart` to send it to an agent). `JSON.stringify` of a result or an image never contains the bytes.

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

## For AI agents

- Import `generateImage` from `agent-accelerator`; the model is a `provider/model` string from `listImageModels()`. Do not invent model ids and do not pass the models of other providers.
- Never combine `size` with `aspectRatio` or `resolution`. Read the model's entry (`getImageModel(model)`) for what it accepts instead of guessing.
- `result.image` is never undefined. Save with `await result.image.save(path)`.
