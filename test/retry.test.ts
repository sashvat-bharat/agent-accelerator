import { describe, it, expect, afterEach } from "bun:test";
import { withRetries } from "../src/utils/retry.ts";
import { parseRetryAfterMs } from "../src/providers/shared.ts";
import { OpenAICompatibleChatProvider } from "../src/index.ts";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("parseRetryAfterMs", () => {
  it("reads retry-after-ms, delta-seconds and HTTP-dates (case-insensitive)", () => {
    expect(parseRetryAfterMs({ "Retry-After-Ms": "250" })).toBe(250);
    expect(parseRetryAfterMs({ "retry-after": "3" })).toBe(3000);
    expect(parseRetryAfterMs({ "retry-after": "Wed, 21 Oct 2026 07:28:30 GMT" }, Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(30_000);
    expect(parseRetryAfterMs({ "retry-after": "-1" })).toBeUndefined();
    expect(parseRetryAfterMs({ "retry-after": "soon" })).toBeUndefined();
    expect(parseRetryAfterMs({})).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });
});

describe("withRetries honors the server's Retry-After", () => {
  const rateLimited = (retryAfterMs?: number) =>
    Object.assign(new Error("rate limited"), { statusCode: 429, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

  it("waits at least retryAfterMs (beyond the normal backoff cap) before retrying", async () => {
    let calls = 0;
    const t0 = Date.now();
    const out = await withRetries(
      async () => {
        calls++;
        if (calls === 1) throw rateLimited(150);
        return "ok";
      },
      { maxRetries: 2, maxRetryDelayMs: 20 }
    );
    expect(out).toBe("ok");
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  it("fails immediately (no sleeping) when Retry-After would exceed the retry budget", async () => {
    let calls = 0;
    const t0 = Date.now();
    await expect(
      withRetries(
        async () => {
          calls++;
          throw rateLimited(10_000);
        },
        { maxRetries: 3, retryBudgetMs: 1_000 }
      )
    ).rejects.toThrow("rate limited");
    expect(calls).toBe(1);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("provider adapters surface Retry-After and retry streams before the first byte", () => {
  const provider = () => new OpenAICompatibleChatProvider("groq", { baseUrl: "https://api.groq.com/openai/v1" });
  const sse = (text: string) =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"id":"s","choices":[{"delta":{"content":"${text}"}}]}\n\n`));
          c.enqueue(new TextEncoder().encode(`data: {"id":"s","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );

  it("generate(): 429 + retry-after-ms is retried after the hinted delay", async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "retry-after-ms": "120" },
        });
      }
      return new Response(
        JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200 }
      );
    };
    const t0 = Date.now();
    const res = await provider().generate("m", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k", maxRetryDelayMs: 10 });
    expect(res.text).toBe("hi");
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it("generate(): exhausted retries expose retryAfterMs (non-enumerable) on the concise error", async () => {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers: { "retry-after": "45" } });
    const err: any = await provider()
      .generate("m", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k" })
      .then(() => null, (e) => e);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBe(45_000);
    expect(Object.keys(err)).not.toContain("retryAfterMs");
  });

  it("stream(): a 503 before the first byte is retried transparently", async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
      return sse("hello");
    };
    const s = provider().stream("m", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k", maxRetryDelayMs: 10 });
    const final = await s.result();
    expect(calls).toBe(2);
    expect(final.text).toBe("hello");
  });

  it("stream(): a non-transient 400 is not retried", async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
    };
    const s = provider().stream("m", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k" });
    await expect(s.result()).rejects.toThrow(/bad request/);
    expect(calls).toBe(1);
  });
});
