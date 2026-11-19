import { describe, it, expect } from "bun:test";
import { generateEmbedding, EMBEDDING_TASKS, ConfigError, ProviderError, ValidationError } from "../src/index.ts";
import { googleEmbeddingText, mapEmbeddingTaskToGoogleTaskType } from "../src/providers.ts";

const G2 = "google/gemini-embedding-2";
const G1 = "google/gemini-embedding-001";
const KEY = "AIza-secret-0123456789";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

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
// A realistic reply: one vector per request, the usage block of embedding-2 (embedding-001 sends none).
const ok = (body: any, usage: unknown = { promptTokenCount: 4, promptTokenDetails: [{ modality: "TEXT", tokenCount: 4 }] }) =>
  new Response(
    JSON.stringify({
      embeddings: body.requests.map((_: unknown, i: number) => ({ values: [i + 0.5, 0.25] })),
      ...(usage ? { usageMetadata: usage } : {}),
    }),
    { status: 200 }
  );
const failure = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("Google embedding adapter: the request", () => {
  it("sends one batch request with one entry per item, only the options that were set, and the key in a header", async () => {
    const s = stub((_n, b) => ok(b));
    const r = await generateEmbedding({ model: G2, input: ["cats", "dogs"], apiKey: KEY, fetch: s.fn });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents");
    expect(s.calls[0]!.headers["x-goog-api-key"]).toBe(KEY);
    expect(JSON.stringify(s.calls[0]!.body)).not.toContain(KEY);
    expect(s.calls[0]!.body).toEqual({
      requests: [
        { model: "models/gemini-embedding-2", content: { parts: [{ text: "cats" }] } },
        { model: "models/gemini-embedding-2", content: { parts: [{ text: "dogs" }] } },
      ],
    });
    expect(r.vectors).toEqual([
      [0.5, 0.25],
      [1.5, 0.25],
    ]);
    expect(r.requests).toBe(1);
    expect(r.raw.request.headers["x-goog-api-key"]).toBe("[REDACTED]"); // the audit never holds the key
  });

  it("sends dimensions as outputDimensionality", async () => {
    const s = stub((_n, b) => ok(b));
    await generateEmbedding({ model: G2, input: "cats", dimensions: 768, apiKey: KEY, fetch: s.fn });
    expect(s.calls[0]!.body.requests[0].outputDimensionality).toBe(768);
  });

  it("gemini-embedding-001 takes the task as taskType, and a title with a document", async () => {
    const s = stub((_n, b) => ok(b, null));
    await generateEmbedding({ model: G1, input: "cats", task: "search_document", title: "Pets", apiKey: KEY, fetch: s.fn });
    await generateEmbedding({ model: G1, input: "which pet?", task: "search_query", apiKey: KEY, fetch: s.fn });
    expect(s.calls[0]!.body.requests[0]).toEqual({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: "cats" }] },
      taskType: "RETRIEVAL_DOCUMENT",
      title: "Pets",
    });
    expect(s.calls[1]!.body.requests[0].taskType).toBe("RETRIEVAL_QUERY");
    expect(s.calls[1]!.body.requests[0].text).toBeUndefined();
  });

  it("gemini-embedding-2 has no task field: the task is written in front of the text, as Google documents", async () => {
    const s = stub((_n, b) => ok(b));
    await generateEmbedding({ model: G2, input: "which pet?", task: "search_query", apiKey: KEY, fetch: s.fn });
    await generateEmbedding({ model: G2, input: "cats purr", task: "search_document", title: "Pets", apiKey: KEY, fetch: s.fn });
    await generateEmbedding({ model: G2, input: "cats purr", task: "search_document", apiKey: KEY, fetch: s.fn });
    await generateEmbedding({ model: G2, input: "great film", task: "classification", apiKey: KEY, fetch: s.fn });
    const sent = s.calls.map((c) => c.body.requests[0]);
    expect(sent.map((r) => r.content.parts[0].text)).toEqual([
      "task: search result | query: which pet?",
      "title: Pets | text: cats purr",
      "title: none | text: cats purr",
      "task: classification | query: great film",
    ]);
    expect(sent.every((r) => r.taskType === undefined && r.title === undefined)).toBe(true);
  });

  it("sends media inline, never prefixes a multimodal item, and combines { parts } into one entry", async () => {
    const s = stub((_n, b) => ok(b, { promptTokenCount: 261, promptTokenDetails: [{ modality: "IMAGE", tokenCount: 258 }, { modality: "TEXT", tokenCount: 3 }] }));
    const r = await generateEmbedding({
      model: G2,
      input: [{ parts: [{ type: "text", text: "a red square" }, { type: "image", image: PNG }] }, { type: "image", image: PNG }],
      task: "search_query",
      apiKey: KEY,
      fetch: s.fn,
    });
    const reqs = s.calls[0]!.body.requests;
    expect(reqs).toHaveLength(2); // two items, two vectors
    expect(reqs[0].content.parts).toEqual([
      { text: "a red square" }, // no task words: the docs advise against prefixing a multimodal input
      { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
    ]);
    expect(reqs[1].content.parts).toEqual([{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }]);
    expect(r.vectors).toHaveLength(2);
  });

  it("refuses a media type the model does not read before the network", async () => {
    const s = stub((_n, b) => ok(b));
    const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    const err = await generateEmbedding({ model: G2, input: { type: "image", image: gif }, apiKey: KEY, fetch: s.fn }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain('does not read image of type "image/gif" (supported: image/png, image/jpeg)');
    expect(s.calls).toHaveLength(0);
  });

  it("every task has a taskType and a prefix", () => {
    for (const t of EMBEDDING_TASKS) {
      expect(mapEmbeddingTaskToGoogleTaskType(t)).toMatch(/^[A-Z_]+$/);
      expect(googleEmbeddingText(t, "T", "x")).toContain("x");
    }
    expect(googleEmbeddingText(undefined, undefined, "plain")).toBe("plain");
  });
});

