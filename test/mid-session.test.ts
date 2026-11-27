import { describe, it, expect, afterEach } from "bun:test";
import { Agent, tool, getProvider, ValidationError, type ProviderContext } from "../src/index.ts";
import { sseFrame } from "./helpers.ts";
import { type ProviderGenerateResult } from "../src/types/model.ts";
import { z } from "zod";

const provider = getProvider("google") as any;
const realGenerate = provider.generate.bind(provider);
afterEach(() => {
  provider.generate = realGenerate;
});

const base = (text: string, extra: Partial<ProviderGenerateResult> = {}): ProviderGenerateResult => ({
  text,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  finishReason: "stop",
  model: "mock",
  provider: "google" as any,
  raw: { request: {} as any },
  durationMs: 1,
  ...extra,
});
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
};
const mkAgent = (tools: Record<string, any> = {}) =>
  new Agent({ model: "google/gemini-3.5-flash-lite", apiKey: "k", tools });

describe("steer / queue / interrupt", () => {
  it("steer during a tool turn is injected into the SAME run and resolves with its response", async () => {
    const seen: ProviderContext["messages"][] = [];
    let calls = 0;
    provider.generate = async (_m: unknown, ctx: ProviderContext) => {
      seen.push(JSON.parse(JSON.stringify(ctx.messages)));
      calls++;
      return calls === 1
        ? base("", { toolCalls: [{ id: "c1", name: "slow", arguments: {} }], finishReason: "tool_calls" })
        : base("final answer");
    };
    const g = gate();
    const agent = mkAgent({ slow: tool({ description: "slow", input: z.object({}), execute: async () => (await g.promise, "done") }) });
    const run = agent.run("start");
    await new Promise((r) => setTimeout(r, 10)); // tool is now running
    const steered = agent.steer("also do X");
    g.open();
    const [a, b] = await Promise.all([run, steered]);
    expect(a.text).toBe("final answer");
    expect(b).toBe(a); // same response object: the steer rode along in the active run
    expect(calls).toBe(2);
    const lastMsgs = seen[1]!;
    expect(lastMsgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect((lastMsgs[3] as any).content).toBe("also do X");
  });

  it("a steer that lands after the final drain still gets its own reply (runs as a follow-up)", async () => {
    let calls = 0;
    provider.generate = async () => base(calls++ === 0 ? "first" : "reply to late steer");
    const agent = mkAgent();
    let late: Promise<any> | undefined;
    // onTurn fires after the loop's last inbox drain, so this steer can no longer be injected.
    const run = agent.run("go", {
      onTurn: () => {
        if (!late) late = agent.steer("one more thing");
      },
    });
    const first = await run;
    expect(first.text).toBe("first");
    const lateRes = await late!;
    expect(lateRes.text).toBe("reply to late steer");
    expect(calls).toBe(2);
  });

  it("a late steer runs BEFORE follow-ups that were already queued, in arrival order", async () => {
    const order: string[] = [];
    const g = gate();
    provider.generate = async (_m: unknown, ctx: ProviderContext) => {
      const last = ctx.messages[ctx.messages.length - 1] as any;
      const text = typeof last.content === "string" ? last.content : "";
      if (text === "go") await g.promise;
      order.push(text);
      return base(`answer:${text}`);
    };
    const agent = mkAgent();
    let turns = 0;
    const run = agent.run("go", {
      onTurn: () => {
        if (turns++ === 0) {
          void agent.steer("late one");
          void agent.steer("late two");
        }
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    const queued = agent.queue("queued earlier");
    g.open();
    await run;
    await queued;
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["go", "late one", "late two", "queued earlier"]);
  });

  it("a fire-and-forget steer does not cause an unhandled rejection when the run fails", async () => {
    provider.generate = async () => {
      throw Object.assign(new Error("boom"), { statusCode: 400 });
    };
    const agent = mkAgent();
    const run = agent.run("go");
    void agent.steer("ignored promise");
    await expect(run).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20)); // a leaked rejection would crash the test process
  });

  it("queue runs the follow-up AFTER the active run, with its own response", async () => {
    const order: string[] = [];
    const g = gate();
    provider.generate = async (_m: unknown, ctx: ProviderContext) => {
      const last = ctx.messages[ctx.messages.length - 1] as any;
      const text = typeof last.content === "string" ? last.content : "";
      if (text === "first") await g.promise;
      order.push(text);
      return base(`answer:${text}`);
    };
    const agent = mkAgent();
    const first = agent.run("first");
    await new Promise((r) => setTimeout(r, 5));
    const second = agent.queue("second");
    g.open();
    const [a, b] = await Promise.all([first, second]);
    expect(a.text).toBe("answer:first");
    expect(b.text).toBe("answer:second");
    expect(order).toEqual(["first", "second"]);
  });

  it("interrupt() right after the model asks for a tool, then a new prompt: history is repaired in order", async () => {
    const requests: ProviderContext["messages"][] = [];
    const g = gate();
    let calls = 0;
    let ran = false;
    provider.generate = async (_m: unknown, ctx: ProviderContext) => {
      requests.push(JSON.parse(JSON.stringify(ctx.messages)));
      calls++;
      if (calls === 1) {
        await g.promise; // the user hits Stop while this model call is still in flight
        return base("", { toolCalls: [{ id: "c1", name: "rm", arguments: {} }], finishReason: "tool_calls" });
      }
      return base("ok, never mind");
    };
    const agent = mkAgent({
      rm: tool({
        description: "deletes",
        input: z.object({}),
        execute: async () => {
          ran = true;
          return "deleted";
        },
      }),
    });
    const run = agent.run("delete the files");
    await new Promise((r) => setTimeout(r, 10));
    agent.interrupt();
    g.open();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(ran).toBe(false); // the tool never started: the call is now an orphan in history

    const next = await agent.run("never mind");
    expect(next.text).toBe("ok, never mind");
    const sent = requests[requests.length - 1]!;
    // The call is immediately followed by its (placeholder) result, then the new user message.
    const roles = sent.map((m) => m.role);
    const callIdx = roles.indexOf("assistant");
    expect(roles.slice(callIdx, callIdx + 3)).toEqual(["assistant", "tool", "user"]);
    expect(((sent[callIdx + 1] as any).content[0] as any).id).toBe("c1");
  });
});

describe("a busy agent keeps each session's prompts in that session", () => {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  // A chat reply (streamed when asked): a tool call while the run's first turn has no tool result yet, then its answer.
  const reply = (body: any, message: Record<string, unknown>, finish: string): Response =>
    body.stream
      ? new Response(
          sseFrame({ id: "r", choices: [{ delta: message.tool_calls ? { tool_calls: (message.tool_calls as any[]).map((c, index) => ({ index, ...c })) } : { content: message.content } }] }) +
            sseFrame({ id: "r", choices: [{ delta: {}, finish_reason: finish }], usage }) +
            "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      : new Response(JSON.stringify({ id: "r", choices: [{ message: { role: "assistant", ...message }, finish_reason: finish }], usage }), { status: 200 });
  // Session A's run waits in its tool until `open()`; session B just answers. Every request's user prompts are recorded.
  const setup = (midSession?: Record<string, unknown>) => {
    const prompts: string[][] = [];
    const g = gate();
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const users = body.messages.filter((m: any) => m.role === "user").map((m: any) => m.content);
      prompts.push(users);
      if (users[0] === "start A" && !body.messages.some((m: any) => m.role === "tool"))
        return reply(body, { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "slow", arguments: "{}" } }] }, "tool_calls");
      return reply(body, { content: users[0] === "start A" ? "answer A" : `answer to ${users.at(-1)}` }, "stop");
    }) as unknown as typeof fetch;
    const slow = tool({ name: "slow", description: "slow", input: z.object({}), execute: async () => (await g.promise, "done") });
    const agent = new Agent({ model: "groq/m", apiKey: "k", baseUrl: "https://x/v1", fetch: fetchImpl, tools: { slow }, runRetries: 0, ...(midSession ? { midSession } : {}) });
    return { agent, prompts, open: g.open };
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("run() for another session waits for its own run instead of being steered in (midSession steer)", async () => {
    const { agent, prompts, open } = setup({ mode: "steer" });
    const a = agent.run("start A", { sessionId: "A" });
    await settle(); // A's tool is running
    const b = agent.run("B's question", { sessionId: "B" });
    open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.text).toBe("answer A");
    expect(rb.text).toBe("answer to B's question");
    expect(rb).not.toBe(ra);
    expect(prompts).toEqual([["start A"], ["start A"], ["B's question"]]); // A never saw B's text, B never saw A's
    // A prompt for A itself is still steered into A's run.
    const again = setup({ mode: "steer" });
    const a2 = again.agent.run("start A", { sessionId: "A" });
    await settle();
    const same = again.agent.run("more for A", { sessionId: "A" });
    again.open();
    expect(await same).toBe(await a2);
    expect(again.prompts.at(-1)).toEqual(["start A", "more for A"]);
  });

  it("stream() for another session gets its own run and its own answer", async () => {
    const { agent, prompts, open } = setup({ mode: "steer" });
    const a = agent.stream("start A", { sessionId: "A" }).result();
    await settle();
    const b = agent.stream("B's question", { sessionId: "B", enqueue: "steer" }).result();
    open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.text).toBe("answer A");
    expect(rb.text).toBe("answer to B's question");
    expect(prompts).toEqual([["start A"], ["start A"], ["B's question"]]);
    // A streamed steer for A itself still joins the streamed run of A.
    const again = setup({ mode: "steer" });
    const a2 = again.agent.stream("start A", { sessionId: "A" });
    await settle();
    const same = again.agent.stream("more for A", { sessionId: "A", enqueue: "steer" });
    again.open();
    expect(same).toBe(a2); // the active stream itself
    await a2.result();
    expect(again.prompts.at(-1)).toEqual(["start A", "more for A"]);
  });

  it("steer() for another session throws, and an enqueue: steer for another session is queued", async () => {
    const { agent, prompts, open } = setup();
    const a = agent.run("start A", { sessionId: "A" });
    await settle();
    // The error a call throws (a returned promise is caught, so a wrong answer fails fast instead of hanging).
    const thrown = (call: () => Promise<unknown>): unknown => {
      try {
        call().catch(() => {});
        return undefined;
      } catch (err) {
        return err;
      }
    };
    const other = thrown(() => agent.steer("B's question", { sessionId: "B" }));
    const unnamed = thrown(() => agent.steer("no session given")); // the agent's own session is another one
    const b = agent.run("B's question", { sessionId: "B", enqueue: "steer" });
    open();
    expect(other).toBeInstanceOf(ValidationError);
    expect(String((unnamed as Error | undefined)?.message)).toMatch(/session "A".*this prompt is for session/);
    expect((await b).text).toBe("answer to B's question");
    expect((await a).text).toBe("answer A");
    expect(prompts).toEqual([["start A"], ["start A"], ["B's question"]]);
  });
});
