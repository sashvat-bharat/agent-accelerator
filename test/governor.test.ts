import { afterEach, describe, expect, test } from "bun:test";
import { Governor, getGovernor, setGovernorLimits, withProviderSlot } from "../src/agent/governor.ts";
import { runAgentLoop, streamAgentLoop } from "../src/agent/loop.ts";
import { AgentContext } from "../src/agent/context.ts";
import { AssistantMessageEventStream } from "../src/streaming/event-stream.ts";
import { AgentResponse } from "../src/types/response.ts";
import type { Provider } from "../src/types/model.ts";

afterEach(() => setGovernorLimits({}));

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

describe("Governor", () => {
  test("unlimited governor never queues", async () => {
    const g = new Governor();
    expect(g.limited).toBe(false);
    const rel = await Promise.all([g.acquire("a"), g.acquire("a"), g.acquire("b")]);
    expect(g.status().waiting).toBe(0);
    rel.forEach((r) => r());
  });

  test("grants in FIFO order", async () => {
    const g = new Governor({ maxRequests: 1 });
    const first = await g.acquire("a");
    const order: number[] = [];
    const waits = [1, 2, 3].map((n) => g.acquire("a").then((r) => (order.push(n), r)));
    first();
    for (const w of waits) (await w)();
    expect(order).toEqual([1, 2, 3]);
  });

  test("per-provider limits are isolated", async () => {
    const g = new Governor({ perProvider: { a: 1 } });
    const a1 = await g.acquire("a");
    let aGranted = false;
    const a2 = g.acquire("a").then((r) => ((aGranted = true), r));
    const b = await g.acquire("b"); // not blocked by provider a's limit
    await tick();
    expect(aGranted).toBe(false);
    a1();
    (await a2)();
    b();
  });

  test("a waiter blocked by its provider does not hold back others behind it", async () => {
    const g = new Governor({ maxRequests: 2, perProvider: { a: 1 } });
    const a1 = await g.acquire("a");
    const a2 = g.acquire("a"); // waits for provider a
    const b = await g.acquire("b"); // fits although a2 is ahead of it
    expect(g.status().active).toBe(2);
    a1();
    b();
    (await a2)();
  });

  test("release is exactly once", async () => {
    const g = new Governor({ maxRequests: 1 });
    const r = await g.acquire("a");
    r();
    r();
    r();
    expect(g.status().active).toBe(0);
    const r2 = await g.acquire("a");
    let granted = false;
    const r3 = g.acquire("a").then((x) => ((granted = true), x));
    await tick();
    expect(granted).toBe(false); // a double release did not free a second slot
    r2();
    (await r3)();
  });

  test("abort while queued rejects with AbortError and frees the line", async () => {
    const g = new Governor({ maxRequests: 1 });
    const held = await g.acquire("a");
    const ctl = new AbortController();
    const queued = g.acquire("a", ctl.signal);
    const behind = g.acquire("a");
    ctl.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(g.status().waiting).toBe(1);
    held();
    (await behind)();
    await expect(g.acquire("a", ctl.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  test("200 runs never exceed the limit at once", async () => {
    setGovernorLimits({ maxRequests: 3, perProvider: { a: 2 } });
    let now = 0;
    let peak = 0;
    let nowA = 0;
    let peakA = 0;
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => {
        const p = i % 2 ? "a" : "b";
        return withProviderSlot(p, undefined, async () => {
          now++;
          peak = Math.max(peak, now);
          if (p === "a") peakA = Math.max(peakA, ++nowA);
          await tick(Math.random() * 2);
          if (p === "a") nowA--;
          now--;
        });
      })
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peakA).toBeLessThanOrEqual(2);
    expect(getGovernor().status().active).toBe(0);
  });

  test("withProviderSlot releases on error", async () => {
    setGovernorLimits({ maxRequests: 1 });
    await expect(
      withProviderSlot("a", undefined, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(getGovernor().status().active).toBe(0);
  });
});

// A fake provider that counts calls in flight and answers after a short delay.
function fakeProvider(state: { now: number; peak: number }, mode: "generate" | "stream"): Provider {
  const response = () =>
    new AgentResponse({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: "m",
      provider: "fake",
      durationMs: 1,
      raw: { request: { url: "u", method: "POST", headers: {}, body: null } },
    });
  const enter = () => {
    state.now++;
    state.peak = Math.max(state.peak, state.now);
  };
  return {
    id: "fake",
    name: "fake",
    models: [],
    getModel: () => undefined,
    async generate() {
      enter();
      try {
        await tick(5);
        const r = response();
        return { text: r.text, usage: r.usage, model: "m", provider: "fake", raw: r.raw, durationMs: 1, finishReason: "stop" };
      } finally {
        state.now--;
      }
    },
    stream() {
      const s = new AssistantMessageEventStream();
      enter();
      void (async () => {
        await tick(5);
        state.now--;
        s.end(response());
      })();
      return s;
    },
  } as Provider;
}

async function runOnce(provider: Provider, mode: "generate" | "stream", signal?: AbortSignal): Promise<void> {
  const context = new AgentContext("sys");
  context.addUserMessage("hi");
  const config = { provider, modelId: "m", context, tools: {}, runOptions: signal ? { signal } : undefined };
  if (mode === "generate") await runAgentLoop(config);
  else await streamAgentLoop(config).result();
}

describe("governor in the loops", () => {
  for (const mode of ["generate", "stream"] as const) {
    test(`${mode}: parallel runs respect maxRequests`, async () => {
      setGovernorLimits({ maxRequests: 2 });
      const state = { now: 0, peak: 0 };
      const provider = fakeProvider(state, mode);
      await Promise.all(Array.from({ length: 8 }, () => runOnce(provider, mode)));
      expect(state.peak).toBe(2);
      expect(getGovernor().status().active).toBe(0);
    });

    test(`${mode}: a run aborted while queued fails with AbortError and takes no slot`, async () => {
      setGovernorLimits({ maxRequests: 1 });
      const state = { now: 0, peak: 0 };
      const provider = fakeProvider(state, mode);
      const first = runOnce(provider, mode);
      const ctl = new AbortController();
      const second = runOnce(provider, mode, ctl.signal);
      ctl.abort();
      await expect(second).rejects.toMatchObject({ name: "AbortError" });
      await first;
      expect(state.peak).toBe(1);
      expect(getGovernor().status()).toEqual({ active: 0, waiting: 0, byProvider: {} });
    });
  }

  test("a failing provider call releases its slot", async () => {
    setGovernorLimits({ maxRequests: 1 });
    const bad = { ...fakeProvider({ now: 0, peak: 0 }, "generate"), generate: async () => Promise.reject(new Error("down")) } as Provider;
    await expect(runOnce(bad, "generate")).rejects.toThrow("down");
    expect(getGovernor().status().active).toBe(0);
  });

  test("queue wait is not counted in the request timeout", async () => {
    setGovernorLimits({ maxRequests: 1 });
    const state = { now: 0, peak: 0 };
    const provider = fakeProvider(state, "generate"); // each call takes ~5 ms
    const run = () => {
      const context = new AgentContext("sys");
      context.addUserMessage("hi");
      return runAgentLoop({ provider, modelId: "m", context, tools: {}, limits: { requestTimeoutMs: 30 } } as never);
    };
    // the 6th call waits ~25 ms in line: longer than its own 5 ms call, still inside no timer because the timer starts after the slot
    await Promise.all(Array.from({ length: 8 }, run));
  });
});
