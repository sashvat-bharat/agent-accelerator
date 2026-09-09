import { describe, it, expect } from "bun:test";
import {
  mapThinkingToReasoning,
  resolveEffectiveThinking,
  mapToolChoice,
  mapThinkingToProviderOptions,
  mapServiceTierToProviderOptions,
  mapCacheToProviderOptions,
  buildAiSdkCallOptions,
  withAiSdkRetries,
  isTransientAiSdkError,
} from "../src/ai-sdk/options.ts";
import { retentionToTtlSeconds } from "../src/utils/cache.ts";
import { toConciseProviderError, assertModalitiesSupported } from "../src/ai-sdk/errors.ts";

describe("AI SDK options mapping", () => {
  it("maps thinking levels to Vercel reasoning", () => {
    expect(mapThinkingToReasoning(undefined)).toBeUndefined();
    expect(mapThinkingToReasoning({ enabled: false, level: "none" })).toBe("none");
    expect(mapThinkingToReasoning({ enabled: true, level: "none" })).toBe("none");
    expect(mapThinkingToReasoning({ enabled: true, level: "dynamic" })).toBe("provider-default");
    expect(mapThinkingToReasoning({ enabled: true, level: "minimal" })).toBe("minimal");
    expect(mapThinkingToReasoning({ enabled: true, level: "low" })).toBe("low");
    expect(mapThinkingToReasoning({ enabled: true, level: "medium" })).toBe("medium");
    expect(mapThinkingToReasoning({ enabled: true, level: "high" })).toBe("high");
    expect(mapThinkingToReasoning({ enabled: true, level: "xhigh" })).toBe("xhigh");
  });

  it("resolves per-run thinking override without mutating base", () => {
    const base = { enabled: true, level: "low" as const };
    expect(resolveEffectiveThinking(base, undefined)).toBe(base);
    expect(resolveEffectiveThinking(base, "high")).toEqual({ enabled: true, level: "high" });
    expect(resolveEffectiveThinking(base, "none")).toEqual({ enabled: false, level: "none", budgetTokens: 0 });
    expect(resolveEffectiveThinking(base, "dynamic")).toEqual({ enabled: true, level: "dynamic", budgetTokens: -1 });
  });

  it("maps toolChoice to Vercel format", () => {
    expect(mapToolChoice(undefined)).toBeUndefined();
    expect(mapToolChoice("auto")).toEqual({ type: "auto" });
    expect(mapToolChoice("none")).toEqual({ type: "none" });
    expect(mapToolChoice("required")).toEqual({ type: "required" });
    expect(mapToolChoice({ type: "function", function: { name: "get_status" } })).toEqual({
      type: "tool",
      toolName: "get_status",
    });
  });

  it("maps thinking to providerOptions per provider", () => {
    expect(mapThinkingToProviderOptions("google", { enabled: true, level: "high" })).toEqual({
      google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
    });
    expect(mapThinkingToProviderOptions("google", { enabled: true, level: "xhigh" })).toEqual({
      google: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
    });
    expect(mapThinkingToProviderOptions("openai", { enabled: true, level: "medium" })).toEqual({
      openai: { reasoningEffort: "medium" },
    });
    expect(mapThinkingToProviderOptions("openai", { enabled: false, level: "none" })).toEqual({});
    expect(mapThinkingToProviderOptions("opencode", { enabled: true, level: "high" })).toEqual({});
  });

  it("maps serviceTier and cache to providerOptions", () => {
    expect(mapServiceTierToProviderOptions("google", "flex")).toEqual({ google: { serviceTier: "flex" } });
    expect(mapServiceTierToProviderOptions("openai", "priority")).toEqual({ openai: { serviceTier: "priority" } });
    expect(mapServiceTierToProviderOptions("groq", "flex")).toEqual({
      openai: { serviceTier: "flex" },
      groq: { serviceTier: "flex" },
    });
    expect(mapCacheToProviderOptions("google", { cachedContentId: "cache-123" }, "sess-1")).toEqual({
      google: { cachedContent: "cache-123" },
      openai: { promptCacheKey: "sess-1" },
    });
  });

  it("builds full call options with session headers", () => {
    const opts = buildAiSdkCallOptions("opencode", {
      thinking: { enabled: true, level: "medium" },
      toolChoice: "auto",
      serviceTier: "priority",
      sessionId: "sess-abc",
      headers: { "x-custom": "1" },
    });
    expect(opts.reasoning).toBe("medium");
    expect(opts.toolChoice).toEqual({ type: "auto" });
    expect(opts.providerOptions?.["openai"]).toMatchObject({ serviceTier: "priority" });
    expect(opts.headers?.["x-custom"]).toBe("1");
    expect(opts.headers?.["x-opencode-session"] ?? opts.headers?.["session_id"] ?? opts.headers?.["x-session-id"]).toBeDefined();
  });

  it("maps retention to OpenCode prompt_cache_retention", () => {
    expect(mapCacheToProviderOptions("opencode", { retention: "long" }, "s1")).toMatchObject({
      opencode: { prompt_cache_retention: "24h" },
    });
    expect(mapCacheToProviderOptions("opencode", { retention: "medium" }, "s1")).toMatchObject({
      opencode: { prompt_cache_retention: "1h" },
    });
    expect(mapCacheToProviderOptions("google", { retention: "long" }, "s1")["opencode"]).toBeUndefined();
    expect(retentionToTtlSeconds("short")).toBe(300);
    expect(retentionToTtlSeconds("medium")).toBe(3600);
    expect(retentionToTtlSeconds("long")).toBe(43200);
    expect(retentionToTtlSeconds("implicit")).toBeUndefined();
    expect(retentionToTtlSeconds("short", 999)).toBe(999);
  });

  it("retries transient errors with backoff", async () => {
    let calls = 0;
    const result = await withAiSdkRetries(
      async () => {
        calls += 1;
        if (calls < 3) {
          const err: unknown = Object.assign(new Error("rate limit"), { status: 429 });
          throw err;
        }
        return "ok";
      },
      { maxRetries: 3, maxRetryDelayMs: 5 }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(isTransientAiSdkError({ status: 429 })).toBe(true);
    expect(isTransientAiSdkError({ status: 400 })).toBe(false);
  });
});

describe("concise provider errors", () => {
  const bigErr = Object.assign(new Error("AI_APICallError: blah"), {
    statusCode: 404,
    url: "https://openrouter.ai/api/v1/chat/completions?key=secret",
    requestBodyValues: { model: "x", messages: [{}] },
    responseHeaders: { "set-cookie": "junk", "content-type": "application/json" },
    responseBody: '{"error":{"message":"No endpoints found that support input video","code":404}}',
    data: { error: { message: "No endpoints found that support input video", code: 404 } },
  });

  it("collapses the wire dump to one line and strips secrets", () => {
    const err = toConciseProviderError(bigErr, "openrouter", "nvidia/nemotron-3.5-lightning:free");
    expect(err.name).toBe("AgentAccelProviderError");
    expect(err.message).toBe(
      "[openrouter/nvidia/nemotron-3.5-lightning:free] request failed (404): No endpoints found that support input video"
    );
    expect((err as any).requestBodyValues).toBeUndefined();
    expect((err as any).responseHeaders).toBeUndefined();
    expect((err as any).url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(err.message).not.toContain("secret");
  });

  it("withAiSdkRetries rethrows concise when labelled", async () => {
    try {
      await withAiSdkRetries(async () => { throw bigErr; }, {
        maxRetries: 0,
        label: { providerId: "openrouter", modelId: "m" },
      });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.name).toBe("AgentAccelProviderError");
      expect(String(e.message)).toContain("(404)");
    }
  });

  it("withAiSdkRetries stays raw without a label", async () => {
    try {
      await withAiSdkRetries(async () => { throw bigErr; }, { maxRetries: 0 });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e).toBe(bigErr);
    }
  });
});

