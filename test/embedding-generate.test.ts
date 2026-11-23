import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateEmbedding,
  getProvider,
  telemetryBus,
  setModels,
  EmbeddingResult,
  ConfigError,
  ValidationError,
  BudgetExceededError,
  ProviderError,
  TimeoutError,
  ModelNotAllowedError,
  SecurityPolicyError,
  setHome,
} from "../src/index.ts";
import { resetModels } from "../src/config/models.ts";
import { setConfigs, SETTING_KEYS } from "../src/config/settings.ts";
import { setGovernorLimits } from "../src/agent/governor.ts";
import { clearEmittedWarnings } from "../src/providers.ts";
import { resetOpenRouterEmbeddingsCache } from "../src/models/openrouter-embeddings.ts";
import type { ProviderEmbeddingRequest, ProviderEmbeddingResult } from "../src/types/embedding.ts";

type Hook = (modelId: string, req: ProviderEmbeddingRequest, options: any) => Promise<ProviderEmbeddingResult>;
// One vector per item: [position in the whole list encoded in the text "n<k>", 0.5]; texts that are not "n<k>" give [0, 0.5].
const vec = (req: ProviderEmbeddingRequest): number[][] =>
  req.items.map((parts) => {
    const p = parts[0]!;
    const k = p.kind === "text" ? Number(/^n(\d+)$/.exec(p.text)?.[1] ?? 0) : 0;
    return [k, 0.5];
  });
const reply = (req: ProviderEmbeddingRequest, extra: Partial<ProviderEmbeddingResult> = {}): ProviderEmbeddingResult => ({
  vectors: vec(req),
  usage: { inputTokens: req.items.length * 100, outputTokens: 0, totalTokens: req.items.length * 100 },
  model: "m",
  provider: "openai",
  raw: { request: { url: "https://x/embeddings", method: "POST", headers: {}, body: { input: ["secret text"] } } },
  durationMs: 1,
  ...extra,
});

// The registry's providers are singletons: put a fake `embed` on one and restore it afterwards.
const patched: Array<() => void> = [];
function fake(provider: "google" | "openai" | "openrouter", hook: Hook | undefined) {
  const target = getProvider(provider) as unknown as { embed?: Hook };
  const before = Object.getOwnPropertyDescriptor(target, "embed");
  const calls: ProviderEmbeddingRequest[] = [];
  const options: any[] = [];
  target.embed = hook
    ? (m, req, o) => {
        calls.push(req);
        options.push(o);
        return hook(m, req, o);
      }
    : undefined;
  patched.push(() => (before ? Object.defineProperty(target, "embed", before) : delete target.embed));
  return { calls, options };
}
const texts = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);

