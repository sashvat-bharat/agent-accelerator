# Settings

> Set limits and options in code, and decide which of them the end user may change.

The environment holds API keys and nothing else. Every other option is a **setting** that you set in code. A program that ships to other people, such as a harness or a binary, also decides which settings its users may change.

```ts
import { setConfigs, getConfigs, setConfig } from "agent-accelerator";

setConfigs({
  values: {
    usage_limit: { max_cost_usd: 5 },
    concurrency: { max_requests: 8, per_provider: { google: 4 } },
    catalog_refresh: "on",
    openrouter: { sort: "price" },
  },
  editable: ["concurrency", "catalog_refresh"],
});

getConfigs(); // { concurrency: {...}, catalog_refresh: "on" }: only the editable ones
setConfig("concurrency", { max_requests: 2 }); // works: it is editable
setConfig("usage_limit", { max_cost_usd: 1000 }); // throws SettingNotEditableError
```

The SDK never reads your settings from disk. Keep them in your code. A `configs.json` file you ship can be imported and passed to `setConfigs` in the same shape.

## Who can change what

A setting is **hidden** unless its key is in `editable`.

- A hidden setting only ever has your value. It never appears in `getConfigs()`.
- An editable setting has the user's value if they set one, then your value, then the built-in default (unlimited or off).
- Nothing is editable until you list it. If you never call `setConfigs`, there is no policy, and every setting is editable.

## The settings

All are optional, written in snake_case. A whole object is replaced, never merged.

| Key | Value |
|---|---|
| `usage_limit`, `scheduled_action_budget` | `{ max_cost_usd?, max_total_tokens? }`. Numbers above 0, at least one. The same caps as the Agent options `usageLimit` and `dynamicSubagents.scheduledActionBudget`. |
| `concurrency` | `{ max_requests?, per_provider?: { google: 4 } }`. Whole numbers of 1 or more. See [Limits and retries](limits-and-retries.md#limit-calls-that-run-at-once). |
| `catalog_refresh` | `"on"` or `"off"`. Whether the model catalog refreshes itself. |
| `catalog_cache_dir`, `models_dev_sha256` | The catalog cache folder, and a 64-character hex checksum that pins the download. |
| `base_urls` | An http(s) address per provider or custom prefix, such as `{ openai: "https://host/v1", ollama: "http://localhost:11434/v1" }`. |
| `openrouter` | `{ order?, only?, ignore?, allow_fallbacks?, require_parameters?, zdr?, data_collection?, sort?, parallel_tool_calls?, reasoning_exclude?, user? }`. OpenRouter request options. |
| `compat` | `{ no_stream_options?, no_session_headers? }`. Opt-outs for strict OpenAI-compatible services. |

## Rules

- **One error lists every problem.** A wrong shape, an unknown key, a bad value, or a key listed twice in `editable` throws one `ConfigError`. A failed `setConfigs` changes nothing. Calling `setConfigs` again replaces your settings.
- **`setConfig(key, value)`** changes one editable setting. `null` removes the user's value, so yours applies again. An unknown key or a bad value is a `ConfigError`. A hidden key is a `SettingNotEditableError`, which is a `ConfigError` and is never retried. A user's value is ignored as soon as its setting becomes hidden.
- **`getConfigs()`** returns the editable settings with their current value, frozen. `null` means "not set, the default applies".
- **This is a guardrail inside your program, not a security wall.** Other code in the same process can call `setConfigs` too.

## The user's saved choices

`setConfig` and `setModel` save in a small, visible file, `<home>/configs.json`. The user may edit it by hand.

```json
{ "version": 1, "model": "google/gemini-4-argon", "concurrency": { "max_requests": 2 } }
```

- It holds the chosen `model` and `sub_agent_model` (see [Allowed models](allowed-models.md)) and the values of editable settings.
- The folder is created on the first write. Reading creates nothing. With no file, the SDK uses your defaults.
- It is read once per process, and again when `setHome()` changes the home. A hand edit takes effect the next time the program starts. It lives in the process-wide home (`setHome()` or `.agent-accel/`), not in an agent's own `home`.
- Writes are durable: `fsync`, a `.bak` of the last good file, and an atomic rename, under a short lock that reads the file first. Processes that share a home do not lose each other's changes, and a crash leaves the old file or the new one. If the file cannot be written, `setConfig` throws `ConfigError` and changes nothing.
- A damaged file is set aside as `configs.json.corrupt-<time>`. The last good version is restored from `.bak` when there is one (`config.file_restored`). Otherwise the defaults apply (`config.file_invalid`). A file with another `version` is ignored and left in place.
- A hand edit that your program does not allow is ignored, with a `config.file_ignored_key` warning. Its `data.reason` is `unknown`, `invalid` or `hidden`, and your value wins. Unknown keys are kept when the file is rewritten.
