# Allowed models

> Fix the list of models your program may use, and let the user choose from it.

A program that ships to other people, such as a harness or a binary, often needs one fixed list of models. Put the list in your code and give it to `setModels`. The SDK never reads the list from disk, so a user cannot change it by editing a file in their home folder.

```ts
import { setModels, listModels } from "agent-accelerator";

setModels({
  default: {
    model: "google/gemini-4-argon",
    sub_agent_model: "google/gemini-4-argon",
  },
  providers: {
    google: { models: ["gemini-4-argon", "gemini-4-carbon"] },
    anthropic: { models: ["claude-opus-5-5"] },
    openrouter: { models: ["meta/muse-ember"] },
  },
});

// A list for a model picker:
for (const m of listModels()?.models ?? []) console.log(m.model);
```

## The shape of the list

- **Models sit under their provider without the `provider/` prefix.** The SDK joins them into `provider/model`. OpenRouter ids keep their own slash: `"meta/muse-ember"` becomes `openrouter/meta/muse-ember`. Use real catalog ids. Anthropic ids use dashes: `claude-opus-5-5`.
- **`default.model` and `default.sub_agent_model`** are full `provider/model` strings and must be on the list.
- **The list means "any of these".** It is not a fallback order, and the model never picks from it.
- **The shape is exact.** A wrong shape, an unknown key, a provider with no models, an empty, duplicate or wildcard (`*`) entry, a `provider/` prefix, or a default outside the list throws one `ConfigError` that lists every problem. Nothing changes.
- **`listModels()`** returns `{ default, models: [{ provider, id, model }] }`, frozen, or `undefined` until you call `setModels`. Calling `setModels` again replaces the list.
- **This is a guardrail inside your program, not a security wall.** Other code in the same process can call `setModels` too.

## The user's choice

`setModel(id)` and `setSubAgentModel(id)` save the user's pick in `<home>/configs.json`. They are the only way the model is written. See [Settings](settings.md#the-users-saved-choices).

- The id must be a full `provider/model` string that is on your list. Otherwise `ModelNotAllowedError` is thrown and nothing is saved. With no list, any non-empty id is accepted.
- An `Agent` with no `model` uses the saved choice, then your `default.model`. A worker with no model uses the saved `sub_agent_model`, then `default.sub_agent_model`. This also covers a `subagents: [...]` entry written as data without a `model`; a plain `Agent` without one uses the main model.
- A model you name in the `Agent` config always wins.
- A saved model that is no longer on the list (you shipped a new list) is ignored, with a `config.saved_model_ignored` warning, and the default is used.

## Where the list is enforced

Once you call `setModels`, a model outside the list throws `ModelNotAllowedError`. It is a `ConfigError`, so it is never retried. The message names the model and lists the available ones, like `Model "openai/gpt-6" is not available. Available: google/gemini-4-argon, ...`.

The list is checked wherever a model is picked:

- Every run start (`run`, `stream`, queued runs, resumed runs), before anything is sent.
- The `Agent` constructor, for the main model and the worker model. This also covers `Agent.fromConfig` and `fork()`.
- Chat workers and scheduled runs. A scheduled run whose model is off the list is recorded as failed.
- `importSession`, for the session's model and worker model, before anything changes.

The model catalog is filtered when it is read. `getModelsForProvider` and the catalog lookups show only listed models, and clearing the list brings everything back. The cache files are never changed, because several processes can share one home.

A listed model the catalog does not know is still allowed. Its price is unknown, never $0. Without `setModels`, nothing is restricted.
