import { describe, it, expect } from "bun:test";
import { getDecisionModel } from "../src/models/decision-models.ts";
import { priceDecisionUsage } from "../src/decision/pricing.ts";

const google = getDecisionModel("google/gemini-decision-1")!;
const openai = getDecisionModel("openai/gpt-6-luna")!;
const usage = (u: Record<string, number>) => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, ...u });

describe("priceDecisionUsage", () => {
  it("prices the input at one rate; output is never charged", () => {
    expect(priceDecisionUsage(google, usage({ inputTokens: 324, outputTokens: 50 }))).toEqual({
      inputCost: 0.000032,
      outputCost: 0,
      totalCost: 0.000032,
    });
  });

  it("is unknown (not $0) without a price or without reported input tokens", () => {
    expect(priceDecisionUsage({ ...google, prices: undefined }, usage({ inputTokens: 100 }))).toBeUndefined();
    expect(priceDecisionUsage(google, usage({}))).toBeUndefined();
  });

  it("bills cache reads at their own rate, as a subset of the input", () => {
    // 1000 input of which 400 were read from the cache: 600 x 0.10 + 400 x 0.01 = 64 micro-USD
    expect(priceDecisionUsage(openai, usage({ inputTokens: 1000, cachedTokens: 400 }))!.totalCost).toBe(0.000064);
    // a read can never be more than the input
    expect(priceDecisionUsage(openai, usage({ inputTokens: 100, cachedTokens: 900 }))!.totalCost).toBe(0.000001);
    // a model with no cache-read rate bills those tokens at the input rate
    expect(priceDecisionUsage(google, usage({ inputTokens: 1000, cachedTokens: 400 }))!.totalCost).toBe(0.0001);
  });

  it("leaves the cost unknown when tokens were written to the cache and no write rate is stated", () => {
    expect(priceDecisionUsage(openai, usage({ inputTokens: 1000, cacheWriteTokens: 300 }))).toBeUndefined();
    const withWrite = { ...openai, prices: { ...openai.prices!, cacheWrite: 0.125 } };
    // 700 x 0.10 + 300 x 0.125 = 107.5 -> 108 micro-USD
    expect(priceDecisionUsage(withWrite, usage({ inputTokens: 1000, cacheWriteTokens: 300 }))!.totalCost).toBe(0.000108);
  });

  it("doubles every rate above 272,000 input tokens (OpenAI)", () => {
    expect(priceDecisionUsage(openai, usage({ inputTokens: 272_000 }))!.totalCost).toBe(0.0272);
    expect(priceDecisionUsage(openai, usage({ inputTokens: 300_000 }))!.totalCost).toBe(0.06); // 300,000 x 0.10 x 2
    expect(priceDecisionUsage(google, usage({ inputTokens: 300_000 }))!.totalCost).toBe(0.03); // no long-context rule
  });
});
