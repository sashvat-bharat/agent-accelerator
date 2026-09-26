import { describe, it, expect } from "bun:test";
import { resolveEffectiveThinking } from "../src/agent/agent.ts";
import { withRetries, isTransientError } from "../src/utils/retry.ts";
import { toConciseProviderError, assertModalitiesSupported } from "../src/utils/errors.ts";
import { retentionToTtlSeconds } from "../src/utils/cache.ts";

describe("per-run thinking override", () => {
  it("resolves per-run thinking override without mutating base", () => {
    const base = { enabled: true, level: "low" as const };
    expect(resolveEffectiveThinking(base, undefined)).toBe(base);
    expect(resolveEffectiveThinking(base, "high")).toEqual({ enabled: true, level: "high" });
    expect(resolveEffectiveThinking(base, "none")).toEqual({ enabled: false, level: "none", budgetTokens: 0 });
    expect(resolveEffectiveThinking(base, "dynamic")).toEqual({ enabled: true, level: "dynamic", budgetTokens: -1 });
  });
});

describe("cache retention TTL mapping", () => {
  it("maps retention to TTL seconds", () => {
    expect(retentionToTtlSeconds("short")).toBe(300);
    expect(retentionToTtlSeconds("medium")).toBe(3600);
    expect(retentionToTtlSeconds("long")).toBe(43200);
    expect(retentionToTtlSeconds("implicit")).toBeUndefined();
    expect(retentionToTtlSeconds("short", 999)).toBe(999);
  });
});

describe("bounded retries for transient failures", () => {
  it("retries then succeeds; classifies transient vs permanent", async () => {
    let calls = 0;
    const result = await withRetries(
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
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ status: 400 })).toBe(false);
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

  it("withRetries rethrows concise when labelled", async () => {
    try {
      await withRetries(async () => { throw bigErr; }, {
        maxRetries: 0,
        label: { providerId: "openrouter", modelId: "m" },
      });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.name).toBe("AgentAccelProviderError");
      expect(String(e.message)).toContain("(404)");
    }
  });

  it("withRetries stays raw without a label", async () => {
    try {
      await withRetries(async () => { throw bigErr; }, { maxRetries: 0 });
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

  it("accepts pdf on space-bunny-alpha via live-verified override", async () => {
    const { assertNoVideoPartsOnResponses } = await import("../src/index.ts");
    expect(() =>
      assertModalitiesSupported(
        ctx({ type: "file", file: "https://example.com/d.pdf", mimeType: "application/pdf" }),
        "openrouter",
        "stealth/space-bunny-alpha"
      )
    ).not.toThrow();
    // ...but video still fails fast on Responses transports (no wire shape),
    // even though the catalog flag is set.
    expect(() =>
      assertNoVideoPartsOnResponses(ctx({ type: "video", video: "https://x/y.mp4" }), "openrouter", "stealth/space-bunny-alpha")
    ).toThrow(/unsupported video input.*Responses API accepts text\/image\/file only/);
    expect(() =>
      assertNoVideoPartsOnResponses(ctx({ type: "video", video: "https://x/y.mp4" }), "openai", "gpt-4o")
    ).toThrow(/unsupported video input/);
    expect(() =>
      assertNoVideoPartsOnResponses(ctx({ type: "text", text: "x" }), "openai", "gpt-4o")
    ).not.toThrow();
  });
});