describe("modality guard (catalog-driven)", () => {
  const ctx = (...parts: any[]) =>
    ({ systemPrompt: "", messages: [{ role: "user", content: parts }] }) as any;

  it("rejects image for a catalog text-only model before any network call", () => {
    expect(() =>
      assertModalitiesSupported(ctx({ type: "text", text: "x" }, { type: "image", image: "https://x/y.png" }), "openrouter", "z-ai/glm-5.2:free")
    ).toThrow(/unsupported image input.*supports: text/);
  });

  it("rejects video naming the supported set", () => {
    expect(() =>
      assertModalitiesSupported(ctx({ type: "video", video: "https://x/y.mp4" }), "openrouter", "z-ai/glm-5.2:free")
    ).toThrow(/unsupported video input/);
  });

  it("accepts image+audio+pdf on gpt-4o via verified override", () => {
    expect(() =>
      assertModalitiesSupported(
        ctx(
          { type: "image", image: "data:image/png;base64,xx" },
          { type: "audio", audio: "data:audio/mp3;base64,xx" },
          { type: "file", file: "data:application/pdf;base64,xx", mimeType: "application/pdf" }
        ),
        "openai",
        "gpt-4o"
      )
    ).not.toThrow();
  });

  it("skips unknown models — provider verdict stands", () => {
    expect(() =>
      assertModalitiesSupported(ctx({ type: "video", video: "https://x/y.mp4" }), "openrouter", "some/unknown-model")
    ).not.toThrow();
  });
});
