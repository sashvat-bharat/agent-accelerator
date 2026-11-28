import { describe, it, expect } from "bun:test";
import { OpenAIResponsesProvider } from "../src/providers/openai.ts";
import { OpenAICompatibleChatProvider } from "../src/providers/openai-compat.ts";
import { OpenRouterChatCompletionsProvider } from "../src/providers/openrouter.ts";
import { AnthropicMessagesProvider } from "../src/providers/anthropic.ts";
import { GoogleInteractionsProvider, clearInteractionChains } from "../src/providers/google.ts";
import { openaiEmbed } from "../src/providers/openai-embedding.ts";
import type { Provider } from "../src/types/model.ts";

// A provider request that outlives its `timeoutMs` is a retryable TimeoutError, retried like a 5xx; the caller's own abort stays an AbortError.
const ctx = { messages: [{ role: "user" as const, content: "x" }] };
const sseOf = (frames: unknown[], tail = "") =>
  new Response(`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}${tail}`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const jsonOf = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const googleEvent = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ ...data, event_type: type })}\n\n`;

// Each chat adapter, with the honest reply "hi" of its `generate()` and of its `stream()`.
const ADAPTERS: Array<{ name: string; make: () => Provider; json: () => Response; sse: () => Response }> = [
  {
    name: "openai",
    make: () => new OpenAIResponsesProvider(),
    json: () =>
      jsonOf({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] }),
    sse: () =>
      sseOf([
        { type: "response.output_text.delta", delta: "hi" },
        { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
      ]),
  },
  {
    name: "openai-compat",
    make: () => new OpenAICompatibleChatProvider("acme", { baseUrl: "https://x.test/v1" }),
    json: () => jsonOf({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }),
    sse: () => sseOf([{ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }], "data: [DONE]\n\n"),
  },
  {
    name: "openrouter",
    make: () => new OpenRouterChatCompletionsProvider(),
    // generate() streams too
    json: () => sseOf([{ id: "g", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }], "data: [DONE]\n\n"),
    sse: () => sseOf([{ id: "g", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }], "data: [DONE]\n\n"),
  },
  {
    name: "anthropic",
    make: () => new AnthropicMessagesProvider(),
    json: () =>
      jsonOf({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }),
    sse: () =>
      sseOf([
        { type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]),
  },
  {
    name: "google",
    make: () => new GoogleInteractionsProvider(),
    json: () =>
      jsonOf({ id: "i", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "hi" }] }] }),
    sse: () =>
      new Response(
        googleEvent("step.start", { index: 0, step: { type: "model_output", content: [{ type: "text", text: "hi" }] } }) +
          googleEvent("step.stop", { index: 0 }) +
          googleEvent("interaction.completed", { interaction: { id: "i", status: "completed" } }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      ),
  },
];

// A fetch whose first `hang` calls never answer (they end only when their signal aborts, with its reason, as fetch does) and whose later calls give `reply()`.
const hanging = (reply: () => Response, hang = 1) => {
  const seen = { calls: 0, signals: [] as AbortSignal[] };
  const fn = (async (_url: string, init: RequestInit) => {
    seen.calls++;
    if (init.signal) seen.signals.push(init.signal);
    if (seen.calls > hang) return reply();
    return await new Promise<Response>((_, reject) => {
      const signal = init.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
  return { fn, seen };
};
const retries = (n: number) => ({ maxRetries: n, retryBaseDelayMs: 1, maxRetryDelayMs: 2 });
// The error a promise rejects with, or the value it gives.
const settle = <T>(p: Promise<T>): Promise<T | (Error & Record<string, unknown>)> =>
  p.catch((e: unknown) => e as Error & Record<string, unknown>);

describe("a provider request that times out", () => {
  for (const a of ADAPTERS) {
    for (const mode of ["generate", "stream"] as const) {
      const call = (fetch: typeof globalThis.fetch, extra: Record<string, unknown>) => {
        clearInteractionChains();
        const options = { apiKey: "k", fetch, timeoutMs: 40, ...extra } as never;
        const p = a.make();
        return mode === "generate" ? p.generate("m", ctx, options) : p.stream("m", ctx, options).result();
      };

      // OpenRouter's generate() streams under ONE timer for the whole call: a first attempt that uses all of it leaves no time to retry.
      const wholeCall = a.name === "openrouter" && mode === "generate";
      if (!wholeCall)
        it(`${a.name} ${mode}(): is retried, and a good second answer recovers the call`, async () => {
        const { fn, seen } = hanging(mode === "generate" ? a.json : a.sse);
        const res = await call(fn, retries(1));
        expect(res.text).toBe("hi");
        expect(seen.calls).toBe(2);
      });

      it(`${a.name} ${mode}(): with no retries left, fails as a retryable TimeoutError, never an AbortError`, async () => {
        const { fn } = hanging(mode === "generate" ? a.json : a.sse, 9);
        const err = await settle(call(fn, retries(0)));
        expect(err).toBeInstanceOf(Error);
        expect([(err as Error).name, (err as Record<string, unknown>)["retryable"]]).toEqual(["TimeoutError", true]);
      });
    }
  }

  it("each stream attempt has its own timer: the first one timing out does not abort the stream's own signal", async () => {
    const { fn, seen } = hanging(ADAPTERS[0]!.sse);
    const res = await new OpenAIResponsesProvider()
      .stream("m", ctx, { apiKey: "k", fetch: fn, timeoutMs: 40, ...retries(1) } as never)
      .result();
    expect(res.text).toBe("hi");
    expect(seen.signals.map((s) => s.aborted)).toEqual([true, false]);
    expect((seen.signals[0]!.reason as Error).name).toBe("TimeoutError");
  });

  it("the caller's own abort stays an AbortError and is not retried", async () => {
    for (const mode of ["generate", "stream"] as const) {
      const { fn, seen } = hanging(ADAPTERS[0]!.json, 9);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const options = { apiKey: "k", fetch: fn, timeoutMs: 5_000, signal: controller.signal, ...retries(2) } as never;
      const p = new OpenAIResponsesProvider();
      const err = await settle(mode === "generate" ? p.generate("m", ctx, options) : p.stream("m", ctx, options).result());
      expect([mode, (err as Error).name, seen.calls]).toEqual([mode, "AbortError", 1]);
    }
  });

  it("google long answer: a status check that times out is retried, and the job is never cancelled", async () => {
    const calls: string[] = [];
    let gets = 0;
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (String(url).endsWith("/cancel")) return jsonOf({ id: "v1_bg", status: "cancelled" });
      if (init.method === "POST") return jsonOf({ id: "v1_bg", status: "in_progress" });
      if (++gets === 1) {
        return await new Promise<Response>((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        );
      }
      return jsonOf({ id: "v1_bg", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "hi" }] }] });
    }) as unknown as typeof globalThis.fetch;
    const p = new GoogleInteractionsProvider();
    p.pollDelaysMs = [1, 1];
    const res = await p.generate("gemini-4-argon", ctx, {
      apiKey: "k",
      fetch,
      maxOutputTokens: 262_144,
      timeoutMs: 40,
      ...retries(1),
    } as never);
    expect(res.text).toBe("hi");
    expect(gets).toBe(2);
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.some((c) => c.endsWith("/cancel"))).toBe(false);
  });

  it("google long answer: a status check that times out with no retry left is a TimeoutError, and the job keeps running", async () => {
    const calls: string[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (String(url).endsWith("/cancel")) return jsonOf({ id: "v1_bg", status: "cancelled" });
      if (init.method === "POST") return jsonOf({ id: "v1_bg", status: "in_progress" });
      return await new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      );
    }) as unknown as typeof globalThis.fetch;
    const p = new GoogleInteractionsProvider();
    p.pollDelaysMs = [1, 1];
    const err = await settle(
      p.generate("gemini-4-argon", ctx, { apiKey: "k", fetch, maxOutputTokens: 262_144, timeoutMs: 40, ...retries(0) } as never)
    );
    expect((err as Error).name).toBe("TimeoutError");
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.some((c) => c.endsWith("/cancel"))).toBe(false); // one slow check never cancels the whole job
  });

  it("a generator called directly reports a TimeoutError (here: embeddings), and retries it", async () => {
    const reply = () => jsonOf({ data: [{ index: 0, embedding: [0.5] }], usage: { prompt_tokens: 1, total_tokens: 1 } });
    const items = [[{ kind: "text" as const, text: "hi" }]];
    const once = hanging(reply, 9);
    const err = await settle(openaiEmbed("m", { items } as never, { apiKey: "k", fetch: once.fn, timeoutMs: 40, ...retries(0) } as never));
    expect((err as Error).name).toBe("TimeoutError");
    const again = hanging(reply);
    const res = await openaiEmbed("m", { items } as never, { apiKey: "k", fetch: again.fn, timeoutMs: 40, ...retries(1) } as never);
    expect([res.vectors, again.seen.calls]).toEqual([[[0.5]], 2]);
  });
});
