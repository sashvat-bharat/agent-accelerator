import { describe, it, expect } from "bun:test";
import { getImageModel } from "../src/index.ts";
import { resolveImageRequest, estimateImageCostUsd } from "../src/image/request.ts";
import type { ImageOptions } from "../src/index.ts";

const model = (id: string) => getImageModel(id)!;
const NB = model("google/gemini-nano-banana-2.1");
const LITE = model("google/gemini-3.1-flash-lite-image");
const SUN25 = model("openai/gpt-image-2.5-sunburst");
const SUN26 = model("openai/gpt-image-2.6-sunburst");
const OR26 = model("openrouter/openai/gpt-image-2.6-sunburst");
const ask = (def: typeof NB, o: Partial<ImageOptions> = {}) => resolveImageRequest({ model: def.model, prompt: "A fox", ...o }, def);
const message = (def: typeof NB, o: Partial<ImageOptions>): string => {
  try {
    ask(def, o);
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("image request: a model's own lists decide", () => {
  it("accepts a valid Nano Banana 2.1 request and keeps only what was asked", () => {
    const { request, warnings } = ask(NB, { aspectRatio: "21:9", resolution: "4K", thinking: "high", format: "jpeg", n: 3 });
    expect(request).toMatchObject({ aspectRatio: "21:9", resolution: "4K", thinking: "high", format: "jpeg", count: 3, prompt: "A fox" });
    expect(request.size).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(ask(NB).request.aspectRatio).toBeUndefined(); // nothing is invented: the provider's default applies
  });

  it("Flash Lite: refuses a ratio, tier and thinking level it does not make and says what it does", () => {
    expect(message(LITE, { aspectRatio: "1:8" })).toMatch(/"1:8" is not available on google\/gemini-3\.1-flash-lite-image\. It makes: 1:1, 3:2/);
    expect(message(LITE, { resolution: "2K" })).toMatch(/"2K" is not available.*It makes: 1K only/);
    expect(message(LITE, { thinking: "medium" })).toMatch(/It takes: minimal, high \(default minimal\)/);
    expect(message(NB, { thinking: "low" })).toMatch(/It takes: minimal, medium, high/);
    expect(message(NB, { thinking: "none" })).toMatch(/not available/);
    expect(message(NB, { resolution: "512" })).toMatch(/It makes: 1K, 2K, 4K/);
  });

  it("reports every problem at once, in one ValidationError", () => {
    const m = message(LITE, { aspectRatio: "1:8", resolution: "4K", format: "webp", n: 0, prompt: " " });
    expect(m).toMatch(/\(5 problems\)/);
    for (const part of ["prompt", "n:", "aspectRatio", "resolution", "format"]) expect(m).toContain(part);
    expect(m).toMatch(/format: "webp" is not available.*It makes: png, jpeg/);
  });

  it("drops a control the model does not have, with a warning (Google has no quality, background or exact size)", () => {
    const { request, warnings } = ask(NB, { quality: "high", background: "transparent", size: "1024x1024" });
    expect(request.quality).toBeUndefined();
    expect(request.background).toBeUndefined();
    expect(request.size).toBeUndefined();
    expect(warnings.map((w) => w.capability).sort()).toEqual(["background", "quality", "size"]);
    expect(ask(SUN25, { thinking: "high" }).warnings.map((w) => w.capability)).toEqual(["thinking"]);
    expect(ask(SUN25, { thinking: "dynamic" }).warnings).toEqual([]); // "dynamic" = the model's default
  });

  it("checks reference images: Nano Banana 2.1 takes 14, OpenAI 16, Flash Lite warns", () => {
    const pics = (n: number) => Array.from({ length: n }, () => "x");
    expect(() => ask(NB, { images: pics(14) })).not.toThrow();
    expect(message(NB, { images: pics(15) })).toMatch(/15 reference images; this model takes at most 14/);
    expect(message(SUN26, { images: pics(17) })).toMatch(/at most 16/);
    expect(ask(LITE, { images: pics(3) }).warnings[0]).toMatchObject({ capability: "reference images" });
    expect(ask(LITE, { images: pics(1) }).warnings).toEqual([]);
  });

  it("checks the prompt and the count", () => {
    expect(message(NB, { prompt: "" })).toMatch(/prompt: required/);
    expect(message(SUN25, { prompt: "x".repeat(32_001) })).toMatch(/32001 characters.*at most 32000/);
    expect(message(NB, { n: 11 })).toMatch(/from 1 to 10/);
    expect(message(NB, { n: 1.5 })).toMatch(/whole number/);
  });
});

describe("image request: OpenAI exact sizes", () => {
  it("turns a ratio and tier into pixels (multiples of 16, the tier's area, 4K capped at the model's maximum)", () => {
    expect(ask(SUN25, { aspectRatio: "16:9", resolution: "2K" }).request.size).toBe("2736x1536");
    expect(ask(SUN25, { aspectRatio: "16:9", resolution: "1K" }).request.size).toBe("1360x768"); // Google makes 1376x768
    expect(ask(SUN25, { aspectRatio: "16:9", resolution: "4K" }).request.size).toBe("3840x2160");
    expect(ask(SUN25, { aspectRatio: "9:16" }).request.size).toBe("768x1360"); // 1K tier by default
    expect(ask(SUN25, { aspectRatio: "3:1", resolution: "4K" }).request.size).toBe("3840x1280"); // no side past 3840
    expect(ask(SUN25, { resolution: "2K" }).request.size).toBe("2048x2048");
    expect(ask(SUN25, { resolution: "4K" }).request.size).toBe("2880x2880"); // 8,294,400 pixels, the model's maximum
    // the ratio and tier are consumed: the adapter only sees `size`
    expect(ask(SUN25, { aspectRatio: "16:9", resolution: "2K" }).request.aspectRatio).toBeUndefined();
    expect(ask(SUN25).request.size).toBeUndefined(); // nothing asked: the model's `auto`
  });

  it("refuses sizes the rules forbid and says which rule", () => {
    expect(message(SUN25, { resolution: "512" })).toMatch(/512x512: too small \(at least 655360 pixels\)/);
    expect(message(SUN25, { size: "4096x2304" })).toMatch(/longer than 3840/);
    expect(message(SUN25, { aspectRatio: "4:1" })).toMatch(/at most 3 times/);
    expect(message(SUN25, { size: "1000x1000" })).toMatch(/multiples of 16/);
    expect(message(SUN25, { size: "4000x2000" })).toMatch(/longer than 3840/);
    expect(message(SUN25, { size: "wide" })).toMatch(/not "WIDTHxHEIGHT"/);
    expect(message(SUN25, { size: "1024x1024", aspectRatio: "1:1" })).toMatch(/cannot be combined/);
    expect(message(SUN25, { aspectRatio: "banana" })).toMatch(/not a ratio/);
    expect(ask(SUN25, { size: "1536x864" }).request.size).toBe("1536x864");
    expect(ask(SUN25, { size: "auto" }).request.size).toBe("auto");
  });

  it("warns about experimental sizes on 2.5 only", () => {
    expect(ask(SUN25, { size: "3840x2160" }).warnings[0]).toMatchObject({ capability: "size" });
    expect(ask(SUN26, { size: "3840x2160" }).warnings).toEqual([]);
  });

  it("checks quality, format and background", () => {
    expect(ask(SUN25, { quality: "max", format: "webp", background: "transparent" }).request).toMatchObject({ quality: "max", format: "webp", background: "transparent" });
    expect(message(SUN25, { quality: "ultra" })).toMatch(/It takes: low, medium, high, xhigh, max, auto/);
    expect(message(SUN25, { background: "transparent", format: "jpeg" })).toMatch(/needs the png or webp/);
    expect(ask(NB, { format: "png" }).request.format).toBe("png");
  });
});

describe("image cost estimate", () => {
  it("is known for Google models (tokens per picture x the image price) and unknown for OpenAI", () => {
    expect(estimateImageCostUsd(NB, "1K", 1)).toBeCloseTo(0.0336, 6);
    expect(estimateImageCostUsd(NB, "2K", 1)).toBeCloseTo(0.0504, 6);
    expect(estimateImageCostUsd(NB, undefined, 3)).toBeCloseTo(0.1008, 6); // the default tier
    expect(estimateImageCostUsd(LITE, "1K", 2)).toBeCloseTo(0.0672, 6);
    expect(estimateImageCostUsd(SUN25, "1K", 1)).toBeUndefined();
  });
});

describe("image request: OpenAI models through OpenRouter (a ratio, no size or tier)", () => {
  it("accepts its 14 ratios and passes the ratio on as is", () => {
    expect(ask(OR26, { aspectRatio: "21:9", quality: "xhigh", n: 4 }).request).toMatchObject({ aspectRatio: "21:9", quality: "xhigh", count: 4 });
    expect(ask(OR26, { aspectRatio: "3:1" }).request.aspectRatio).toBe("3:1");
    expect(message(OR26, { aspectRatio: "5:1" })).toMatch(/"5:1" is not available on openrouter\/openai\/gpt-image-2\.6-sunburst\. It makes: 1:1, 3:2/);
    expect(message(OR26, { images: Array.from({ length: 17 }, () => "x") })).toMatch(/at most 16/);
  });

  it("drops a size tier or an exact size with a warning, since the model only takes a ratio", () => {
    const { request, warnings } = ask(OR26, { resolution: "2K", size: "1536x864" });
    expect(request.resolution).toBeUndefined();
    expect(request.size).toBeUndefined();
    expect(warnings.map((w) => w.capability).sort()).toEqual(["resolution", "size"]);
  });
});
