import { describe, it, expect } from "bun:test";
import { Agent, ProviderError } from "../src/index.ts";
import { readBytesCapped, readTextCapped, CHAT_REPLY_LIMIT, ERROR_BODY_LIMIT } from "../src/utils/body.ts";

// A response that streams `chunks` of `size` bytes and reports whether it was cancelled and how many chunks were pulled.
function streamed(chunks: number, size: number, headers: Record<string, string> = {}) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) return controller.close();
      state.pulled++;
      controller.enqueue(new Uint8Array(size).fill(65)); // "A"
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { res: new Response(body, { status: 200, headers }), state };
}

describe("reading a body with a byte cap", () => {
  it("returns the whole body when it is under the cap, in one chunk or many", async () => {
    expect(await readTextCapped(new Response("hello"), 100)).toBe("hello");
    const { res } = streamed(4, 10);
    expect(await readTextCapped(res, 100)).toBe("A".repeat(40));
    expect((await readBytesCapped(new Response(new Uint8Array([1, 2, 3])), 3)).length).toBe(3); // exactly the cap is fine
  });

  it("decodes UTF-8 across chunk boundaries and strips a BOM, like res.text()", async () => {
    const bytes = new TextEncoder().encode("﻿héllo ✓");
    const split = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 5)); // cuts the two-byte "é" or the BOM apart on purpose
        c.enqueue(bytes.slice(5));
        c.close();
      },
    });
    expect(await readTextCapped(new Response(split), 100)).toBe("héllo ✓");
  });

  it("stops reading and cancels the connection the moment the cap is passed", async () => {
    const { res, state } = streamed(1000, 100); // 100 KB offered, cap 250 bytes
    const err = await readBytesCapped(res, 250).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect((err as ProviderError).status).toBe(200);
    expect((err as Error).message).toContain("larger than");
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(10); // it did not read the rest
  });

  it("refuses an honest oversized content-length before reading a byte", async () => {
    const { res, state } = streamed(5, 10, { "content-length": String(10 * 1024 * 1024) });
    const err = await readTextCapped(res, 1024).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(state.pulled).toBe(0);
    expect(state.cancelled).toBe(true);
  });

  it("a response with no stream still works", async () => {
    expect(await readTextCapped(new Response(null, { status: 204 }), 10)).toBe("");
  });

  it("the caps are sensible: chat replies 64 MB, error bodies 1 MB", () => {
    expect(CHAT_REPLY_LIMIT).toBe(64 * 1024 * 1024);
    expect(ERROR_BODY_LIMIT).toBe(1024 * 1024);
  });
});

describe("an adapter refuses a reply that is far too large", () => {
  it("a chat reply that declares 70 MB fails as a non-retryable ProviderError, and is not retried", async () => {
    let calls = 0;
    const fn = (async () => {
      calls++;
      return new Response("{}", { status: 200, headers: { "content-length": String(70 * 1024 * 1024) } });
    }) as unknown as typeof fetch;
    const agent = new Agent({
      model: "groq/test-model",
      apiKey: "k",
      baseUrl: "https://x.test/v1",
      fetch: fn,
      runRetries: 0,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });
    const err = (await agent.run("hi").catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("larger than 64 MB");
    expect(err.retryable).toBe(false);
    expect(calls).toBe(1);
  });

  it("a normal reply is untouched", async () => {
    const fn = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const agent = new Agent({ model: "groq/test-model", apiKey: "k", baseUrl: "https://x.test/v1", fetch: fn });
    expect((await agent.run("hi")).text).toBe("hi");
  });
});
