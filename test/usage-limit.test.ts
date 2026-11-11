import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, BudgetExceededError, ConfigError, loadSessionDir } from "../src/index.ts";
import { buildDynamicWorkerConfig } from "../src/agent/worker.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accel-usagelimit-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
// A reply of `text` (or tool calls) that spends `tokens` (and reports `cost` when given), plain or streamed as the request asks.
function reply(body: any, opts: { text?: string; calls?: Array<{ id: string; name: string; args: object }>; tokens?: number; cost?: number }): Response {
  const tokens = opts.tokens ?? 4;
  const usage = { prompt_tokens: tokens - 1, completion_tokens: 1, total_tokens: tokens, ...(opts.cost !== undefined ? { cost: opts.cost } : {}) };
  const message = opts.calls
    ? { role: "assistant", content: null, tool_calls: opts.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
    : { role: "assistant", content: opts.text ?? "ok" };
  const finish = opts.calls ? "tool_calls" : "stop";
  if (body.stream) {
    const delta: Record<string, unknown> = opts.calls
      ? { tool_calls: opts.calls.map((c, index) => ({ index, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
      : { content: opts.text ?? "ok" };
    return new Response(sse({ id: "r", choices: [{ delta }] }) + sse({ id: "r", choices: [{ delta: {}, finish_reason: finish }], usage }) + "data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
  return new Response(JSON.stringify({ id: "r", choices: [{ message, finish_reason: finish }], usage }), { status: 200, headers: { "content-type": "application/json" } });
}

type Handler = (body: any, n: number) => Response;
function make(handler: Handler, extra: Record<string, unknown> = {}) {
  const bodies: any[] = [];
  const agent = new Agent({
    model: "groq/p",
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    sessionId: "chat1",
    runRetries: 0,
    retry: { maxRetries: 0 },
    fetch: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return handler(body, bodies.length);
    }) as unknown as typeof fetch,
    ...extra,
  });
  return { agent, bodies };
}
const ctx = { toolCallId: "call_1", log: () => {}, stop: (): never => { throw new Error("stop"); } } as any;

describe("usageLimit: validation", () => {
  it("accepts maxCostUsd / maxTotalTokens and rejects anything else with a ConfigError", () => {
    expect(() => make(() => reply({}, {}), { usageLimit: { maxTotalTokens: 10 } })).not.toThrow();
    for (const bad of [{}, { maxCostUsd: 0 }, { maxTotalTokens: -1 }, { maxCostUsd: "5" }, { maxTotalTokens: Infinity }, { maxTurns: 3 }, "x"]) {
      expect(() => make(() => reply({}, {}), { usageLimit: bad })).toThrow(ConfigError);
    }
  });
});

describe("usageLimit: one cap for the whole chat", () => {
  it("counts every run of the chat (it never resets) and stops before the next request", async () => {
    const { agent, bodies } = make((b) => reply(b, { tokens: 4 }), { usageLimit: { maxTotalTokens: 10 } });
    await agent.run("one"); // 4
    await agent.run("two"); // 8
    await expect(agent.run("three")).rejects.toThrow(/Usage limit reached.*12 of 10 tokens/); // 12 >= 10: stopped right after this turn
    const calls = bodies.length;
    expect(calls).toBe(3);
    const err = await agent.run("four").catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(String(err.message)).toContain("Usage limit reached");
    expect(bodies.length).toBe(calls); // refused before any request
  });

  it("a cost cap uses the provider-reported cost; unknown pricing adds tokens but no cost", async () => {
    const priced = make((b) => reply(b, { cost: 0.01 }), { usageLimit: { maxCostUsd: 0.025 } });
    await priced.agent.run("a");
    await priced.agent.run("b");
    await expect(priced.agent.run("c")).rejects.toThrow(/Usage limit reached: \$0\.030000 of \$0\.025/);
    const unpriced = make((b) => reply(b, { tokens: 1000 }), { usageLimit: { maxCostUsd: 0.000001 } });
    for (let i = 0; i < 3; i++) await unpriced.agent.run(`q${i}`); // no price known: never reaches a cost cap
  });

  it("workers count into the cap, and a worker started after the cap is reached is refused without a request", async () => {
    const { agent, bodies } = make(
      (b) => {
        if (b.model === "w") return reply(b, { text: "worker says hi", tokens: 6 });
        return b.messages.some((m: any) => m.role === "tool")
          ? reply(b, { text: "all done", tokens: 4 })
          : reply(b, { calls: [{ id: "c1", name: "subagents", args: { command: "spawn", name: "r", task: "go" } }], tokens: 4 });
      },
      { usageLimit: { maxTotalTokens: 12 }, dynamicSubagents: { model: "groq/w" } }
    );
    // parent turn 4 + worker 6 = 10 < 12: the parent's second turn (4) reaches 14 >= 12 and stops the run right after it.
    await expect(agent.run("delegate")).rejects.toThrow(/Usage limit reached/);
    expect(bodies.filter((b) => b.model === "w").length).toBe(1);
    const before = bodies.length;
    const spawned = String(await agent.tools["subagents"]!.execute({ command: "spawn", name: "again", task: "x" }, ctx));
    expect(spawned).toContain("Usage limit reached");
    expect(bodies.length).toBe(before); // the worker never reached the provider
  });

  it("fixed subagents count into the parent's cap too", async () => {
    const helper = new Agent({ name: "helper", model: "groq/h", apiKey: "k", baseUrl: "https://example.test/v1", runRetries: 0, fetch: (async (_u: string, init: RequestInit) => reply(JSON.parse(String(init.body)), { text: "h says hi", tokens: 6 })) as unknown as typeof fetch });
    const { agent } = make(
      (b) =>
        b.messages.some((m: any) => m.role === "tool")
          ? reply(b, { text: "done", tokens: 2 })
          : reply(b, { calls: [{ id: "c1", name: "helper", args: { task: "go" } }], tokens: 2 }),
      { usageLimit: { maxTotalTokens: 10 }, subagents: [helper] }
    );
    // 2 + helper 6 + 2 = 10 >= 10
    await expect(agent.run("delegate")).rejects.toThrow(/Usage limit reached: 10 of 10 tokens/);
  });

  it("survives a restart: a persisted chat starts from what its saved sessions already spent", async () => {
    const root = tmp();
    const restart = (): ReturnType<typeof make> => {
      const next = make((b) => reply(b, { tokens: 4 }), { usageLimit: { maxTotalTokens: 10 }, persist: { dir: root } });
      const saved = loadSessionDir(path.join(root, "chat1"));
      if (saved) next.agent.importSession(saved.session); // how a chat is continued after a restart
      return next;
    };
    const first = restart();
    await first.agent.run("one");
    await first.agent.run("two"); // 8 spent, saved with the session
    const second = restart();
    await expect(second.agent.run("three")).rejects.toThrow(/Usage limit reached: 12 of 10/); // 8 from before + this turn
    expect(second.bodies.length).toBe(1);
    // A later process that finds the limit already spent does not even make a request.
    const third = restart();
    await expect(third.agent.run("four")).rejects.toThrow(/Usage limit reached/);
    expect(third.bodies.length).toBe(0);
  });

  it("a persisted worker's saved spending counts after a restart too", async () => {
    const root = tmp();
    const handler = (b: any) =>
      b.model === "w"
        ? reply(b, { text: "worker says hi", tokens: 6 })
        : b.messages.some((m: any) => m.role === "tool")
          ? reply(b, { text: "all done", tokens: 2 })
          : reply(b, { calls: [{ id: "c1", name: "subagents", args: { command: "spawn", name: "r", task: "go" } }], tokens: 2 });
    const mk = () =>
      make(handler, { usageLimit: { maxTotalTokens: 12 }, persist: { dir: root }, dynamicSubagents: { model: "groq/w" } });
    const first = mk();
    await first.agent.run("delegate"); // 2 + 6 + 2 = 10 < 12, saved (the worker's 6 lives in its own saved session)
    const second = mk();
    second.agent.importSession(loadSessionDir(path.join(root, "chat1"))!.session);
    await expect(second.agent.run("more")).rejects.toThrow(/Usage limit reached: 1[2-9] of 12/); // 10 saved + this turn (4)
  });

  it("without a usageLimit nothing is counted or checked; scheduled-style workers never get the chat's cap", async () => {
    const { agent } = make((b) => reply(b, { tokens: 1_000_000 }), { dynamicSubagents: { model: "groq/w", tools: {} } });
    await agent.run("a");
    await agent.run("b");
    expect(agent.chat).toBeUndefined();
    const limited = make((b) => reply(b, { tokens: 4 }), { usageLimit: { maxTotalTokens: 1 }, dynamicSubagents: { model: "groq/w", tools: {} } });
    const oneShot = new Agent(buildDynamicWorkerConfig(limited.agent, { name: "job", instructions: "i", sessionId: "s", tools: {} }));
    expect(oneShot.chat).toBeUndefined();
  });
});
