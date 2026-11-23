# src/

The whole SDK. `index.ts` is the only public entry (`main`/`module`/`types`); everything else is reached through it.

| File / folder       | What it is                                                                                                                                                                  |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`          | The public barrel. Adding or removing an export is a public API change.                                                                                                     |
| `telemetry.ts`      | The in-process event bus (`telemetryBus`). Imports nothing from the SDK, so any module may use it.                                                                          |
| `telemetry-file.ts` | Opt-in NDJSON sink for the bus: a persisted session's events go to `<session folder>/telemetry.ndjson`, the rest to `<home>/telemetry/<date>.ndjson`; never outside a home. |
| `update-models.ts`  | CLI behind `bun run update-models` (refreshes the model catalog cache).                                                                                                     |
| `providers.ts`      | Provider-agnostic mappers (thinking, cache, tool choice, structured output, generation params). No HTTP.                                                                    |
| `agent/`            | `Agent`, the model-to-tools loop, workers, delegation.                                                                                                                      |
| `testing/`          | `fauxProvider`: a scripted `fetch` (OpenAI-compatible wire) so tests can run an Agent through the real adapter with no network.                                             |
| `providers/`        | One adapter per wire (Google, OpenAI, Anthropic, OpenRouter, OpenAI-compatible), the registry, shared helpers.                                                              |
| `image/`            | `generateImage`: the per-model request check, the call, `ImageResult` / `GeneratedImage`.                                                                                   |
| `video/`            | `generateVideo`: the request check, the call (polling for job-based providers), clip-length checks, pricing, `VideoResult`, `GeneratedVideo`.                               |
| `decision/`         | `generateDecision`: the request check, the call, answer checks, pricing, `DecisionResult`.                                                                                  |
| `embedding/`        | `generateEmbedding`: the request check, the call split into requests, pricing, `EmbeddingResult`, `cosineSimilarity`.                                                       |
| `models/`           | The model catalog (a small per-provider extract of models.dev) and its cache.                                                                                               |
| `tools/`            | `tool()`, schemas, the executor.                                                                                                                                            |
| `streaming/`        | The event stream and the SSE parser.                                                                                                                                        |
| `session/`          | Persistence (snapshot + journal), usage accounting, tool logs.                                                                                                              |
| `prompts/`          | The SDK's own prompts as `.md` files, `DEFAULT_PROMPTS`, `AgentConfig.prompts`.                                                                                             |
| `config/`           | Developer settings set in code: the allowed-models list (`setModels`, `listModels`) and the settings (`setConfigs`, `getConfigs`, `setConfig`).                             |
| `scheduler/`        | Scheduled actions.                                                                                                                                                          |
| `types/`            | Shared contracts (no logic except small helpers).                                                                                                                           |
| `utils/`            | Small shared helpers (durable writes, home, env, media, retry, safe I/O).                                                                                                   |

## Rules for every file here

- Imports use `.ts` extensions; type-only imports use `import type`.
- No `console.*`: warnings and traces go to `telemetryBus` (exceptions: the `update-models.ts` CLI and one compat `console.warn` in `providers.ts`).
- All state is written under the one home folder (`utils/home.ts`). Files are replaced through `utils/durable.ts`; the append-only ones are the session journal and tool logs (fsynced per line) and the opt-in telemetry file (not fsynced).
- Provider differences never leave `providers/` and `providers.ts`.
- Every export has an explicit type: `tsconfig.src.json` checks `src/` with `isolatedDeclarations`, and `bun run typecheck` runs it. Every `as unknown as` cast and every empty `catch` has a reason line.
- Every function has one comment line above it (how it works, where input comes from, where output goes).
- Change a public option, export, env var or telemetry code: update `README.md` and `docs/` in the same change.
