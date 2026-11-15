# src/config/

Settings the developer sets in code (v0.7.0). The SDK never reads these from the end user's home folder, so a user cannot change them by editing a file.

| File        | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `models.ts` | `parseModels` (pure validator for the exact `models.json` shape, one `ConfigError` listing every problem, result deep-frozen), `setModels(json)`, `listModels()` (the frozen list for a picker, `undefined` until `setModels` is called), `resetModels()` (tests), and the enforcement helpers `isModelAllowed` / `assertModelAllowed` (throws `ModelNotAllowedError`), `allowedIds` (the catalog's read-time filter) and `onModelsChange`. |

| `settings.ts` | `parseConfigs` (pure validator for the exact `configs.json` shape: `values` + `editable`), the table of known settings and their rules, `setConfigs(json)`, `getConfigs()` (editable settings only, `null` = not set), `setConfig(key, value)` (typed `SettingNotEditableError` on a hidden key), `getSetting(key)` (the value the SDK reads), `resetConfigs()` (tests). |

## Invariants

- The shape is exact: unknown keys are refused. Models sit under their provider WITHOUT the `provider/` prefix (OpenRouter ids keep their own slash); the SDK joins them into `provider/model`. No wildcards, no duplicates, no provider without models.
- `default.model` and `default.sub_agent_model` are full `provider/model` strings and must be in the list.
- A failed `setModels` changes nothing. The list is frozen: callers get a read-only view.
- This is a guardrail inside the program, not a security wall (code in the same process can call `setModels` again).
- Enforcement points: `resolveModel` (every run start; `resolveModelUnchecked` is for code that only needs the provider), the `Agent` constructor (main and worker model), and `importSession`. `AgentConfig.allowedModels` was removed in 0.7.0.
- Without `setModels` nothing is restricted. A listed model the catalog does not know is allowed, with an unknown price.
- Settings: `hidden` is the default; only keys in `editable` may be changed. A hidden setting has only the developer's value; an editable one the user's, else the developer's, else the built-in default. With no `setConfigs` call every setting is editable. Whole objects are replaced, never merged. A user value is ignored once its setting is hidden. The user layer is in memory until C4 persists it to `<home>/configs.json`.
