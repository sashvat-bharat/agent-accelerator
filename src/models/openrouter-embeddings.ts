/**
 * OpenRouter's embedding models, read from OpenRouter's own public list (`GET /api/v1/embeddings/models`, no key needed) and
 * cached in the catalog folder (`<cache>/openrouter-embeddings.json`). OpenRouter has dozens of embedding models that change
 * often, so the SDK keeps no hand-written table for them: the list carries each model's inputs, length limit and prices, which is
 * all the request checks need. Refreshing follows the model catalog's rules: a fresh copy is used as is, a failed refresh keeps the
 * old copy (and is not retried for 10 minutes), the `catalog_refresh: "off"` setting stops every automatic download, and the file
 * is written with the durable writer. Nothing here touches the network unless a refresh is asked for or a copy is missing or stale.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getSetting } from "../config/settings.ts";
import { telemetryBus } from "../telemetry.ts";
import { ProviderError } from "../types/errors.ts";
import { writeFileDurable } from "../utils/durable.ts";
import { DEFAULT_CATALOG_TTL_MS, REFRESH_FAILURE_BACKOFF_MS, getCacheDir } from "./catalog-cache.ts";
import type { EmbeddingInputKind, EmbeddingModelInfo, EmbeddingPrices } from "./embedding-models.ts";

const DEFAULT_URL = "https://openrouter.ai/api/v1/embeddings/models";
/** The list is about 100 KB; anything far above that is not the list. */
const MAX_LIST_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

/** What `<cache>/openrouter-embeddings.json` holds. */
interface Saved {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
  source: string;
  models: EmbeddingModelInfo[];
}

/** Options of a refresh. */
export interface RefreshOpenRouterEmbeddingsOptions {
  /** Download even when the saved copy is still fresh. */
  force?: boolean;
  /** How long the new copy counts as fresh, in ms. Default 12 hours (the catalog's). */
  ttlMs?: number;
  /** Fetch timeout in ms. Default 15 000. */
  timeoutMs?: number;
  /** Another list URL (tests, a proxy). */
  apiUrl?: string;
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof fetch;
}

// Path of the saved list in the current cache folder (follows `setHome` and `catalog_cache_dir`); in: every function here, out: a path.
function filePath(): string {
  return path.join(getCacheDir(), "openrouter-embeddings.json");
}

// True for a plain object; in: the readers below, out: a type guard.
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// A price string such as "0.00000008" per token as USD per 1M tokens, or undefined when it is not a number; in: toModel, out: a price.
function perMillion(v: unknown): number | undefined {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Number((n * 1_000_000).toFixed(6)) : undefined;
}

// One entry of OpenRouter's list as our model info, or undefined for an entry that is not usable (no id, expired, or not an embedding model); in: parseList, out: the entry.
function toModel(raw: unknown, now: number): EmbeddingModelInfo | undefined {
  if (!isObject(raw) || typeof raw["id"] !== "string" || !raw["id"]) return undefined;
  const arch = raw["architecture"];
  const modalities = isObject(arch) ? arch["input_modalities"] : undefined;
  const outputs = isObject(arch) ? arch["output_modalities"] : undefined;
  if (!Array.isArray(modalities) || (Array.isArray(outputs) && !outputs.includes("embeddings"))) return undefined;
  const expires = typeof raw["expiration_date"] === "string" ? Date.parse(raw["expiration_date"]) : NaN;
  if (Number.isFinite(expires) && expires <= now) return undefined;
  const inputs = [
    ...new Set(
      modalities.flatMap((m): EmbeddingInputKind[] =>
        m === "file" ? ["pdf"] : m === "text" || m === "image" || m === "audio" || m === "video" ? [m] : []
      )
    ),
  ];
  if (inputs.length === 0) return undefined;
  const id = raw["id"];
  const pricing = isObject(raw["pricing"]) ? raw["pricing"] : {};
  const text = perMillion(pricing["prompt"]);
  const image = perMillion(pricing["image"] ?? pricing["image_token"]);
  const audio = perMillion(pricing["audio"]);
  const prices: EmbeddingPrices | undefined =
    text === undefined
      ? undefined
      : {
          textInput: text,
          ...(image !== undefined ? { imageInput: image } : {}),
          ...(audio !== undefined ? { audioInput: audio } : {}),
        };
  const context =
    typeof raw["context_length"] === "number" && raw["context_length"] > 0 ? raw["context_length"] : undefined;
  return {
    model: `openrouter/${id}`,
    provider: "openrouter",
    id,
    name: typeof raw["name"] === "string" && raw["name"] ? raw["name"] : id,
    description:
      typeof raw["description"] === "string" && raw["description"]
        ? raw["description"]
        : `${id} through OpenRouter's embeddings endpoint.`,
    inputs,
    limits: context !== undefined ? { inputTokens: context } : {},
    // The list does not say whether `dimensions` or `input_type` works for a model, so the request is sent as asked and the provider decides.
    task: "inputType",
    ...(prices ? { prices } : {}),
  };
}

// Turns OpenRouter's `{ data: [...] }` into model infos (unusable entries are skipped); throws when the body is not the list; in: refresh, out: the models.
function parseList(body: unknown, now: number): EmbeddingModelInfo[] {
  const data = isObject(body) ? body["data"] : undefined;
  if (!Array.isArray(data)) throw new Error("the reply has no `data` list");
  const models = data.flatMap((raw) => {
    const m = toModel(raw, now);
    return m ? [m] : [];
  });
  if (models.length === 0) throw new Error("the list has no embedding model");
  return models;
}

