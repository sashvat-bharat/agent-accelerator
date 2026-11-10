import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, registerModel, clearCustomModels } from "../src/index.ts";
import { createGenericModelSpec } from "../src/models/catalog.ts";
import { loadSessionDir, priceUsage, sessionDirFor } from "../src/session/store.ts";
import { addTurn, buildUsageReport, emptyUsage, mergeUsage, readUsage, usageLine } from "../src/session/usage.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accel-usage-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  clearCustomModels();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

// $3 / $15 per M, cache reads $0.30, cache writes $3.75.
const price = (id: string) =>
  registerModel({ ...createGenericModelSpec("groq", id), pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 } });
// One model call: 1000 input (600 read from the cache, 100 written), 200 output (50 of it thinking).
const usage = (extra: Record<string, unknown> = {}) => ({
  prompt_tokens: 1000,
  completion_tokens: 200,
  total_tokens: 1200,
  prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
  completion_tokens_details: { reasoning_tokens: 50 },
  ...extra,
});
const sseFrame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const reply = (text: string, body: any, u = usage()): Response =>
  body.stream
    ? new Response(sseFrame({ id: "r", choices: [{ delta: { content: text } }] }) + sseFrame({ id: "r", choices: [{ delta: {}, finish_reason: "stop" }], usage: u }) + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
    : new Response(JSON.stringify({ id: "r", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: u }), { status: 200, headers: { "content-type": "application/json" } });
const callTool = (name: string, args: Record<string, unknown>, body: any): Response =>
  body.stream
    ? new Response(
        sseFrame({ id: "r", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }) + sseFrame({ id: "r", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: usage() }) + "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    : new Response(JSON.stringify({ id: "r", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: usage() }), { status: 200, headers: { "content-type": "application/json" } });
const hasTool = (body: any) => body.messages.some((m: any) => m.role === "tool");
const systemText = (body: any): string => body.messages[0].content;

type Handler = (body: any) => Response;
const mk = (handler: Handler, extra: Record<string, unknown> = {}) =>
  new Agent({
    model: "groq/p",
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    sessionId: "p1",
    fetch: (async (_url: string, init: RequestInit) => handler(JSON.parse(String(init.body)))) as unknown as typeof fetch,
    dynamicSubagents: { model: "groq/w" },
    ...extra,
  });

// What the call above must come to: 300 fresh * $3 + 600 * $0.30 + 100 * $3.75 + 200 * $15, in micro-USD.
const ONE_CALL = { fresh: 900, read: 180, write: 375, out: 3000, total: 4455 };

describe("usage totals and lines (pure)", () => {
  const spec: any = { id: "m", pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 } };
  const turn = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedTokens: 600, cacheReadTokens: 600, cacheWriteTokens: 100, thinkingTokens: 50 };

  it("adds a priced turn: tokens split into fresh/read/write, thinking inside output, cost per part in micro-USD", () => {
    const t = emptyUsage();
    addTurn(t, turn, priceUsage(turn, spec));
    const line = usageLine(t);
    expect(line.turns).toBe(1);
    expect(line.tokens).toEqual({ input: 1000, freshInput: 300, cacheRead: 600, cacheWrite: 100, output: 200, thinking: 50, total: 1200 });
    expect(line.cacheHitRate).toBeCloseTo(0.6, 9);
    expect(t.costMicroUSD).toEqual({ input: ONE_CALL.fresh, output: ONE_CALL.out, cacheRead: ONE_CALL.read, cacheWrite: ONE_CALL.write, total: ONE_CALL.total });
    expect(line.cost).toEqual({ source: "catalog", unpricedTurns: 0, totalUsd: 0.004455, parts: { inputUsd: 0.0009, outputUsd: 0.003, cacheReadUsd: 0.00018, cacheWriteUsd: 0.000375 } });
  });

  it("keeps unknown pricing unknown, and says mixed or partial when the sources differ", () => {
    const unknown = emptyUsage();
    addTurn(unknown, turn, undefined);
    expect(usageLine(unknown).cost).toEqual({ source: "unknown", unpricedTurns: 1, totalUsd: null });

    const mixed = emptyUsage();
    addTurn(mixed, turn, priceUsage(turn, spec));
    addTurn(mixed, { ...turn, cost: { totalCost: 0.01 } }, priceUsage({ ...turn, cost: { totalCost: 0.01 } }, spec));
    addTurn(mixed, turn, undefined);
    const cost = usageLine(mixed).cost;
    expect(cost.source).toBe("mixed");
    expect(cost.unpricedTurns).toBe(1);
    expect(cost.totalUsd).toBeCloseTo(0.004455 + 0.01, 9);
  });

  it("merges totals without loss, and reads saved totals defensively", () => {
    const a = emptyUsage();
    const b = emptyUsage();
    addTurn(a, turn, priceUsage(turn, spec));
    addTurn(b, turn, priceUsage(turn, spec));
    mergeUsage(a, b);
    expect(a.turns).toBe(2);
    expect(a.costMicroUSD.total).toBe(2 * ONE_CALL.total);
    expect(readUsage(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(readUsage({ turns: "x", inputTokens: -5 })).toEqual(emptyUsage());
    expect(readUsage(null)).toEqual(emptyUsage());
    expect(usageLine(emptyUsage()).cacheHitRate).toBeNull();
  });

  it("builds the report with the total counting each part once", () => {
    const own = emptyUsage();
    const child = emptyUsage();
    addTurn(own, turn, priceUsage(turn, spec));
    addTurn(child, turn, priceUsage(turn, spec));
    const report = buildUsageReport({ id: "s", name: "Lead", model: "groq/p", totals: own }, [
      { id: "w-1", name: "w", model: "groq/w", status: "open", totals: child, workers: [{ id: "k-1", name: "k", model: "groq/w", status: "closed", totals: child, workers: [] }] },
    ]);
    expect(report.agent.turns).toBe(1);
    expect(report.workers[0]!.workers[0]!.status).toBe("closed");
    expect(report.total.turns).toBe(3);
    expect(report.total.cost.totalUsd).toBeCloseTo(3 * 0.004455, 9);
  });
});

describe("agent.usageReport()", () => {
  it("reports the agent's own call exactly, cache hits and thinking included, and saves it with the session", async () => {
    price("p");
    const root = tmp();
    const agent = mk((body) => reply("hi", body), { persist: { dir: root } });
    await agent.run("hello");
    const { agent: own, workers, total } = agent.usageReport();
    expect(workers).toEqual([]);
    expect(own).toMatchObject({ id: "p1", name: "Agent", model: "groq/p", turns: 1 });
    expect(own.tokens).toEqual({ input: 1000, freshInput: 300, cacheRead: 600, cacheWrite: 100, output: 200, thinking: 50, total: 1200 });
    expect(own.cacheHitRate).toBeCloseTo(0.6, 9);
    expect(own.cost).toMatchObject({ source: "catalog", unpricedTurns: 0, totalUsd: 0.004455 });
    expect(total).toEqual({ turns: own.turns, tokens: own.tokens, cacheHitRate: own.cacheHitRate, cost: own.cost });

    // Saved: a later process loads it and carries on adding to it.
    const saved = loadSessionDir(sessionDirFor(root, "p1"))!.session;
    expect(saved.usage!.turns).toBe(1);
    expect(saved.usage!.costMicroUSD.total).toBe(ONE_CALL.total);
    const next = mk((body) => reply("again", body), { persist: { dir: root } });
    next.importSession(saved);
    expect(next.usageReport().agent.turns).toBe(1);
    await next.run("more");
    expect(next.usageReport().agent.turns).toBe(2);
    expect(next.usageReport().agent.cost.totalUsd).toBeCloseTo(2 * 0.004455, 9);
  });

  it("keeps unknown pricing unknown and shows a provider-reported cost as provider", async () => {
    const unknown = mk((body) => reply("hi", body), { model: "groq/no-price" });
    await unknown.run("x");
    expect(unknown.usageReport().agent.cost).toEqual({ source: "unknown", unpricedTurns: 1, totalUsd: null });

    price("p");
    const reported = mk((body) => reply("hi", body, usage({ cost: 0.5 })));
    await reported.run("x");
    expect(reported.usageReport().agent.cost).toMatchObject({ source: "provider", totalUsd: 0.5 });
  });

  it("lists each worker with its own spending, closed ones too, and a total that adds up exactly once", async () => {
    price("p");
    price("w");
    const parent = mk((body) => reply("ok", body));
    await parent.run("hello"); // parent: 1 call
    const a = await parent.workers.spawn({ name: "a", task: "x" }); // worker a: 1 call
    await parent.workers.message(a.id, "again"); // worker a: 2 calls
    const b = await parent.workers.spawn({ name: "b", task: "y" }); // worker b: 1 call
    parent.workers.close(b.id);

    const report = parent.usageReport();
    expect(report.agent.turns).toBe(1);
    expect(report.workers.map((w) => [w.id, w.status, w.turns, w.model])).toEqual([
      [a.id, "open", 2, "groq/w"],
      [b.id, "closed", 1, "groq/w"],
    ]);
    expect(report.workers[0]!.cost.totalUsd).toBeCloseTo(2 * 0.004455, 9);
    expect(report.total.turns).toBe(4);
    expect(report.total.tokens.cacheRead).toBe(4 * 600);
    expect(report.total.cost.totalUsd).toBeCloseTo(4 * 0.004455, 9);
  });

  it("rebuilds the worker lines from disk after a restart, nested workers included", async () => {
    price("p");
    price("w");
    const root = tmp();
    // L1 starts a worker of its own (L2), which answers with text.
    const handler: Handler = (body) => {
      if (!/L1/.test(systemText(body))) return reply("leaf", body);
      return hasTool(body) ? reply("done", body) : callTool("subagents", { command: "spawn", name: "kid", instructions: "You are L2.", task: "go" }, body);
    };
    const before = mk(handler, { persist: { dir: root } });
    const top = await before.workers.spawn({ name: "top", instructions: "You are L1.", task: "start" });
    const live = before.usageReport();
    expect(live.workers[0]!.turns).toBe(2); // L1: the tool call and the final answer
    expect(live.workers[0]!.workers).toHaveLength(1);
    expect(live.workers[0]!.workers[0]!.turns).toBe(1);
    expect(live.total.turns).toBe(3);

    const after = mk(handler, { persist: { dir: root } }); // a new process: nothing is in memory
    const restored = after.usageReport();
    expect(restored.agent.turns).toBe(0);
    expect(restored.workers[0]).toMatchObject({ id: top.id, turns: 2, model: "groq/w" });
    expect(restored.workers[0]!.workers[0]).toMatchObject({ turns: 1, status: "open" });
    expect(restored.total.cost.totalUsd).toBeCloseTo(live.total.cost.totalUsd!, 9);
  });

  it("includes fixed `subagents` workers, each call's copy folded into its worker", async () => {
    price("p");
    price("w");
    const fixed = new Agent({ name: "Fixed", model: "groq/w", apiKey: "k", baseUrl: "https://example.test/v1", fetch: (async (_u: string, init: RequestInit) => reply("fixed answer", JSON.parse(String(init.body)))) as unknown as typeof fetch });
    const parent = new Agent({
      model: "groq/p",
      apiKey: "k",
      baseUrl: "https://example.test/v1",
      subagents: [fixed],
      fetch: (async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return hasTool(body) ? reply("all done", body) : callTool("fixed", { task: "do it" }, body);
      }) as unknown as typeof fetch,
    });
    const res = await parent.run("delegate");
    expect(res.usage.totalTokens).toBe(3 * 1200); // the response counts parent turn + fixed worker + parent turn
    const report = parent.usageReport();
    expect(report.agent.turns).toBe(2);
    expect(report.workers.map((w) => [w.id, w.status, w.turns])).toEqual([["Fixed", "fixed", 1]]);
    expect(report.total.turns).toBe(3);
    expect(report.total.tokens.total).toBe(res.usage.totalTokens); // the same tokens as the response, counted once
    expect(report.total.cost.totalUsd).toBeCloseTo(3 * 0.004455, 9);
  });

  it("adds up to the same tokens as the response when the model starts a worker with the subagents tool", async () => {
    price("p");
    price("w");
    const parent = mk((body) => {
      if (body.model === "w") return reply("worker text", body);
      return hasTool(body) ? reply("all done", body) : callTool("subagents", { command: "spawn", name: "r", task: "go" }, body);
    });
    const res = await parent.run("delegate");
    const report = parent.usageReport();
    expect([report.agent.turns, report.workers[0]!.turns]).toEqual([2, 1]);
    expect(report.total.tokens.total).toBe(res.usage.totalTokens);
    expect(report.total.cost.totalUsd).toBeCloseTo(res.usage.cost!.totalCost!, 9);
  });
});

describe("media usage details across turns", () => {
  it("accumulateUsage sums them, never mutates the source, and does not change the priced cost", async () => {
    const { accumulateUsage } = await import("../src/agent/loop.ts");
    const turn = { inputTokens: 100, outputTokens: 10, totalTokens: 110, inputDetails: { audioTokens: 30 }, outputDetails: { imageTokens: 2 } };
    const total: any = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    accumulateUsage(total, turn);
    accumulateUsage(total, turn);
    expect(total.inputDetails).toEqual({ audioTokens: 60 });
    expect(total.outputDetails).toEqual({ imageTokens: 4 });
    expect(turn.inputDetails).toEqual({ audioTokens: 30 });
  });
});
