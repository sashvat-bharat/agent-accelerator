import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateEmbedding, setHome, telemetryBus, ConfigError, ProviderError } from "../src/index.ts";
import { setConfigs, SETTING_KEYS } from "../src/config/settings.ts";
import { clearEmittedWarnings, mapEmbeddingTaskToOpenRouterInputType } from "../src/providers.ts";
import { refreshOpenRouterEmbeddingModels, resetOpenRouterEmbeddingsCache } from "../src/models/openrouter-embeddings.ts";

const FREE = "openrouter/nvidia/free-text:free";
const MM = "openrouter/google/gemini-embedding-2";
const KEY = "sk-or-v1-secret-0123456789abcdef";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

// What OpenRouter's public list says about three models: a free text model, a multimodal one with prices, a text and image one.
const list = {
  data: [
    { id: "nvidia/free-text:free", context_length: 4096, architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] }, pricing: { prompt: "0" } },
    {
      id: "google/gemini-embedding-2",
      context_length: 8192,
      architecture: { input_modalities: ["text", "image", "file", "audio", "video"], output_modalities: ["embeddings"] },
      pricing: { prompt: "0.0000002", image: "0.00000045", audio: "0.0000065" },
    },
  ],
};

let home: string;
beforeEach(async () => {
  clearEmittedWarnings();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-or-emb-"));
  setHome(home);
  resetOpenRouterEmbeddingsCache();
  await refreshOpenRouterEmbeddingModels({ fetch: (async () => new Response(JSON.stringify(list), { status: 200 })) as unknown as typeof fetch });
});
afterEach(() => {
  setHome();
  resetOpenRouterEmbeddingsCache();
  fs.rmSync(home, { recursive: true, force: true });
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}
function stub(handler: (n: number, body: any) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    return handler(calls.length, body);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
// A realistic reply: vectors listed by `index` (deliberately out of order), usage with OpenRouter's USD cost.
const ok = (body: any, over: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      id: "embd-123",
      object: "list",
      data: body.input.map((_: unknown, i: number) => ({ object: "embedding", index: i, embedding: [i + 0.5, 0.25] })).reverse(),
      model: body.model,
      usage: { prompt_tokens: body.input.length * 5, total_tokens: body.input.length * 5, cost: 0.0001 },
      ...over,
    }),
    { status: 200 }
  );
const failure = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const opts = (fn: typeof fetch) => ({ apiKey: KEY, fetch: fn, retry: { baseDelayMs: 1 } });

