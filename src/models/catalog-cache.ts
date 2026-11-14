import * as path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { getEnv } from "../utils/env.ts";
import { telemetryBus } from "../telemetry.ts";
import { onHomeChange, resolveHome } from "../utils/home.ts";
import { writeFileDurable } from "../utils/durable.ts";
import { buildShards, isShard, CATALOG_PROVIDERS, type CatalogProvider, type SlimModel } from "./catalog-shards.ts";

/** Default TTL: 12 Hours (in milliseconds). */
export const DEFAULT_CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

/** Max accepted models.dev payload size: 15MB. Larger payloads are rejected before parse. */
export const MAX_CATALOG_PAYLOAD_BYTES = 15 * 1024 * 1024;

let globalCatalogTtlMs = DEFAULT_CATALOG_TTL_MS;

/** Sets the global model catalog cache TTL in milliseconds.
 * Note: cache files carry their own `ttlMs`. A global `setCatalogTTL`
 * does not rewrite in-flight file TTLs; it takes effect on the next refresh
 * (fresh download) or when the cached file has no `ttlMs` of its own.
 */
export function setCatalogTTL(ttlMs: number): void {
  if (Number.isFinite(ttlMs) && ttlMs > 0) {
    globalCatalogTtlMs = ttlMs;
  }
}

/** Gets the currently configured global catalog TTL in milliseconds. */
export function getCatalogTTL(): number {
  return globalCatalogTtlMs;
}

/** `<cache>/meta.json`: written LAST after a refresh (the commit marker); the shards it counts are read lazily. */
export interface CatalogMeta {
  version: 2;
  fetchedAt: number;
  ttlMs: number;
  source: string;
  /** Models kept per provider. */
  counts: Record<CatalogProvider, number>;
}

export interface CatalogStatus {
  loaded: boolean;
  fromCache: boolean;
  isExpired: boolean;
  fetchedAt?: number;
  ttlMs: number;
  expiresAt?: number;
  cachePath: string;
  providerCount: number;
  modelCount: number;
}

export interface RefreshCatalogOptions {
  /** Force re-download even if current cache is still within TTL. Default: false */
  force?: boolean;
  /** Custom TTL in milliseconds for this cache entry. Default: 12 hours */
  ttlMs?: number;
  /** Custom models endpoint URL. Default: "https://models.dev/api.json" */
  apiUrl?: string;
  /** Fetch timeout in milliseconds. Default: 30000 */
  timeoutMs?: number;
}

type CatalogUpdateListener = () => void;
const updateListeners: Set<CatalogUpdateListener> = new Set();

/** Registers a callback run whenever the catalog changes; in: catalog.ts (cache invalidation), out: an unsubscribe function. */
export function registerCatalogUpdateListener(listener: CatalogUpdateListener): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

// Runs every catalog-change listener, ignoring their errors; in: refresh and home change, out: the listeners.
function notifyUpdateListeners(): void {
  for (const listener of updateListeners) {
    try {
      listener();
    } catch {}
  }
}

/**
 * Catalog cache directory: `<home>/catalog` (the single Agent Accelerator home,
 * see `resolveHome`), or `AGENT_CACHE_DIR` when set (read-only or serverless
 * filesystems).
 */
export function getCacheDir(): string {
  const override = getEnv("AGENT_CACHE_DIR");
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(resolveHome(), "catalog");
}

/** Shard path: `<cacheDir>/<provider>/models.json`, honoring AGENT_CACHE_DIR. */
export function getCacheFilePath(provider: CatalogProvider): string {
  return path.join(getCacheDir(), provider, "models.json");
}

// `<cacheDir>/meta.json`, the marker that says which refresh the shards belong to; in: the loaders and refresh, out: its path.
function metaPath(): string {
  return path.join(getCacheDir(), "meta.json");
}

