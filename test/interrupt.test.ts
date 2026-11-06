import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { Agent, tool } from "../src/index.ts";

// ---------------------------------------------------------------------------
// A fake OpenAI-compatible server that SEES the HTTP-level abort: the signal of every request and the cancellation of
// every response body. That is what decides whether the provider stops generating (a closed connection) or not.
// ---------------------------------------------------------------------------
const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
const enc = new TextEncoder();
const frame = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !cond(); i++) await sleep(5);
};
const lastUser = (body: any): string => [...body.messages].reverse().find((m: any) => m.role === "user")?.content;

// A normal answer, streamed or not, whichever the request asks for.
const answer = (text: string, body: any): Response =>
  body.stream
    ? new Response(frame({ id: "r", choices: [{ delta: { content: text } }] }) + frame({ id: "r", choices: [{ delta: {}, finish_reason: "stop" }], usage }) + "data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    : new Response(JSON.stringify({ id: "r", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }), { status: 200 });

const toolTurn = (name: string): Response =>
  new Response(
    JSON.stringify({ id: "r", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage }),
    { status: 200 }
  );

interface Fake {
  calls: any[];
  signals: AbortSignal[];
  fn: typeof fetch;
}
// `handler(n, body, signal)` answers the n-th request (1-based).
function fake(handler: (n: number, body: any, signal: AbortSignal) => Promise<Response> | Response): Fake {
  const f: Fake = { calls: [], signals: [], fn: undefined as never };
  f.fn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    f.calls.push(body);
    f.signals.push(init.signal as AbortSignal);
    return handler(f.calls.length, body, init.signal as AbortSignal);
  }) as unknown as typeof fetch;
  return f;
}
// A reply that never comes: the request stays open until the client aborts it, like a model still thinking.
// Like a real fetch, it rejects with the reason the signal was aborted with.
const hang = (signal: AbortSignal): Promise<Response> =>
  new Promise((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })
  );

// A streamed reply that keeps producing tokens until the client closes the connection (cancel of the body).
function endless(): { response: Response; state: { sent: number; cancelled: boolean } } {
  const state = { sent: 0, cancelled: false };
  let timer: ReturnType<typeof setInterval>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        state.sent++;
        controller.enqueue(enc.encode(frame({ id: "s", choices: [{ delta: { content: "tok " } }] })));
      }, 5);
    },
    cancel() {
      state.cancelled = true;
      clearInterval(timer);
    },
  });
  return { response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }), state };
}

const mk = (f: Fake, extra: Record<string, unknown> = {}) =>
  new Agent({ model: "groq/m", apiKey: "k", baseUrl: "https://example.test/v1", fetch: f.fn, runRetries: 0, retry: { maxRetries: 0 }, ...extra });

