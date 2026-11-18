import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateImage,
  getProvider,
  telemetryBus,
  setModels,
  GeneratedImage,
  ConfigError,
  ValidationError,
  BudgetExceededError,
  ProviderError,
  TimeoutError,
  ModelNotAllowedError,
  SecurityPolicyError,
} from "../src/index.ts";
import { resetModels } from "../src/config/models.ts";
import { clearEmittedWarnings } from "../src/providers.ts";
import type { ProviderImageRequest, ProviderImageResult } from "../src/index.ts";

type Hook = (modelId: string, req: ProviderImageRequest, options: any) => Promise<ProviderImageResult>;
const PNG = (n: number) => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, n]);
const reply = (count = 1, extra: Partial<ProviderImageResult> = {}): ProviderImageResult => ({
  images: Array.from({ length: count }, (_, i) => ({ bytes: PNG(i), mimeType: "image/png" })),
  usage: { inputTokens: 10, outputTokens: 1120, totalTokens: 1130 },
  model: "m",
  provider: "google",
  raw: { request: { url: "https://x/interactions", method: "POST", headers: {}, body: { input: "secret prompt" } } },
  durationMs: 1,
  ...extra,
});

// The registry's providers are singletons: put a fake `generateImage` on one and restore it afterwards.
const patched: Array<() => void> = [];
function fake(provider: "google" | "openai", hook: Hook | undefined): { calls: ProviderImageRequest[]; options: any[] } {
  const target = getProvider(provider) as unknown as { generateImage?: Hook };
  const before = Object.getOwnPropertyDescriptor(target, "generateImage");
  const calls: ProviderImageRequest[] = [];
  const options: any[] = [];
  target.generateImage = hook
    ? (m, req, o) => {
        calls.push(req);
        options.push(o);
        return hook(m, req, o);
      }
    : undefined;
  patched.push(() => (before ? Object.defineProperty(target, "generateImage", before) : delete target.generateImage));
  return { calls, options };
}

