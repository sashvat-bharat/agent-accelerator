import { describe, it, expect, afterEach } from "bun:test";
import { generateImage, setConfigs, ConfigError, ProviderError } from "../src/index.ts";
import { resetConfigs } from "../src/config/settings.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const SUN = "openrouter/openai/gpt-image-2.6-sunburst";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}
function stub(handler: (n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return handler(calls.length);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const ok = (n = 1, usage: Record<string, unknown> | null = { prompt_tokens: 12, completion_tokens: 1756, total_tokens: 1768, cost: 0.0527 }) =>
  new Response(
    JSON.stringify({ created: 1, data: Array.from({ length: n }, () => ({ b64_json: b64(PNG), media_type: "image/png" })), ...(usage ? { usage } : {}) }),
    { status: 200 }
  );
const err = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

afterEach(() => resetConfigs());

describe("OpenRouter image adapter", () => {
  it("text to image: POST /images with the OpenAI model id and only the options that were set", async () => {
    const s = stub(() => ok(2));
    const r = await generateImage({ model: SUN, prompt: "A fox", aspectRatio: "16:9", quality: "high", format: "webp", background: "transparent", n: 2, apiKey: "sk-or-secret-0123456789", fetch: s.fn });
    expect(s.calls[0]!.url).toBe("https://openrouter.ai/api/v1/images");
    expect(s.calls[0]!.headers["Authorization"]).toBe("Bearer sk-or-secret-0123456789");
    expect(s.calls[0]!.body).toEqual({
      model: "openai/gpt-image-2.6-sunburst",
      prompt: "A fox",
      n: 2,
      aspect_ratio: "16:9",
      quality: "high",
      output_format: "webp",
      background: "transparent",
    });
    expect(r.images).toHaveLength(2);
    expect(new Uint8Array(r.image.bytes)).toEqual(PNG);
    expect(r.provider).toBe("openrouter");
    expect(r.model).toBe("openai/gpt-image-2.6-sunburst");
    expect(r.requests).toBe(1); // OpenRouter takes up to 10 in one request
    expect(s.calls[0]!.body.size).toBeUndefined();
  });

  it("edits: reference images go in `input_references` as image_url data URLs", async () => {
    const s = stub(() => ok());
    const png = `data:image/png;base64,${b64(PNG)}`;
    await generateImage({ model: SUN, prompt: "Add a hat", images: [png, PNG], apiKey: "k", fetch: s.fn });
    expect(s.calls[0]!.body.input_references).toEqual([
      { type: "image_url", image_url: { url: png } },
      { type: "image_url", image_url: { url: png } },
    ]);
  });

  it("takes OpenRouter's reported USD cost as the price, and keeps the tokens", async () => {
    const s = stub(() => ok());
    const r = await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: s.fn });
    expect(r.usage).toMatchObject({ inputTokens: 12, outputTokens: 1756, totalTokens: 1768 });
    expect(r.usage.cost).toEqual({ totalCost: 0.0527 });
  });

  it("without a reported cost it prices the tokens from the table; without any usage the cost is unknown", async () => {
    const noCost = stub(() => ok(1, { prompt_tokens: 12, completion_tokens: 1756, total_tokens: 1768 }));
    const a = await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: noCost.fn });
    expect(a.usage.cost?.totalCost).toBeCloseTo((12 * 5 + 1756 * 30) / 1_000_000, 8);
    const none = stub(() => ok(1, null));
    const b = await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: none.fn });
    expect(b.usage.cost).toBeUndefined();
    const free = stub(() => ok(1, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 }));
    expect((await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: free.fn })).usage.cost).toEqual({ totalCost: 0 }); // an explicit 0 is a known cost
  });

  it("adds the developer's provider routing and user from the openrouter setting", async () => {
    setConfigs({ values: { openrouter: { only: ["openai"], allow_fallbacks: false, zdr: true, user: "team-7" } } });
    const s = stub(() => ok());
    await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: s.fn });
    expect(s.calls[0]!.body.provider).toEqual({ only: ["openai"], allow_fallbacks: false, zdr: true });
    expect(s.calls[0]!.body.user).toBe("team-7");
    expect(s.calls[0]!.body.parallel_tool_calls).toBeUndefined(); // chat-only options never reach an image request
  });

  it("drops a size tier and an exact size with a warning and still sends the ratio", async () => {
    const s = stub(() => ok());
    const warn = console.warn;
    console.warn = () => {};
    try {
      // a ratio and a size together is fine here: the size is dropped (the model has no exact sizes) before it can conflict
      await generateImage({ model: SUN, prompt: "x", aspectRatio: "1:1", resolution: "2K", size: "1024x1024", apiKey: "k", fetch: s.fn });
    } finally {
      console.warn = warn;
    }
    expect(s.calls[0]!.body.aspect_ratio).toBe("1:1");
    expect(s.calls[0]!.body.size).toBeUndefined();
    expect(s.calls[0]!.body.resolution).toBeUndefined();
  });

  it("retries a 502 (a failed generation, not billed) and a 429 with Retry-After, then succeeds", async () => {
    const s = stub((n) => (n === 1 ? err(502, { error: { message: "Generation failed" } }) : n === 2 ? err(429, { error: { message: "slow down" } }, { "retry-after-ms": "5" }) : ok()));
    const r = await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: s.fn, retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 20 } });
    expect(s.calls).toHaveLength(3);
    expect(r.images).toHaveLength(1);
  });

  it("a 402 says the account lacks credit and is not retried; a 401 names the key", async () => {
    const credit = stub(() => err(402, { error: { message: "Insufficient credits", code: 402 } }));
    const e = await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: credit.fn, retry: { maxRetries: 3, baseDelayMs: 1 } }).catch((x) => x);
    expect(credit.calls).toHaveLength(1);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toMatch(/Insufficient credits.*too little credit/);
    const auth = stub(() => err(401, { error: { message: "No auth credentials found" } }));
    const e2 = await generateImage({ model: SUN, prompt: "x", apiKey: "sk-or-secret-0123456789", fetch: auth.fn }).catch((x) => x);
    expect(e2.message).toMatch(/Check OPENROUTER_API_KEY/);
    expect(JSON.stringify(e2)).not.toContain("sk-or-secret");
  });

  it("a reply with no picture is a ProviderError; the key never shows in the audit", async () => {
    const empty = stub(() => ok(0));
    const e = await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: empty.fn }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    const good = stub(() => ok());
    const r = await generateImage({ model: SUN, prompt: "x", apiKey: "sk-or-secret-0123456789", fetch: good.fn, captureRaw: true });
    expect(JSON.stringify(r.raw)).not.toContain("sk-or-secret");
    expect(r.raw.request.headers["Authorization"]).toBe("[REDACTED]");
  });

  it("without a key it is a ConfigError before any request", async () => {
    const s = stub(() => ok());
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await expect(generateImage({ model: SUN, prompt: "x", fetch: s.fn })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
    expect(s.calls).toHaveLength(0);
  });
});
