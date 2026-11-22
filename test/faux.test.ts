import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { Agent, tool, fauxProvider, ConfigError, ProviderError } from "../src/index.ts";

const mk = (faux: ReturnType<typeof fauxProvider>, extra: Record<string, unknown> = {}) =>
  new Agent({ ...faux.config, runRetries: 0, retry: { maxRetries: 0 }, ...extra });

describe("fauxProvider", () => {
  it("answers a string step as text, records the call and counts what is left", async () => {
    const faux = fauxProvider(["Hello!", "Second."]);
    const agent = mk(faux);
    expect(faux.remaining).toBe(2);
    const res = await agent.run("hi there");
    expect(res.text).toBe("Hello!");
    expect(res.finishReason).toBe("stop");
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(faux.calls).toHaveLength(1);
    expect(faux.calls[0]!.lastUserText).toBe("hi there");
    expect(faux.calls[0]!.stream).toBe(false);
    expect(faux.remaining).toBe(1);
    expect((await agent.run("again")).text).toBe("Second.");
  });

  it("scripts a tool loop: the tool runs with the scripted arguments and its result reaches the next call", async () => {
    const seen: unknown[] = [];
    const weather = tool({ description: "w", input: z.object({ city: z.string() }), execute: async (a) => (seen.push(a), "sunny") });
    const faux = fauxProvider([{ toolCalls: [{ name: "weather", arguments: { city: "Paris" } }] }, "It is sunny in Paris."]);
    const res = await mk(faux, { tools: { weather } }).run("weather?");
    expect(seen).toEqual([{ city: "Paris" }]);
    expect(res.text).toBe("It is sunny in Paris.");
    expect(res.turns).toBe(2);
    expect(faux.calls[0]!.toolNames).toEqual(["weather"]);
    const toolMsg = faux.calls[1]!.body.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toBe("sunny");
  });

  it("a function step decides from the request", async () => {
    const faux = fauxProvider([(req) => `you said: ${req.lastUserText} (call ${req.number})`]);
    expect((await mk(faux).run("ping")).text).toBe("you said: ping (call 1)");
  });

  it("streams real deltas, thinking and tool calls through the production adapter", async () => {
    const t = tool({ description: "t", input: z.object({ n: z.number() }), execute: async ({ n }) => String(n * 2) });
    const faux = fauxProvider([
      { thinking: "let me think about it", toolCalls: [{ name: "t", arguments: { n: 21 } }] },
      { text: "The answer is 42, as computed by the tool." },
    ]);
    const deltas: string[] = [];
    const thinking: string[] = [];
    const stream = mk(faux, { tools: { t } }).stream("compute");
    stream.on("text_delta", (e) => deltas.push(e.delta!));
    stream.on("thinking_delta", (e) => thinking.push(e.thinkingDelta!));
    const res = await stream.result();
    expect(res.text).toBe("The answer is 42, as computed by the tool.");
    expect(deltas.length).toBeGreaterThan(1);
    expect(thinking.join("")).toBe("let me think about it");
    expect(res.toolResults.map((r) => r.result)).toEqual(["42"]);
    expect(faux.calls.every((c) => c.stream)).toBe(true);
  });

  it("reports the usage, cost and finish reason you script", async () => {
    const faux = fauxProvider([{ text: "cut", usage: { inputTokens: 100, outputTokens: 7, cachedTokens: 40 }, cost: 0.0123, finishReason: "length" }]);
    const res = await mk(faux).run("x");
    expect(res.usage).toMatchObject({ inputTokens: 100, outputTokens: 7, cachedTokens: 40 });
    expect(res.usage.cost?.totalCost).toBe(0.0123);
    expect(res.finishReason).toBe("length");
  });

  it("scripts HTTP errors, and a run that fails on one", async () => {
    const faux = fauxProvider([{ error: { status: 429, message: "slow down", retryAfterSeconds: 1 } }, { error: { status: 400, message: "bad" } }]);
    const agent = mk(faux);
    const err = await agent.run("x").catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(429);
    expect(String(err.message)).toContain("slow down");
    await expect(agent.run("y")).rejects.toThrow(/bad/);
  });

  it("a run retries a scripted transient error like a real provider", async () => {
    const faux = fauxProvider([{ error: { status: 503, message: "overloaded" } }, "recovered"]);
    const res = await new Agent({ ...faux.config, retry: { maxRetries: 1, baseDelayMs: 1 } }).run("x");
    expect(res.text).toBe("recovered");
    expect(faux.calls).toHaveLength(2);
  });

  it("fails clearly when the script runs out, unless repeatLast is set", async () => {
    const faux = fauxProvider(["only one"]);
    const agent = mk(faux);
    await agent.run("a");
    await expect(agent.run("b")).rejects.toThrow(/no scripted reply left for call 2/);
    const loop = fauxProvider(["same"], { repeatLast: true });
    const a2 = mk(loop);
    expect((await a2.run("1")).text).toBe("same");
    expect((await a2.run("2")).text).toBe("same");
  });

  it("push and reset", async () => {
    const faux = fauxProvider(["a"]);
    faux.push("b");
    expect(faux.remaining).toBe(2);
    const agent = mk(faux);
    await agent.run("1");
    faux.reset();
    expect(faux.calls).toHaveLength(0);
    expect(faux.remaining).toBe(2);
    expect((await mk(faux).run("again")).text).toBe("a");
  });

  it("delayMs can be interrupted", async () => {
    const faux = fauxProvider([{ text: "late", delayMs: 5000 }]);
    const agent = mk(faux);
    const run = agent.run("x");
    setTimeout(() => agent.interrupt(), 20);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses the prefix you give and refuses a bad one", () => {
    expect(fauxProvider([], { prefix: "mock" }).config.model).toBe("mock/faux-model");
    expect(() => fauxProvider([], { prefix: "a/b" })).toThrow(ConfigError);
  });
});
