import { describe, it, expect } from "bun:test";
import {
  getCatalogStatus,
  getCacheFilePath,
  getCacheDir,
  setCatalogTTL,
  getCatalogTTL,
  DEFAULT_CATALOG_TTL_MS,
  ensureModelCatalogFresh,
  isValidCatalogPayload,
} from "../src/index.ts";

describe("Model Catalog Dynamic Cache & 12h TTL", () => {
  it("should resolve cache directory and path to src/data by default", () => {
    const dir = getCacheDir();
    const filePath = getCacheFilePath();
    expect(dir).toContain("src/data");
    expect(filePath).toContain("src/data/models.dev.json");
  });

  it("should have a default TTL of 12 hours", () => {
    expect(DEFAULT_CATALOG_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });

  it("should allow getting and setting custom TTL", () => {
    const original = getCatalogTTL();
    setCatalogTTL(6 * 60 * 60 * 1000); // 6 hours
    expect(getCatalogTTL()).toBe(6 * 60 * 60 * 1000);
    // Restore
    setCatalogTTL(original);
  });

  it("should return valid catalog status with model and provider counts", () => {
    const status = getCatalogStatus();
    expect(status.loaded).toBe(true);
    expect(status.providerCount).toBeGreaterThan(0);
    expect(status.modelCount).toBeGreaterThan(0);
    expect(typeof status.isExpired).toBe("boolean");
  });

  it("should ensure catalog is loaded and fresh", async () => {
    const status = await ensureModelCatalogFresh();
    expect(status.loaded).toBe(true);
    expect(status.providerCount).toBeGreaterThan(0);
  });

  it("should reject non-catalog payloads before they overwrite the disk cache", () => {
    // Mocked-fetch chat completion (the payload that once poisoned the cache).
    expect(
      isValidCatalogPayload({
        id: "chatcmpl-local",
        choices: [{ message: { role: "assistant", content: "local hello" } }],
        usage: { total_tokens: 8 },
      })
    ).toBe(false);
    // Error envelope.
    expect(isValidCatalogPayload({ error: { message: "boom", code: 500 } })).toBe(false);
    // Primitives / arrays.
    expect(isValidCatalogPayload(null)).toBe(false);
    expect(isValidCatalogPayload([])).toBe(false);
    // Degenerate shaped payload (no real models).
    expect(isValidCatalogPayload({ a: { models: {} }, b: { models: {} } })).toBe(false);
    // Real shape.
    expect(
      isValidCatalogPayload({
        google: { models: { "gemini-3.5-flash-lite": { id: "gemini-3.5-flash-lite" } } },
        openai: { models: { "gpt-4o": { id: "gpt-4o" } } },
        openrouter: { models: { "x/y": { id: "x/y" } } },
      })
    ).toBe(true);
  });
});