let dir: string;
beforeEach(() => {
  clearEmittedWarnings();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "accel-emb-"));
  setHome(dir);
  resetOpenRouterEmbeddingsCache();
});
afterEach(() => {
  while (patched.length) patched.pop()!();
  resetModels();
  setGovernorLimits(undefined);
  setHome();
  resetOpenRouterEmbeddingsCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("generateEmbedding", () => {
  it("makes one vector per item, in order, priced from the table, with the wire audit redacted", async () => {
    const { calls, options } = fake("openai", async (_m, req) => reply(req));
    const r = await generateEmbedding({ model: "openai/text-embedding-3-small", input: ["n1", "n2"], apiKey: "k", timeoutMs: 5000 });
    expect(r).toBeInstanceOf(EmbeddingResult);
    expect(r.vectors).toEqual([
      [1, 0.5],
      [2, 0.5],
    ]);
    expect(r.vector).toEqual([1, 0.5]);
    expect(r.dimensions).toBe(2);
    expect(r.model).toBe("text-embedding-3-small");
    expect(r.provider).toBe("openai");
    expect(r.requests).toBe(1);
    expect(r.usage).toMatchObject({ inputTokens: 200, totalTokens: 200 });
    expect(r.usage.cost).toEqual({ inputCost: 0.000004, outputCost: 0, totalCost: 0.000004 }); // 200 tokens x $0.02 per 1M
    expect((r.raw.request.body as any).redacted).toBe(true); // the default capture policy keeps no text
    expect(calls[0]!.items).toEqual([[{ kind: "text", text: "n1" }], [{ kind: "text", text: "n2" }]]);
    expect(options[0]).toMatchObject({ apiKey: "k", timeoutMs: 5000 });
    expect(options[0].signal).toBeDefined();
  });

  it("takes one item as well as a list", async () => {
    fake("openai", async (_m, req) => reply(req));
    const r = await generateEmbedding({ model: "openai/text-embedding-3-small", input: "n3" });
    expect(r.vectors).toEqual([[3, 0.5]]);
  });

  it("splits a long list into the model's request size and keeps the order and the totals", async () => {
    const { calls } = fake("openai", async (_m, req) => reply(req));
    const r = await generateEmbedding({ model: "openai/text-embedding-3-small", input: texts(2050) });
    expect(calls.map((c) => c.items.length)).toEqual([2048, 2]); // OpenAI takes 2048 inputs per request
    expect(r.requests).toBe(2);
    expect(r.vectors.map((v) => v[0])).toEqual(Array.from({ length: 2050 }, (_, i) => i));
    expect(r.usage.inputTokens).toBe(205_000);
    expect(r.usage.cost!.totalCost).toBe(0.0041);
  });

  it("runs at most four requests at a time", async () => {
    let live = 0;
    let peak = 0;
    const { calls } = fake("google", async (_m, req) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return reply(req, { provider: "google" });
    });
    const r = await generateEmbedding({ model: "google/gemini-embedding-2", input: texts(1000) });
    expect(calls).toHaveLength(10); // a model with no stated maximum gets 100 per request
    expect(peak).toBe(4);
    expect(r.vectors.map((v) => v[0])).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  });

  it("waits for the concurrency limit when one is set", async () => {
    setGovernorLimits({ maxRequests: 1 });
    let live = 0;
    let peak = 0;
    fake("google", async (_m, req) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 3));
      live--;
      return reply(req, { provider: "google" });
    });
    await generateEmbedding({ model: "google/gemini-embedding-2", input: texts(300) });
    expect(peak).toBe(1);
  });

  it("a failing request stops the others, throws the first real error and carries the finished vectors", async () => {
    let n = 0;
    fake("google", async (_m, req) => {
      const mine = ++n;
      if (mine === 2) {
        await new Promise((r) => setTimeout(r, 15)); // after the first request has finished
        throw new ProviderError("boom", { provider: "google", retryable: false });
      }
      await new Promise((r) => setTimeout(r, mine === 1 ? 1 : 100));
      return reply(req, { provider: "google" });
    });
    const err = await generateEmbedding({ model: "google/gemini-embedding-2", input: texts(250) }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("boom");
    const done = err.partial.vectors as Array<number[] | undefined>;
    expect(done).toHaveLength(250);
    expect(done.slice(0, 100).every((v, i) => v?.[0] === i)).toBe(true); // the first request finished
    expect(done.slice(100).every((v) => v === undefined)).toBe(true); // the failed one and the one it stopped did not
  });

  it("passes dimensions, task and title on, and drops what the model has no control for with one warning", async () => {
    const { calls } = fake("openai", async (_m, req) => reply(req));
    const warnings: string[] = [];
    const off = telemetryBus.onEvent((e) => e.code === "provider_warning" && warnings.push(e.message));
    try {
      await generateEmbedding({ model: "openai/text-embedding-3-small", input: "n1", dimensions: 256, task: "search_query" });
      await generateEmbedding({ model: "openai/text-embedding-3-small", input: "n1", task: "search_query" });
    } finally {
      off();
    }
    expect(calls[0]).toMatchObject({ dimensions: 256 });
    expect(calls[0]!.task).toBeUndefined();
    expect(warnings.filter((w) => w.includes("no task control"))).toHaveLength(1); // the same warning is not repeated
    expect(warnings[0]).toContain("task");

    const g = fake("google", async (_m, req) => reply(req, { provider: "google" }));
    await generateEmbedding({ model: "google/gemini-embedding-001", input: "n1", task: "search_document", title: "T" });
    expect(g.calls[0]).toMatchObject({ task: "search_document", title: "T" });
  });

  it("makes a shortened vector of a model that does not normalize it length 1, and leaves other models alone", async () => {
    fake("google", async (_m, req) => reply(req, { provider: "google", vectors: req.items.map(() => [3, 4]) }));
    const short = await generateEmbedding({ model: "google/gemini-embedding-001", input: "n1", dimensions: 768 });
    expect(short.vector).toEqual([0.6, 0.8]);
    const full = await generateEmbedding({ model: "google/gemini-embedding-001", input: "n1" });
    expect(full.vector).toEqual([3, 4]); // the default length is normalized by the provider
    const two = await generateEmbedding({ model: "google/gemini-embedding-2", input: "n1", dimensions: 768 });
    expect(two.vector).toEqual([3, 4]); // embedding-2 normalizes by itself
  });

  it("warns when the model returns another length than asked", async () => {
    fake("openai", async (_m, req) => reply(req));
    const seen: string[] = [];
    const off = telemetryBus.onEvent((e) => e.code === "provider_warning" && seen.push(e.message));
    try {
      await generateEmbedding({ model: "openai/text-embedding-3-small", input: "n1", dimensions: 256 }); // the fake makes 2 numbers
    } finally {
      off();
    }
    expect(seen[0]).toContain("returned vectors of 2 numbers");
  });

  it("reads media, checks its type and stays inside fileAccess", async () => {
    const { calls } = fake("google", async (_m, req) => reply(req, { provider: "google" }));
    const png = "data:image/png;base64,iVBORw0KGgo=";
    await generateEmbedding({ model: "google/gemini-embedding-2", input: { parts: [{ type: "text", text: "cap" }, { type: "image", image: png }] } });
    expect(calls[0]!.items[0]).toEqual([
      { kind: "text", text: "cap" },
      { kind: "image", media: expect.objectContaining({ mimeType: "image/png", base64Data: "iVBORw0KGgo=" }) },
    ]);
    // a text file given as an image
    const txt = path.join(dir, "a.txt");
    fs.writeFileSync(txt, "not a picture");
    await expect(generateEmbedding({ model: "google/gemini-embedding-2", input: { type: "image", image: txt } })).rejects.toThrow(
      'An input given as image has the type "application/octet-stream"'
    );
    // a path outside the allowed folders
    const err = await generateEmbedding({
      model: "google/gemini-embedding-2",
      input: { type: "image", image: txt },
      fileAccess: { roots: [path.join(dir, "allowed")] },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SecurityPolicyError);
    // a model that cannot read images fails before the network
    await expect(generateEmbedding({ model: "openai/text-embedding-3-small", input: { type: "image", image: png } })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an unusable reply instead of passing it on", async () => {
    for (const bad of [
      (req: ProviderEmbeddingRequest) => ({ vectors: [] as number[][], usage: reply(req).usage }),
      (req: ProviderEmbeddingRequest) => ({ vectors: req.items.map(() => [1, Number.NaN]), usage: reply(req).usage }),
      (req: ProviderEmbeddingRequest) => ({ vectors: req.items.map(() => []), usage: reply(req).usage }),
      (req: ProviderEmbeddingRequest) => ({ vectors: req.items.map((_, i) => (i ? [1] : [1, 2])), usage: reply(req).usage }),
    ]) {
      fake("openai", async (_m, req) => ({ ...reply(req), ...bad(req) }));
      const err = await generateEmbedding({ model: "openai/text-embedding-3-small", input: ["n1", "n2"] }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toContain("unusable embedding reply");
      expect(err.retryable).toBe(false);
    }
  });

  it("takes the provider's reported cost over the table, and stops over budget", async () => {
    fake("openai", async (_m, req) => reply(req, { usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100, cost: { totalCost: 0.5 } } }));
    const r = await generateEmbedding({ model: "openai/text-embedding-3-small", input: "n1" });
    expect(r.usage.cost!.totalCost).toBe(0.5);
    const err = await generateEmbedding({ model: "openai/text-embedding-3-small", input: "n1", budget: { maxCostUsd: 0.1 } }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.message).toContain("above budget.maxCostUsd $0.1");
    await expect(generateEmbedding({ model: "openai/text-embedding-3-small", input: "n1", budget: { maxCostUsd: -1 } })).rejects.toBeInstanceOf(ValidationError);
  });

  it("leaves the cost unknown when it cannot be priced, never 0", async () => {
    fake("google", async (_m, req) => reply(req, { provider: "google" }));
    const r = await generateEmbedding({ model: "google/gemini-embedding-2", input: { type: "image", image: "data:image/png;base64,iVBORw0KGgo=" } });
    expect(r.usage.cost).toBeUndefined(); // an image with no per-kind token split
  });

  it("refuses an unknown model, one outside the setModels list, and a provider that cannot embed yet", async () => {
    await expect(generateEmbedding({ model: "openai/gpt-5", input: "x" })).rejects.toBeInstanceOf(ConfigError);
    await expect(generateEmbedding({ model: undefined as never, input: "x" })).rejects.toBeInstanceOf(ConfigError);
    fake("openai", undefined);
    await expect(generateEmbedding({ model: "openai/text-embedding-3-small", input: "x" })).rejects.toThrow("cannot make embeddings yet");
    fake("openai", async (_m, req) => reply(req));
    setModels({
      default: { model: "openai/text-embedding-3-large", sub_agent_model: "openai/text-embedding-3-large" },
      providers: { openai: { models: ["text-embedding-3-large"] } },
    });
    await expect(generateEmbedding({ model: "openai/text-embedding-3-small", input: "x" })).rejects.toBeInstanceOf(ModelNotAllowedError);
    expect((await generateEmbedding({ model: "openai/text-embedding-3-large", input: "n1" })).vectors).toHaveLength(1);
  });

  it("stops on a signal, before or during a request, and on a timeout", async () => {
    fake("openai", () => new Promise(() => {}));
    const pre = new AbortController();
    pre.abort(new Error("nope"));
    await expect(generateEmbedding({ model: "openai/text-embedding-3-small", input: "n1", signal: pre.signal })).rejects.toMatchObject({ name: "AbortError", message: "nope" });
    const during = new AbortController();
    const running = generateEmbedding({ model: "openai/text-embedding-3-small", input: "n1", signal: during.signal });
    setTimeout(() => during.abort(), 5);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    const err = await generateEmbedding({ model: "openai/text-embedding-3-small", input: "n1", timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toContain("Embedding request timed out after 20ms");
  });

  it("reads the OpenRouter model list first (once), then embeds with a model from it", async () => {
    setConfigs({ values: { catalog_refresh: "on" }, editable: [...SETTING_KEYS] });
    const list = {
      data: [
        {
          id: "nvidia/free-one:free",
          context_length: 4096,
          architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
          pricing: { prompt: "0" },
        },
      ],
    };
    const urls: string[] = [];
    const fetchList = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(list), { status: 200 });
    }) as unknown as typeof fetch;
    const { calls } = fake("openrouter", async (_m, req) => reply(req, { provider: "openrouter" }));
    const r = await generateEmbedding({ model: "openrouter/nvidia/free-one:free", input: ["n1", "n2"], fetch: fetchList });
    await generateEmbedding({ model: "openrouter/nvidia/free-one:free", input: "n1", fetch: fetchList });
    expect(urls).toEqual(["https://openrouter.ai/api/v1/embeddings/models"]); // read once, then cached
    expect(r.model).toBe("nvidia/free-one:free");
    expect(r.usage.cost!.totalCost).toBe(0); // a free model: known price 0
    expect(calls[0]!.items).toHaveLength(2);
    await expect(generateEmbedding({ model: "openrouter/not/listed", input: "x", fetch: fetchList })).rejects.toBeInstanceOf(ConfigError);
  });
});
