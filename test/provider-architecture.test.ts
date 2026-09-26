import { describe, it, expect } from "bun:test";
import {
  Agent,
  tool,
  z,
  getProvider,
  resolveModel,
  GoogleAIStudioProvider,
  OpenAIProvider,
  OpenRouterProvider,
  OpenAICompatibleProvider,
  stripSchemaForGoogle,
  isValidThoughtSignature,
  retainThoughtSignature,
  GOOGLE_MODELS,
  OPENAI_MODELS,
  OPENROUTER_MODELS,
} from "../src/index.ts";
import type {
  GoogleGenerateContentRequest,
  OpenAIChatCompletionRequest,
  OpenRouterChatRequest,
} from "../src/types/provider-payloads.ts";

describe("Single-File Provider Architecture & Provider-Specific Types", () => {
  it("should have all providers defined in single .ts files and registered", () => {
    const google = getProvider("google");
    const openai = getProvider("openai");
    const openrouter = getProvider("openrouter");
    const groq = getProvider("groq"); // Custom provider auto-created

    expect(openai).toBeInstanceOf(OpenAIProvider);
    expect(openrouter).toBeInstanceOf(OpenRouterProvider);
    expect(groq).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("should expose provider-specific models and fallbacks", () => {
    expect(GOOGLE_MODELS.length).toBeGreaterThan(0);
    expect(OPENAI_MODELS.length).toBeGreaterThan(0);
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

  it("should route Gemini models through the native Interactions adapter (no 2.x rejection)", async () => {
    const google = getProvider("google") as GoogleAIStudioProvider;

    // NOTE: catalog-populated `models` assertions live in the test above;
    // the test env ships an empty catalog cache, so routing (which falls back
    // to a generic spec) is asserted here instead.
    expect(google.id).toBe("google");

    // Interactions API documents 2.5 support (flex/priority + thinking tables),
    // so the legacy 2.x/1.x client rejection is intentionally gone.
    // Unknown/legacy ids pass through; the server verdict surfaces concisely.
    const resolved25 = resolveModel("google/gemini-2.5-flash");
    expect(resolved25.provider.id).toBe("google");
    expect(resolved25.modelId).toBe("gemini-2.5-flash");

    // Should accept Gemini 3.x models (prefix stripped by the adapter)
    const resolvedLite = resolveModel("google/gemini-3.5-flash-lite");
    expect(resolvedLite.provider.id).toBe("google");
    expect(resolvedLite.modelId).toBe("gemini-3.5-flash-lite");

    // Thinking maps to the canonical Google level (no budget field exists natively).
    const { mapThinkingLevelToGoogle } = await import("../src/index.ts");
    expect(mapThinkingLevelToGoogle("high")).toEqual({ thinkingLevel: "high" });
  });
});
