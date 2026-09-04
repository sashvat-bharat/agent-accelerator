import { describe, it, expect } from "bun:test";
import { AgentResponse } from "../src/index.ts";

describe("Complete JSON Data Exposure", () => {
  it("should expose all request, response, usage, and execution details in JSON", () => {
    const response = new AgentResponse({
      text: "The weather in Delhi is Sunny and 21°C.",
      thinking: "User asked for weather in Delhi. Called get_weather.",
      thoughtSignature: "sig_abc_123",
      toolCalls: [
        {
          id: "call_1",
          name: "get_weather",
          arguments: { city: "Delhi" },
        },
      ],
      toolResults: [
        {
          id: "call_1",
          name: "get_weather",
          result: { city: "Delhi", temperature: 21, condition: "Sunny" },
          durationMs: 42,
        },
      ],
      usage: {
        inputTokens: 120,
        outputTokens: 35,
        totalTokens: 155,
        cachedTokens: 80,
        cacheReadTokens: 80,
        thinkingTokens: 15,
      },
      responseId: "resp_998877",
      model: "gemini-3.5-flash-lite",
      provider: "google",
      finishReason: "STOP",
      durationMs: 350,
      raw: {
        request: {
          url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: { contents: [] },
        },
        response: {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: { candidates: [] },
        },
      },
      turns: 2,
    });

    const json = response.toJSON();

    expect(json.text).toBe("The weather in Delhi is Sunny and 21°C.");
    expect(json.thinking).toBe("User asked for weather in Delhi. Called get_weather.");
    expect(json.thoughtSignature).toBe("sig_abc_123");
    expect(json.toolCalls?.length).toBe(1);
    expect(json.toolResults?.length).toBe(1);
    expect(json.usage.cachedTokens).toBe(80);
    expect(json.usage.thinkingTokens).toBe(15);
    expect(json.model).toBe("gemini-3.5-flash-lite");
    expect(json.provider).toBe("google");
    expect(json.raw.request.url).toContain("generativelanguage.googleapis.com");
    expect(json.raw.response?.status).toBe(200);
    expect(json.turns).toBe(2);
  });

  it("should calculate real-time dollar costs accurately based on model pricing", async () => {
    const { computeCostFromPricing } = await import("../src/agent/loop.ts");
    const mockSpec: any = {
      id: "test-model",
      pricing: {
        inputPerMillion: 1.0, // $1 per 1M uncached input tokens
        outputPerMillion: 4.0, // $4 per 1M output tokens
        cacheReadPerMillion: 0.1, // $0.10 per 1M cached input tokens
        cacheWritePerMillion: 1.0,
      },
    };

    const usage: any = {
      inputTokens: 10000,
      cachedTokens: 8000, // 8000 cached, 2000 non-cached
      cacheReadTokens: 8000,
      cacheWriteTokens: 0,
      outputTokens: 500,
    };

    const cost = computeCostFromPricing(usage, mockSpec);
    expect(cost).toBeDefined();

    // 2,000 non-cached * ($1.0 / 1M) = $0.002
    expect(cost?.inputCost).toBeCloseTo(0.002, 6);

    // 8,000 cached * ($0.1 / 1M) = $0.0008
    expect(cost?.cacheReadCost).toBeCloseTo(0.0008, 6);

    // 500 output * ($4.0 / 1M) = $0.002
    expect(cost?.outputCost).toBeCloseTo(0.002, 6);

    // Total = 0.002 + 0.0008 + 0.002 = $0.0048
    expect(cost?.totalCost).toBeCloseTo(0.0048, 6);
  });
});