// Reads and parses a JSON file, null when missing or damaged; in: the cache loaders, out: the parsed value.
function readJsonFileSync(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

// Writes a cache file durably but without a `.bak` (everything here is re-downloadable); in: path + payload from refreshModelCatalog, out: the file.
function writeJsonFileSync(filePath: string, data: unknown): void {
  writeFileDurable(filePath, JSON.stringify(data), { backup: false });
}

/** Verifies optional sha256 pin from MODELS_DEV_SHA256. Returns false on mismatch. */
export function verifyCatalogSha256(text: string): boolean {
  const pin = getEnv("MODELS_DEV_SHA256")?.trim().toLowerCase();
  if (!pin) return true;
  const hex = createHash("sha256").update(text, "utf8").digest("hex").toLowerCase();
  return hex === pin;
}

/** Wall-clock of the last failed network refresh (0 = none); drives the retry backoff. */
let lastRefreshFailureAt = 0;
/** After a failed refresh, `ensureModelCatalogFresh` stays quiet this long (10 min). */
export const REFRESH_FAILURE_BACKOFF_MS = 10 * 60 * 1000;
/** Network timeout for a background refresh when a usable catalog is already loaded. */
const BACKGROUND_REFRESH_TIMEOUT_MS = 8_000;

let inFlightRefresh: Promise<CatalogStatus> | null = null;

// In-memory state: only the tiny meta file is read at import; a provider's models are read from its shard on first use.
let activeMeta: CatalogMeta | undefined;
/** Shards read so far (`null` = looked for and not usable, so a missing file is not re-read on every lookup). */
const shardCache = new Map<CatalogProvider, Record<string, SlimModel> | null>();
let activeFromCache = false;

// A parsed meta.json that has the expected shape, else undefined; in: the loaders, out: CatalogMeta.
function readMeta(): CatalogMeta | undefined {
  const raw = readJsonFileSync(metaPath()) as Partial<CatalogMeta> | null;
  if (!raw || raw.version !== 2 || typeof raw.fetchedAt !== "number" || !raw.counts || typeof raw.counts !== "object")
    return undefined;
  return raw as CatalogMeta;
}

// Adopts the meta on disk (or none) and forgets the shards read so far; in: import, home change, refresh, out: activeMeta.
function loadMeta(fromCache: boolean): void {
  activeMeta = readMeta();
  activeFromCache = fromCache && activeMeta !== undefined;
  shardCache.clear();
}

loadMeta(true);
// `setHome()` moves the cache folder: reload from the new place.
onHomeChange(() => {
  loadMeta(true);
  notifyUpdateListeners();
});

/**
 * The models of one catalog provider (`id` -> slim entry), read from its shard on first use, or undefined when the
 * provider is not kept (custom prefixes) or has no usable shard. Shared with the catalog: read it, never change it.
 */
export function getShardModels(provider: string): Record<string, SlimModel> | undefined {
  if (!(CATALOG_PROVIDERS as readonly string[]).includes(provider)) return undefined;
  const key = provider as CatalogProvider;
  if (!shardCache.has(key)) {
    const raw = activeMeta ? readJsonFileSync(getCacheFilePath(key)) : null;
    shardCache.set(key, isShard(raw, key) ? raw.models : null);
  }
  return shardCache.get(key) ?? undefined;
}

/** Checks whether the active model catalog has expired based on its TTL. */
export function isCatalogExpired(): boolean {
  if (!activeMeta) return true;
  const age = Date.now() - activeMeta.fetchedAt;
  return age < 0 || age >= activeMeta.ttlMs;
}

/** Returns diagnostic metadata about the current model catalog status (counts come from the meta file: no shard is read). */
export function getCatalogStatus(): CatalogStatus {
  const counts = activeMeta ? Object.values(activeMeta.counts).filter((n) => n > 0) : [];
  const ttlMs = activeMeta?.ttlMs ?? globalCatalogTtlMs;
  return {
    loaded: counts.length > 0,
    fromCache: activeFromCache,
    isExpired: isCatalogExpired(),
    fetchedAt: activeMeta?.fetchedAt,
    ttlMs,
    expiresAt: activeMeta ? activeMeta.fetchedAt + ttlMs : undefined,
    cachePath: getCacheDir(),
    providerCount: counts.length,
    modelCount: counts.reduce((a, b) => a + b, 0),
  };
}

/**
 * Structural check for a models.dev catalog payload: a map of provider ids
 * to entries that each carry a `models` map. Rejects chat-completion
 * payloads, error envelopes, and other non-catalog JSON (e.g. from mocked
 * `fetch` in tests) BEFORE they can overwrite the good on-disk cache.
 */
export function isValidCatalogPayload(data: unknown): data is Record<string, any> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length < 3) return false;
  let providersWithModels = 0;
  for (const [, value] of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const models = (value as Record<string, unknown>).models;
    if (!models || typeof models !== "object" || Array.isArray(models)) return false;
    if (Object.keys(models).length > 0) providersWithModels++;
  }
  // Guard against degenerate-but-shaped payloads (e.g. `{a:{models:{}}}`).
  return providersWithModels >= 3;
}

// Removes the single models.dev.json of releases before 0.6.8 (the full payload is no longer kept); in: a successful refresh, out: nothing.
function removeLegacyCache(): void {
  for (const name of ["models.dev.json", "models.dev.json.bak"]) {
    try {
      fs.rmSync(path.join(getCacheDir(), name), { force: true });
    } catch {
      // why: an undeletable leftover is harmless; it is never read.
    }
  }
}

/**
 * Refreshes the model catalog: downloads models.dev, keeps only the supported providers' newest series as one small
 * shard per provider (`<home>/catalog/<provider>/models.json`) plus `meta.json` (written last), and drops the rest. The
 * full payload is never saved. Default TTL 12 hours.
 */
