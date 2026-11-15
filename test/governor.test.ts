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

// A clock the test moves by hand: timers fire when `advance` passes them.
function fakeClock() {
  let t = 1_000;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  return {
    now: () => t,
    later: (fn: () => void, ms: number) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
    advance(ms: number) {
      t += ms;
      for (const timer of timers.filter((x) => x.live && x.at <= t)) {
        timer.live = false;
        timer.fn();
      }
    },
  };
}

const rateLimited = (retryAfterMs?: number) =>
  Object.assign(new Error("429"), { status: 429, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

describe("429 pause", () => {
  test("a paused provider's queue resumes when the wait has passed", async () => {
    const clock = fakeClock();
    const g = new Governor({ maxRequests: 5 }, clock);
    g.pause("a", 2_000);
    expect(g.isPaused("a")).toBe(true);
    let granted = false;
    const waiting = g.acquire("a").then((r) => ((granted = true), r));
    await tick();
    expect(granted).toBe(false);
    clock.advance(1_999);
    await tick();
    expect(granted).toBe(false);
    clock.advance(1);
    (await waiting)();
    expect(g.isPaused("a")).toBe(false);
  });

  test("other providers keep running and a running call is not touched", async () => {
    const clock = fakeClock();
    const g = new Governor({ maxRequests: 5 }, clock);
    const running = await g.acquire("a");
    g.pause("a", 5_000);
    (await g.acquire("b"))();
    expect(g.status().active).toBe(1);
    running();
  });

  test("a pause never gets shorter and is capped at 60 s", async () => {
    const clock = fakeClock();
    const g = new Governor({ maxRequests: 5 }, clock);
    g.pause("a", 10_000);
    g.pause("a", 1_000);
    clock.advance(5_000);
    expect(g.isPaused("a")).toBe(true);
    g.pause("a", 10 * 60_000);
    clock.advance(59_999);
    expect(g.isPaused("a")).toBe(true);
    clock.advance(1);
    expect(g.isPaused("a")).toBe(false);
  });

  test("an abort while paused still rejects", async () => {
    const clock = fakeClock();
    const g = new Governor({ maxRequests: 5 }, clock);
    g.pause("a", 5_000);
    const ctl = new AbortController();
    const q = g.acquire("a", ctl.signal);
    ctl.abort();
    await expect(q).rejects.toMatchObject({ name: "AbortError" });
  });

  test("withProviderSlot pauses on 429 with Retry-After, and not without it or on other errors", async () => {
    const clock = fakeClock();
    setGovernorLimits({ maxRequests: 5 }, clock);
    const fail = (e: Error) =>
      withProviderSlot("a", undefined, async () => {
        throw e;
      }).catch(() => {});
    await fail(rateLimited()); // no Retry-After
    await fail(Object.assign(new Error("500"), { status: 500, retryAfterMs: 3_000 }));
    expect(getGovernor().isPaused("a")).toBe(false);
    await fail(rateLimited(3_000));
    expect(getGovernor().isPaused("a")).toBe(true);
    let ran = false;
    const next = withProviderSlot("a", undefined, async () => (ran = true));
    await tick();
    expect(ran).toBe(false);
    clock.advance(3_000);
    await next;
    expect(ran).toBe(true);
  });
});

describe("public setting", () => {
  test("configure({ concurrency }) sets the limits, configure({}) clears them", async () => {
    const { configure, getConcurrencyStatus } = await import("../src/index.ts");
    configure({ concurrency: { maxRequests: 2, perProvider: { google: 1 } } });
    expect(getConcurrencyStatus()).toEqual({ limited: true, active: 0, waiting: 0, byProvider: {}, paused: [] });
    const r = await withProviderSlot("google", undefined, async () => getConcurrencyStatus());
    expect(r.active).toBe(1);
    expect(r.byProvider).toEqual({ google: 1 });
    configure({});
    expect(getConcurrencyStatus().limited).toBe(false);
  });

  test("a bad concurrency value is a ConfigError naming the problem", async () => {
    const { configure } = await import("../src/index.ts");
    for (const bad of [{ maxRequests: 0 }, { maxRequests: 1.5 }, { perProvider: { a: -1 } }, { perProvider: [] }, { nope: 1 }, 5]) {
      expect(() => configure({ concurrency: bad as never })).toThrow(/configure\(\): invalid concurrency/);
    }
  });

  test("queueing and pausing are reported on the telemetry bus", async () => {
    const { telemetryBus } = await import("../src/index.ts");
    const seen: Array<{ code: string; data: any }> = [];
    const off = telemetryBus.onEvent((e) => e.code.startsWith("concurrency.") && seen.push({ code: e.code, data: e.data }));
    const clock = fakeClock();
    const g = new Governor({ maxRequests: 1 }, clock);
    const first = await g.acquire("a");
    const second = g.acquire("a");
    g.pause("a", 1_000);
    first();
    clock.advance(1_000);
    (await second)();
    off();
    expect(seen.map((e) => e.code)).toEqual(["concurrency.queued", "concurrency.paused"]);
    expect(seen[0]!.data).toMatchObject({ provider: "a", waiting: 1, active: 1 });
    expect(seen[1]!.data).toMatchObject({ provider: "a", ms: 1_000 });
  });

  test("getConcurrencyStatus lists paused providers", async () => {
    const { getConcurrencyStatus } = await import("../src/index.ts");
    const clock = fakeClock();
    setGovernorLimits({ maxRequests: 3 }, clock);
    getGovernor().pause("openai", 2_000);
    expect(getConcurrencyStatus().paused).toEqual(["openai"]);
    clock.advance(2_000);
    expect(getConcurrencyStatus().paused).toEqual([]);
  });
});
