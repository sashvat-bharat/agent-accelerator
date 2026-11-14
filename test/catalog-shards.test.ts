import { describe, it, expect } from "bun:test";
import { buildShards, isShard, CATALOG_PROVIDERS } from "../src/models/catalog-shards.ts";

const m = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  description: "dropped",
  interleaved: true,
  limit: { context: 1000, output: 100 },
  ...extra,
});
const entries = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, m(id)]));

describe("buildShards: which models each provider shard keeps", () => {
  const payload = {
    google: {
      models: entries(
        "gemini-2.5-flash",
        "gemini-flash-latest",
        "gemma-4-31b-it",
        "gemini-embedding-001",
        "gemini-3-flash-preview",
        "gemini-3.5-flash-lite",
        "gemini-4-argon"
      ),
    },
    openai: { models: entries("gpt-4o", "gpt-4.1", "o3", "gpt-image-2", "gpt-5", "gpt-5.4-mini", "gpt-6-sol", "gpt-6.1-sol") },
    anthropic: {
      models: entries("claude-opus-4-8", "claude-haiku-4-5-20251001", "claude-opus-5", "claude-opus-5-5", "claude-fable-5-2"),
    },
    openrouter: {
      models: {
        "a/text": m("a/text", { modalities: { input: ["text"], output: ["text"] } }),
        "a/image": m("a/image", { modalities: { input: ["text"], output: ["text", "image"] } }),
        "a/none": m("a/none"),
      },
    },
    groq: { models: entries("llama") },
  };
  const shards = buildShards(payload as Record<string, unknown>);

  it("Google keeps gemini 3 and newer only", () => {
    expect(Object.keys(shards.google.models)).toEqual(["gemini-3-flash-preview", "gemini-3.5-flash-lite", "gemini-4-argon"]);
  });
  it("OpenAI keeps gpt-5 and newer only", () => {
    expect(Object.keys(shards.openai.models)).toEqual(["gpt-5", "gpt-5.4-mini", "gpt-6-sol", "gpt-6.1-sol"]);
  });
  it("Anthropic keeps claude 5 and newer only", () => {
    expect(Object.keys(shards.anthropic.models)).toEqual(["claude-opus-5", "claude-opus-5-5", "claude-fable-5-2"]);
  });
  it("OpenRouter keeps only models whose output is text alone", () => {
    expect(Object.keys(shards.openrouter.models)).toEqual(["a/text"]);
  });
  it("keeps only the fields the SDK reads and never other providers", () => {
    expect(shards.google.models["gemini-4-argon"]).toEqual({ id: "gemini-4-argon", name: "gemini-4-argon", limit: { context: 1000, output: 100 } });
    expect(Object.keys(shards)).toEqual([...CATALOG_PROVIDERS]);
  });
  it("a missing or malformed provider gives an empty shard, and isShard checks the shape", () => {
    const empty = buildShards({ google: { models: [] }, openai: null } as never);
    expect(empty.openai.models).toEqual({});
    expect(empty.google.models).toEqual({});
    expect(isShard(shards.google, "google")).toBe(true);
    expect(isShard(shards.google, "openai")).toBe(false);
    expect(isShard({ version: 1, provider: "google", models: [] }, "google")).toBe(false);
    expect(isShard(null, "google")).toBe(false);
  });
});
