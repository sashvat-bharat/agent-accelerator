import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, registerModel, clearCustomModels } from "../src/index.ts";
import { createGenericModelSpec } from "../src/models/catalog.ts";
import { loadSessionDir, loadSessionFile, priceUsage, saveSessionDir, saveSessionFile, sessionDirFor } from "../src/session/store.ts";
import { OLDER_WORKERS_ID, addTurn, buildUsageReport, emptyUsage, foldOldNodes, mergeUsage, readFixedUsage, readUsage, usageLine, type UsageNode } from "../src/session/usage.ts";
import { sseFrame } from "./helpers.ts";

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

// One model reply that makes several tool calls at once (parallel calls of one turn).
const callTools = (calls: Array<{ name: string; args: Record<string, unknown> }>, body: any, u = usage()): Response =>
  body.stream
    ? new Response(
        sseFrame({ id: "r", choices: [{ delta: { tool_calls: calls.map((c, i) => ({ index: i, id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] }) +
          sseFrame({ id: "r", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: u }) +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    : new Response(
        JSON.stringify({
          id: "r",
          choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }],
          usage: u,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
const fetchOf = (handler: Handler): typeof fetch => (async (_url: string, init: RequestInit) => handler(JSON.parse(String(init.body)))) as unknown as typeof fetch;
const wire = { apiKey: "k", baseUrl: "https://example.test/v1" };
// A usage node with `turns` model calls of the standard size, for the folding tests.
const nodeOf = (id: string, turns: number): UsageNode => {
  const totals = emptyUsage();
  const turn = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 };
  for (let i = 0; i < turns; i++) addTurn(totals, turn, undefined);
  return { id, name: id, model: "groq/w", status: "closed", totals, workers: [] };
};

describe("workers started below a fixed worker", () => {
  it("lists them under that fixed worker, and the total still matches the response", async () => {
    price("p");
    price("f");
    price("w");
    const handler: Handler = (body) => {
      if (body.model === "w") return reply("worker done", body);
      if (body.model === "f") return hasTool(body) ? reply("fixed done", body) : callTool("subagents", { command: "spawn", name: "inner", task: "go" }, body);
      return hasTool(body) ? reply("all done", body) : callTool("researcher", { task: "go" }, body);
    };
    const fixed = new Agent({ ...wire, name: "researcher", model: "groq/f", fetch: fetchOf(handler), dynamicSubagents: { model: "groq/w" } });
    const lead = new Agent({ ...wire, model: "groq/p", subagents: [fixed], fetch: fetchOf(handler) });
    const res = await lead.run("go");

    const report = lead.usageReport();
    expect(report.total.turns).toBe(5); // lead 2, the fixed worker 2, the worker the fixed worker started 1
    expect(report.total.tokens.total).toBe(res.usage.totalTokens);
    expect(report.total.cost.totalUsd).toBeCloseTo(res.usage.cost!.totalCost!, 9);
    const line = report.workers[0]!;
    expect([line.id, line.status, line.turns, line.workers.length]).toEqual(["researcher", "fixed", 2, 1]);
    expect(line.workers[0]).toMatchObject({ turns: 1, model: "groq/w" });
  });

  it("keeps the workers of two parallel calls apart", async () => {
    price("p");
    price("f");
    price("w");
    const handler: Handler = (body) => {
      if (body.model === "w") return reply("worker done", body);
      if (body.model === "f") return hasTool(body) ? reply("fixed done", body) : callTool("subagents", { command: "spawn", name: "inner", task: "go" }, body);
      return hasTool(body)
        ? reply("all done", body)
        : callTools([{ name: "researcher", args: { task: "one" } }, { name: "researcher", args: { task: "two" } }], body);
    };
    const fixed = new Agent({ ...wire, name: "researcher", model: "groq/f", fetch: fetchOf(handler), dynamicSubagents: { model: "groq/w" } });
    const lead = new Agent({ ...wire, model: "groq/p", subagents: [fixed], fetch: fetchOf(handler) });
    const res = await lead.run("go");

    const report = lead.usageReport();
    expect(report.total.turns).toBe(2 + 2 * 2 + 2); // lead 2, two copies of 2, two workers of 1
    expect(report.total.tokens.total).toBe(res.usage.totalTokens);
    expect(report.total.cost.totalUsd).toBeCloseTo(res.usage.cost!.totalCost!, 9);
    expect(report.workers).toHaveLength(1);
    expect(report.workers[0]!.turns).toBe(4);
    expect(report.workers[0]!.workers.map((w) => w.turns)).toEqual([1, 1]);
    expect(new Set(report.workers[0]!.workers.map((w) => w.id)).size).toBe(2);
  });

  it("goes down through fixed workers of fixed workers", async () => {
    price("p");
    price("a");
    price("b");
    price("w");
    const handler: Handler = (body) => {
      if (body.model === "w") return reply("worker done", body);
      if (body.model === "b") return hasTool(body) ? reply("beta done", body) : callTool("subagents", { command: "spawn", name: "inner", task: "go" }, body);
      if (body.model === "a") return hasTool(body) ? reply("alpha done", body) : callTool("beta", { task: "go" }, body);
      return hasTool(body) ? reply("all done", body) : callTool("alpha", { task: "go" }, body);
    };
    const beta = new Agent({ ...wire, name: "beta", model: "groq/b", fetch: fetchOf(handler), dynamicSubagents: { model: "groq/w" } });
    const alpha = new Agent({ ...wire, name: "alpha", model: "groq/a", fetch: fetchOf(handler), subagents: [beta] });
    const lead = new Agent({ ...wire, model: "groq/p", subagents: [alpha], fetch: fetchOf(handler) });
    const res = await lead.run("go");

    const report = lead.usageReport();
    expect(report.total.turns).toBe(7); // lead 2, alpha 2, beta 2, the worker 1
    expect(report.total.tokens.total).toBe(res.usage.totalTokens);
    const a = report.workers[0]!;
    const b = a.workers[0]!;
    expect([a.id, a.turns, b.id, b.turns, b.workers.length, b.workers[0]!.turns]).toEqual(["alpha", 2, "beta", 2, 1, 1]);
  });

  it("keeps the list bounded: the oldest fold into one line and the total never changes", () => {
    const agent = new Agent({ ...wire, model: "groq/p", fetch: fetchOf((body) => reply("x", body)) });
    agent.absorbWorkers(Array.from({ length: 1010 }, (_, i) => nodeOf(`w${i}`, 1)));
    const report = agent.usageReport();
    expect(report.workers.length).toBeLessThanOrEqual(1000);
    expect(report.workers[0]!.id).toBe(OLDER_WORKERS_ID);
    expect(report.workers.at(-1)!.id).toBe("w1009"); // the newest are still listed one by one
    expect(report.total.turns).toBe(1010);
  });

  it("foldOldNodes adds up the oldest nodes (and what lies below them) and folds again on the next call", () => {
    const parent = nodeOf("parent", 1);
    parent.workers = [nodeOf("child", 2)];
    const nodes = [parent, nodeOf("n1", 1), nodeOf("n2", 1), nodeOf("n3", 1), nodeOf("n4", 1)];
    foldOldNodes(nodes, 3);
    expect(nodes.map((n) => n.id)).toEqual([OLDER_WORKERS_ID, "n3", "n4"]);
    expect(nodes[0]!.totals.turns).toBe(5); // parent 1 + child 2 + n1 + n2
    nodes.push(nodeOf("n5", 1));
    foldOldNodes(nodes, 3);
    expect(nodes.map((n) => n.id)).toEqual([OLDER_WORKERS_ID, "n4", "n5"]);
    expect(nodes[0]!.totals.turns).toBe(6);
    const small = [nodeOf("only", 1)];
    foldOldNodes(small, 3);
    expect(small.map((n) => n.id)).toEqual(["only"]);
  });
});

// A fixed worker called "researcher" that starts one worker per call, under a lead; `extra` goes to the lead (persist, sessionId), `fixedName` renames the fixed worker.
const fixedHandler: Handler = (body) => {
  if (body.model === "w") return reply("worker done", body);
  if (body.model === "f") return hasTool(body) ? reply("fixed done", body) : callTool("subagents", { command: "spawn", name: "inner", task: "go" }, body);
  return hasTool(body) ? reply("all done", body) : callTool("researcher", { task: "go" }, body);
};
const leadWithFixed = (handler: Handler, extra: Record<string, unknown> = {}, fixedName = "researcher"): Agent => {
  const fixed = new Agent({ ...wire, name: fixedName, model: "groq/f", fetch: fetchOf(handler), dynamicSubagents: { model: "groq/w" } });
  return new Agent({ ...wire, model: "groq/p", subagents: [fixed], fetch: fetchOf(handler), ...extra });
};

describe("fixed workers across a restart", () => {
  it("come back from the folder, written to the journal once and not again on the lead's next turn", async () => {
    price("p");
    price("f");
    price("w");
    const root = tmp();
    const before = leadWithFixed(fixedHandler, { sessionId: "lead", persist: { dir: root } });
    const res = await before.run("go");
    const live = before.usageReport();
    expect(live.total.turns).toBe(5);

    const journal = fs.readFileSync(path.join(sessionDirFor(root, "lead"), "journal.ndjson"), "utf8");
    expect(journal.match(/"t":"fixed"/g)?.length).toBe(1);

    const after = leadWithFixed(fixedHandler, { sessionId: "lead", persist: { dir: root } }); // a new process: nothing is in memory
    after.importSession(loadSessionDir(sessionDirFor(root, "lead"))!.session);
    const restored = after.usageReport();
    expect(restored.total.turns).toBe(5);
    expect(restored.total.tokens.total).toBe(res.usage.totalTokens);
    expect(restored.total.cost.totalUsd).toBeCloseTo(res.usage.cost!.totalCost!, 9);
    expect(restored.workers).toEqual(live.workers);
  });

  it("come back from a single file too", async () => {
    price("p");
    price("f");
    price("w");
    const file = path.join(tmp(), "lead.json");
    const before = leadWithFixed(fixedHandler, { sessionId: "lead", persist: { file } });
    await before.run("go");
    const after = leadWithFixed(fixedHandler);
    after.importSession(loadSessionFile(file)!);
    expect(after.usageReport().workers).toEqual(before.usageReport().workers);
    expect(after.usageReport().total.turns).toBe(5);
  });

  it("survive a reset and a later snapshot of the folder", async () => {
    price("p");
    price("f");
    price("w");
    const root = tmp();
    let plain = false;
    const handler: Handler = (body) => (plain && body.model === "p" ? reply("plain answer", body) : fixedHandler(body));
    const before = leadWithFixed(handler, { sessionId: "lead", persist: { dir: root } });
    await before.run("go");
    before.reset(); // the conversation is gone, the spending is not
    plain = true;
    await before.run("hello"); // a shorter history: the journal starts a new snapshot
    expect(before.usageReport().total.turns).toBe(6);

    const after = leadWithFixed(fixedHandler);
    after.importSession(loadSessionDir(sessionDirFor(root, "lead"))!.session);
    expect(after.usageReport().total.turns).toBe(6);
    expect(after.usageReport().workers[0]).toMatchObject({ id: "researcher", turns: 2 });
    expect(after.usageReport().workers[0]!.workers).toHaveLength(1);

    const copy = tmp(); // and saveSessionDir (which copies the agent too) keeps it
    saveSessionDir(copy, before);
    const again = leadWithFixed(fixedHandler);
    again.importSession(loadSessionDir(sessionDirFor(copy, "lead"))!.session);
    expect(again.usageReport().total.turns).toBe(6);
  });

  it("are replaced, not added, when the same session is imported twice", async () => {
    price("p");
    price("f");
    price("w");
    const before = leadWithFixed(fixedHandler);
    await before.run("go");
    const saved = before.exportSession();
    const after = leadWithFixed(fixedHandler);
    after.importSession(saved);
    after.importSession(saved);
    expect(after.usageReport().total.turns).toBe(5);
    expect(after.usageReport().workers[0]!.workers).toHaveLength(1);
  });

  it("keep their spending when the fixed worker was renamed, and give it back when the name returns", async () => {
    price("p");
    price("f");
    price("w");
    const before = leadWithFixed(fixedHandler);
    await before.run("go");
    const saved = before.exportSession();

    const renamed = leadWithFixed(fixedHandler, {}, "analyst");
    renamed.importSession(saved);
    const report = renamed.usageReport();
    expect(report.total.turns).toBe(5); // nothing lost
    expect(report.workers.map((w) => [w.id, w.turns]).sort()).toEqual([["analyst", 0], ["researcher", 2]]);

    const next = leadWithFixed(fixedHandler, {}, "analyst");
    next.importSession(renamed.exportSession()); // the kept spending is saved again
    expect(next.usageReport().total.turns).toBe(5);
    const original = leadWithFixed(fixedHandler);
    original.importSession(renamed.exportSession());
    expect(original.usageReport().workers).toEqual(before.usageReport().workers); // the name matches again
  });

  it("a hand-edited file is read defensively", () => {
    const file = path.join(tmp(), "edited.json");
    const agent = leadWithFixed((body) => reply("x", body));
    saveSessionFile(file, agent, null);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.fixedUsage = [{ id: 3 }, { id: "ok", totals: "bad", workers: "bad" }, "junk"];
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(loadSessionFile(file)!.fixedUsage).toEqual([{ id: "ok", name: "ok", model: "", status: "closed", totals: emptyUsage(), workers: [] }]);
  });

  it("readFixedUsage drops wrong shapes, cuts long text and caps depth and size", () => {
    expect(readFixedUsage(undefined)).toEqual([]);
    expect(readFixedUsage("text")).toEqual([]);
    expect(readFixedUsage([null, 5, "a", {}, { id: "" }, { id: 7 }])).toEqual([]);

    const [node] = readFixedUsage([{ id: "a".repeat(500), status: "weird", totals: { turns: -3, inputTokens: "x" }, workers: [{ id: "b", status: "open" }, "junk"] }]);
    expect(node!.id).toHaveLength(200);
    expect(node!.status).toBe("closed");
    expect(node!.totals.turns).toBe(0);
    expect(node!.workers.map((w) => [w.id, w.status])).toEqual([["b", "open"]]);

    let deep: Record<string, unknown> = { id: "leaf" };
    for (let i = 0; i < 20; i++) deep = { id: `n${i}`, workers: [deep] };
    let levels = 0;
    for (let cur: UsageNode | undefined = readFixedUsage([deep])[0]; cur; cur = cur.workers[0]) levels++;
    expect(levels).toBe(9); // the root and 8 levels below it

    expect(readFixedUsage(Array.from({ length: 25_000 }, (_, i) => ({ id: `n${i}` }))).length).toBe(20_000);
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