describe("interrupt() reaches the provider: the HTTP request is really cancelled", () => {
  it("a run waiting for the model: the request's abort signal fires and nothing else is sent", async () => {
    const f = fake((_n, _b, signal) => hang(signal));
    const agent = mk(f);
    const run = agent.run("think hard");
    await until(() => f.calls.length === 1);
    expect(f.signals[0]!.aborted).toBe(false);
    agent.interrupt();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(f.signals[0]!.aborted).toBe(true); // fetch was told to drop the connection
    await sleep(30);
    expect(f.calls).toHaveLength(1); // no retry, no second request
  });

  it("a stream in flight: the response body is cancelled and the tokens stop", async () => {
    const e = endless();
    const f = fake(() => e.response);
    const agent = mk(f);
    const stream = agent.stream("write a novel");
    await until(() => e.state.sent >= 3);
    agent.interrupt();
    await expect(stream.result()).rejects.toMatchObject({ name: "AbortError" });
    const sentAtStop = e.state.sent;
    await sleep(60);
    expect(e.state.cancelled).toBe(true); // the connection is closed, so the provider stops generating
    expect(e.state.sent).toBe(sentAtStop); // and we are not reading (or being fed) tokens any more
    expect(f.signals[0]!.aborted).toBe(true);
  });

  it("OpenRouter: even run() is sent as a stream, so interrupting it closes the connection", async () => {
    const e = endless();
    const f = fake(() => e.response);
    const agent = new Agent({ model: "openrouter/z-ai/glm-5.3-flash", apiKey: "k", baseUrl: "https://example.test/v1", fetch: f.fn, runRetries: 0, retry: { maxRetries: 0 } });
    const run = agent.run("write a novel"); // run(), not stream()
    await until(() => e.state.sent >= 3);
    expect(f.calls[0].stream).toBe(true); // OpenRouter only cancels requests that stream
    agent.interrupt();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    const at = e.state.sent;
    await sleep(60);
    expect(e.state.cancelled).toBe(true);
    expect(e.state.sent).toBe(at);
    expect(f.signals[0]!.aborted).toBe(true);
  });

  it("an AbortSignal passed to run() cancels the provider request the same way", async () => {
    const f = fake((_n, _b, signal) => hang(signal));
    const ctl = new AbortController();
    const run = mk(f).run("hi", { signal: ctl.signal });
    await until(() => f.calls.length === 1);
    ctl.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(f.signals[0]!.aborted).toBe(true);
  });

  it("a tool in flight gets the abort signal, and the run does not wait for a tool that ignores it", async () => {
    const f = fake((n, body) => (n === 1 ? toolTurn("slow") : answer("ok", body)));
    let sawAbort = false;
    let started = false;
    const cooperative = tool({
      description: "listens",
      input: z.object({}),
      execute: async (_i, ctx) => {
        started = true;
        await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => ((sawAbort = true), resolve()), { once: true }));
        return "stopped early";
      },
    });
    const a = mk(f, { tools: { slow: cooperative } });
    const runA = a.run("go");
    await until(() => started);
    a.interrupt();
    await expect(runA).rejects.toMatchObject({ name: "AbortError" });
    expect(sawAbort).toBe(true);

    // A tool that never looks at its signal: the run is released at once; the tool just finishes in the background.
    const g = fake((n, body) => (n === 1 ? toolTurn("deaf") : answer("ok", body)));
    let deafStarted = false;
    const deaf = tool({ description: "ignores abort", input: z.object({}), execute: async () => ((deafStarted = true), await sleep(500), "done") });
    const b = mk(g, { tools: { deaf } });
    const runB = b.run("go");
    await until(() => deafStarted);
    const t0 = Date.now();
    b.interrupt();
    await expect(runB).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it("interrupt(error) aborts with that error's message", async () => {
    const f = fake((_n, _b, signal) => hang(signal));
    const agent = mk(f);
    const run = agent.run("hi");
    await until(() => f.calls.length === 1);
    agent.interrupt(new Error("user pressed stop"));
    await expect(run).rejects.toMatchObject({ name: "AbortError", message: "user pressed stop" });
  });
});

