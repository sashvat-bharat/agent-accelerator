import { describe, it, expect } from "bun:test";
import { Agent, ValidationError, telemetryBus } from "../src/index.ts";
import { chatReply, mockFetch } from "./helpers.ts";

const mk = (fn: typeof fetch, extra: Record<string, unknown> = {}) =>
  new Agent({ model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", fetch: fn, runRetries: 0, ...extra });
const slow = (ms: number) =>
  mockFetch(async (n) => (await new Promise((r) => setTimeout(r, ms)), chatReply(`answer ${n}`)));

describe("requestId: idempotent submit", () => {
  it("the same id again returns the first result and the model is called once", async () => {
    const { fn, calls } = mockFetch(() => chatReply("hello"));
    const agent = mk(fn);
    const a = await agent.run("hi", { requestId: "r1" });
    const b = await agent.run("hi", { requestId: "r1" });
    expect(b).toBe(a);
    expect(calls).toHaveLength(1);
    expect(agent.context.messages).toHaveLength(2);
  });

  it("two calls at the same time share one run", async () => {
    const { fn, calls } = slow(20);
    const agent = mk(fn);
    const [a, b] = await Promise.all([agent.run("hi", { requestId: "r1" }), agent.run("hi", { requestId: "r1" })]);
    expect(b).toBe(a);
    expect(calls).toHaveLength(1);
  });

  it("different ids (or none) run separately", async () => {
    const { fn, calls } = mockFetch((n) => chatReply(`a${n}`));
    const agent = mk(fn);
    await agent.run("one", { requestId: "a" });
    await agent.run("two", { requestId: "b" });
    await agent.run("three");
    await agent.run("four");
    expect(calls).toHaveLength(4);
  });

  it("a failed run is forgotten, so a retry with the same id runs again", async () => {
    let n = 0;
    const { fn, calls } = mockFetch(() => (++n === 1 ? new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }) : chatReply("ok")));
    const agent = mk(fn);
    await expect(agent.run("hi", { requestId: "r1" })).rejects.toThrow();
    const res = await agent.run("hi", { requestId: "r1" });
    expect(res.text).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("works for queue() and steer(), also behind a run that is active", async () => {
    const { fn, calls } = slow(30);
    const agent = mk(fn);
    const first = agent.run("busy");
    const q1 = agent.queue("later", { requestId: "q" });
    const q2 = agent.queue("later", { requestId: "q" });
    expect(q2).toBe(q1);
    expect(agent.pendingCount).toBe(1);
    const s1 = agent.steer("redirect", { requestId: "s" });
    const s2 = agent.steer("redirect", { requestId: "s" });
    expect(s2).toBe(s1);
    expect(agent.steerPendingCount).toBe(1);
    await Promise.all([first, q1, s1]);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("works through ask() without streaming", async () => {
    const { fn, calls } = mockFetch(() => chatReply("hey"));
    const agent = mk(fn);
    await agent.ask("hi", { requestId: "x" });
    await agent.ask("hi", { requestId: "x" });
    expect(calls).toHaveLength(1);
  });

  it("refuses streaming, and a bad id", async () => {
    const agent = mk(mockFetch(() => chatReply("x")).fn);
    expect(() => agent.stream("hi", { requestId: "r" })).toThrow(ValidationError);
    expect(() => agent.run("hi", { stream: true, requestId: "r" })).toThrow(ValidationError);
    expect(() => agent.run("hi", { requestId: "" })).toThrow(ValidationError);
    expect(() => agent.run("hi", { requestId: "x".repeat(201) })).toThrow(ValidationError);
    expect(() => agent.run("hi", { requestId: 5 as never })).toThrow(ValidationError);
  });

  it("says so on the bus: a duplicate, and an id reused with another prompt", async () => {
    const codes: string[] = [];
    const off = telemetryBus.onEvent((e) => e.code.startsWith("agent.duplicate") || e.code === "agent.request_id_reused" ? codes.push(e.code) : undefined);
    try {
      const agent = mk(mockFetch(() => chatReply("x")).fn);
      await agent.run("one", { requestId: "r" });
      await agent.run("one", { requestId: "r" });
      await agent.run("two", { requestId: "r" });
    } finally {
      off();
    }
    expect(codes).toEqual(["agent.duplicate_request", "agent.duplicate_request", "agent.request_id_reused"]);
  });

  it("remembers at most the last 1000 ids", async () => {
    const { fn, calls } = mockFetch(() => chatReply("x"));
    const agent = mk(fn);
    for (let i = 0; i < 1001; i++) await agent.run("p", { requestId: `id-${i}` });
    expect(calls).toHaveLength(1001);
    await agent.run("p", { requestId: "id-1000" }); // still remembered
    expect(calls).toHaveLength(1001);
    await agent.run("p", { requestId: "id-0" }); // the oldest was dropped: runs again
    expect(calls).toHaveLength(1002);
  });
});
