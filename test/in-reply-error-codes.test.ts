import { describe, it, expect, afterEach } from "bun:test";
import { Agent } from "../src/index.ts";
import { RUN_RETRY_DELAYS_MS } from "../src/agent/agent.ts";
import { errorCodeStatus } from "../src/providers/shared.ts";
import { GoogleInteractionsProvider, clearInteractionChains } from "../src/providers/google.ts";
import { OpenAICompatibleChatProvider } from "../src/providers/openai-compat.ts";
import { OpenAIResponsesProvider } from "../src/providers/openai.ts";
import { isRetryableRun } from "../src/utils/retry.ts";

// An error a provider reports inside a reply or a stream (the HTTP status is 200) is retried when its code names a temporary failure.
const realDelays = [...RUN_RETRY_DELAYS_MS];
afterEach(() => {
  RUN_RETRY_DELAYS_MS.splice(0, RUN_RETRY_DELAYS_MS.length, ...realDelays);
  clearInteractionChains();
});
const fastRunRetries = () => RUN_RETRY_DELAYS_MS.splice(0, RUN_RETRY_DELAYS_MS.length, 1, 1, 1, 1);

const ctx = { messages: [{ role: "user" as const, content: "x" }] };
const jsonOf = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const sseOf = (text: string) => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
const frames = (chunks: unknown[]) => `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
// A fetch that answers call n with `replies[n]()` (the last one repeats), and counts the calls.
const answers = (...replies: Array<() => Response>) => {
  const seen = { calls: 0 };
  const fn = (async () => replies[Math.min(seen.calls++, replies.length - 1)]!()) as unknown as typeof fetch;
  return { fn, seen };
};
const settle = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error & Record<string, unknown>);

const CHAT_TEXT = () => jsonOf({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] });
const CHAT_TEXT_SSE = () => sseOf(frames([{ id: "g", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }]));
const GOOGLE_TEXT = () =>
  jsonOf({ id: "i", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "hi" }] }] });
const googleError = (code: unknown) =>
  sseOf(`event: error\ndata: ${JSON.stringify({ error: { message: "upstream", code }, event_type: "error" })}\n\n`);

describe("errorCodeStatus", () => {
  it("reads a status number, also as text, and only from 100 to 599", () => {
    expect([429, 503, 400, "429", " 502 "].map(errorCodeStatus)).toEqual([429, 503, 400, 429, 502]);
    expect([99, 600, 429.5, "4290", Number.NaN].map(errorCodeStatus)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it("maps the names of temporary failures, in any case and with - or spaces", () => {
    expect(
      ["RESOURCE_EXHAUSTED", "rate_limit_exceeded", "rate-limit-exceeded", "Too Many Requests"].map(errorCodeStatus)
    ).toEqual([429, 429, 429, 429]);
    expect(["UNAVAILABLE", "overloaded", "overloaded_error", "service unavailable"].map(errorCodeStatus)).toEqual([
      503, 503, 503, 503,
    ]);
    expect(["INTERNAL", "internal_error", "server_error", "bad_gateway"].map(errorCodeStatus)).toEqual([500, 500, 500, 502]);
    expect(["gateway_timeout", "DEADLINE_EXCEEDED", "timeout"].map(errorCodeStatus)).toEqual([504, 504, 504]);
  });

  it("leaves every other code without a status, so the error stays final", () => {
    for (const code of ["invalid_argument", "INVALID_ARGUMENT", "content_policy", "invalid_api_key", "weird", "", undefined, null, {}]) {
      expect(errorCodeStatus(code)).toBeUndefined();
    }
  });
});

describe("an error inside a reply or a stream", () => {
  it("google stream: an error event with a temporary code is retryable, with Google's own names", async () => {
    for (const [code, status] of [
      ["gateway_timeout", 504],
      ["RESOURCE_EXHAUSTED", 429],
      ["UNAVAILABLE", 503],
    ] as const) {
      const err = await settle(
        new GoogleInteractionsProvider()
          .stream("m", ctx, { apiKey: "k", fetch: answers(() => googleError(code)).fn } as never)
          .result()
      );
      expect([code, err?.["statusCode"], err?.["retryable"]]).toEqual([code, status, true]);
    }
    const final = await settle(
      new GoogleInteractionsProvider()
        .stream("m", ctx, { apiKey: "k", fetch: answers(() => googleError("INVALID_ARGUMENT")).fn } as never)
        .result()
    );
    expect([final?.["statusCode"], final?.["retryable"]]).toEqual([undefined, false]);
  });

  it("google: an interaction that failed for a temporary reason is retried by runRetries", async () => {
    fastRunRetries();
    const failed = () => jsonOf({ id: "i0", status: "failed", error: { code: "UNAVAILABLE", message: "try later" } });
    const { fn, seen } = answers(failed, GOOGLE_TEXT);
    const res = await new Agent({ model: "google/gemini-3.5-flash-lite", apiKey: "k", fetch: fn, runRetries: 1 }).run("x");
    expect([res.text, seen.calls]).toEqual(["hi", 2]);
  });

  it("openai-compat: an error sent with HTTP 200 is retried when its code is temporary, and stays final otherwise", async () => {
    const provider = () => new OpenAICompatibleChatProvider("acme", { baseUrl: "https://x.test/v1" });
    const overloaded = answers(() => jsonOf({ error: { message: "busy", code: "overloaded" } }), CHAT_TEXT);
    const res = await provider().generate("m", ctx, { apiKey: "k", fetch: overloaded.fn, maxRetries: 1, retryBaseDelayMs: 1 } as never);
    expect([res.text, overloaded.seen.calls]).toEqual(["hi", 2]);
    const numeric = await settle(
      provider().generate("m", ctx, { apiKey: "k", fetch: answers(() => jsonOf({ error: { code: 429 } })).fn, maxRetries: 0 } as never)
    );
    expect([numeric?.["statusCode"], numeric?.["retryable"]]).toEqual([429, true]);
    const final = await settle(
      provider().generate("m", ctx, {
        apiKey: "k",
        fetch: answers(() => jsonOf({ error: { message: "no", code: "invalid_api_key" } })).fn,
        maxRetries: 2,
      } as never)
    );
    expect(final?.["retryable"]).toBe(false);
  });

  it("openai-compat stream: an error frame with a temporary code is retryable", async () => {
    const err = await settle(
      new OpenAICompatibleChatProvider("acme", { baseUrl: "https://x.test/v1" })
        .stream("m", ctx, { apiKey: "k", fetch: answers(() => sseOf(frames([{ error: { message: "slow down", code: "rate_limit_exceeded" } }]))).fn } as never)
        .result()
    );
    expect([err?.["statusCode"], err?.["retryable"]]).toEqual([429, true]);
  });

  it("openrouter: an error chunk with a named code and no error_type is retryable through the name", async () => {
    const err = await settle(
      new Agent({
        model: "openrouter/openai/gpt-5.5",
        apiKey: "k",
        fetch: answers(() => sseOf(frames([{ error: { message: "busy", code: "overloaded" } }]))).fn,
        runRetries: 0,
        retry: { maxRetries: 0 },
      }).run("x")
    );
    expect([err?.["statusCode"], err?.["retryable"]]).toEqual([503, true]);
  });

  it("finish_reason \"error\" is a retryable upstream failure, in a stream and in a whole reply", async () => {
    const cut = () => frames([{ id: "g", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: "error" }] }]);
    for (const model of ["openrouter/openai/gpt-5.5", "groq/m"]) {
      fastRunRetries();
      const { fn } = answers(() => sseOf(cut()), CHAT_TEXT_SSE);
      const agent = new Agent({ model, apiKey: "k", baseUrl: model.startsWith("groq") ? "https://x.test/v1" : undefined, fetch: fn, runRetries: 0 } as never);
      const err = await settle(agent.stream("x").result());
      expect([model, err?.["statusCode"], err?.["retryable"]]).toEqual([model, 502, true]);
      expect(String(err?.message)).toContain('finish_reason "error"');
      // run(): OpenRouter streams, openai-compat reads a whole reply; both are tried again.
      const again = answers(
        () => (model.startsWith("groq") ? jsonOf({ choices: [{ message: { content: "Hel" }, finish_reason: "error" }] }) : sseOf(cut())),
        model.startsWith("groq") ? CHAT_TEXT : CHAT_TEXT_SSE
      );
      const res = await new Agent({
        model,
        apiKey: "k",
        baseUrl: model.startsWith("groq") ? "https://x.test/v1" : undefined,
        fetch: again.fn,
        runRetries: 1,
        retry: { maxRetries: 0 },
      } as never).run("x");
      expect([model, res.text, again.seen.calls]).toEqual([model, "hi", 2]);
    }
  });

  it("openai: a failed reply with a numeric or named temporary code is retryable; its own two codes keep their status", async () => {
    const failedWith = (code: unknown) =>
      settle(
        new OpenAIResponsesProvider().generate("m", ctx, {
          apiKey: "k",
          fetch: answers(() => jsonOf({ id: "r", status: "failed", error: { message: "x", code }, output: [] })).fn,
          maxRetries: 0,
        } as never)
      );
    for (const [code, status] of [
      [503, 503],
      ["server_error", 500],
      ["rate_limit_exceeded", 429],
    ] as const) {
      const err = await failedWith(code);
      expect([code, err?.["statusCode"], isRetryableRun(err)]).toEqual([code, status, true]);
    }
    expect((await failedWith("invalid_prompt"))?.["retryable"]).toBe(false);
  });
});
