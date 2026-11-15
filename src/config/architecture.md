# src/config/

Settings the developer sets in code (v0.7.0). The SDK never reads these from the end user's home folder, so a user cannot change them by editing a file.

| File        | What it is                                                                                                                                                                                                                                                         |
| :---------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models.ts` | `parseModels` (pure validator for the exact `models.json` shape, one `ConfigError` listing every problem, result deep-frozen), `setModels(json)`, `listModels()` (the frozen list for a picker, `undefined` until `setModels` is called), `resetModels()` (tests). |

## Invariants

- The shape is exact: unknown keys are refused. Models sit under their provider WITHOUT the `provider/` prefix (OpenRouter ids keep their own slash); the SDK joins them into `provider/model`. No wildcards, no duplicates, no provider without models.
- `default.model` and `default.sub_agent_model` are full `provider/model` strings and must be in the list.
- A failed `setModels` changes nothing. The list is frozen: callers get a read-only view.
- This is a guardrail inside the program, not a security wall (code in the same process can call `setModels` again).
