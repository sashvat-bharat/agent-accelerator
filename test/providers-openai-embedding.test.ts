import { describe, it, expect } from "bun:test";
import { generateEmbedding, ConfigError, ProviderError, ValidationError } from "../src/index.ts";

const SMALL = "openai/text-embedding-3-small";
const LARGE = "openai/text-embedding-3-large";
const ADA = "openai/text-embedding-ada-002";
const KEY = "sk-secret-0123456789abcdef";

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
// A realistic reply: vectors listed by `index` (deliberately out of order), usage as OpenAI reports it.
const ok = (body: any, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(
    JSON.stringify({
      object: "list",
      data: body.input.map((_: unknown, i: number) => ({ object: "embedding", index: i, embedding: [i + 0.5, 0.25] })).reverse(),
      model: body.model,
      usage: { prompt_tokens: body.input.length * 5, total_tokens: body.input.length * 5 },
      ...over,
    }),
    { status: 200, headers }
  );
const failure = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe("OpenAI embedding adapter: the request", () => {
  it("sends one /embeddings request with the strings, only the options that were set, and the key as a Bearer header", async () => {
    const s = stub((_n, b) => ok(b));
    const r = await generateEmbedding({ model: SMALL, input: ["cats", "dogs"], apiKey: KEY, fetch: s.fn });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(s.calls[0]!.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(s.calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(s.calls[0]!.body).toEqual({ model: "text-embedding-3-small", input: ["cats", "dogs"] });
    expect(JSON.stringify(s.calls[0]!.body)).not.toContain(KEY);
    expect(r.requests).toBe(1);
    expect(r.raw.request.headers["Authorization"]).toBe("[REDACTED]");
  });

  it("puts the vectors back in the order of the input by their index", async () => {
    const s = stub((_n, b) => ok(b));
    const r = await generateEmbedding({ model: SMALL, input: ["a", "b", "c"], apiKey: KEY, fetch: s.fn });
    expect(r.vectors.map((v) => v[0])).toEqual([0.5, 1.5, 2.5]);
  });

  it("sends dimensions on the 3 models, and nothing on ada-002 (its own length)", async () => {
    const s = stub((_n, b) => ok(b));
    await generateEmbedding({ model: LARGE, input: "cats", dimensions: 1024, apiKey: KEY, fetch: s.fn });
    await generateEmbedding({ model: ADA, input: "cats", dimensions: 1536, apiKey: KEY, fetch: s.fn });
    expect(s.calls[0]!.body.dimensions).toBe(1024);
    expect(s.calls[1]!.body).toEqual({ model: "text-embedding-ada-002", input: ["cats"] });
    await expect(generateEmbedding({ model: ADA, input: "cats", dimensions: 512, apiKey: KEY, fetch: s.fn })).rejects.toBeInstanceOf(ValidationError);
    expect(s.calls).toHaveLength(2); // refused before the network
  });

  it("drops a task with one warning (OpenAI has no task control) and still embeds", async () => {
    const s = stub((_n, b) => ok(b));
    await generateEmbedding({ model: SMALL, input: "cats", task: "search_query", apiKey: KEY, fetch: s.fn });
    expect(s.calls[0]!.body).toEqual({ model: "text-embedding-3-small", input: ["cats"] });
  });

  it("uses the base_urls.openai setting or the baseUrl option for the endpoint", async () => {
    const s = stub((_n, b) => ok(b));
    await generateEmbedding({ model: SMALL, input: "a", apiKey: KEY, baseUrl: "https://proxy.example/v1/", fetch: s.fn });
    expect(s.calls[0]!.url).toBe("https://proxy.example/v1/embeddings");
  });

  it("splits a list over 2048 into requests of at most 2048", async () => {
    const s = stub((_n, b) => ok(b));
    const r = await generateEmbedding({ model: SMALL, input: Array.from({ length: 2050 }, (_, i) => `t${i}`), apiKey: KEY, fetch: s.fn });
    expect(s.calls.map((c) => c.body.input.length).sort((a, b) => b - a)).toEqual([2048, 2]);
    expect(r.vectors).toHaveLength(2050);
    expect(r.usage.inputTokens).toBe(2050 * 5);
  });
});

describe("OpenAI embedding adapter: the reply", () => {
  it("maps the usage and prices it from the table", async () => {
    const s = stub((_n, b) => ok(b, { usage: { prompt_tokens: 1000, total_tokens: 1000 } }, { "x-request-id": "req_123" }));
    const r = await generateEmbedding({ model: LARGE, input: "cats", apiKey: KEY, fetch: s.fn });
    expect(r.usage).toMatchObject({ inputTokens: 1000, outputTokens: 0, totalTokens: 1000 });
    expect(r.usage.cost).toEqual({ inputCost: 0.00013, outputCost: 0, totalCost: 0.00013 }); // 1000 tokens x $0.13 per 1M
  });

  it("a reply with no usage leaves the cost unknown, never 0", async () => {
    const s = stub((_n, b) => ok(b, { usage: undefined }));
    const r = await generateEmbedding({ model: SMALL, input: "cats", apiKey: KEY, fetch: s.fn });
    expect(r.usage.cost).toBeUndefined();
  });

  it("refuses base64 vectors and a wrong count instead of passing them on", async () => {
    const b64 = stub((_n, b) => ok(b, { data: [{ index: 0, embedding: "AAAA" }] }));
    const a = await generateEmbedding({ model: SMALL, input: "a", apiKey: KEY, fetch: b64.fn }).catch((e) => e);
    expect(a).toBeInstanceOf(ProviderError);
    expect(a.message).toContain("unusable embedding reply");
    const few = stub((_n, b) => ok(b, { data: [{ index: 0, embedding: [1] }] }));
    const c = await generateEmbedding({ model: SMALL, input: ["a", "b"], apiKey: KEY, fetch: few.fn }).catch((e) => e);
    expect(c.message).toContain("1 vectors for 2 inputs");
  });

  it("an HTML or broken body is a ProviderError that shows a short slice", async () => {
    const s = stub(() => new Response("<html>bad gateway</html>", { status: 200 }));
    const err = await generateEmbedding({ model: SMALL, input: "a", apiKey: KEY, fetch: s.fn, retry: { maxRetries: 0 } }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("<html>bad gateway</html>");
  });
});

describe("OpenAI embedding adapter: errors", () => {
  it("a missing key fails before the network", async () => {
    const s = stub((_n, b) => ok(b));
    const saved = { ...process.env };
    for (const k of ["OPENAI_API_KEY", "OPENAI_BASE_API_KEY"]) delete process.env[k];
    try {
      await expect(generateEmbedding({ model: SMALL, input: "a", fetch: s.fn })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      Object.assign(process.env, saved);
    }
    expect(s.calls).toHaveLength(0);
  });

  it("a 401 says what to check, never repeats the key, and is not retried", async () => {
    const s = stub(() => failure(401, { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }));
    const err = await generateEmbedding({ model: SMALL, input: "a", apiKey: KEY, fetch: s.fn }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("Incorrect API key provided");
    expect(err.message).toContain("Check OPENAI_API_KEY");
    expect(err.message).not.toContain(KEY);
    expect(err.retryable).toBe(false);
    expect(s.calls).toHaveLength(1);
  });

  it("OpenAI's own message about too many tokens reaches the caller (the SDK has no tokenizer)", async () => {
    const s = stub(() => failure(400, { error: { message: "Requested 310000 tokens, max 300000 tokens per request", type: "invalid_request_error", code: null } }));
    const err = await generateEmbedding({ model: SMALL, input: "a", apiKey: KEY, fetch: s.fn }).catch((e) => e);
    expect(err.message).toContain("max 300000 tokens per request");
    expect(err.retryable).toBe(false);
  });

  it("retries a 429 with its Retry-After, then succeeds", async () => {
    const s = stub((n, b) => (n === 1 ? failure(429, { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } }, { "retry-after": "0" }) : ok(b)));
    const r = await generateEmbedding({ model: SMALL, input: "a", apiKey: KEY, fetch: s.fn, retry: { baseDelayMs: 1 } });
    expect(s.calls).toHaveLength(2);
    expect(r.vectors).toHaveLength(1);
  });

  it("stops on an abort signal even when the request never answers", async () => {
    const slow = stub(() => new Promise<Response>(() => {}));
    const c = new AbortController();
    const running = generateEmbedding({ model: SMALL, input: "a", apiKey: KEY, fetch: slow.fn, signal: c.signal });
    setTimeout(() => c.abort(), 5);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });
});
