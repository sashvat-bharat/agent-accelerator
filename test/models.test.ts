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

  it("should resolve OpenCode models", () => {
    const res1 = resolveModel("opencode-zen/hy3-free");
    expect(res1.provider.id).toBe("opencode");
    expect(res1.modelId).toBe("hy3-free");

    const res2 = resolveModel("opencode-go/muse-spark-1.2-contributor-free");
    expect(res2.provider.id).toBe("opencode");
    expect(res2.modelId).toBe("muse-spark-1.2-contributor-free");
  });

  it("should resolve OpenRouter models", () => {
    const res = resolveModel("openrouter/z-ai/glm-5.2:free");
    expect(res.provider.id).toBe("openrouter");
    expect(res.modelId).toBe("z-ai/glm-5.2:free");
  });

  it("should create model instances with ModelProvider helper", () => {
    const genAI = ModelProvider.GoogleGenAI("gemini-3.5-flash-lite", "TEST_KEY", {
      thinking_level: "low",
    });
    expect(genAI.model).toBe("google/gemini-3.5-flash-lite");
    expect(genAI.apiKey).toBe("TEST_KEY");
    expect(genAI.thinkingLevel).toBe("low");

    const openCode = ModelProvider.OpenCode("hy3-free", "OPENCODE_KEY");
    expect(openCode.model).toBe("opencode/hy3-free");
    expect(openCode.apiKey).toBe("OPENCODE_KEY");
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
  });
});
