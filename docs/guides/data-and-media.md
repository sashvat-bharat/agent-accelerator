# Data and media
[Docs](../README.md) › Guides › Data and media

> Save and resume conversations, send images and documents, track tokens and cost, and manage the model catalog.

## Sessions and persistence

```ts
import { Agent, findLatestSessionDir, loadSessionDir } from "agent-accelerator";

const agent = new Agent({
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  persist: { dir: "sessions" }, // saves sessions/<sessionId>/ (session.json + journal.ndjson + media/) after every step
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
| `sessions/` | saved conversations (`persist: {}`); with `telemetry: { persist: true }` each session folder also holds its own `telemetry.ndjson` |
| `scheduled/` | scheduled actions and their results |
| `telemetry/` | daily event log of the events that belong to no persisted session, only with `telemetry: { persist: true }` |
| `catalog/` | the model catalog cache |

Move it with `setHome(dir)` (call once, before creating Agents), the `AGENT_ACCEL_HOME` env var, or a per-Agent `home`. Explicit paths you pass (`persist: { dir }`, `saveSessionFile`) are used as given.

**Tool logs.** Each tool call also writes `tool-logs/<n>-<tool>.ndjson` next to the session (see [Tools and streaming](tools-and-streaming.md)); the session itself keeps only a `logFile` reference on the tool result.

**What else is saved.** Each run's start is recorded (`runs`: run id, index of its user message, time) so turns can be counted later, and prompts still waiting in the steer inbox or follow-up queue are saved too (`pending`, in the journal only; media in them becomes a file under `media/`). `loadSessionDir(dir).session.pending` shows what was waiting when the process stopped.

**Surviving a crash.** With `persist: { dir }` and the SAME `sessionId` after a restart, an Agent notices a run that was cut off (it began, never ended) or prompts that were still waiting, and continues on its own:

```ts
const agent = new Agent({ model, persist: { dir: "sessions" }, sessionId: "support-chat" }); // resume: "automatic" (default)
// the cut-off run is already continuing; a run() you call now queues behind it
```

- The conversation is reloaded, and the model carries on from where it stopped. **A tool call that already finished is never run again**: its result was saved the moment it finished. Only calls with no saved result run now (for example the email that was still being sent). Sub-agent usage of a call finished before the crash is not re-counted.
- Prompts that were waiting (steers, follow-ups) run afterwards: steers first, in order.
- `resume: "explicit"` loads the state but runs nothing: `agent.interrupted()` lists the cut-off runs (`runId`, `startedAt`, `prompt`, `pendingToolCalls`) and `await agent.resume()` continues them (it resolves to the run's response, or `undefined` when nothing was cut off). A new `run()` instead closes the old one as `abandoned`.
- A resume that fails is reported on the bus (`agent.resume_failed`) and does not throw from the constructor.
- Needs `persist: { dir }` (not `{ file }`). A saved session over the load limits makes the constructor throw `SessionLoadError` rather than overwrite it. Media inside the session must still be allowed by `fileAccess.roots`, if you set it.

**Several processes can share one home; each session folder belongs to one.** An Agent that persists a session takes `<session folder>/.lock` (pid, host, start time; `<home>/sessions/<id>/` for `persist: {}`, `<dir>/<id>/` for `persist: { dir }`, the folder of the file for `persist: { file }`). A second process opening the **same session** fails at once with a `ConfigError` naming the owner; processes using different sessions of the same home do not interfere. The lock is shared by all Agents of one process, held until the process exits, a lock left by a killed process is taken over automatically, and leftover temp files of unfinished writes inside the folder are removed when the lock is taken. Everything else in a home is safe to share: scheduled actions use one folder and a short lock per action, telemetry is appended one line at a time, and the model catalog is written atomically. Local disks only. Other processes may read the files, but must not write session files.

| `persist` | Writes |
|---|---|
| `{ dir }` | `<dir>/<sessionId>/session.json` (snapshot; includes the agent's own spending as `usage`, see `agent.usageReport()`) + `journal.ndjson` (one appended line per step, folded into the snapshot after 500 lines / 4 MB or when history changes another way) + `media/` files (written once, named by content hash) |
| `{ file }` | one JSON file, rewritten each step (binary media inlined as data URLs; no journal) |
| `{}` | `<home>/sessions` (`home` defaults to `setHome(dir)`, then `AGENT_ACCEL_HOME`, then `.agent-accel/` in the working directory) |

Saves are durable (temp file, fsync of file and folder, the last good version kept as `session.json.bak`, atomic rename), so a crash or power cut never leaves a torn file; a damaged `session.json` loads from its `.bak`. Saves are coalesced and never fail a turn (`onPersistError` hook available). Also exported: `saveSessionFile`, `loadSessionFile`, `saveSessionDir`, `sessionDirFor`, `buildSessionData`, `serializeSession`, `deserializeSession`, `inspectSessionPayload`, `writeFileAtomic`, `extractMediaToDir`, `resolveMediaPaths`. Loading validates message shape; a **corrupt** file is renamed `*.corrupt-<ts>`, a valid file over the limits (50k messages / 100 MB) throws `SessionLoadError` and is never touched. Old pretty-printed and JSONL files still load. Sub-agent traces are saved too, and Google turns keep their raw output steps so a resumed session replays them exactly (thought signatures and cache prefix intact). Importing a session that points at local files warns (`session.local_media_paths`) unless `fileAccess.roots` is set.

**On OpenRouter**, when the router parses a PDF it returns the parsed file as an annotation. The SDK keeps it with the assistant message (and saves it with the session) and sends it back on the next turns, so the same PDF is not parsed, and billed for parsing, again.

**Recommendations:** ✅ one `sessionId` per conversation; resume with `findLatestSessionDir`. ✅ Set `fileAccess.roots` before importing sessions you did not create. ✅ With `persist: { dir }` each step costs one appended line, so long sessions stay fast.

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

Part types: `text`, `image`, `audio`, `video`, `file`. MIME types are inferred from the extension or magic bytes (`sniffMimeType`). Unsupported modalities fail **before** the network with a one-line error (the catalog knows what each model accepts; custom endpoints reject video and files). A model without native file input fails fast on every provider except OpenRouter, which parses files for any model and is never gated by the catalog's file flag; elsewhere convert the document to text yourself before `run` (the SDK ships no converter). Remote downloads re-check redirects and are size-capped.

**On OpenRouter**, images and videos given as web links are passed through untouched; everything else is inlined as base64. Audio is always inlined (audio links are downloaded) and sent with its real format: `wav`, `mp3`, `aiff`, `aac`, `ogg`, `flac` or `m4a`, found from `mimeType`, the file extension or the first bytes. A QuickTime video is sent as `video/mov`. Supported video types: MP4, MPEG, MOV and WebM; sizes and durations are limited by the model and the route, and their errors come back as they are. A web link the route cannot fetch comes back as a bare "Provider returned error"; the SDK adds a hint to that error saying a remote image or video link may be the cause (pass the file itself instead).

**On Google**, links Google can fetch itself are sent as a `uri` (no download, no inlining): YouTube video links, Files API links (`https://generativelanguage.googleapis.com/v1beta/files/...` or `/v1/files/...`), `gs://` objects, and public `https://` URLs whose type (from `mimeType` or the extension) Google fetches: PDF, CSV, plain text/HTML/CSS/XML/RTF/JS, JSON, PNG/JPEG/WebP/BMP images and common video formats (max 15 MB per URL). Everything else, including **all audio URLs** and `http://` links, is downloaded and inlined. Inline types are checked before the network: images PNG/JPEG/WebP/HEIC/HEIF/GIF/BMP/TIFF, audio WAV/MP3/AIFF/AAC/OGG/FLAC/MPEG/M4A/L16/OPUS/ALAW/MULAW/WebM, video MP4/MPEG/MPG/MOV/AVI/FLV/WebM/WMV/3GPP, documents **PDF and CSV only** (convert other documents to text first). Google allows 100 MB inline per request (50 MB per PDF). Images and videos accept an optional `resolution` (`"low" | "medium" | "high" | "ultra_high"`) that trades detail for input tokens, e.g. `{ type: "image", image: "./chart.png", resolution: "high" }`; OpenRouter sends an image's `resolution` as `image_url.detail` (`low`, `auto`, `high`, `original`); other providers (and OpenRouter videos) ignore it with a warning.

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

