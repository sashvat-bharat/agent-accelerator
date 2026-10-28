# Data and media
[Docs](../README.md) › Guides › Data and media

> Save and resume conversations, send images and documents, track tokens and cost, and manage the model catalog.

## Sessions and persistence

```ts
import { Agent, findLatestSessionDir, loadSessionDir } from "agent-accelerator";

const agent = new Agent({
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  persist: { dir: "sessions" }, // writes sessions/<sessionId>/session.json (+ media/) after every step
});

const latest = findLatestSessionDir("sessions");
const saved = latest ? loadSessionDir(latest) : null;
if (saved) agent.importSession(saved.session); // resume where you left off

const res = await agent.run("Continue our conversation.");
console.log(res.text);
```

**The home folder.** Everything the SDK stores lives in ONE folder, `.agent-accel/` by default, so nothing is scattered across your project:

| Subfolder | Holds |
|---|---|
| `sessions/` | saved conversations (`persist: {}`) |
| `scheduled_actions/` | scheduled actions and their results |
| `telemetry/` | event log, only with `telemetry: { persist: true }` |
| `catalog/` | the model catalog cache |

Move it with `setHome(dir)` (call once, before creating Agents), the `AGENT_ACCEL_HOME` env var, or a per-Agent `home`. Explicit paths you pass (`persist: { dir }`, `saveSessionFile`) are used as given.

| `persist` | Writes |
|---|---|
| `{ dir }` | `<dir>/<sessionId>/session.json` + `media/` files |
| `{ file }` | one JSON file (binary media inlined as data URLs) |
| `{}` | `<home>/sessions` (`home` defaults to `setHome(dir)`, then `AGENT_ACCEL_HOME`, then `.agent-accel/` in the working directory) |

Saves are atomic (temp file + rename), coalesced, and never fail a turn (`onPersistError` hook available). Also exported: `saveSessionFile`, `loadSessionFile`, `saveSessionDir`, `sessionDirFor`, `buildSessionData`, `serializeSession`, `deserializeSession`, `inspectSessionPayload`, `writeFileAtomic`, `extractMediaToDir`, `resolveMediaPaths`. Loading validates message shape; a **corrupt** file is renamed `*.corrupt-<ts>`, a valid file over the limits (50k messages / 100 MB) throws `SessionLoadError` and is never touched. Old pretty-printed and JSONL files still load. Sub-agent traces are saved too. Importing a session that points at local files warns (`session.local_media_paths`) unless `fileAccess.roots` is set.

**Recommendations:** ✅ one `sessionId` per conversation; resume with `findLatestSessionDir`. ✅ Set `fileAccess.roots` before importing sessions you did not create. ⚠️ The whole snapshot is rewritten each step, which gets slow for very long sessions.

## Images, audio, video and documents

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  fileAccess: { roots: [process.cwd()] }, // local paths must stay inside these folders
});

const res = await agent.run([
  { type: "text", text: "What is in this picture, and what does the PDF say?" },
  { type: "image", image: "https://example.com/photo.png" }, // URL, local path, data URL, base64 or Uint8Array
  { type: "file", file: "./report.pdf", filename: "report.pdf" },
]);
console.log(res.text);
```

Part types: `text`, `image`, `audio`, `video`, `file`. MIME types are inferred from the extension or magic bytes (`sniffMimeType`). Unsupported modalities fail **before** the network with a one-line error (the catalog knows what each model accepts; custom endpoints reject video and files). For models without native file input, set `bypassInputFileModality: true`: `file` parts become `<Document>` Markdown (needs the optional `@firecrawl/anydoc`; PDF, Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV). `convertDocumentToMarkdown(path)` does the same on demand and `createConvertDocumentTool({ roots })` gives the model a safe converter. Remote downloads refuse private hosts and are size-capped.

**Recommendations:** ✅ prefer URLs for large media (not inlined). ✅ Restrict local reads with `fileAccess.roots`. ❌ Don't pass untrusted paths without `roots`.

## Usage and cost

```ts
import { Agent, SessionTelemetry } from "agent-accelerator";

const agent = new Agent({ model: process.env.MODEL ?? "google/gemini-3.5-flash-lite" });
const telemetry = new SessionTelemetry();

const res = await agent.run("Summarize the plot of Hamlet.");
telemetry.add(res.usage, `${res.provider}/${res.model}`);
console.log(telemetry.formatBar(res)); // tokens, cache hit rates, cost, context-window use
console.log(telemetry.totals); // { input, output, cacheRead, cacheWrite, reasoning, cost }
```

`res.usage` has `inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`, `cacheReadTokens`, `cacheWriteTokens`, `thinkingTokens` and optional `cost`. Cached tokens are always a subset of input. Cost is the provider's reported total when present (OpenRouter), else computed from catalog prices with integer micro-USD maths, including tiered prices above 200k context and service-tier multipliers (flex 0.5x, priority 2x). **Unknown pricing stays unknown**, never a made-up zero. Sub-agent usage is added to the parent's total.

## Model catalog

The SDK reads limits, prices, modalities and reasoning options from a cached copy of models.dev (`<home>/catalog/models.dev.json`, or `AGENT_CACHE_DIR`).

```bash
bun run update-models            # refresh if expired
bun run update-models --force    # always download
bun src/update-models.ts --ttl=24h
```

```ts
import { createGenericModelSpec, getModelFromCatalog, registerModel } from "agent-accelerator";

console.log(getModelFromCatalog("google", "gemini-3.5-flash-lite")?.limit?.context);

// Register a fine-tune or private model so pricing and limits are known.
registerModel({
  ...createGenericModelSpec("openai", "ft:gpt-4o:acme"),
  contextWindow: 128_000,
  pricing: { inputPerMillion: 3, outputPerMillion: 12 },
});
```

Behavior: the default TTL is 12 h; an expired catalog is used **immediately** and refreshed in the background (8 s timeout, 10 minute backoff after a failure); a cold start waits for the download; invalid payloads never overwrite a good cache. Set `AGENT_CATALOG_REFRESH=off` for air-gapped hosts and tests. Other helpers: `refreshModelCatalog`, `ensureModelCatalogFresh`, `getCatalogStatus`, `setCatalogTTL`, `getModelsForProvider`, `getModelThinkingInfo`, `validateModelThinking`, `modelSupportsStructuredOutput`, `getModelSource`, `clearCustomModels`. Custom prefixes never borrow another provider's price or abilities. Never hand-edit the cache file.

**Recommendations:** ✅ `registerModel` for private models; ✅ read-only deployments: set `AGENT_CACHE_DIR` to a writable path. ⚠️ Loading the catalog costs roughly 18 MB of memory.

## For AI agents

- Persist: `persist: { dir }`; resume: `findLatestSessionDir` → `loadSessionDir` → `agent.importSession(saved.session)`.
- Prompt is `string | ContentPart[]`; part keys: `image`, `audio`, `video`, `file` (+ `filename`, `mimeType`).
- Cost may be `undefined`; handle it. Use `SessionTelemetry` for running totals.
- Never edit `<home>/catalog/models.dev.json`; use `registerModel`.
- See also: [Agents and models](agents-and-models.md), [Safety and operations](safety-and-ops.md), [`examples/05-chat.ts`](../../examples/05-chat.ts), [`examples/06-multimodal_image.ts`](../../examples/06-multimodal_image.ts), [`examples/10-document_markdown.ts`](../../examples/10-document_markdown.ts).