describe("Google embedding adapter: the reply", () => {
  it("maps the usage with its per-kind split, and prices it from the table", async () => {
    const s = stub((_n, b) => ok(b, { promptTokenCount: 261, promptTokenDetails: [{ modality: "IMAGE", tokenCount: 258 }, { modality: "TEXT", tokenCount: 3 }] }));
    const r = await generateEmbedding({ model: G2, input: { parts: [{ type: "text", text: "red" }, { type: "image", image: PNG }] }, apiKey: KEY, fetch: s.fn });
    expect(r.usage).toMatchObject({ inputTokens: 261, inputDetails: { textTokens: 3, imageTokens: 258 } });
    expect(r.usage.cost!.totalCost).toBe(0.000117); // 3 x $0.20 + 258 x $0.45 per 1M tokens, in micro-USD
  });

  it("leaves the cost unknown when the model reports no usage, or counts document tokens", async () => {
    const none = stub((_n, b) => ok(b, null));
    const a = await generateEmbedding({ model: G1, input: "cats", apiKey: KEY, fetch: none.fn });
    expect(a.usage.inputTokens).toBe(0);
    expect(a.usage.cost).toBeUndefined(); // embedding-001 sends no usage: unknown, never $0
    const pdf = stub((_n, b) => ok(b, { promptTokenCount: 300, promptTokenDetails: [{ modality: "DOCUMENT", tokenCount: 258 }, { modality: "TEXT", tokenCount: 42 }] }));
    const b = await generateEmbedding({ model: G2, input: { type: "file", file: "data:application/pdf;base64,JVBERi0=" }, apiKey: KEY, fetch: pdf.fn });
    expect(b.usage.inputDetails).toBeUndefined();
    expect(b.usage.cost).toBeUndefined(); // the table has no document rate
  });

  it("an unusable reply is a ProviderError (the core checks the count)", async () => {
    const s = stub(() => new Response(JSON.stringify({ embeddings: [] }), { status: 200 }));
    const err = await generateEmbedding({ model: G2, input: ["a", "b"], apiKey: KEY, fetch: s.fn }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("0 vectors for 2 inputs");
    const html = stub(() => new Response("<html>oops</html>", { status: 200 }));
    const bad = await generateEmbedding({ model: G2, input: "a", apiKey: KEY, fetch: html.fn, retry: { maxRetries: 0 } }).catch((e) => e);
    expect(bad).toBeInstanceOf(ProviderError);
    expect(bad.message).toContain("request failed (200): <html>oops</html>"); // the shared mapper shows a short body
  });
});

describe("Google embedding adapter: errors", () => {
  it("a missing key fails before the network", async () => {
    const s = stub((_n, b) => ok(b));
    const saved = { ...process.env };
    for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"]) delete process.env[k];
    try {
      await expect(generateEmbedding({ model: G2, input: "a", fetch: s.fn })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      Object.assign(process.env, saved);
    }
    expect(s.calls).toHaveLength(0);
  });

  it("a 401 says what to check, with the key never in the message", async () => {
    const s = stub(() => failure(401, { error: { code: 401, message: "API key not valid.", status: "UNAUTHENTICATED" } }));
    const err = await generateEmbedding({ model: G2, input: "a", apiKey: KEY, fetch: s.fn }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("API key not valid.");
    expect(err.message).toContain("Check GEMINI_API_KEY");
    expect(err.message).not.toContain(KEY);
    expect(err.retryable).toBe(false);
    expect(s.calls).toHaveLength(1); // not retried
  });

  it("a 400 over the batch size is reported as the API says it", async () => {
    const s = stub(() => failure(400, { error: { code: 400, message: "at most 100 requests can be in one batch", status: "INVALID_ARGUMENT" } }));
    const err = await generateEmbedding({ model: G2, input: "a", apiKey: KEY, fetch: s.fn }).catch((e) => e);
    expect(err.message).toContain("at most 100 requests");
  });

  it("retries a 429 with its Retry-After, then succeeds", async () => {
    const s = stub((n, b) => (n === 1 ? failure(429, { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } }, { "retry-after": "0" }) : ok(b)));
    const r = await generateEmbedding({ model: G2, input: "a", apiKey: KEY, fetch: s.fn, retry: { baseDelayMs: 1 } });
    expect(s.calls).toHaveLength(2);
    expect(r.vectors).toHaveLength(1);
  });

  it("a list longer than the batch limit becomes several requests of at most 100", async () => {
    const s = stub((_n, b) => ok(b));
    const r = await generateEmbedding({ model: G2, input: Array.from({ length: 250 }, (_, i) => `t${i}`), apiKey: KEY, fetch: s.fn });
    expect(s.calls.map((c) => c.body.requests.length).sort((a, b) => b - a)).toEqual([100, 100, 50]);
    expect(r.vectors).toHaveLength(250);
    expect(r.requests).toBe(3);
  });

  it("stops on an abort signal even when the request never answers", async () => {
    const slow = stub(() => new Promise<Response>(() => {}));
    const c = new AbortController();
    const running = generateEmbedding({ model: G2, input: "a", apiKey: KEY, fetch: slow.fn, signal: c.signal });
    setTimeout(() => c.abort(), 5);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });
});
