# Models Catalog Data (`models.dev.json`)

This directory contains the model catalog snapshot used by **Agent Accelerator** as its single source of truth for model capabilities, pricing, context windows, token limits, and reasoning configurations across 200+ providers and 7,500+ models.

---

## Why is `models.dev.json` in `.gitignore`?

`models.dev.json` is a ~4.4 MB generated data snapshot fetched directly from [models.dev](https://models.dev). Because models and pricing change frequently upstream, this file is excluded from git tracking to prevent repository bloat and merge conflicts.

---

## How to Generate / Update `models.dev.json`

You can generate or refresh the catalog snapshot anytime using one of the following methods:

### Method 1: Using the bun/npm script (Recommended)

From the project root:

```bash
bun run update-models
```

*(or `npm run update-models` / `pnpm run update-models`)*

---

### Method 2: Using `curl` directly

```bash
curl -sSL https://models.dev/api.json -o src/data/models.dev.json
```

---

## How It Works in Agent Accelerator

When Agent Accelerator runs:
1. `src/models/catalog.ts` loads `src/data/models.dev.json`.
2. An in-memory global index (`getGlobalIndex()`) indexes all models in $O(1)$ lookup time.
3. Every model query automatically resolves:
   * **Context window & max output limits**
   * **Input, output, and prompt cache read/write pricing**
   * **Supported thinking levels** (`low`, `medium`, `high`, etc.)
   * **Modalities** (`text`, `image`, `audio`, `video`)