describe("OpenRouter embedding adapter: the request", () => {
  it("sends plain strings to /embeddings with the Bearer key, and nothing that was not asked", async () => {
    const s = stub((_n, b) => ok(b));
    const r = await generateEmbedding({ model: FREE, input: ["cats", "dogs"], ...opts(s.fn) });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(s.calls[0]!.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(s.calls[0]!.body).toEqual({ model: "nvidia/free-text:free", input: ["cats", "dogs"] });
    expect(JSON.stringify(s.calls[0]!.body)).not.toContain(KEY);
    expect(r.model).toBe("nvidia/free-text:free");
    expect(r.provider).toBe("openrouter");
    expect(r.raw.request.headers["Authorization"]).toBe("[REDACTED]");
  });

  it("puts the vectors back in the order of the input by their index", async () => {
    const s = stub((_n, b) => ok(b));
    const r = await generateEmbedding({ model: FREE, input: ["a", "b", "c"], ...opts(s.fn) });
    expect(r.vectors.map((v) => v[0])).toEqual([0.5, 1.5, 2.5]);
  });

  it("sends dimensions and the task as input_type, exactly as asked", async () => {
    const s = stub((_n, b) => ok(b));
    await generateEmbedding({ model: FREE, input: "q", dimensions: 256, task: "search_query", ...opts(s.fn) });
    await generateEmbedding({ model: FREE, input: "d", task: "search_document", ...opts(s.fn) });
    await generateEmbedding({ model: FREE, input: "c", task: "clustering", ...opts(s.fn) });
    expect(s.calls[0]!.body).toMatchObject({ dimensions: 256, input_type: "search_query" });
    expect(s.calls[1]!.body.input_type).toBe("search_document");
    expect(s.calls[2]!.body.input_type).toBe("clustering");
  });

  it("maps the tasks OpenRouter has no value for to the nearest one or drops them, with one warning", async () => {
    const s = stub((_n, b) => ok(b));
    const seen: string[] = [];
    const off = telemetryBus.onEvent((e) => e.code === "provider_warning" && seen.push(e.message));
    try {
      await generateEmbedding({ model: FREE, input: "q", task: "question_answering", ...opts(s.fn) });
      await generateEmbedding({ model: FREE, input: "q", task: "similarity", ...opts(s.fn) });
    } finally {
      off();
    }
    expect(s.calls[0]!.body.input_type).toBe("search_query");
    expect(s.calls[1]!.body.input_type).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("question_answering is sent as the query side of search");
    expect(seen[1]).toContain("no similarity value");
    expect(mapEmbeddingTaskToOpenRouterInputType("search_query")).toEqual({ inputType: "search_query" });
  });

  it("sends images, audio, video and PDF as content parts, one content list per item", async () => {
    const s = stub((_n, b) => ok(b, { usage: { prompt_tokens: 10, total_tokens: 10 } }));
    const wav = "data:audio/wav;base64,UklGRg==";
    const mp4 = "data:video/mp4;base64,AAAAGGZ0eXA=";
    const pdf = "data:application/pdf;base64,JVBERi0=";
    await generateEmbedding({
      model: MM,
      input: [
        { parts: [{ type: "text", text: "a red square" }, { type: "image", image: PNG }] },
        { type: "audio", audio: wav },
        { type: "video", video: mp4 },
        { type: "file", file: pdf },
        "just text",
      ],
      ...opts(s.fn),
    });
    expect(s.calls[0]!.body.input).toEqual([
      { content: [{ type: "text", text: "a red square" }, { type: "image_url", image_url: { url: PNG } }] },
      { content: [{ type: "input_audio", input_audio: { data: wav, format: "wav" } }] },
      { content: [{ type: "input_video", input_video: { data: mp4, format: "mp4" } }] },
      { content: [{ type: "input_file", input_file: { data: pdf, format: "pdf" } }] },
      { content: [{ type: "text", text: "just text" }] }, // one list of items: every one in the same form
    ]);
  });

  it("adds the developer's provider routing and user from the openrouter setting", async () => {
    setConfigs({ values: { catalog_refresh: "off", openrouter: { order: ["nvidia"], allow_fallbacks: false, user: "team-7" } }, editable: [...SETTING_KEYS] });
    const s = stub((_n, b) => ok(b));
    await generateEmbedding({ model: FREE, input: "a", ...opts(s.fn) });
    expect(s.calls[0]!.body).toMatchObject({ provider: { order: ["nvidia"], allow_fallbacks: false }, user: "team-7" });
  });

  it("splits a list over 100 into requests of at most 100 (the table states no maximum)", async () => {
    const s = stub((_n, b) => ok(b));
    const r = await generateEmbedding({ model: FREE, input: Array.from({ length: 230 }, (_, i) => `t${i}`), ...opts(s.fn) });
    expect(s.calls.map((c) => c.body.input.length).sort((a, b) => b - a)).toEqual([100, 100, 30]);
    expect(r.vectors).toHaveLength(230);
  });
});

describe("OpenRouter embedding adapter: the reply", () => {
  it("takes OpenRouter's reported cost, and an explicit 0 for a free model counts", async () => {
    const s = stub((_n, b) => ok(b, { usage: { prompt_tokens: 8, total_tokens: 8, cost: 0 } }));
    const free = await generateEmbedding({ model: FREE, input: "a", ...opts(s.fn) });
    expect(free.usage.cost).toEqual({ totalCost: 0 });
    const paid = stub((_n, b) => ok(b, { usage: { prompt_tokens: 8, total_tokens: 8, cost: 0.00042 } }));
    const r = await generateEmbedding({ model: MM, input: "a", ...opts(paid.fn) });
    expect(r.usage.cost!.totalCost).toBe(0.00042);
    expect(r.usage.inputTokens).toBe(8);
    expect((r.raw.response as any).body.id).toBe("embd-123");
  });

  it("without a reported cost the table's price from the list is used (per kind when split)", async () => {
    const s = stub((_n, b) =>
      ok(b, { usage: { prompt_tokens: 261, total_tokens: 261, prompt_tokens_details: { text_tokens: 3, image_tokens: 258 } } })
    );
    const r = await generateEmbedding({ model: MM, input: { parts: [{ type: "text", text: "red" }, { type: "image", image: PNG }] }, ...opts(s.fn) });
    expect(r.usage.inputDetails).toEqual({ textTokens: 3, imageTokens: 258 });
    expect(r.usage.cost!.totalCost).toBe(0.000117); // 3 x $0.20 + 258 x $0.45 per 1M tokens
  });

  it("file tokens leave the split out, so the price stays unknown instead of wrong", async () => {
    const s = stub((_n, b) =>
      ok(b, { usage: { prompt_tokens: 300, total_tokens: 300, prompt_tokens_details: { text_tokens: 42, file_tokens: 258 } } })
    );
    const r = await generateEmbedding({ model: MM, input: { type: "file", file: "data:application/pdf;base64,JVBERi0=" }, ...opts(s.fn) });
    expect(r.usage.inputDetails).toBeUndefined();
    expect(r.usage.cost).toBeUndefined();
  });

  it("an unusable reply is a ProviderError (the core checks the count and the numbers)", async () => {
    const s = stub((_n, b) => ok(b, { data: [{ index: 0, embedding: "AAAA" }] }));
    const err = await generateEmbedding({ model: FREE, input: "a", ...opts(s.fn) }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("unusable embedding reply");
    const html = stub(() => new Response("<html>oops</html>", { status: 200 }));
    const bad = await generateEmbedding({ model: FREE, input: "a", apiKey: KEY, fetch: html.fn, retry: { maxRetries: 0 } }).catch((e) => e);
    expect(bad).toBeInstanceOf(ProviderError);
    expect(bad.message).toContain("<html>oops</html>");
  });
});

describe("OpenRouter embedding adapter: errors", () => {
  it("a missing key fails before the network", async () => {
    const s = stub((_n, b) => ok(b));
    const saved = process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENROUTER_API_KEY"];
    try {
      await expect(generateEmbedding({ model: FREE, input: "a", fetch: s.fn })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      if (saved !== undefined) process.env["OPENROUTER_API_KEY"] = saved;
    }
    expect(s.calls).toHaveLength(0);
  });

  it("a 401 says what to check and never repeats the key; a 402 names the embedding", async () => {
    const s401 = stub(() => failure(401, { error: { code: 401, message: "Missing Authentication header" } }));
    const a = await generateEmbedding({ model: FREE, input: "a", ...opts(s401.fn) }).catch((e) => e);
    expect(a).toBeInstanceOf(ProviderError);
    expect(a.message).toContain("Check OPENROUTER_API_KEY");
    expect(a.message).not.toContain(KEY);
    expect(s401.calls).toHaveLength(1); // not retried
    const s402 = stub(() => failure(402, { error: { code: 402, message: "Insufficient credits" } }));
    const b = await generateEmbedding({ model: MM, input: "a", ...opts(s402.fn) }).catch((e) => e);
    expect(b.message).toContain("too little credit for this embedding");
  });

  it("retries a 429 with its Retry-After and a provider 5xx, then succeeds", async () => {
    const s = stub((n, b) =>
      n === 1
        ? failure(429, { error: { code: 429, message: "Rate limit exceeded" } }, { "retry-after": "0" })
        : n === 2
          ? failure(502, { error: { code: 502, message: "Provider returned error" } })
          : ok(b)
    );
    const r = await generateEmbedding({ model: FREE, input: "a", ...opts(s.fn) });
    expect(s.calls).toHaveLength(3);
    expect(r.vectors).toHaveLength(1);
  });

  it("stops on an abort signal even when the request never answers", async () => {
    const slow = stub(() => new Promise<Response>(() => {}));
    const c = new AbortController();
    const running = generateEmbedding({ model: FREE, input: "a", ...opts(slow.fn), signal: c.signal });
    setTimeout(() => c.abort(), 5);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });
});
