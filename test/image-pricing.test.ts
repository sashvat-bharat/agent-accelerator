import { describe, it, expect, afterEach } from "bun:test";
import { generateImage, getImageModel, getProvider } from "../src/index.ts";
import { priceImageUsage, sumCosts } from "../src/image/pricing.ts";
import type { ProviderImageResult } from "../src/index.ts";

const NB = getImageModel("google/gemini-nano-banana-2.1")!;
const LITE = getImageModel("google/gemini-3.1-flash-lite-image")!;
const SUN = getImageModel("openai/gpt-image-2.5-sunburst")!;
const micro = (def: typeof NB, usage: any, call: any = { images: 1, references: 0 }) => priceImageUsage(def, usage, call)?.breakdown.totalMicroUSD;

describe("priceImageUsage: Google (image output $30/M, text and thinking $7.50/M, input $1.50/M)", () => {
  it("prices the reported image tokens at the image rate and the rest of the output at the text rate", () => {
    // 20 input tokens = 30; 1120 image tokens = 33,600; 80 text + thinking tokens = 600
    const u = { inputTokens: 20, outputTokens: 1200, totalTokens: 1220, outputDetails: { imageTokens: 1120 } };
    const p = priceImageUsage(NB, u, { images: 1, references: 0 })!;
    expect(p.breakdown).toMatchObject({ inputMicroUSD: 30, outputMicroUSD: 34_200, totalMicroUSD: 34_230 });
    expect(p.totalCost).toBeCloseTo(0.03423, 8);
    expect(p.source).toBe("catalog");
  });

  it("a plain 1K picture with no text costs the $0.0336 Google lists", () => {
    expect(micro(NB, { inputTokens: 0, outputTokens: 1120, totalTokens: 1120, outputDetails: { imageTokens: 1120 } })).toBe(33_600);
    expect(micro(LITE, { inputTokens: 0, outputTokens: 1120, totalTokens: 1120, outputDetails: { imageTokens: 1120 } })).toBe(33_600);
  });

  it("without the modality split it estimates the image tokens from the table (per picture and tier)", () => {
    const u = { inputTokens: 20, outputTokens: 1200, totalTokens: 1220 };
    expect(micro(NB, u, { images: 1, references: 0, resolution: "1K" })).toBe(34_230);
    expect(micro(NB, { inputTokens: 0, outputTokens: 5000, totalTokens: 5000 }, { images: 2, references: 0, resolution: "2K" })).toBe(
      Math.round(2 * 1680 * 30 + (5000 - 3360) * 7.5)
    );
    // never more image tokens than the model wrote
    expect(micro(NB, { inputTokens: 0, outputTokens: 100, totalTokens: 100 }, { images: 1, references: 0 })).toBe(3000);
  });

  it("input costs the same for text and images, so reference images need no split", () => {
    const u = { inputTokens: 2000, outputTokens: 1120, totalTokens: 3120, outputDetails: { imageTokens: 1120 } };
    expect(micro(NB, u, { images: 1, references: 3 })).toBe(3000 + 33_600);
    expect(micro(LITE, u, { images: 1, references: 3 })).toBe(500 + 33_600); // $0.25/M
  });
});

describe("priceImageUsage: OpenAI (text in $5/M, image in $8/M, image out $30/M, no text output)", () => {
  it("prices the split input and all output as image tokens", () => {
    const u = { inputTokens: 1000, outputTokens: 1756, totalTokens: 2756, inputDetails: { textTokens: 200, imageTokens: 800 } };
    const p = priceImageUsage(SUN, u, { images: 1, references: 2 })!;
    expect(p.breakdown).toMatchObject({ inputMicroUSD: 200 * 5 + 800 * 8, outputMicroUSD: 1756 * 30 });
    expect(p.totalCost).toBeCloseTo(0.06008, 8);
  });

  it("a prompt with no reference images is all text input", () => {
    expect(micro(SUN, { inputTokens: 24, outputTokens: 196, totalTokens: 220 })).toBe(24 * 5 + 196 * 30);
  });

  it("is UNKNOWN (undefined) when reference images were sent and the input split is missing", () => {
    expect(micro(SUN, { inputTokens: 2365, outputTokens: 196, totalTokens: 2561 }, { images: 1, references: 2 })).toBeUndefined();
  });

  it("is unknown when the provider reported no usage at all (never $0)", () => {
    expect(micro(SUN, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBeUndefined();
    expect(micro(NB, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBeUndefined();
  });

  it("never reads more image tokens than were sent or written", () => {
    expect(micro(SUN, { inputTokens: 10, outputTokens: 50, totalTokens: 60, inputDetails: { imageTokens: 99 } }, { images: 1, references: 1 })).toBe(10 * 8 + 50 * 30);
  });
});

describe("generateImage fills usage.cost", () => {
  const target = getProvider("google") as unknown as { generateImage?: unknown };
  const before = Object.getOwnPropertyDescriptor(target, "generateImage");
  afterEach(() => (before ? Object.defineProperty(target, "generateImage", before) : delete target.generateImage));
  const reply = (usage: any): ProviderImageResult => ({
    images: [{ bytes: new Uint8Array([1]), mimeType: "image/png" }],
    usage,
    model: "m",
    provider: "google",
    raw: { request: { url: "u", method: "POST", headers: {}, body: {} } },
    durationMs: 1,
  });
  const ask = (n = 1) => generateImage({ model: "google/gemini-nano-banana-2.1", prompt: "x", n });

  it("prices each request from the table and adds them up", async () => {
    target.generateImage = async () => reply({ inputTokens: 20, outputTokens: 1120, totalTokens: 1140, outputDetails: { imageTokens: 1120 } });
    const r = await ask(3);
    expect(r.usage.cost?.totalCost).toBeCloseTo(3 * 0.03363, 6);
    expect(r.usage.cost?.inputCost).toBeCloseTo(3 * 0.00003, 8);
    expect(r.usage.outputDetails).toEqual({ imageTokens: 3360 });
  });

  it("the provider's own cost wins over the table", async () => {
    target.generateImage = async () => reply({ inputTokens: 20, outputTokens: 1120, totalTokens: 1140, cost: { totalCost: 0.5 } });
    expect((await ask()).usage.cost).toEqual({ totalCost: 0.5 });
  });

});

describe("sumCosts", () => {
  it("adds known costs and keeps the parts only when every call has them", () => {
    expect(sumCosts([{ inputCost: 0.001, outputCost: 0.03, totalCost: 0.031 }, { inputCost: 0.002, outputCost: 0.03, totalCost: 0.032 }])).toEqual({
      inputCost: 0.003,
      outputCost: 0.06,
      totalCost: 0.063,
    });
    expect(sumCosts([{ totalCost: 0.5 }, { inputCost: 0.1, outputCost: 0.1, totalCost: 0.2 }])).toEqual({ totalCost: 0.7 });
  });

  it("one unpriced call makes the total unknown, never a partial sum", () => {
    expect(sumCosts([{ totalCost: 0.5 }, undefined])).toBeUndefined();
    expect(sumCosts([{ totalCost: 0.5 }, {}])).toBeUndefined();
    expect(sumCosts([])).toBeUndefined();
  });
});
