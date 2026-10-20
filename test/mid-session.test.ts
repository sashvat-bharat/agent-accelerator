import { describe, it, expect, afterEach } from "bun:test";
import { Agent, tool, z, getProvider, type ProviderGenerateResult, type ProviderContext } from "../src/index.ts";

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
