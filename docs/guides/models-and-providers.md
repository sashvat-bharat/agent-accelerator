# Models and providers

> Choose a model, see where it goes, pin a provider when you need to, and teach the SDK about private models.

## Write the model as `provider/model`

The part before the first slash decides which provider is called and which key is used.

| Model string | Goes to | Key |
|---|---|---|
| `google/<id>` (or `gemini/<id>`) | Google Interactions API | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| `openai/<id>` | OpenAI Responses API | `OPENAI_API_KEY` |
| `anthropic/<id>` | Anthropic Messages API | `ANTHROPIC_API_KEY` |
| `openrouter/<vendor>/<id>` (or `vendor/id:variant`) | OpenRouter Chat Completions | `OPENROUTER_API_KEY` |
| `<prefix>/<id>` (anything else) | An OpenAI-compatible Chat Completions service | `<PREFIX>_API_KEY` and `base_urls.<prefix>` |
| `<id>` with no provider | The catalog is searched (Google, OpenAI, Anthropic, OpenRouter), then OpenRouter | |

Always write the provider. Rules worth knowing:

- A custom prefix never falls back to another vendor's key or default address. A missing address is an error before any network call.
- A local service (localhost, a LAN address, `*.local`) may have no key.
- Gemini older than version 3 is rejected before the network.
- If you set `base_urls.openai`, a model with no provider goes to OpenAI.

An OpenAI-compatible service needs its address once, in code:

```ts
import { Agent, setConfigs } from "agent-accelerator";

setConfigs({ values: { base_urls: { groq: "https://api.groq.com/openai/v1" } } });

const agent = new Agent({ model: "groq/llama-3.3-70b-versatile" });
```

## Pin the provider, key and address

When several providers run in one process, say exactly which key and address each agent uses:

```ts
import { Agent, ModelProvider } from "agent-accelerator";

const gemini = new Agent({
  model: ModelProvider.GoogleGenAI(
    "gemini-3.5-flash-lite",
    process.env.GEMINI_API_KEY,
    { thinkingLevel: "low" },
  ),
});

const groq = new Agent({
  model: ModelProvider.OpenAICompatible(
    "groq/llama-3.3-70b-versatile",
    process.env.GROQ_API_KEY,
    { baseUrl: "https://api.groq.com/openai/v1" },
  ),
});

console.log((await gemini.run("hi")).provider);
console.log((await groq.run("hi")).provider);
```

The helpers are `ModelProvider.GoogleGenAI`, `OpenAI`, `Anthropic`, `OpenRouter` and `OpenAICompatible`. Each returns a `ModelProviderInstance` (`{ model, apiKey?, baseUrl?, thinkingLevel? }`) that you can pass as `model`. You can also pass `apiKey` and `baseUrl` straight to the `Agent`.

To see where a string goes before you ship, call `resolveModel`. It throws if the model is not allowed.

```ts
import { resolveModel } from "agent-accelerator";

const { provider, modelId } = resolveModel("google/gemini-3.5-flash-lite");
console.log(provider.id, modelId);
```

## What differs between providers

The SDK handles these differences for you:

| | Google | OpenAI | OpenRouter | Custom |
|---|---|---|---|---|
| History | Chained on Google's side | Sent each turn | Sent each turn | Sent each turn |
| `serviceTier` | `flex`, `priority` | `flex`, `priority` | `flex`, `priority` | Dropped with a warning |
| `thinking` | `thinking_level` (up to `high`) | `reasoning.effort` | `reasoning.effort` | Dropped with a warning |
| Video and files | Yes | Images and files | Images, video, files | Images and audio only |

An option a provider does not support is dropped, and a warning goes to the telemetry bus. It is never sent.

- **Google conversations** are kept on Google's side for 23 hours (`googleTier: "free"`, the default) or 54 days (`"paid"`). After that the SDK sends the full history again.
- **Long answers on Gemini 4.** A `maxOutputTokens` above 65,536 runs as a background job of up to 24 hours. `run()` waits for it, `stream()` reconnects after a dropped connection, and cancelling stops it on Google's side.
- **OpenRouter attribution** headers are opt-in: `setAttribution({ referer, title })`.
- **Switching providers** in the middle of a conversation works. The history does not depend on the provider.

What each adapter sends and how it reads the answer is in [Provider notes](provider-notes.md).

## The model catalog

The SDK reads limits, prices, input types and reasoning options from a small cached copy of [models.dev](https://models.dev). It keeps one file per provider in `<home>/catalog/`, and reads a file the first time that provider is used.

| Provider | Models kept |
|---|---|
| `google` | `gemini-3*` and newer |
| `openai` | `gpt-5*` and newer |
| `anthropic` | `claude-*-5*` and newer |
| `openrouter` | Every model whose only output is text |

Any other model is **unknown** to the catalog. Its price is unknown, any thinking level is accepted, and the SDK does not check its input types. A model that only OpenRouter lists, such as `openai/gpt-4o`, is found through its OpenRouter entry.

Describe a private or fine-tuned model with `registerModel`, so its price and limits are known:

```ts
import {
  createGenericModelSpec,
  getModelFromCatalog,
  registerModel,
} from "agent-accelerator";

console.log(getModelFromCatalog("google", "gemini-3.5-flash-lite")?.limit?.context);

registerModel({
  ...createGenericModelSpec("openai", "ft:gpt-4o:acme"),
  contextWindow: 128_000,
  pricing: { inputPerMillion: 3, outputPerMillion: 12 },
});
```

### Keeping the catalog fresh

- The catalog is valid for 12 hours. After that it is used right away and refreshed in the background (8 second timeout, then a 10 minute pause after a failure). The very first start waits for the download.
- A bad download never replaces a good copy.
- On air-gapped machines and in tests, turn the refresh off: `setConfigs({ values: { catalog_refresh: "off" } })`.
- Pin the download with a checksum using the `models_dev_sha256` setting. Move the cache with `catalog_cache_dir`.
- Refresh by hand with `bun run update-models` (or `--force`, or `--ttl=24h`).
- Never edit the cache files. Use `registerModel`.

Other helpers: `refreshModelCatalog`, `ensureModelCatalogFresh`, `getCatalogStatus`, `setCatalogTTL`, `getModelsForProvider`, `getModelThinkingInfo`, `validateModelThinking`, `modelSupportsStructuredOutput`, `getModelSource`, `clearCustomModels`.

Custom prefixes never borrow another provider's price or abilities. The catalog uses almost no memory at start. Only a small index is read, and a provider's file (a few MB at most) is read on its first lookup.

## Tips

- Use `ModelProvider.*` or `apiKey` and `baseUrl` when you run several providers in one process.
- Check a string with `resolveModel` before you ship.
- There are no `stop`, `seed` or `temperature` options.
- On a read-only deployment, set `catalog_cache_dir` to a folder you can write to.
