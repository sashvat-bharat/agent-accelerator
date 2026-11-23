/**
 * A list of models that OpenRouter publishes (embedding models, decision models), read from OpenRouter's own API and cached
 * in the catalog folder (`<cache>/<file>`). One factory serves every such list, so each one follows the model catalog's
 * rules: a fresh copy is used as is, a failed refresh keeps the old copy (and is not retried for 10 minutes), the
 * `catalog_refresh: "off"` setting stops every automatic download, and the file is written with the durable writer. Nothing
 * here touches the network unless a refresh is asked for or a copy is missing or stale.
 */
import * as fs from "node:fs";
import { isRecord } from "../utils/guards.ts";
import { readTextCapped } from "../utils/body.ts";
import * as path from "node:path";
import { getSetting } from "../config/settings.ts";
import { telemetryBus } from "../telemetry.ts";
import { ProviderError } from "../types/errors.ts";
import { getApiKey } from "../utils/env.ts";
import { writeFileDurable } from "../utils/durable.ts";
import { DEFAULT_CATALOG_TTL_MS, REFRESH_FAILURE_BACKOFF_MS, getCacheDir } from "./catalog-cache.ts";

/** The list is about 100 KB; anything far above that is not the list. */
const MAX_LIST_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

/** What makes one list different from another. */
export interface OpenRouterListSpec<T> {
  /** File name inside the catalog folder, e.g. `openrouter-embeddings.json`. */
  file: string;
  /** Where the list is downloaded from. */
  url: string;
  /** What the list is called in messages, e.g. `embedding model list`. */
  what: string;
  /** Bus codes of the two warnings. */
  codes: { writeFailed: string; refreshFailed: string };
  /** `true`: the request carries the OpenRouter key when one is known (the decision list needs it; the embedding list is public). */
  sendKey?: boolean;
  /** Turns the downloaded JSON into entries (unusable ones skipped); throws when the body is not the list. */
  parse(body: unknown, now: number): T[];
}

/** Options of a refresh. */
export interface RefreshOpenRouterListOptions {
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
  /** OpenRouter key for a list that needs one (else the environment's). */
  apiKey?: string;
  /** Key overrides, as everywhere in the SDK. */
  env?: Record<string, string>;
}

/** What the saved file holds. */
interface Saved<T> {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
  source: string;
  models: T[];
}

/** What `createOpenRouterList` gives a list module: read the saved list, refresh it, make sure it is fresh, forget it (tests). */
export interface OpenRouterList<T> {
  read(): readonly T[];
  refresh(options?: RefreshOpenRouterListOptions): Promise<readonly T[]>;
  ensure(options?: RefreshOpenRouterListOptions): Promise<readonly T[]>;
  reset(): void;
}

/** Builds the reader, refresher and "ensure" functions of one OpenRouter list; each list module calls it once. */
export function createOpenRouterList<T>(spec: OpenRouterListSpec<T>): OpenRouterList<T> {
  // Path of the saved list in the current cache folder (follows `setHome` and `catalog_cache_dir`); in: every function here, out: a path.
  const filePath = (): string => path.join(getCacheDir(), spec.file);

  // The saved file when it has the expected shape, else undefined; in: the readers, out: Saved.
  const readSaved = (): Saved<T> | undefined => {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(filePath(), "utf8"));
      if (
        isRecord(raw) &&
        raw["version"] === 1 &&
        typeof raw["fetchedAt"] === "number" &&
        typeof raw["ttlMs"] === "number" &&
        Array.isArray(raw["models"])
      )
        // why: `raw` is the saved list; its envelope was just checked, and each model is checked when the list is used.
        return raw as unknown as Saved<T>;
    } catch {
      // why: no file or a damaged one: the list is simply not known yet.
    }
    return undefined;
  };

  // Remembers the parsed file so a lookup does not re-read it; keyed by path and modification time, so another process's refresh is seen.
  let memo: { file: string; mtimeMs: number; models: readonly T[] } | undefined;
  // A list that could not be written to disk (read-only folder): kept for this process only.
  let memoryOnly: readonly T[] | undefined;

  // The models from the saved list, read from disk without any network call (empty until the list was downloaded once); in: lookups, out: the entries.
  const read = (): readonly T[] => {
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
  };

  // True while the saved copy is within its own TTL; in: refresh and ensure, out: a boolean.
  const isFresh = (saved: Saved<T> | undefined): boolean => {
    if (!saved) return false;
    const age = Date.now() - saved.fetchedAt;
    return age >= 0 && age < saved.ttlMs;
  };

  // Downloads the list and saves it (unless the saved copy is still fresh and `force` is not set); throws a ProviderError when the download fails or is not the list, leaving the saved copy as it was; in: ensure and callers, out: the models.
  const refresh = async (options: RefreshOpenRouterListOptions = {}): Promise<readonly T[]> => {
    if (!options.force && isFresh(readSaved())) return read();
    const url = options.apiUrl ?? spec.url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const key = spec.sendKey ? getApiKey("openrouter", options.apiKey, options.env) : undefined;
      const res = await (options.fetch ?? fetch)(url, {
        headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      const text = await readTextCapped(res, MAX_LIST_BYTES);
      if (text.length > MAX_LIST_BYTES) throw new Error("the reply is too large to be the model list");
      const now = Date.now();
      const models = spec.parse(JSON.parse(text), now);
      const saved: Saved<T> = {
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
          spec.codes.writeFailed,
          `[Agent Accelerator] Could not save the OpenRouter ${spec.what} (${err instanceof Error ? err.message : String(err)}). Using it from memory for this process.`,
          { path: filePath() }
        );
        memoryOnly = models;
        return models;
      }
      memoryOnly = undefined;
      memo = undefined; // the next read sees the new file
      return read();
    } catch (err) {
      throw new ProviderError(
        `[openrouter] could not read the ${spec.what} from ${url}: ${err instanceof Error ? err.message : String(err)}`,
        { provider: "openrouter", retryable: true }
      );
    } finally {
      clearTimeout(timer);
    }
  };

  /** Wall-clock of the last failed refresh (0 = none); a failure keeps the old copy and is not retried for 10 minutes. */
  let lastFailureAt = 0;
  let inFlight: Promise<readonly T[]> | undefined;

  // The models, downloading the list only when needed: a fresh copy is returned at once; a missing or stale one is refreshed (one download at a time); a failed refresh falls back to a stale copy (with a warning), and without any copy the failure is thrown; `catalog_refresh: "off"` never downloads; in: the one-call functions, out: the models.
  const ensure = async (options: RefreshOpenRouterListOptions = {}): Promise<readonly T[]> => {
    const saved = readSaved();
    if (!options.force && isFresh(saved)) return read();
    if (getSetting("catalog_refresh") === "off") return read();
    if (saved && !options.force && Date.now() - lastFailureAt < REFRESH_FAILURE_BACKOFF_MS) return read();
    inFlight ??= refresh({ ...options, force: true })
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
        spec.codes.refreshFailed,
        `[Agent Accelerator] The OpenRouter ${spec.what} could not be refreshed; the saved copy from ${new Date(saved.fetchedAt).toISOString()} is used. ${err instanceof Error ? err.message : String(err)}`,
        { fetchedAt: saved.fetchedAt }
      );
      return read();
    }
  };

  // Forgets the in-memory copy and the failure backoff (tests only); in: test hooks, out: nothing.
  const reset = (): void => {
    memo = undefined;
    memoryOnly = undefined;
    lastFailureAt = 0;
    inFlight = undefined;
  };

  return { read, refresh, ensure, reset };
}
