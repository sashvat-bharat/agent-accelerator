import { describe, it, expect } from "bun:test";
import { listImageModels, getImageModel } from "../src/index.ts";
import { unsupportedImageModelReason } from "../src/models/image-models.ts";

const USD = (tokens: number, perMillion: number) => (tokens * perMillion) / 1_000_000;

describe("the supported image models", () => {
  it("are two Google, four OpenAI and the same four OpenAI models through OpenRouter, sorted", () => {
    expect(listImageModels().map((m) => m.model)).toEqual([
      "google/gemini-3.1-flash-lite-image",
      "google/gemini-nano-banana-2.1",
      "openai/gpt-image-2.5-flare",
      "openai/gpt-image-2.5-sunburst",
      "openai/gpt-image-2.6-flare",
      "openai/gpt-image-2.6-sunburst",
      "openrouter/openai/gpt-image-2.5-flare",
      "openrouter/openai/gpt-image-2.5-sunburst",
      "openrouter/openai/gpt-image-2.6-flare",
      "openrouter/openai/gpt-image-2.6-sunburst",
    ]);
    expect(listImageModels("openrouter")).toHaveLength(4);
    expect(listImageModels("google").map((m) => m.id)).toEqual(["gemini-3.1-flash-lite-image", "gemini-nano-banana-2.1"]);
    expect(listImageModels("gemini")).toHaveLength(2); // the SDK routes gemini/ to google
    expect(listImageModels("anthropic")).toEqual([]);
  });

  it("every model makes images and says what it accepts", () => {
    for (const m of listImageModels()) {
      expect(m.outputs).toContain("image");
      expect(m.model).toBe(`${m.provider}/${m.id}`);
      expect(m.formats.length).toBeGreaterThan(0);
      expect(m.imagesPerRequest.max).toBeGreaterThanOrEqual(1);
      expect(m.prices.imageOutput).toBeGreaterThan(0);
      // how a size is asked: tiers (Google), exact-size rules (OpenAI), or the aspect ratio alone (OpenRouter)
      expect(Boolean(m.resolutions) && Boolean(m.sizeRules)).toBe(false);
      if (m.provider === "openrouter") expect(m.resolutions || m.sizeRules).toBeUndefined();
      else expect(Boolean(m.resolutions) !== Boolean(m.sizeRules)).toBe(true);
    }
  });

  it("Nano Banana 2.1: limits, 14 ratios, three tiers, 14 references, thinking, prices", () => {
    const m = getImageModel("google/gemini-nano-banana-2.1")!;
    expect(m.limits).toEqual({ inputTokens: 131_072, outputTokens: 32_768 });
    expect(m.aspectRatios).toHaveLength(14);
    expect(m.aspectRatios).toContain("1:8");
    expect(m.resolutions).toEqual(["1K", "2K", "4K"]);
    expect(m.referenceImages.max).toBe(14);
    expect(m.thinking).toEqual({ levels: ["minimal", "medium", "high"], default: "medium" });
    expect(m.prices).toEqual({ textInput: 1.5, textOutput: 7.5, imageInput: 1.5, imageOutput: 30 });
    expect(m.batchPrices?.imageOutput).toBe(15);
    // the per-image price on the provider's page: 1K = $0.0336, 2K = $0.0504, 4K = $0.113
    expect(USD(m.tokensPerImage!["1K"]!, 30)).toBeCloseTo(0.0336, 6);
    expect(USD(m.tokensPerImage!["2K"]!, 30)).toBeCloseTo(0.0504, 6);
    expect(USD(m.tokensPerImage!["4K"]!, 30)).toBeCloseTo(0.1134, 4);
  });

  it("Flash Lite: smaller limits, only the 10 named ratios, 1K only, thinking minimal or high", () => {
    const m = getImageModel("google/gemini-3.1-flash-lite-image")!;
    expect(m.limits).toEqual({ inputTokens: 65_536, outputTokens: 4096 });
    expect(m.aspectRatios).toHaveLength(10);
    expect(m.aspectRatios).not.toContain("1:8");
    expect(m.resolutions).toEqual(["1K"]);
    expect(m.thinking?.levels).toEqual(["minimal", "high"]);
    expect(m.referenceImages.max).toBeUndefined();
    expect(m.referenceImages.note).toMatch(/not optimized/);
    expect(m.prices).toEqual({ textInput: 0.25, textOutput: 1.5, imageInput: 0.25, imageOutput: 30 });
    expect(USD(m.tokensPerImage!["1K"]!, 30)).toBeCloseTo(0.0336, 6);
  });

  it("OpenAI models share prices and size rules; only 2.5 has batch and the experimental-size note", () => {
    for (const id of ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2.6-sunburst", "gpt-image-2.6-flare"]) {
      const m = getImageModel(`openai/${id}`)!;
      expect(m.prices).toMatchObject({ textInput: 5, imageInput: 8, imageOutput: 30, cacheRead: 2 });
      expect(m.quality).toEqual(["low", "medium", "high", "xhigh", "max", "auto"]);
      expect(m.referenceImages.max).toBe(16);
      expect(m.sizeRules).toMatchObject({ multipleOf: 16, maxEdge: 3840, minPixels: 655_360, maxPixels: 8_294_400, maxRatio: 3 });
      expect(m.thinking).toBeUndefined();
      // the 2.6 models have 400K context and output and a cache-write price (OpenRouter's listing of the same model)
      const is26 = id.includes("2.6");
      expect(m.limits).toEqual(is26 ? { promptChars: 32_000, inputTokens: 400_000, outputTokens: 400_000 } : { promptChars: 32_000 });
      expect(m.prices.cacheWrite).toBe(is26 ? 10 : undefined);
      expect(Boolean(m.batchPrices)).toBe(id.includes("2.5"));
      expect(Boolean(m.sizeRules?.experimentalAbove)).toBe(id.includes("2.5"));
    }
  });

  it("the OpenAI models through OpenRouter: same model, prices and limits; a ratio but no size, tier or batch", () => {
    for (const id of ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2.6-sunburst", "gpt-image-2.6-flare"]) {
      const direct = getImageModel(`openai/${id}`)!;
      const via = getImageModel(`openrouter/openai/${id}`)!;
      expect(via).toMatchObject({ provider: "openrouter", id: `openai/${id}`, model: `openrouter/openai/${id}` });
      expect(via.prices).toEqual(direct.prices);
      expect(via.limits).toEqual(direct.limits);
      expect(via.quality).toEqual(direct.quality);
      expect(via.referenceImages).toEqual({ max: 16 });
      expect(via.aspectRatios).toHaveLength(14);
      expect(via.aspectRatios).toContain("21:9");
      expect(via.sizeRules).toBeUndefined();
      expect(via.batchPrices).toBeUndefined();
      expect(direct.batchPrices !== undefined).toBe(id.includes("2.5")); // the direct models are unchanged
    }
    expect(getImageModel("openrouter/openai/gpt-image-2.6-flare")!.limits.inputTokens).toBe(400_000);
  });

  it("finds a model by full string or bare id, and never returns an unsupported one", () => {
    expect(getImageModel("gemini-nano-banana-2.1")?.provider).toBe("google");
    expect(getImageModel("gemini/gemini-nano-banana-2.1")?.provider).toBe("google");
    expect(getImageModel("openai/gemini-nano-banana-2.1")).toBeUndefined();
    expect(getImageModel("google/gemini-3.1-flash-image")).toBeUndefined();
    expect(getImageModel("google/gemini-3-pro-image")).toBeUndefined();
    expect(getImageModel("openai/gpt-image-2.6-sunburst")?.provider).toBe("openai"); // not the OpenRouter route
    expect(getImageModel("openrouter/openai/gpt-image-1")).toBeUndefined();
  });

  it("explains why a model is not supported: retired, or just not on the list", () => {
    expect(unsupportedImageModelReason("openai/gpt-image-2.5-flare")).toBeUndefined();
    expect(unsupportedImageModelReason("openai/gpt-image-1")).toMatch(/shut down.*Supported image models: .*gpt-image-2\.6-sunburst/);
    expect(unsupportedImageModelReason("openai/gpt-image-2")).toMatch(/deprecated/);
    expect(unsupportedImageModelReason("google/gemini-3.1-flash-image")).toMatch(/not a supported image model/);
  });
});