let dir: string;
beforeEach(() => {
  clearEmittedWarnings();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "accel-img-"));
});
afterEach(() => {
  while (patched.length) patched.pop()!();
  resetModels();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NB = "google/gemini-nano-banana-2.1";
const SUN = "openai/gpt-image-2.5-sunburst";
const silence = <T>(fn: () => Promise<T>): Promise<T> => {
  const warn = console.warn;
  console.warn = () => {};
  return fn().finally(() => (console.warn = warn));
};

describe("generateImage: a call to a supported model", () => {
  it("sends the checked request to the provider and returns saved-able pictures, with no bytes in JSON", async () => {
    const f = fake("google", async () => reply(1, { text: "Here you go", finishReason: "stop", responseId: "i1" }));
    const r = await generateImage({ model: NB, prompt: "  A fox  ", aspectRatio: "16:9", resolution: "2K", thinking: "high", apiKey: "k", headers: { "x-a": "1" } });
    expect(f.calls).toEqual([{ prompt: "A fox", images: [], count: 1, aspectRatio: "16:9", resolution: "2K", thinking: "high" }]);
    expect(f.options[0]).toMatchObject({ apiKey: "k", headers: { "x-a": "1" }, timeoutMs: 300_000 });
    expect(f.options[0].signal).toBeInstanceOf(AbortSignal);
    expect(r.model).toBe("gemini-nano-banana-2.1");
    expect(r.provider).toBe("google");
    expect(r.text).toBe("Here you go");
    expect(r.finishReason).toBe("stop");
    expect(r.requests).toBe(1);
    expect(r.image).toBe(r.images[0]!);
    expect(r.image.mimeType).toBe("image/png");
    expect(r.image.extension).toBe(".png");
    expect(r.image.dataUrl).toStartWith("data:image/png;base64,iVBOR");
    expect(r.image.toPart()).toEqual({ type: "image", image: PNG(0), mimeType: "image/png" });
    const json = JSON.stringify(r);
    expect(json).not.toContain("iVBOR");
    expect(JSON.parse(json).images).toEqual([{ mimeType: "image/png", bytes: 9 }]);
    expect(JSON.stringify(r.raw)).not.toContain("secret prompt"); // captureRaw defaults to redacted
  });

  it("save() writes the bytes, makes folders and adds the extension when the name has none", async () => {
    fake("google", async () => reply());
    const r = await generateImage({ model: NB, prompt: "x" });
    const a = await r.image.save(path.join(dir, "deep", "fox"));
    expect(a).toBe(path.join(dir, "deep", "fox.png"));
    expect(new Uint8Array(fs.readFileSync(a))).toEqual(PNG(0));
    const b = await r.image.save(path.join(dir, "fox.image"));
    expect(path.basename(b)).toBe("fox.image");
  });

  it("n above the model's per-request maximum runs parallel requests (Google: one picture each) and adds the usage", async () => {
    const f = fake("google", async () => reply(1, { usage: { inputTokens: 5, outputTokens: 1120, totalTokens: 1125, cost: { totalCost: 0.01 } } }));
    const r = await generateImage({ model: NB, prompt: "x", n: 3 });
    expect(f.calls.map((c) => c.count)).toEqual([1, 1, 1]);
    expect(r.images).toHaveLength(3);
    expect(r.requests).toBe(3);
    expect(r.usage).toMatchObject({ inputTokens: 15, outputTokens: 3360, totalTokens: 3375 });
    expect(r.usage.cost?.totalCost).toBeCloseTo(0.03, 6);
    const o = fake("openai", async (_m, req) => reply(req.count, { provider: "openai" }));
    const many = await generateImage({ model: SUN, prompt: "x", n: 10 });
    expect(o.calls.map((c) => c.count)).toEqual([10]); // OpenAI takes all ten in one request
    expect(many.images).toHaveLength(10);
  });

  it("passes OpenAI the exact size it computed and the retry and timeout settings", async () => {
    const f = fake("openai", async () => reply(1, { provider: "openai" }));
    await generateImage({ model: SUN, prompt: "x", aspectRatio: "16:9", resolution: "4K", quality: "high", timeoutMs: 1000, retry: { maxRetries: 1, baseDelayMs: 5 } });
    expect(f.calls[0]).toMatchObject({ size: "3840x2160", quality: "high" });
    expect(f.calls[0]!.aspectRatio).toBeUndefined();
    expect(f.options[0]).toMatchObject({ timeoutMs: 1000, maxRetries: 1, retryBaseDelayMs: 5 });
  });

  it("reads reference images: a made picture, a data URL, bytes; refuses a non-image and paths outside fileAccess.roots", async () => {
    const f = fake("google", async () => reply());
    const made = new GeneratedImage(PNG(7), "image/png");
    const png = `data:image/png;base64,${Buffer.from(PNG(1)).toString("base64")}`;
    await generateImage({ model: NB, prompt: "edit", images: [made, png, PNG(2)] });
    expect(f.calls[0]!.images.map((i) => i.mimeType)).toEqual(["image/png", "image/png", "image/png"]);
    expect(f.calls[0]!.images[0]!.base64Data).toBe(made.base64);
    await expect(generateImage({ model: NB, prompt: "x", images: ["data:text/plain;base64,aGk="] })).rejects.toBeInstanceOf(ValidationError);
    await expect(generateImage({ model: NB, prompt: "x", images: ["/etc/hostname"], fileAccess: { roots: [dir] } })).rejects.toBeInstanceOf(SecurityPolicyError);
    expect(f.calls).toHaveLength(1);
  });
});

describe("generateImage: it fails clearly before anything is billed", () => {
  it("an unsupported model is a ConfigError that says why and lists the supported ones", async () => {
    await expect(generateImage({ model: "openai/gpt-image-1", prompt: "x" })).rejects.toThrow(/shut down.*Supported image models: google\/gemini-nano-banana-2\.1, google\/gemini-3\.1-flash-lite-image/);
    await expect(generateImage({ model: "google/gemini-3.1-flash-image", prompt: "x" })).rejects.toBeInstanceOf(ConfigError);
    await expect(generateImage({ model: "anthropic/claude-opus-5-5", prompt: "x" })).rejects.toThrow(/not a supported image model/);
  });

  it("a bad option is one ValidationError and no provider call", async () => {
    const f = fake("google", async () => reply());
    await expect(generateImage({ model: "google/gemini-3.1-flash-lite-image", prompt: "x", aspectRatio: "1:8", resolution: "4K" })).rejects.toThrow(/\(2 problems\)/);
    expect(f.calls).toHaveLength(0);
  });

  it("a model outside the setModels list is refused", async () => {
    const f = fake("google", async () => reply());
    setModels({ default: { model: "openai/gpt-5", sub_agent_model: "openai/gpt-5" }, providers: { openai: { models: ["gpt-5"] } } });
    await expect(generateImage({ model: NB, prompt: "x" })).rejects.toBeInstanceOf(ModelNotAllowedError);
    expect(f.calls).toHaveLength(0);
  });

  it("a provider with no image support yet is a ConfigError", async () => {
    fake("google", undefined);
    await expect(generateImage({ model: NB, prompt: "x" })).rejects.toThrow(/cannot make images yet/);
  });

  it("warns once on the bus for a control the model does not have, and still makes the picture", async () => {
    fake("google", async () => reply());
    const seen: string[] = [];
    const off = telemetryBus.onEvent((e) => e.code === "provider_warning" && seen.push(e.message));
    try {
      await silence(() => generateImage({ model: NB, prompt: "x", quality: "high" }));
      await silence(() => generateImage({ model: NB, prompt: "x", quality: "high" }));
    } finally {
      off();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/quality.*google\/gemini-nano-banana-2\.1.*no quality control/);
  });
});

describe("generateImage: limits, budget, abort", () => {
  it("a call that yields no picture throws a ProviderError with the provider's reason", async () => {
    fake("google", async () => reply(0, { text: "blocked by safety", finishReason: "content_filter" }));
    const err = await generateImage({ model: NB, prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/returned no image: blocked by safety/);
    expect(err.retryable).toBe(false);
  });

  it("stops before sending when the estimate is over budget.maxCostUsd, and after when the reported cost is", async () => {
    const f = fake("google", async () => reply(1, { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: { totalCost: 0.2 } } }));
    await expect(generateImage({ model: NB, prompt: "x", resolution: "4K", n: 3, budget: { maxCostUsd: 0.1 } })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(f.calls).toHaveLength(0); // 3 x $0.113 is known to be over $0.1: nothing was sent
    await expect(generateImage({ model: NB, prompt: "x", budget: { maxCostUsd: 0.1 } })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(f.calls).toHaveLength(1);
    await expect(generateImage({ model: NB, prompt: "x", budget: { maxCostUsd: 0 } })).rejects.toBeInstanceOf(ValidationError);
    const ok = await generateImage({ model: NB, prompt: "x", resolution: "1K", budget: { maxCostUsd: 1 } });
    expect(ok.requests).toBe(1);
  });

  it("an unknown price never stops a budgeted call (it counts as 0)", async () => {
    fake("openai", async (_m, req) => reply(req.count, { provider: "openai" }));
    const r = await generateImage({ model: SUN, prompt: "x", budget: { maxCostUsd: 0.01 } });
    expect(r.usage.cost).toBeUndefined();
  });

  it("when one of several requests fails the others are aborted and the cause is what is thrown, with the finished pictures attached", async () => {
    let n = 0;
    let aborted = 0;
    fake("google", async (_m, _req, o) => {
      const mine = ++n;
      if (mine === 2) throw new ProviderError("[google/x] boom", { provider: "google", retryable: false });
      if (mine === 1) return reply(1);
      return new Promise((_res, rej) => o.signal.addEventListener("abort", () => (aborted++, rej(new Error("aborted"))), { once: true }));
    });
    const err = await generateImage({ model: NB, prompt: "x", n: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("[google/x] boom");
    expect(aborted).toBe(1);
    expect(err.partial.images).toHaveLength(1);
  });

  it("the caller's signal aborts a call, even before it starts and even when the adapter ignores it", async () => {
    const f = fake("google", () => new Promise(() => {}));
    const pre = new AbortController();
    pre.abort(new Error("stop it"));
    await expect(generateImage({ model: NB, prompt: "x", signal: pre.signal })).rejects.toMatchObject({ name: "AbortError", message: "stop it" });
    expect(f.calls).toHaveLength(0);
    const live = new AbortController();
    const running = generateImage({ model: NB, prompt: "x", signal: live.signal });
    setTimeout(() => live.abort(), 10);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a hung provider is a TimeoutError after timeoutMs", async () => {
    fake("google", () => new Promise(() => {}));
    await expect(generateImage({ model: NB, prompt: "x", timeoutMs: 30 })).rejects.toBeInstanceOf(TimeoutError);
  });
});
