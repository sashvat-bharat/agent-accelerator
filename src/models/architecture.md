# src/models/

The model catalog: context limits, prices, modalities and reasoning options come from models.dev, not from code.

| File               | What it is                                                                                                                                                                                                                                                                                                          |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `catalog-cache.ts` | Downloads and caches `models.dev/api.json` in `<home>/catalog/` (or `AGENT_CACHE_DIR`). Stale-while-revalidate: an expired catalog is served at once and refreshed in the background (8 s timeout, 10 min backoff after a failure); only a cold start waits. `AGENT_CATALOG_REFRESH=off` stops automatic refreshes. |
| `catalog.ts`       | Lookups (`getModelFromCatalog`), `registerModel`, thinking validation (`validateModelThinking`, which throws `ThinkingLevelError`, a one-line `ConfigError`), and the exported `GOOGLE_/OPENAI_/OPENROUTER_MODELS` arrays (rebuilt in place when the catalog changes).                                              |

## Invariants

- Never hand-edit the cache file; register custom models with `registerModel()`. Verified modality fixes go in `MODALITY_OVERRIDES`.
- The global bare-id fallback applies to first-class providers and explicit bare-id lookups only. A custom prefix never borrows another provider's price or modalities: unknown stays unknown.
- A payload that is not a catalog (fewer than 3 providers with models) never overwrites the cache.
- Do not keep static copies of catalog data; use the lookups or the update listener.