describe("interrupt(message): stop what is running and start the new message", () => {
  it("aborts the active run, then answers the message; the aborted run's history stays", async () => {
    const f = fake((n, body, signal) => (n === 1 ? hang(signal) : answer(`answer:${lastUser(body)}`, body)));
    const agent = mk(f);
    const first = agent.run("one");
    await until(() => f.calls.length === 1);
    const second = agent.interrupt("two instead");
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect((await second).text).toBe("answer:two instead");
    expect(f.signals[0]!.aborted).toBe(true);
    // The second request carries the first prompt (kept) and the new one; the unfinished answer was never stored.
    expect(f.calls[1].messages.filter((m: any) => m.role !== "system").map((m: any) => [m.role, m.content])).toEqual([
      ["user", "one"],
      ["user", "two instead"],
    ]);
  });

  it("runs before queued follow-ups and before a steer that missed the aborted run", async () => {
    const f = fake((n, body, signal) => (n === 1 ? hang(signal) : answer(`answer:${lastUser(body)}`, body)));
    const agent = mk(f);
    const first = agent.run("one");
    await until(() => f.calls.length === 1);
    const steered = agent.steer("a steer typed before the interrupt");
    const later = agent.queue("later");
    const now = agent.interrupt("now");
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect((await now).text).toBe("answer:now");
    await Promise.all([steered, later]);
    expect(f.calls.map(lastUser)).toEqual(["one", "now", "a steer typed before the interrupt", "later"]);
  });

  it("two interrupts in a row run in the order they were made", async () => {
    const f = fake((n, body, signal) => (n === 1 ? hang(signal) : answer(`answer:${lastUser(body)}`, body)));
    const agent = mk(f);
    const first = agent.run("one");
    await until(() => f.calls.length === 1);
    const a = agent.interrupt("A");
    const b = agent.interrupt("B");
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await Promise.all([a, b]);
    expect(f.calls.map(lastUser)).toEqual(["one", "A", "B"]);
  });

  it("works for a stream: stream(prompt, { enqueue: 'interrupt' }) cancels the first and streams the second", async () => {
    const e = endless();
    const f = fake((n, body) => (n === 1 ? e.response : answer("second answer", body)));
    const agent = mk(f);
    const first = agent.stream("one");
    await until(() => e.state.sent >= 2);
    const second = agent.stream("two", { enqueue: "interrupt" });
    await expect(first.result()).rejects.toMatchObject({ name: "AbortError" });
    expect(e.state.cancelled).toBe(true);
    const seen: string[] = [];
    for await (const ev of second) if (ev.type === "text_delta") seen.push(ev.delta ?? "");
    expect(seen.join("")).toBe("second answer");
    expect((await second.result()).text).toBe("second answer");
  });

  it("is allowed even when midSession.mode only permits steer or queue", async () => {
    const f = fake((n, body, signal) => (n === 1 ? hang(signal) : answer("ok", body)));
    const agent = mk(f, { midSession: { mode: "queue" } });
    const first = agent.run("one");
    await until(() => f.calls.length === 1);
    const now = agent.interrupt("now");
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect((await now).text).toBe("ok");
  });

  it("goes through even when the follow-up queue is full", async () => {
    const f = fake((n, body, signal) => (n === 1 ? hang(signal) : answer(`answer:${lastUser(body)}`, body)));
    const agent = mk(f, { midSession: { maxQueued: 1 } });
    const first = agent.run("one");
    await until(() => f.calls.length === 1);
    const queued = agent.queue("fills the queue");
    expect(() => agent.queue("one too many")).toThrow(/Queue is full/);
    const now = agent.interrupt("urgent");
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await Promise.all([now, queued]);
    expect(f.calls.map(lastUser)).toEqual(["one", "urgent", "fills the queue"]);
  });

  it("when idle it simply runs the message", async () => {
    const f = fake((_n, body) => answer("hello", body));
    const res = await mk(f).interrupt("hi");
    expect(res.text).toBe("hello");
    expect(f.signals[0]!.aborted).toBe(false);
  });

  it("is non-streaming as a method: a stream is asked for with enqueue 'interrupt'", () => {
    const agent = mk(fake((_n, body) => answer("x", body)));
    expect(() => agent.interrupt("hi", { stream: true })).toThrow(/stream\(prompt, \{ enqueue: "interrupt" \}\)/);
    expect(() => agent.interrupt([])).toThrow(/empty/);
  });

  it("interrupting a tool turn leaves a repaired history: the call gets a result before the new message", async () => {
    const f = fake((n, body) => (n === 1 ? toolTurn("slow") : answer("fine", body)));
    let started = false;
    const slow = tool({
      description: "slow",
      input: z.object({}),
      execute: async (_i, ctx) => {
        started = true;
        await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return "never read";
      },
    });
    const agent = mk(f, { tools: { slow } });
    const first = agent.run("go");
    await until(() => started);
    const now = agent.interrupt("never mind");
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect((await now).text).toBe("fine");
    const roles = f.calls[1].messages.filter((m: any) => m.role !== "system").map((m: any) => m.role);
    // The call is directly followed by its result, then the new message (the Chat Completions adapter adds a one-line
    // assistant bridge between a tool result and a user message, which strict endpoints require).
    const callAt = roles.indexOf("assistant");
    expect(roles.slice(callAt, callAt + 2)).toEqual(["assistant", "tool"]);
    expect(roles[roles.length - 1]).toBe("user");
    expect(lastUser(f.calls[1])).toBe("never mind");
  });
});

// ---------------------------------------------------------------------------
// Aborting a streaming request closes the connection, which errors the response body. Cancelling that already-errored
// body rejects, so every adapter must absorb that rejection: nothing may reach `unhandledRejection` (which crashes a host).
// ---------------------------------------------------------------------------
describe("aborting a stream leaves nothing unhandled", () => {
  for (const [label, model, extra] of [
    ["OpenRouter", "openrouter/x/y", {}],
    ["OpenAI", "openai/gpt-5-nano", {}],
    ["a custom endpoint", "groq/some-model", { env: { GROQ_BASE_URL: "http://localhost:1/v1" } }],
    ["Google", "google/gemini-3-test", {}],
  ] as const) {
    it(`${label}: stream()${label === "OpenRouter" ? " and run()" : ""} aborted by a signal`, async () => {
      const seen: unknown[] = [];
      const onUnhandled = (reason: unknown) => seen.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        // A response that stays open (an SSE comment only) and errors its body when the request is aborted, like a real connection.
        const open = (async (_url: unknown, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(enc.encode(": keep-alive\n\n"));
                init.signal?.addEventListener("abort", () => c.error(Object.assign(new Error("connection aborted"), { name: "AbortError" })));
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } }
          )) as unknown as typeof fetch;
        const agent = new Agent({ model, apiKey: "k", fetch: open, runRetries: 0, ...extra });
        // OpenRouter streams even for run(); the other adapters read a stream only for stream().
        for (const start of label === "OpenRouter" ? ["stream", "run"] : ["stream"]) {
          const ac = new AbortController();
          const done =
            start === "stream"
              ? agent.stream("hello", { signal: ac.signal }).result().then(() => null, (e) => e)
              : agent.run("hello", { signal: ac.signal }).then(() => null, (e) => e);
          await sleep(40);
          ac.abort(new Error("stop"));
          expect((await done)?.name).toBe("AbortError");
          await sleep(100);
        }
        expect(seen).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  }
});
