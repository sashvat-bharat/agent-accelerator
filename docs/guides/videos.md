# Generating videos

`generateVideo` makes a clip with a supported video model. It is one function and stateless: no `Agent` is involved. Pass a prompt, wait, save the clip.

```ts
import { generateVideo } from "agent-accelerator";

const result = await generateVideo({
  model: "google/gemini-omni-1.2-flash",
  prompt: "A marble rolling fast on a chain reaction style track, continuous smooth shot.",
  duration: 6,
  aspectRatio: "16:9",
  onProgress: (p) => console.log(p.status, p.progress), // only providers that work in jobs report progress
});

await result.video.save("marble.mp4"); // folders are created, the write is atomic, a name with no extension gets the right one
console.log(result.usage.cost, result.video.durationSeconds, result.jobId ?? result.responseId);
```

A video takes seconds to minutes and **costs real money** (Google's model is about $0.07 per second at 720p). Every option is checked against the model before anything is sent, so a wrong request never reaches the provider.

## Which models

`listVideoModels(provider?)` returns every known model; `getVideoModel("google/gemini-omni-1.2-flash")` returns one. Each entry says which lengths, tiers and ratios the model makes, which pictures it takes (first frame, last frame, reference pictures, reference clips), whether it writes audio, its limits and its prices.

- **Google:** one model, `google/gemini-omni-1.2-flash` (3 to 15 seconds, 360p / 720p / 1080p / 4K, 16:9 or 9:16, with audio). Its predecessor `gemini-omni-1.1-flash` is not supported: Google reroutes it to 1.2 on 3 Dec 2026, so asking for it is the plain "not a known video model" error.
- **OpenRouter:** `openrouter/<vendor>/<model>` for every model on OpenRouter's public list (`GET https://openrouter.ai/api/v1/videos/models`, no key needed). The SDK reads it the first time you use one, saves it in `<home>/catalog/openrouter-videos.json` and refreshes it every 12 hours (a failed refresh keeps the old copy and is not retried for 10 minutes; `catalog_refresh: "off"` never downloads). Only models that make a video from a prompt are kept: the list also holds upscalers, editors and avatar makers, which are skipped. `listVideoModels("openrouter")` is empty until the list was read once; `await refreshOpenRouterVideoModels()` reads it on demand.

OpenRouter's list states lengths, tiers, ratios, exact sizes, frame roles and the audio flag, and the SDK checks against them. It does **not** state a default length, how many reference pictures a model takes, or whether it reads reference clips, and prices differ in unit per model: those stay unknown (the SDK never guesses), and OpenRouter reports the real cost of every job. A model outside a `setModels` list is refused like any other model.

## Options

Only `model` is required, and `prompt` unless you give a `firstFrame`.

| Option | Meaning |
| --- | --- |
| `prompt` | What happens in the clip. |
| `duration` | Whole seconds from the model's list, or `"auto"` on models that can choose (OpenRouter `-1`). Google defaults to 10 s when you omit it; a model with no stated default gets none sent. |
| `resolution` | A tier from the model's list (`"720p"`, `"1080p"`, `"4K"` ...; matched without regard to case, so `"4k"` works). |
| `aspectRatio` | A ratio from the model's list. |
| `size` | An exact `"1280x720"` from the model's list (models that list sizes; not together with `aspectRatio` or `resolution`). |
| `firstFrame`, `lastFrame` | A picture the clip starts from / ends on (path, URL, data URL, base64, bytes or a `GeneratedImage`). A model with no such role refuses it: it is never silently turned into text-to-video. With both frames Google allows at most 10 s. |
| `referenceImages` | Pictures that guide who or what is in the clip (Google: up to 6). On OpenRouter use frames **or** reference pictures: it ignores references when frames are sent, so the SDK refuses the mix. |
| `referenceVideos` | Short clips that guide look or motion. Google: up to 3 clips of at most 3 s for a clip of 10 s or less, 1 clip for 11 to 15 s. The length of each MP4 or MOV clip is read from its header and a clip over the limit is refused before anything is sent (other containers are left to the provider). Where a provider's list does not say whether a model reads clips (all of OpenRouter), they are sent with one `provider_warning` that a model that does not read them simply ignores them. |
| `audio` | `false` asks for a silent clip where the model has a switch. Google Omni always writes audio, so `false` is dropped with a warning (like `seed` or `size` on a model without them). |
| `seed` | For repeatable results, on models that take one. |
| `onProgress` | Called with `{ status, progress?, jobId? }` each time a polled job reports in. |
| `signal`, `timeoutMs`, `pollIntervalMs`, `retry` | Abort; the whole call including polling (default 600 000 ms, `0` or `Infinity` turns it off); how often a job is polled (default 10 000 ms); retries of transient failures. |
| `budget` | `{ maxCostUsd }`: Google is estimated from the table before anything is sent; any call is checked again against the reported cost. An unknown price counts as 0, never a guess. |
| `fileAccess` | `{ roots }`: local pictures and clips must be inside these folders. |
| `continueFrom` | A clip an earlier call made, to change it (see [Editing a clip](#editing-a-clip)). `video.edit(prompt)` sets it for you. |
| `apiKey`, `baseUrl`, `headers`, `env`, `fetch`, `captureRaw` | As everywhere in the SDK. |

Values outside a model's list (a length, tier, ratio, size, too many pictures or clips, a clip that is too long) are one `ValidationError` that lists every problem; controls the model does not have at all are dropped with a single `provider_warning`.

## Editing a clip

`result.video.edit(prompt, options?)` changes a clip with a follow-up prompt, on the model that made it and with the same connection settings (key, endpoint, headers, `fetch`, retry, timeout, poll interval). Google continues the stored interaction; OpenRouter continues the job (`previous_job_id`). Each edit returns a new `VideoResult` whose clip can be edited again.

```ts
const first = await generateVideo({ model: "google/gemini-omni-1.2-flash", prompt: "A violinist on a stage", duration: 6 });
const second = await first.video.edit("Make the violin invisible.");
await second.video.save("edited.mp4");
```

An edit takes the prompt only: pictures and clips cannot be added to it, and a length, tier or ratio is sent only when you ask again (the edit otherwise keeps the clip's own length). A clip can only be edited by the model that made it, and only when it came from `generateVideo` (or `resumeVideo`): anything else is a `ValidationError`. Google keeps the interaction for later edits only while it is stored (the SDK never turns storing off), and Google's own retention limits apply.

## Resuming a job

A timeout or an abort does not cancel a job at the provider. For OpenRouter the error carries `jobId`, and `resumeVideo` asks for that job again, polls it to the end and downloads the file, without submitting (or paying for) a new one:

```ts
try {
  await generateVideo({ model: "openrouter/google/veo-3.1", prompt: "A marble", duration: 8, timeoutMs: 120_000 });
} catch (err) {
  if (err instanceof TimeoutError && err.jobId) {
    const result = await resumeVideo({ model: "openrouter/google/veo-3.1", jobId: err.jobId });
    await result.video.save("marble.mp4");
  }
}
```

`resumeVideo` takes `model`, `jobId`, the connection options, `signal`, `timeoutMs`, `pollIntervalMs`, `onProgress`, `budget` and `captureRaw`. Google answers in one request, so it has no job to resume (a `ConfigError`).

## The result

`generateVideo` returns a `VideoResult`:

| Field | Meaning |
| --- | --- |
| `video` | A `GeneratedVideo`: `bytes`, `mimeType`, `base64`, `dataUrl`, `extension`, `durationSeconds` (MP4 and MOV), `save(file)`, `toPart()` (a `VideoPart` for an agent). |
| `text` | Words the model wrote next to the clip, when it wrote any. |
| `usage` | Tokens and `cost` (the provider's report, else the table's price, else unknown). |
| `jobId` / `responseId` | OpenRouter's job id / Google's interaction id. |
| `model`, `provider`, `finishReason`, `raw`, `durationMs` | As for images. |

`JSON.stringify(result)` never contains the bytes.

## Failures, timeouts and jobs left running

- A reply with no video (a refusal) is a non-retryable `ProviderError` that carries the model's words.
- On a timeout or an abort a job already running at the provider is **not cancelled and may keep billing**. The error carries `error.jobId` so you can find it; a timeout is a `TimeoutError`, an abort an `AbortError`.
- A call that holds the `concurrency` governor's slot holds it until the job ends.
- A cost over `budget.maxCostUsd` after the video was made throws a `BudgetExceededError` with the finished clip on `error.partial.video`: it was paid for.

Errors: `ConfigError` (unknown model, missing key), `ModelNotAllowedError`, `ValidationError`, `SecurityPolicyError` (a local path outside `fileAccess.roots`), `BudgetExceededError`, `TimeoutError`, `ProviderError`, `AbortError`.

A runnable walkthrough is in [`examples/20-video.ts`](../../examples/20-video.ts): offline by default (scripted providers, no key, no cost), `--live <model>` makes a real clip with the shortest length and lowest tier the model lists (this costs money).
