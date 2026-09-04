import { describe, it, expect } from "bun:test";
import {
  Agent,
  tool,
  z,
  getProvider,
  resolveModel,
  GoogleAIStudioProvider,
  OpenAIProvider,
  OpenCodeProvider,
  OpenRouterProvider,
  OpenAICompatibleProvider,
  stripSchemaForGoogle,
  isValidThoughtSignature,
  retainThoughtSignature,
  GOOGLE_MODELS,
  OPENAI_MODELS,
  OPENCODE_MODELS,
  OPENROUTER_MODELS,
} from "../src/index.ts";
import type {
  GoogleGenerateContentRequest,
  OpenAIChatCompletionRequest,
  OpenCodeChatRequest,
  OpenCodeResponsesRequest,
  OpenRouterChatRequest,
} from "../src/index.ts";

describe("Single-File Provider Architecture & Provider-Specific Types", () => {
  it("should have all providers defined in single .ts files and registered", () => {
    const google = getProvider("google");
    const openai = getProvider("openai");
    const opencode = getProvider("opencode");
    const openrouter = getProvider("openrouter");
    const groq = getProvider("groq"); // Custom provider auto-created

    expect(google).toBeInstanceOf(GoogleAIStudioProvider);
    expect(openai).toBeInstanceOf(OpenAIProvider);
    expect(opencode).toBeInstanceOf(OpenCodeProvider);
    expect(openrouter).toBeInstanceOf(OpenRouterProvider);
    expect(groq).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("should expose provider-specific models and fallbacks", () => {
    expect(GOOGLE_MODELS.length).toBeGreaterThan(0);
    expect(OPENAI_MODELS.length).toBeGreaterThan(0);
    expect(OPENCODE_MODELS.length).toBeGreaterThan(0);
    expect(OPENROUTER_MODELS.length).toBeGreaterThan(0);
  });

  it("should correctly clean schemas for Google OpenAPI 3.0 specifications", () => {
    const jsonSchemaWithDefs = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    };

    const cleaned = stripSchemaForGoogle(jsonSchemaWithDefs);
    expect(cleaned.$schema).toBeUndefined();
    expect(cleaned.additionalProperties).toBeUndefined();
    expect(cleaned.properties.query.type).toBe("string");
    expect(cleaned.properties.limit.type).toBe("number");
    expect(cleaned.required).toEqual(["query"]);
  });

  it("should validate and retain Gemini thought signatures correctly", () => {
    expect(isValidThoughtSignature("YWJjZA==")).toBe(true);
    expect(isValidThoughtSignature("invalid!!")).toBe(false);
    expect(isValidThoughtSignature("")).toBe(false);

    expect(retainThoughtSignature("existing", "incoming")).toBe("incoming");
    expect(retainThoughtSignature("existing", "")).toBe("existing");
    expect(retainThoughtSignature("existing", undefined)).toBe("existing");
    expect(retainThoughtSignature(undefined, "incoming")).toBe("incoming");
  });

  it("should allow type-checking provider-specific request payload types", () => {
    // Compile-time and runtime check of provider-specific types
    const googleReq: GoogleGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      generationConfig: {
        thinkingConfig: {
          thinkingLevel: "HIGH",
        },
      },
    };
    expect(googleReq.contents[0].parts[0].text).toBe("Hello");
    expect(googleReq.generationConfig?.thinkingConfig?.thinkingLevel).toBe("HIGH");

    const openaiReq: OpenAIChatCompletionRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      reasoning_effort: "medium",
    };
    expect(openaiReq.model).toBe("gpt-4o");
    expect(openaiReq.reasoning_effort).toBe("medium");

    const opencodeReq: OpenCodeChatRequest = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
      reasoning_effort: "high",
    };
    expect(opencodeReq.model).toBe("gpt-5.4");

    const openrouterReq: OpenRouterChatRequest = {
      model: "anthropic/claude-3.7-sonnet",
      messages: [{ role: "user", content: "Hello" }],
      reasoning: { effort: "high" },
    };
    expect(openrouterReq.reasoning?.effort).toBe("high");
  });

  it("should ensure skills subsystem is completely eliminated", () => {
    // Verify that index.ts does not export any skill functions
    const mod: any = require("../src/index.ts");
    expect(mod.defineSkill).toBeUndefined();
    expect(mod.loadSkill).toBeUndefined();
    expect(mod.Skill).toBeUndefined();
  });

  it("should strictly support Gemini 3.x series and reject Gemini 2.x and 1.x models", async () => {
    const google = getProvider("google") as GoogleAIStudioProvider;
    
    // Valid Gemini 3.x models
    expect(google.models.some((m) => m.id.includes("gemini-3"))).toBe(true);
    // Ensure no Gemini 2.x models in google.models
    expect(google.models.some((m) => m.id.includes("gemini-2"))).toBe(false);
    expect(google.models.some((m) => m.id.includes("gemini-1"))).toBe(false);

    // Should reject Gemini 2.x models
    expect(() => (google as any).cleanModelId("google/gemini-2.5-flash")).toThrow(/Gemini 2.x and 1.x models are not supported/);
    expect(() => (google as any).cleanModelId("gemini-2.0-flash")).toThrow(/Gemini 2.x and 1.x models are not supported/);
    expect(() => (google as any).cleanModelId("gemini-1.5-pro")).toThrow(/Gemini 2.x and 1.x models are not supported/);

    // Should accept Gemini 3.x models
    expect((google as any).cleanModelId("google/gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
    expect((google as any).cleanModelId("gemini-3.7-flash")).toBe("gemini-3.7-flash");

    // Wire payload for Gemini 3 uses thinkingLevel without thinkingBudget
    const payload = await (google as any).buildPayload(
      "gemini-3.7-flash",
      { messages: [{ role: "user", content: "Hello" }] },
      { thinking: { enabled: true, level: "high" } }
    );
    expect(payload.generationConfig?.thinkingConfig?.thinkingLevel).toBe("HIGH");
    expect(payload.generationConfig?.thinkingConfig?.thinkingBudget).toBeUndefined();
  });
});
