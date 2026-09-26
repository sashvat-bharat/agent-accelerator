import * as path from "node:path";
import * as fs from "node:fs";
import { getEnv } from "../utils/env.ts";

/** Default TTL: 12 Hours (in milliseconds). */
export const DEFAULT_CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

let globalCatalogTtlMs = DEFAULT_CATALOG_TTL_MS;

/** Sets the global model catalog cache TTL in milliseconds. */
export function setCatalogTTL(ttlMs: number): void {
  if (Number.isFinite(ttlMs) && ttlMs > 0) {
    globalCatalogTtlMs = ttlMs;
  }
}

/** Gets the currently configured global catalog TTL in milliseconds. */
export function getCatalogTTL(): number {
  return globalCatalogTtlMs;
}

export interface CatalogCacheFile {
  fetchedAt: number;
  ttlMs: number;
  source: string;
  version: string;
  data: Record<string, any>;
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

export function registerCatalogUpdateListener(listener: CatalogUpdateListener): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

function notifyUpdateListeners(): void {
  for (const listener of updateListeners) {
    try {
      listener();
    } catch {}
  }
}

/**
 * Catalog cache directory. Defaults to `src/data` (repo convention); override
 * with `AGENT_CACHE_DIR` when embedding as a package or running on a
 * read-only filesystem (serverless/containers).
 */
export function getCacheDir(): string {
  const override = getEnv("AGENT_CACHE_DIR");
  if (override && override.trim()) return path.resolve(override.trim());
  return path.resolve(process.cwd(), "src/data");
}

/** Non-configurable cache file path: src/data/models.dev.json */
export function getCacheFilePath(): string {
  return path.resolve(process.cwd(), "src/data/models.dev.json");
}

function readJsonFileSync(filePath: string): any {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function writeJsonFileSync(filePath: string, data: any): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
}

// In-memory catalog state
let activeCatalog: Record<string, any> = {};
let activeFetchedAt: number | undefined = undefined;
let activeTtlMs: number = globalCatalogTtlMs;
let activeFromCache = false;

// Synchronous bootstrap: load from src/data/models.dev.json if present
function initializeCatalogSync(): void {
  const cachePath = getCacheFilePath();
  const cached = readJsonFileSync(cachePath);
  if (cached && typeof cached === "object") {
    if (cached.data && typeof cached.data === "object") {
      activeCatalog = cached.data;
      activeFetchedAt = cached.fetchedAt;
      activeTtlMs = cached.ttlMs || globalCatalogTtlMs;
      activeFromCache = true;
      return;
    }
    if (cached.google || cached.openai) {
      activeCatalog = cached;
      activeFetchedAt = fs.statSync(cachePath).mtimeMs || Date.now();
      activeTtlMs = globalCatalogTtlMs;
      activeFromCache = true;
      return;
    }
  }

  activeCatalog = {};
  activeFetchedAt = undefined;
  activeTtlMs = globalCatalogTtlMs;
  activeFromCache = false;
}

initializeCatalogSync();

/** Returns the active in-memory catalog data. */
export function getActiveCatalog(): Record<string, any> {
  return activeCatalog;
}

/** Checks whether the active model catalog has expired based on its TTL. */
export function isCatalogExpired(): boolean {
  if (!activeFetchedAt) return true;
  const age = Date.now() - activeFetchedAt;
  return age < 0 || age >= activeTtlMs;
}

/** Returns diagnostic metadata about the current model catalog status. */
export function getCatalogStatus(): CatalogStatus {
  const providerCount = Object.keys(activeCatalog).length;
  let modelCount = 0;
  for (const prov of Object.values(activeCatalog)) {
    if (prov && typeof prov === "object" && prov.models) {
      modelCount += Object.keys(prov.models).length;
    }
  }

  const isExpired = !activeFetchedAt || Date.now() - activeFetchedAt >= activeTtlMs;

  return {
    loaded: providerCount > 0,
    fromCache: activeFromCache,
    isExpired,
    fetchedAt: activeFetchedAt,
    ttlMs: activeTtlMs,
    expiresAt: activeFetchedAt ? activeFetchedAt + activeTtlMs : undefined,
    cachePath: getCacheFilePath(),
    providerCount,
    modelCount,
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

/**
 * Refreshes the model catalog by downloading from models.dev
 * directly into src/data/models.dev.json with a 12-hour TTL.
 */
export async function refreshModelCatalog(options: RefreshCatalogOptions = {}): Promise<CatalogStatus> {
  const effectiveTtl = options.ttlMs ?? globalCatalogTtlMs;
  const apiUrl = options.apiUrl || "https://models.dev/api.json";
  const timeoutMs = options.timeoutMs ?? 30000;
  const cachePath = getCacheFilePath();

  // Return existing cache if still within TTL and not forcing
  if (!options.force) {
    const cached = readJsonFileSync(cachePath);
    if (cached && typeof cached === "object" && cached.data) {
      const age = Date.now() - (cached.fetchedAt || 0);
      const fileTtl = cached.ttlMs || effectiveTtl;
      if (age >= 0 && age < fileTtl) {
        activeCatalog = cached.data;
        activeFetchedAt = cached.fetchedAt;
        activeTtlMs = fileTtl;
        activeFromCache = true;
        notifyUpdateListeners();
        return getCatalogStatus();
      }
    }
  }

  // Fetch from models.dev
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let freshData: Record<string, any>;

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

    freshData = (await res.json()) as Record<string, any>;

    // Never let a non-catalog payload (mocked fetch, proxy error page,
    // chat-completion stub) overwrite the good on-disk cache.
    if (!isValidCatalogPayload(freshData)) {
      clearTimeout(timer);
      const existing = readJsonFileSync(cachePath);
      if (existing && existing.data) {
        activeCatalog = existing.data;
        activeFetchedAt = existing.fetchedAt;
        activeTtlMs = existing.ttlMs || effectiveTtl;
        activeFromCache = true;
        notifyUpdateListeners();
      }
      return getCatalogStatus();
    }
  } catch (err: any) {
    clearTimeout(timer);
    // If download fails, retain disk cache if available
    const existing = readJsonFileSync(cachePath);
    if (existing && existing.data) {
      activeCatalog = existing.data;
      activeFetchedAt = existing.fetchedAt;
      activeTtlMs = existing.ttlMs || effectiveTtl;
      activeFromCache = true;
      notifyUpdateListeners();
    }
    return getCatalogStatus();
  } finally {
    clearTimeout(timer);
  }

  const fetchedAt = Date.now();
  const cachePayload: CatalogCacheFile = {
    fetchedAt,
    ttlMs: effectiveTtl,
    source: apiUrl,
    version: "1.0",
    data: freshData,
  };

  // Update in-memory state FIRST so a read-only filesystem still serves the
  // fresh catalog for this process; disk persistence below is best-effort.
  activeCatalog = freshData;
  activeFetchedAt = fetchedAt;
  activeTtlMs = effectiveTtl;
  activeFromCache = true;

  // Save to src/data/models.dev.json (or the AGENT_CACHE_DIR override)
  try {
    writeJsonFileSync(cachePath, cachePayload);
  } catch (err) {
    activeFromCache = false;
    console.warn(
      `[Agent Accelerator] Could not write model catalog cache to ${cachePath} (${err instanceof Error ? err.message : String(err)}). Continuing with the in-memory catalog.`
    );
  }

  notifyUpdateListeners();
  return getCatalogStatus();
}

let inFlightRefresh: Promise<CatalogStatus> | null = null;

/**
 * Ensures that the model catalog is loaded and fresh.
 * Called automatically before Agent runs. If the cache is expired, triggers a refresh.
 */
export async function ensureModelCatalogFresh(options: RefreshCatalogOptions = {}): Promise<CatalogStatus> {
  const current = getCatalogStatus();
  if (!current.isExpired && current.loaded && !options.force) {
    return current;
  }

  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  inFlightRefresh = refreshModelCatalog(options).finally(() => {
    inFlightRefresh = null;
  });

  return inFlightRefresh;
}
