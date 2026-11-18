import { describe, it, expect } from "bun:test";
import { generateImage, ConfigError, ProviderError } from "../src/index.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const SUN = "openai/gpt-image-2.5-sunburst";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}
// A fetch stub that records each request and answers with `handler(callNumber)`.
function stub(handler: (n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return handler(calls.length);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const ok = (n = 1, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      created: 1,
      data: Array.from({ length: n }, () => ({ b64_json: b64(PNG) })),
      output_format: "png",
      usage: {
        input_tokens: 1000,
        output_tokens: 1756,
        total_tokens: 2756,
        input_tokens_details: { text_tokens: 200, image_tokens: 800 },
        output_tokens_details: { image_tokens: 1756, text_tokens: 0 },
      },
      ...extra,
    }),
    { status: 200, headers: { "x-request-id": "req_1" } }
  );
const err = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("OpenAI image adapter", () => {
  it("text to image: POST /images/generations with the checked options, base64 back as bytes", async () => {
    const s = stub(() => ok(2));
    const r = await generateImage({
      model: SUN,
      prompt: "A fox",
      aspectRatio: "16:9",
      resolution: "4K",
      quality: "high",
      format: "webp",
      background: "transparent",
      n: 2,
      apiKey: "sk-test-123456789",
      fetch: s.fn,
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    expect(s.calls[0]!.headers["Authorization"]).toBe("Bearer sk-test-123456789");
    expect(s.calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(s.calls[0]!.body).toEqual({
      model: "gpt-image-2.5-sunburst",
      prompt: "A fox",
      n: 2,
      size: "3840x2160",
      quality: "high",
      output_format: "webp",
      background: "transparent",
    });
    expect(r.images).toHaveLength(2);
    expect(r.images[0]!.mimeType).toBe("image/png"); // the real bytes decide, not the request
    expect(new Uint8Array(r.images[0]!.bytes)).toEqual(PNG);
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-image-2.5-sunburst");
    expect(r.requests).toBe(1);
    expect(r.finishReason).toBe("stop");
  });

  it("sends nothing the caller did not ask for (the model's own defaults apply)", async () => {
    const s = stub(() => ok());
    await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: s.fn });
    expect(s.calls[0]!.body).toEqual({ model: "gpt-image-2.5-sunburst", prompt: "x", n: 1 });
  });

  it("edits: reference images go to /images/edits as data URLs in `images`", async () => {
    const s = stub(() => ok());
    const png = `data:image/png;base64,${b64(PNG)}`;
    await generateImage({ model: SUN, prompt: "Add a hat", images: [png, PNG], apiKey: "k", fetch: s.fn, baseUrl: "https://proxy.example/v1/" });
    expect(s.calls[0]!.url).toBe("https://proxy.example/v1/images/edits");
    expect(s.calls[0]!.body.images).toEqual([{ image_url: png }, { image_url: png }]);
    expect(s.calls[0]!.body.prompt).toBe("Add a hat");
  });

  it("reads the usage split and prices the call from the table", async () => {
    const s = stub(() => ok());
    const r = await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: s.fn });
    expect(r.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 1756,
      totalTokens: 2756,
      inputDetails: { textTokens: 200, imageTokens: 800 },
      outputDetails: { imageTokens: 1756, textTokens: 0 },
    });
    // 200 text x $5 + 800 image x $8 + 1756 image out x $30 = $0.06008
    expect(r.usage.cost?.totalCost).toBeCloseTo(0.06008, 8);
    expect(r.raw.response?.headers["x-request-id"]).toBe("req_1");
  });

  it("a reply with no picture is a ProviderError from the core, not an empty success", async () => {
    const s = stub(() => ok(0));
    const e = await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: s.fn }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toMatch(/returned no image\./);
  });

  it("a moderation block is not retried and says what to do", async () => {
    const s = stub(() =>
      err(400, { error: { message: "Your request was rejected by the safety system.", code: "moderation_blocked", type: "image_generation_user_error", moderation_details: { moderation_stage: "input", categories: ["violence"] } } })
    );
    const e = await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: s.fn, retry: { maxRetries: 3, baseDelayMs: 1 } }).catch((x) => x);
    expect(s.calls).toHaveLength(1);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toMatch(/rejected by the safety system.*blocked by moderation at the input stage: violence.*change the prompt/);
    expect(e.retryable).toBe(false);
    expect(e.providerCode).toBe("moderation_blocked");
  });

  it("retries a 429 (honouring Retry-After) and a 500, then succeeds", async () => {
    const s = stub((n) => (n === 1 ? err(429, { error: { message: "slow down" } }, { "retry-after-ms": "5" }) : n === 2 ? err(500, { error: { message: "oops" } }) : ok()));
    const r = await generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: s.fn, retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 20 } });
    expect(s.calls).toHaveLength(3);
    expect(r.images).toHaveLength(1);
  });

  it("a 401 says which key to check; the key never appears in the audit headers", async () => {
    const s = stub(() => err(401, { error: { message: "Incorrect API key provided" } }));
    const e = await generateImage({ model: SUN, prompt: "x", apiKey: "sk-secret-0123456789", fetch: s.fn }).catch((x) => x);
    expect(e.message).toMatch(/Incorrect API key provided.*Check OPENAI_API_KEY/);
    expect(JSON.stringify(e)).not.toContain("sk-secret");
    const good = stub(() => ok());
    const r = await generateImage({ model: SUN, prompt: "x", apiKey: "sk-secret-0123456789", fetch: good.fn, captureRaw: true });
    expect(JSON.stringify(r.raw)).not.toContain("sk-secret");
    expect(r.raw.request.headers["Authorization"]).toBe("[REDACTED]");
  });

  it("without a key it is a ConfigError before any request", async () => {
    const s = stub(() => ok());
    const saved = { a: process.env.OPENAI_API_KEY, b: process.env.OPENAI_BASE_API_KEY };
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_API_KEY;
    try {
      await expect(generateImage({ model: SUN, prompt: "x", fetch: s.fn })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      if (saved.a !== undefined) process.env.OPENAI_API_KEY = saved.a;
      if (saved.b !== undefined) process.env.OPENAI_BASE_API_KEY = saved.b;
    }
    expect(s.calls).toHaveLength(0);
  });

  it("a hung request ends with a TimeoutError, and an abort with an AbortError", async () => {
    const hang = (async (_u: string, init: any) =>
      new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    await expect(generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: hang, timeoutMs: 30, retry: { maxRetries: 0 } })).rejects.toMatchObject({ name: "TimeoutError" });
    const ctrl = new AbortController();
    const running = generateImage({ model: SUN, prompt: "x", apiKey: "k", fetch: hang, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("the 2.6 models use the same endpoint and body", async () => {
    const s = stub(() => ok());
    await generateImage({ model: "openai/gpt-image-2.6-flare", prompt: "x", quality: "xhigh", apiKey: "k", fetch: s.fn });
    expect(s.calls[0]!.body).toMatchObject({ model: "gpt-image-2.6-flare", quality: "xhigh" });
  });
});
