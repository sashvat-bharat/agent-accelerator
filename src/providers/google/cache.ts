import { getApiKey } from "../../utils/env.ts";

export interface CreateExplicitCacheOptions {
  model: string;
  systemInstruction?: string;
  contents?: Array<{
    role?: string;
    parts: Array<Record<string, unknown>>;
  }>;
  tools?: Array<Record<string, unknown>>;
  toolConfig?: Record<string, unknown>;
  displayName?: string;
  ttlSeconds?: number;
  /** ISO string or Date for explicit expireTime (overrides ttl) */
  expireTime?: string | Date;
  apiKey?: string;
  baseUrl?: string;
}

export interface CachedContentMetadata {
  name: string; // cachedContents/...
  displayName?: string;
  model: string;
  createTime: string;
  updateTime: string;
  expireTime: string;
  usageMetadata?: {
    totalTokenCount?: number;
  };
}

/**
 * Creates an explicit cached content object using Google Gemini's cachedContents API
 * REST: POST https://generativelanguage.googleapis.com/v1beta/cachedContents?key=...
 * Body: { model, contents, systemInstruction, tools, toolConfig, displayName, ttl }
 * Docs: /references/gemini-documentation/context-caching.md
 */
export async function createExplicitCache(
  options: CreateExplicitCacheOptions
): Promise<CachedContentMetadata> {
  const apiKey = getApiKey("google", options.apiKey);
  if (!apiKey) {
    throw new Error("API key is required to create explicit cache (GEMINI_API_KEY)");
  }

  const baseUrl = options.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  // TTL handling per docs: "300s" style, default 1h
  const ttl = options.expireTime
    ? undefined
    : options.ttlSeconds
      ? `${options.ttlSeconds}s`
      : "3600s";

  let modelName = options.model;
  if (!modelName.startsWith("models/")) {
    modelName = `models/${modelName.replace(/^google\//, "")}`;
  }

  const payload: Record<string, unknown> = {
    model: modelName,
    contents: options.contents ?? [],
    ...(ttl ? { ttl } : {}),
    ...(options.expireTime
      ? { expireTime: options.expireTime instanceof Date ? options.expireTime.toISOString() : options.expireTime }
      : {}),
  };

  if (options.displayName) {
    payload.displayName = options.displayName;
    // Also set display_name for REST snake_case compat
    (payload as any).display_name = options.displayName;
  }

  if (options.systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: options.systemInstruction }],
    };
    // Also snake_case for REST
    (payload as any).system_instruction = payload.systemInstruction;
  }

  if (options.tools && options.tools.length > 0) {
    payload.tools = options.tools;
  }

  if (options.toolConfig) {
    payload.toolConfig = options.toolConfig;
    (payload as any).tool_config = options.toolConfig;
  }

  const url = `${baseUrl}/cachedContents?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to create explicit cache (${response.status} ${response.statusText}): ${errorBody}`
    );
  }

  return (await response.json()) as CachedContentMetadata;
}

/**
 * Gets a cached content by name
 * REST: GET https://generativelanguage.googleapis.com/v1beta/{name}?key=...
 */
export async function getExplicitCache(
  cacheName: string,
  apiKey?: string,
  baseUrl?: string
): Promise<CachedContentMetadata> {
  const resolvedApiKey = getApiKey("google", apiKey);
  if (!resolvedApiKey) throw new Error("API key required to get cache");
  const base = baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const formattedName = cacheName.startsWith("cachedContents/")
    ? cacheName
    : `cachedContents/${cacheName}`;
  const url = `${base}/${formattedName}?key=${resolvedApiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to get cache ${cacheName}: ${err}`);
  }
  return (await response.json()) as CachedContentMetadata;
}

/**
 * Lists all cached contents
 * REST: GET https://generativelanguage.googleapis.com/v1beta/cachedContents?key=...
 */
export async function listExplicitCaches(
  apiKey?: string,
  baseUrl?: string,
  pageSize = 10
): Promise<CachedContentMetadata[]> {
  const resolvedApiKey = getApiKey("google", apiKey);
  if (!resolvedApiKey) throw new Error("API key required to list caches");
  const base = baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const url = `${base}/cachedContents?key=${resolvedApiKey}&pageSize=${pageSize}`;
  const response = await fetch(url);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to list caches: ${err}`);
  }
  const data: any = await response.json();
  return (data.cachedContents || []) as CachedContentMetadata[];
}

/**
 * Updates a cache's TTL or expireTime
 * REST: PATCH https://generativelanguage.googleapis.com/v1beta/{name}?key=... Body: {ttl: "600s"}
 * Docs: context-caching.md#update-a-cache
 */
export async function updateExplicitCache(
  cacheName: string,
  options: { ttlSeconds?: number; expireTime?: string | Date },
  apiKey?: string,
  baseUrl?: string
): Promise<CachedContentMetadata> {
  const resolvedApiKey = getApiKey("google", apiKey);
  if (!resolvedApiKey) throw new Error("API key required to update cache");
  const base = baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const formattedName = cacheName.startsWith("cachedContents/")
    ? cacheName
    : `cachedContents/${cacheName}`;
  const url = `${base}/${formattedName}?key=${resolvedApiKey}`;
  const body: Record<string, unknown> = {};
  if (options.ttlSeconds !== undefined) body.ttl = `${options.ttlSeconds}s`;
  if (options.expireTime) body.expireTime = options.expireTime instanceof Date ? options.expireTime.toISOString() : options.expireTime;
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to update cache ${cacheName}: ${err}`);
  }
  return (await response.json()) as CachedContentMetadata;
}

/**
 * Deletes an explicit cache from Google Gemini
 * REST: DELETE https://generativelanguage.googleapis.com/v1beta/{name}?key=...
 */
export async function deleteExplicitCache(
  cacheName: string,
  apiKey?: string,
  baseUrl?: string
): Promise<void> {
  const resolvedApiKey = getApiKey("google", apiKey);
  if (!resolvedApiKey) throw new Error("API key required to delete cache");
  const base = baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const formattedName = cacheName.startsWith("cachedContents/")
    ? cacheName
    : `cachedContents/${cacheName}`;

  const url = `${base}/${formattedName}?key=${resolvedApiKey}`;
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to delete cache ${cacheName}: ${err}`);
  }
}
