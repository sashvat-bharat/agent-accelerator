# Model Catalog Cache (`src/data/`)

This directory is the local destination for the dynamic model catalog cache used by **Agent Accelerator**.

Agent Accelerator references a catalog of **7,500+ models across 200+ providers** for token limits, context windows, modality support, reasoning configurations, and per-token pricing (input, output, cache-read, cache-write).

---

## Zero-Bloat Distribution Architecture

To keep the repository and published npm/Bun package lightweight and blazing fast:

1. **Excluded from Production Package & Git**:
   * The ~4.5 MB full catalog snapshot (`models.dev.json`) is **never** committed to git and is **excluded** from the npm/Bun distribution bundle.
   * The file is tracked in `.gitignore` and `.npmignore`.

2. **Dynamic 12-Hour Automated TTL Cache**:
   * On agent execution (`runAgentLoop` / `streamAgentLoop`), Agent Accelerator checks the status of `src/data/models.dev.json`.
   * **Cache Hit (< 12h)**: Instant memory/disk load with zero network overhead.
   * **Cache Miss / Expired (≥ 12h)**: Automatically downloads the latest catalog directly from `https://models.dev/api.json`, caches it to `src/data/models.dev.json`, and loads the catalog into memory.
   * **Resilience**: If an existing cache exists on disk, temporary upstream network issues will safely continue using the local cached copy.

---

## Developer Controls & Management

### 1. CLI Script

You can manually inspect or refresh the model catalog anytime via the developer CLI script:

```bash
# Refresh catalog if expired (or download if missing)
bun run update-models

# Force download regardless of age
bun run update-models --force

# Custom TTL (e.g., 24 hours)
bun src/update-models.ts --ttl=24h
```

---

### 2. Programmatic API

All catalog cache lifecycle controls are exported from the root package:

```typescript
import {
  refreshModelCatalog,
  ensureModelCatalogFresh,
  getCatalogStatus,
  setCatalogTTL,
  getModelFromCatalog,
} from "agent-accelerator";

// 1. Check current cache status
const status = getCatalogStatus();
console.log(status);
// {
//   isExpired: false,
//   cachedAt: 1773400000000,
//   ttlMs: 43200000,
//   modelCount: 7696,
//   providerCount: 213,
//   source: "cache"
// }

// 2. Refresh on-demand (e.g. in a cron job or startup hook)
await refreshModelCatalog({ force: true });

// 3. Customize runtime TTL (e.g., 6 hours)
setCatalogTTL(6 * 60 * 60 * 1000);
```

---

## Structure

```text
src/data/
├── README.md               # This documentation
└── models.dev.json         # Auto-generated on first run (gitignored, excluded from bundle)
```
