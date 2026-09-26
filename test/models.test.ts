import { describe, it, expect } from "bun:test";
import { resolveModel, getProvider, ModelProvider } from "../src/index.ts";

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

  it("should validate thinking options against models.dev.json", () => {
    const { validateModelThinking, getModelThinkingInfo } = require("../src/index.ts");
    
    // Model without reasoning (e.g. gpt-4o)
    const gpt4oInfo = getModelThinkingInfo("openai", "gpt-4o");
    expect(gpt4oInfo.supportsThinking).toBe(false);
    expect(() => validateModelThinking("openai", "gpt-4o", "high")).toThrow(/does not support thinking\/reasoning/);
    expect(() => validateModelThinking("openai", "gpt-4o", "none")).not.toThrow();

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
