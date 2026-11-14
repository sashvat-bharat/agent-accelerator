import { describe, it, expect } from "bun:test";
import {
  resolveModel,
  getProvider,
  ModelProvider,
  getModelFromCatalog,
  getModelThinkingInfo,
  computeSessionTurnCost,
  GOOGLE_MODELS,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  OPENROUTER_MODELS,
} from "../src/index.ts";

describe("Model Resolution & Providers", () => {
  it("should resolve Google AI Studio models", () => {
    const res1 = resolveModel("google/gemini-3.5-flash-lite");
    expect(res1.provider.id).toBe("google");
    expect(res1.modelId).toBe("gemini-3.5-flash-lite");

    const res2 = resolveModel("gemini-3.7-flash");
    expect(res2.provider.id).toBe("google");
    expect(res2.modelId).toBe("gemini-3.7-flash");
  });

  it("should reject removed OpenCode prefixes", () => {
    expect(() => resolveModel("opencode/hy3-free")).toThrow(/has been removed/);
    expect(() => resolveModel("opencode-go/mimo-v2.5-free")).toThrow(/has been removed/);
    expect(() => getProvider("opencode")).toThrow(/has been removed/);
  });

  it("should resolve OpenRouter models", () => {
    const res = resolveModel("openrouter/z-ai/glm-5.2:free");
    expect(res.provider.id).toBe("openrouter");
    expect(res.modelId).toBe("z-ai/glm-5.2:free");
  });

  it("should create model instances with ModelProvider helper", () => {
    const genAI = ModelProvider.GoogleGenAI("gemini-3.5-flash-lite", "TEST_KEY", {
      thinkingLevel: "low",
    });
    expect(genAI.model).toBe("google/gemini-3.5-flash-lite");
    expect(genAI.apiKey).toBe("TEST_KEY");
    expect(genAI.thinkingLevel).toBe("low");

    expect((ModelProvider as any).OpenCode).toBeUndefined();
  });

  it("should validate thinking options against the catalog", () => {
    const { validateModelThinking, getModelThinkingInfo } = require("../src/index.ts");
    
    // Model without reasoning (registered: every model the catalog keeps today reasons)
    const { registerModel, clearCustomModels } = require("../src/index.ts");
    registerModel({ id: "plain-llm", provider: "openai", name: "plain-llm", contextWindow: 1000, maxOutputTokens: 100, reasoning: false, capabilities: { supportsThinking: false } });
    const plainInfo = getModelThinkingInfo("openai", "plain-llm");
    expect(plainInfo.supportsThinking).toBe(false);
    expect(() => validateModelThinking("openai", "plain-llm", "high")).toThrow(/does not support thinking\/reasoning/);
    expect(() => validateModelThinking("openai", "plain-llm", "none")).not.toThrow();
    clearCustomModels();

    // Model with effort reasoning (e.g. gemini-3.7-flash)
    const geminiInfo = getModelThinkingInfo("google", "gemini-3.7-flash");
    expect(geminiInfo.supportsThinking).toBe(true);
    expect(geminiInfo.allowedLevels).toContain("low");
    expect(geminiInfo.allowedLevels).toContain("medium");
    expect(geminiInfo.allowedLevels).toContain("high");
    expect(() => validateModelThinking("google", "gemini-3.7-flash", "low")).not.toThrow();
    expect(() => validateModelThinking("google", "gemini-3.7-flash", "unsupported_level_xyz")).toThrow(/Invalid thinking level/);

    const { ThinkingLevelError } = require("../src/index.ts");
    try {
      validateModelThinking("google", "gemini-3.8-flash", "none");
      expect(true).toBe(false); // Should not reach here
    } catch (e: any) {
      expect(e).toBeInstanceOf(ThinkingLevelError);
      expect(e).toBeInstanceOf(Error);
      expect(e.modelId).toBe("gemini-3.8-flash");
      expect(e.requestedLevel).toBe("none");
      expect(e.allowedLevels).toEqual(["low", "medium", "high", "dynamic"]);
      expect(e.message).toContain("requires thinking and does not support disabling it");
      expect(e.message).toContain("How to fix:");
    }
  });
});

describe("catalog lookups do not bleed across providers", () => {
  it("a custom prefix never inherits another provider's entry that shares its id", () => {
    // gpt-5 is a hosted OpenAI model; a self-hosted endpoint serving a model of
    // the same name must not pick up its price, modalities or reasoning flags.
    expect(getModelFromCatalog("openai", "gpt-5")).toBeDefined();
    expect(getModelFromCatalog("ollama", "gpt-5")).toBeUndefined();
    expect(getModelFromCatalog("my-private-endpoint", "gpt-5")).toBeUndefined();
  });

  it("first-class providers and explicit bare-id lookups still resolve globally", () => {
    expect(getModelFromCatalog("gpt-5", "gpt-5")).toBeDefined();
    expect(getModelFromCatalog("OpenAI", "gpt-5")).toBeDefined();
    expect(getModelFromCatalog("anthropic", "claude-opus-5")).toBeDefined();
    expect(getModelFromCatalog("google", "gemini-3.5-flash-lite")).toBeDefined();
  });

  it("custom-prefix cost stays unknown (0) while the hosted model is priced", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };
    expect(computeSessionTurnCost(usage, "openai/gpt-5")).toBeGreaterThan(0);
    expect(computeSessionTurnCost(usage, "ollama/gpt-5")).toBe(0);
  });

  it("thinking validation for a custom prefix is permissive (no borrowed reasoning flags)", () => {
    const info = getModelThinkingInfo("ollama", "gpt-5");
    expect(info.supportsThinking).toBe(true);
    expect(info.allowedLevels).toContain("high");
    // The hosted model keeps the levels its catalog entry lists, not the permissive generic set.
    expect(getModelThinkingInfo("openai", "gpt-5").allowedLevels).not.toContain("max");
  });
});

describe("lazy model lists", () => {
  it("behave like arrays of the newest series of each provider", () => {
    for (const list of [GOOGLE_MODELS, OPENAI_MODELS, ANTHROPIC_MODELS, OPENROUTER_MODELS]) {
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      expect([...list].length).toBe(list.length);
    }
    expect(GOOGLE_MODELS.every((m) => /^gemini-[3-9]/.test(m.id))).toBe(true);
    expect(OPENAI_MODELS.every((m) => /^gpt-[5-9]/.test(m.id))).toBe(true);
    expect(ANTHROPIC_MODELS.every((m) => /^claude-[a-z]+-[5-9]/.test(m.id))).toBe(true);
    expect(OPENROUTER_MODELS.every((m) => m.modalities?.output.join() === "text")).toBe(true);
    expect(GOOGLE_MODELS.find((m) => m.id === "gemini-3.5-flash-lite")?.provider).toBe("google");
  });
});
