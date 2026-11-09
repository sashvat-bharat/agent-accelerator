import { describe, it, expect, afterEach } from "bun:test";
import { z } from "zod";
import { Agent, tool, ConfigError, telemetryBus } from "../src/index.ts";
import { RUN_RETRY_DELAYS_MS } from "../src/agent/agent.ts";

const realDelays = [...RUN_RETRY_DELAYS_MS];
afterEach(() => {
  RUN_RETRY_DELAYS_MS.splice(0, RUN_RETRY_DELAYS_MS.length, ...realDelays);
});
const fastRetries = (ms = 1) => RUN_RETRY_DELAYS_MS.splice(0, RUN_RETRY_DELAYS_MS.length, ms, ms, ms, ms);

const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (t: string) => json({ id: "r", choices: [{ message: { role: "assistant", content: t }, finish_reason: "stop" }], usage });
const fail = (status: number) => json({ error: { message: `http ${status}` } }, status);
const toolCall = (name: string) =>
  json({ id: "r", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: "{}" } }] } }], usage });

// An agent whose provider answers with the given sequence; the provider's own retry is off so each attempt is one request.
function agentWith(answers: Array<() => Response>, extra: Record<string, unknown> = {}) {
  const bodies: any[] = [];
  let n = 0;
  const agent = new Agent({
    model: "groq/test-model",
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    retry: { maxRetries: 0 },
    fetch: (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return answers[Math.min(n++, answers.length - 1)]!();
    }) as unknown as typeof fetch,
    ...extra,
  });
  return { agent, bodies };
}
const codes = (): { seen: string[]; off: () => void } => {
  const seen: string[] = [];
  return { seen, off: telemetryBus.onEvent((e) => seen.push(e.code)) };
};

describe("failed-run retry", () => {
  it("tries a transient failure again from the same conversation and then succeeds", async () => {
    fastRetries();
    const { seen, off } = codes();
    const { agent, bodies } = agentWith([() => fail(503), () => fail(503), () => text("finally")]);
    try {
      const res = await agent.run("hello");
      expect(res.text).toBe("finally");
      expect(bodies).toHaveLength(3);
      expect(bodies.at(-1).messages.filter((m: any) => m.role === "user")).toHaveLength(1); // the prompt is not added again
      expect(seen.filter((c) => c === "agent.run_retry")).toHaveLength(2);
    } finally {
      off();
    }
  });

  it("gives up after runRetries and surfaces the provider error", async () => {
    fastRetries();
    const { agent, bodies } = agentWith([() => fail(503)], { runRetries: 2 });
    await expect(agent.run("hello")).rejects.toThrow(/503/);
    expect(bodies).toHaveLength(3); // 1 attempt + 2 retries
  });

  it("runRetries: 0 turns it off", async () => {
    const { agent, bodies } = agentWith([() => fail(503)], { runRetries: 0 });
    await expect(agent.run("hello")).rejects.toThrow();
    expect(bodies).toHaveLength(1);
  });

  it("never retries a bad key or a bad request", async () => {
    fastRetries();
    for (const status of [400, 401, 403, 404]) {
      const { agent, bodies } = agentWith([() => fail(status)]);
      await expect(agent.run("hello")).rejects.toThrow();
      expect(bodies).toHaveLength(1);
    }
  });

  it("does not repeat a tool that already ran: the retry continues after its result", async () => {
    fastRetries();
    let ran = 0;
    const lookup = tool({ description: "d", input: z.object({}), execute: async () => `result ${++ran}` });
    const { agent, bodies } = agentWith([() => toolCall("lookup"), () => fail(503), () => text("done")], { tools: { lookup } });
    const res = await agent.run("go");
    expect(res.text).toBe("done");
    expect(ran).toBe(1);
    expect(bodies).toHaveLength(3);
    expect(bodies[2].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content)).toEqual(["result 1"]);
    expect(res.toolResults.map((r) => r.result)).toEqual(["result 1"]); // the first attempt's work is reported, not hidden
    expect(res.toolCalls).toHaveLength(1);
    expect(res.usage.totalTokens).toBe(8); // the tool turn (4) + the final turn (4)
  });

  it("reports the workers of a failed attempt in the final response", async () => {
    fastRetries();
    const sse = (t: string) =>
      new Response(`data: ${JSON.stringify({ id: "w", choices: [{ delta: { content: t }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const helper = new Agent({
      name: "helper",
      model: "groq/test-model",
      apiKey: "k",
      baseUrl: "https://example.test/v1",
      fetch: (async () => sse("worker answer")) as unknown as typeof fetch,
    });
    const callHelper = () =>
      json({ id: "r", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "helper", arguments: '{"task":"look it up"}' } }] } }], usage });
    const { agent, bodies } = agentWith([callHelper, () => fail(503), () => text("done")], { subagents: [helper] });
    const res = await agent.run("go");
    expect(res.text).toBe("done");
    expect(bodies).toHaveLength(3);
    expect(res.subagents.map((s) => [s.name, s.text])).toEqual([["helper", "worker answer"]]); // attempt 1's worker is not lost
    expect(res.usage.totalTokens).toBe(12); // tool turn (4) + worker (4) + final turn (4), nothing counted twice
  });

  it("keeps the agent busy while it waits, so a new run() queues behind the retry", async () => {
    RUN_RETRY_DELAYS_MS.splice(0, RUN_RETRY_DELAYS_MS.length, 60, 60, 60, 60);
    const { agent, bodies } = agentWith([() => fail(503), () => text("one"), () => text("two")]);
    const first = agent.run("first");
    await new Promise((r) => setTimeout(r, 20)); // inside the wait
    expect(agent.isBusy).toBe(true);
    const second = agent.run("second"); // queued, not started in between
    expect((await first).text).toBe("one");
    expect((await second).text).toBe("two");
    expect(bodies.map((b) => b.messages.filter((m: any) => m.role === "user").length)).toEqual([1, 1, 2]);
  });

  it("an interrupt during the wait ends the run as aborted, with no further request", async () => {
    RUN_RETRY_DELAYS_MS.splice(0, RUN_RETRY_DELAYS_MS.length, 5_000, 5_000, 5_000, 5_000);
    const { agent, bodies } = agentWith([() => fail(503)]);
    const run = agent.run("hello");
    await new Promise((r) => setTimeout(r, 20));
    agent.interrupt();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(bodies).toHaveLength(1);
  });

  it("does not apply to stream()", async () => {
    fastRetries();
    const { agent, bodies } = agentWith([() => fail(503), () => text("late")]);
    await expect(agent.stream("hello").result()).rejects.toThrow();
    expect(bodies).toHaveLength(1);
  });

  it("rejects a bad runRetries", () => {
    for (const bad of [-1, 1.5, "3" as never]) {
      expect(() => new Agent({ model: "google/gemini-3.5-flash-lite", runRetries: bad })).toThrow(ConfigError);
    }
  });
});