export async function refreshModelCatalog(options: RefreshCatalogOptions = {}): Promise<CatalogStatus> {
  const effectiveTtl = options.ttlMs ?? globalCatalogTtlMs;
  const apiUrl = options.apiUrl || "https://models.dev/api.json";
  const timeoutMs = options.timeoutMs ?? 30000;

  // Return existing cache if still within TTL and not forcing
  if (!options.force) {
    const cached = readMeta();
    if (cached) {
      const age = Date.now() - cached.fetchedAt;
      if (age >= 0 && age < (cached.ttlMs || effectiveTtl)) {
        loadMeta(true);
        notifyUpdateListeners();
        return getCatalogStatus();
      }
    }
  }

  // Fetch from models.dev
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let freshData: Record<string, any>;

  // A failed refresh keeps whatever is on disk (it may be newer than memory when another process refreshed).
  const fallbackToDiskCache = (): void => {
    lastRefreshFailureAt = Date.now();
    if (readMeta()) {
      loadMeta(true);
      notifyUpdateListeners();
    }
  };

  try {
    const res = await fetch(apiUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "agent-accelerator/1.0",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    // Size-cap before parse (check text length, reject >15MB).
    const text = await res.text();
    if (text.length > MAX_CATALOG_PAYLOAD_BYTES) {
      clearTimeout(timer);
      fallbackToDiskCache();
      return getCatalogStatus();
    }
    // Optional sha256 pin via MODELS_DEV_SHA256.
    if (!verifyCatalogSha256(text)) {
      clearTimeout(timer);
      fallbackToDiskCache();
      return getCatalogStatus();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      clearTimeout(timer);
      fallbackToDiskCache();
      return getCatalogStatus();
    }
    freshData = parsed as Record<string, any>;

    // Never let a non-catalog payload (mocked fetch, proxy error page,
    // chat-completion stub) overwrite the good on-disk cache.
    if (!isValidCatalogPayload(freshData)) {
      clearTimeout(timer);
      fallbackToDiskCache();
      return getCatalogStatus();
    }
  } catch {
    clearTimeout(timer);
    // If download fails, retain disk cache if available
    fallbackToDiskCache();
    return getCatalogStatus();
  } finally {
    clearTimeout(timer);
  }

  lastRefreshFailureAt = 0;
  const shards = buildShards(freshData);
  freshData = undefined as never; // the 6 MB payload is not needed any more
  const meta: CatalogMeta = {
    version: 2,
    fetchedAt: Date.now(),
    ttlMs: effectiveTtl,
    source: apiUrl,
    counts: Object.fromEntries(CATALOG_PROVIDERS.map((p) => [p, Object.keys(shards[p].models).length])) as Record<
      CatalogProvider,
      number
    >,
  };

  // Disk persistence is best-effort (a read-only filesystem still serves this process): shards first, `meta.json` last.
  let written = true;
  try {
    for (const p of CATALOG_PROVIDERS) writeJsonFileSync(getCacheFilePath(p), shards[p]);
    writeJsonFileSync(metaPath(), meta);
    removeLegacyCache();
  } catch (err) {
    written = false;
    telemetryBus.emitWarning(
      "catalog_cache_write_failed",
      `[Agent Accelerator] Could not write model catalog cache (${err instanceof Error ? err.message : String(err)}). Continuing with the in-memory catalog.`,
      { path: getCacheDir() }
    );
  }

  // Adopt the fresh data. When the disk could not take it, this process keeps the shards in memory instead.
  activeMeta = meta;
  activeFromCache = false;
  shardCache.clear();
  if (!written) for (const p of CATALOG_PROVIDERS) shardCache.set(p, shards[p].models);

  notifyUpdateListeners();
  return getCatalogStatus();
}

/** True when `AGENT_CATALOG_REFRESH` is `off`/`0`/`false`: never touch the network automatically. */
function automaticRefreshDisabled(): boolean {
  const v = getEnv("AGENT_CATALOG_REFRESH")?.trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

/**
 * Ensures that the model catalog is loaded and fresh. Called automatically
 * before Agent runs.
 *
 * - Fresh and loaded: returns immediately.
 * - Expired but loaded (stale-while-revalidate): returns the stale catalog at
 *   once and refreshes in the background with a short timeout, so a run is
 *   never delayed by models.dev being slow or unreachable.
 * - Nothing loaded yet (cold start): waits for the download.
 * - A failed refresh is not retried automatically for 10 minutes.
 * - `AGENT_CATALOG_REFRESH=off` disables automatic refreshes entirely
 *   (air-gapped hosts, hermetic tests); `force` and `refreshModelCatalog`
 *   still work.
 */
export async function ensureModelCatalogFresh(options: RefreshCatalogOptions = {}): Promise<CatalogStatus> {
  const current = getCatalogStatus();
  if (!options.force) {
    if (!current.isExpired && current.loaded) return current;
    if (automaticRefreshDisabled()) return current;
    if (Date.now() - lastRefreshFailureAt < REFRESH_FAILURE_BACKOFF_MS) return current;
  }

  const start = (): Promise<CatalogStatus> => {
    if (!inFlightRefresh) {
      const timeoutMs = options.timeoutMs ?? (current.loaded ? BACKGROUND_REFRESH_TIMEOUT_MS : undefined);
      inFlightRefresh = refreshModelCatalog({ ...options, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }).finally(
        () => {
          inFlightRefresh = null;
        }
      );
    }
    return inFlightRefresh;
  };

  if (current.loaded && !options.force) {
    start().catch(() => {}); // background revalidation; failures are non-fatal
    return current;
  }
  return start();
}
