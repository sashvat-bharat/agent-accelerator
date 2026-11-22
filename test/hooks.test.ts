import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { Agent, tool, ConfigError, telemetryBus } from "../src/index.ts";
import { chatReply, mockFetch, sseFrame, sseResponse } from "./helpers.ts";

const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
const callReply = (name: string, args: Record<string, unknown> = {}, id = "call_1"): Response =>
  new Response(
    JSON.stringify({
      id: "r",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
      usage,
    }),
    { status: 200 }
  );
const streamText = (text: string): Response =>
  sseResponse(
    sseFrame({ id: "s", choices: [{ index: 0, delta: { content: text } }] }) +
      sseFrame({ id: "s", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }) +
      "data: [DONE]\n\n"
  );
const mk = (fn: typeof fetch, extra: Record<string, unknown> = {}) =>
  new Agent({ model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", fetch: fn, runRetries: 0, ...extra });
const toolMessages = (body: any): string[] => body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);

describe("hooks: validation", () => {
  it("accepts no hooks and an empty object, refuses unknown keys, non-functions and non-objects", () => {
    expect(() => mk(chatReply as never)).not.toThrow();
    expect(() => mk(chatReply as never, { hooks: {} })).not.toThrow();
    expect(() => mk(chatReply as never, { hooks: { nope: () => {} } })).toThrow(ConfigError);
    expect(() => mk(chatReply as never, { hooks: { beforeTool: "x" } })).toThrow(ConfigError);
    expect(() => mk(chatReply as never, { hooks: [] })).toThrow(ConfigError);
  });
});

describe("hooks: beforeTool", () => {
  const mkTool = (runs: unknown[]) =>
    tool({ description: "pay", input: z.object({ amount: z.number() }), execute: async (a) => (runs.push(a), "paid") });

  it("can block a call: the tool never runs and the model reads the reason as an error", async () => {
    const runs: unknown[] = [];
    const { fn, calls } = mockFetch((n) => (n === 1 ? callReply("pay", { amount: 50 }) : chatReply("ok")));
    const agent = mk(fn, {
      tools: { pay: mkTool(runs) },
      hooks: { beforeTool: (call: any) => (call.arguments.amount > 10 ? { block: "needs approval over 10" } : undefined) },
    });
    const res = await agent.run("pay");
    expect(runs).toEqual([]);
    expect(toolMessages(calls[1])).toEqual(["Blocked: needs approval over 10"]);
    expect(res.toolResults[0]!.isError).toBe(true);
  });

  it("may be async (an approval prompt) and lets an approved call run", async () => {
    const runs: unknown[] = [];
    const { fn } = mockFetch((n) => (n === 1 ? callReply("pay", { amount: 5 }) : chatReply("ok")));
    const agent = mk(fn, {
      tools: { pay: mkTool(runs) },
      hooks: { beforeTool: async () => (await new Promise((r) => setTimeout(r, 20)), undefined) },
    });
    await agent.run("pay");
    expect(runs).toEqual([{ amount: 5 }]);
  });

  it("can rewrite the arguments, which are still validated against the tool's schema", async () => {
    const runs: unknown[] = [];
    const { fn, calls } = mockFetch((n) => (n < 3 ? callReply("pay", { amount: 500 }, `call_${n}`) : chatReply("ok")));
    let rewrite: unknown = { amount: 1 };
    const agent = mk(fn, { tools: { pay: mkTool(runs) }, hooks: { beforeTool: () => ({ arguments: rewrite as any }) } });
    await agent.run("pay");
    expect(runs[0]).toEqual({ amount: 1 }); // the tool ran with the rewritten value
    runs.length = 0;
    rewrite = { amount: "lots" };
    const again = mk(mockFetch((n) => (n === 1 ? callReply("pay", { amount: 5 }) : chatReply("ok"))).fn, {
      tools: { pay: mkTool(runs) },
      hooks: { beforeTool: () => ({ arguments: rewrite as any }) },
    });
    const res = await again.run("pay");
    expect(runs).toEqual([]);
    expect(String(res.toolResults[0]!.result)).toContain("Schema validation error");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("fails closed: a hook that throws blocks the call", async () => {
    const runs: unknown[] = [];
    const { fn } = mockFetch((n) => (n === 1 ? callReply("pay", { amount: 5 }) : chatReply("ok")));
    const agent = mk(fn, {
      tools: { pay: mkTool(runs) },
      hooks: {
        beforeTool: () => {
          throw new Error("approval service down");
        },
      },
    });
    const res = await agent.run("pay");
    expect(runs).toEqual([]);
    expect(String(res.toolResults[0]!.result)).toMatch(/Blocked: the beforeTool hook failed: approval service down/);
  });

  it("emits tool.call_blocked with reason hook_blocked", async () => {
    const seen: string[] = [];
    const off = telemetryBus.onEvent((e) => e.code === "tool.call_blocked" && seen.push(String((e.data as any).reason)));
    try {
      const { fn } = mockFetch((n) => (n === 1 ? callReply("pay", { amount: 5 }) : chatReply("ok")));
      await mk(fn, { tools: { pay: mkTool([]) }, hooks: { beforeTool: () => ({ block: "no" }) } }).run("pay");
    } finally {
      off();
    }
    expect(seen).toEqual(["hook_blocked"]);
  });
});

describe("hooks: afterTool", () => {
  const secret = tool({ description: "s", input: z.object({}), execute: async () => "token=abc123" });

  it("can replace a result before the model and the saved record see it", async () => {
    const { fn, calls } = mockFetch((n) => (n === 1 ? callReply("secret") : chatReply("ok")));
    const agent = mk(fn, {
      tools: { secret },
      hooks: { afterTool: (_c: any, r: any) => ({ result: String(r.result).replace(/abc123/, "[redacted]") }) },
    });
    const res = await agent.run("go");
    expect(toolMessages(calls[1])).toEqual(["token=[redacted]"]);
    expect(res.toolResults[0]!.result).toBe("token=[redacted]");
    expect(agent.toolRecords[0]!.result).toBe("token=[redacted]");
  });

  it("can mark a result as an error", async () => {
    const { fn } = mockFetch((n) => (n === 1 ? callReply("secret") : chatReply("ok")));
    const res = await mk(fn, { tools: { secret }, hooks: { afterTool: () => ({ isError: true }) } }).run("go");
    expect(res.toolResults[0]!.isError).toBe(true);
  });

  it("a hook that throws keeps the original result and warns on the bus", async () => {
    const codes: string[] = [];
    const off = telemetryBus.onEvent((e) => e.code === "hook.error" && codes.push(e.code));
    try {
      const { fn, calls } = mockFetch((n) => (n === 1 ? callReply("secret") : chatReply("ok")));
      await mk(fn, {
        tools: { secret },
        hooks: {
          afterTool: () => {
            throw new Error("boom");
          },
        },
      }).run("go");
      expect(toolMessages(calls[1])).toEqual(["token=abc123"]);
    } finally {
      off();
    }
    expect(codes).toEqual(["hook.error"]);
  });
});

describe("hooks: beforeRequest", () => {
  it("reshapes what is sent without touching the saved history", async () => {
    const { fn, calls } = mockFetch(() => chatReply("ok"));
    const agent = mk(fn, {
      instructions: "base",
      hooks: {
        beforeRequest: (messages: any[]) => ({
          messages: messages.slice(-1),
          systemPrompt: "shaped",
        }),
      },
    });
    await agent.run("first");
    await agent.run("second");
    const sent = calls[1];
    expect(sent.messages.filter((m: any) => m.role !== "system").map((m: any) => m.content)).toEqual(["second"]);
    expect(sent.messages[0]).toMatchObject({ role: "system", content: "shaped" });
    expect(agent.context.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]); // history kept
    expect(agent.context.systemPrompt).toBe("base");
  });

  it("gets a copy of the list (changing it does not change the history) and sees the turn", async () => {
    const turns: Array<number | undefined> = [];
    const { fn } = mockFetch(() => chatReply("ok"));
    const agent = mk(fn, {
      hooks: {
        beforeRequest: (messages: any[], ctx: any) => {
          turns.push(ctx.turn);
          messages.length = 0;
        },
      },
    });
    await agent.run("hi");
    expect(agent.context.messages).toHaveLength(2);
    expect(turns).toEqual([1]);
  });

  it("a hook that throws fails the run", async () => {
    const { fn } = mockFetch(() => chatReply("ok"));
    const agent = mk(fn, {
      hooks: {
        beforeRequest: () => {
          throw new Error("no");
        },
      },
    });
    await expect(agent.run("hi")).rejects.toThrow("no");
  });

  it("works the same on streams", async () => {
    const { fn, calls } = mockFetch(() => streamText("ok"));
    const agent = mk(fn, { hooks: { beforeRequest: () => ({ systemPrompt: "shaped" }) } });
    const res = await agent.stream("hi").result();
    expect(res.text).toBe("ok");
    expect(calls[0].messages[0]).toMatchObject({ role: "system", content: "shaped" });
  });
});

describe("hooks: onYield", () => {
  it("can keep the run going with a user message: one response, more turns, the message in history", async () => {
    const { fn, calls } = mockFetch((n) => chatReply(n === 1 ? "draft" : "final"));
    const seen: string[] = [];
    const agent = mk(fn, {
      hooks: {
        onYield: (turn: any) => {
          seen.push(turn.text);
          return turn.text === "draft" ? { continue: "now review it" } : undefined;
        },
      },
    });
    const res = await agent.run("write");
    expect(res.text).toBe("final");
    expect(res.turns).toBe(2);
    expect(seen).toEqual(["draft", "final"]);
    expect(calls[1].messages.filter((m: any) => m.role === "user").map((m: any) => m.content)).toEqual(["write", "now review it"]);
  });

  it("is bounded by maxTurns", async () => {
    const { fn, calls } = mockFetch(() => chatReply("again"));
    const agent = mk(fn, { maxTurns: 3, hooks: { onYield: () => ({ continue: "more" }) } });
    const res = await agent.run("go");
    expect(calls).toHaveLength(3);
    expect(res.turns).toBe(3);
  });

  it("works the same on streams", async () => {
    let n = 0;
    const { fn } = mockFetch(() => streamText(++n === 1 ? "draft" : "final"));
    const agent = mk(fn, { hooks: { onYield: (t: any) => (t.text === "draft" ? { continue: "again" } : undefined) } });
    const res = await agent.stream("go").result();
    expect(res.turns).toBe(2);
    expect(res.text).toBe("final");
  });

  it("refuses an empty continue message", async () => {
    const { fn } = mockFetch(() => chatReply("x"));
    const agent = mk(fn, { hooks: { onYield: () => ({ continue: "  " }) } });
    await expect(agent.run("go")).rejects.toThrow(/onYield/);
  });
});