`res.usage` has `inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`, `cacheReadTokens`, `cacheWriteTokens`, `thinkingTokens`, optional `cost`, and, on OpenRouter, `inputDetails` (`audioTokens`, `videoTokens`) and `outputDetails` (`audioTokens`, `imageTokens`) when the route reports them (subsets of input and output, report only). Cached tokens are always a subset of input. Cost is the provider's reported total when present (OpenRouter), else computed from catalog prices with integer micro-USD maths, including tiered prices above 200k context and service-tier multipliers (flex 0.5x, priority 2x). **Unknown pricing stays unknown**, never a made-up zero. Sub-agent usage is added to the parent's total.

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

- Crash recovery: `persist: { dir }` + the same `sessionId`; `resume: "automatic" | "explicit"`, `agent.interrupted()`, `agent.resume()`. Manual resume of a finished chat: `findLatestSessionDir` → `loadSessionDir` → `agent.importSession(saved.session)`.
- Prompt is `string | ContentPart[]`; part keys: `image`, `audio`, `video`, `file` (+ `filename`, `mimeType`).
- Cost may be `undefined`; handle it. Use `SessionTelemetry` for running totals.
- Never edit `<home>/catalog/models.dev.json`; use `registerModel`.
- See also: [`examples/15-durable-agent.ts`](../../examples/15-durable-agent.ts) (crash, resume, approval, tool logs), [Agents and models](agents-and-models.md), [Safety and operations](safety-and-ops.md), [`examples/05-chat.ts`](../../examples/05-chat.ts), [`examples/06-multimodal_image.ts`](../../examples/06-multimodal_image.ts), [`examples/09-multimodal_document.ts`](../../examples/09-multimodal_document.ts).