// The saved file when it has the expected shape, else undefined; in: the readers, out: Saved.
function readSaved(): Saved | undefined {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    if (
      isObject(raw) &&
      raw["version"] === 1 &&
      typeof raw["fetchedAt"] === "number" &&
      typeof raw["ttlMs"] === "number" &&
      Array.isArray(raw["models"])
    )
      return raw as unknown as Saved;
  } catch {
    // why: no file or a damaged one: the list is simply not known yet.
  }
  return undefined;
}

// Remembers the parsed file so a lookup does not re-read it; keyed by path and modification time, so another process's refresh is seen.
let memo: { file: string; mtimeMs: number; models: readonly EmbeddingModelInfo[] } | undefined;
// A list that could not be written to disk (read-only folder): kept for this process only.
let memoryOnly: readonly EmbeddingModelInfo[] | undefined;

/** The OpenRouter embedding models from the saved list, read from disk without any network call (empty until the list was downloaded once). */
export function openRouterEmbeddingModels(): readonly EmbeddingModelInfo[] {
  const file = filePath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return memoryOnly ?? [];
  }
  if (memo?.file === file && memo.mtimeMs === mtimeMs) return memo.models;
  const models = readSaved()?.models ?? [];
  memo = { file, mtimeMs, models };
  return models;
}

// True while the saved copy is within its own TTL; in: refresh and ensure, out: a boolean.
function isFresh(saved: Saved | undefined): boolean {
  if (!saved) return false;
  const age = Date.now() - saved.fetchedAt;
  return age >= 0 && age < saved.ttlMs;
}

/**
 * Downloads OpenRouter's embedding model list and saves it (unless the saved copy is still fresh and `force` is not set).
 * Throws a `ProviderError` when the download fails or is not the list; the saved copy is left as it was.
 */
export async function refreshOpenRouterEmbeddingModels(
  options: RefreshOpenRouterEmbeddingsOptions = {}
): Promise<readonly EmbeddingModelInfo[]> {
  if (!options.force && isFresh(readSaved())) return openRouterEmbeddingModels();
  const url = options.apiUrl ?? DEFAULT_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await (options.fetch ?? fetch)(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    const text = await res.text();
    if (text.length > MAX_LIST_BYTES) throw new Error("the reply is too large to be the model list");
    const now = Date.now();
    const models = parseList(JSON.parse(text), now);
    const saved: Saved = {
      version: 1,
      fetchedAt: now,
      ttlMs: options.ttlMs ?? DEFAULT_CATALOG_TTL_MS,
      source: url,
      models,
    };
    try {
      writeFileDurable(filePath(), JSON.stringify(saved), { backup: false });
    } catch (err) {
      telemetryBus.emitWarning(
        "embedding_models_cache_write_failed",
        `[Agent Accelerator] Could not save the OpenRouter embedding model list (${err instanceof Error ? err.message : String(err)}). Using it from memory for this process.`,
        { path: filePath() }
      );
      memoryOnly = models;
      return models;
    }
    memoryOnly = undefined;
    memo = undefined; // the next read sees the new file
    return openRouterEmbeddingModels();
  } catch (err) {
    throw new ProviderError(
      `[openrouter] could not read the embedding model list from ${url}: ${err instanceof Error ? err.message : String(err)}`,
      { provider: "openrouter", retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Wall-clock of the last failed refresh (0 = none); a failure keeps the old copy and is not retried for 10 minutes. */
let lastFailureAt = 0;
let inFlight: Promise<readonly EmbeddingModelInfo[]> | undefined;

/**
 * The OpenRouter embedding models, downloading the list only when needed: a fresh saved copy is returned at once; a missing or
 * stale one is refreshed (one download at a time). If the refresh fails, a stale copy is still used (with a warning on the bus);
 * without any copy the failure is thrown. The `catalog_refresh: "off"` setting never downloads: the saved copy, or `[]`, is returned.
 */
export async function ensureOpenRouterEmbeddingModels(
  options: RefreshOpenRouterEmbeddingsOptions = {}
): Promise<readonly EmbeddingModelInfo[]> {
  const saved = readSaved();
  if (!options.force && isFresh(saved)) return openRouterEmbeddingModels();
  if (getSetting("catalog_refresh") === "off") return openRouterEmbeddingModels();
  if (saved && !options.force && Date.now() - lastFailureAt < REFRESH_FAILURE_BACKOFF_MS)
    return openRouterEmbeddingModels();
  inFlight ??= refreshOpenRouterEmbeddingModels({ ...options, force: true })
    .then((models) => {
      lastFailureAt = 0;
      return models;
    })
    .finally(() => {
      inFlight = undefined;
    });
  try {
    return await inFlight;
  } catch (err) {
    lastFailureAt = Date.now();
    if (!saved) throw err;
    telemetryBus.emitWarning(
      "embedding_models_refresh_failed",
      `[Agent Accelerator] The OpenRouter embedding model list could not be refreshed; the saved copy from ${new Date(saved.fetchedAt).toISOString()} is used. ${err instanceof Error ? err.message : String(err)}`,
      { fetchedAt: saved.fetchedAt }
    );
    return openRouterEmbeddingModels();
  }
}

/** Forgets the in-memory copy and the failure backoff (tests only). */
export function resetOpenRouterEmbeddingsCache(): void {
  memo = undefined;
  memoryOnly = undefined;
  lastFailureAt = 0;
  inFlight = undefined;
}
