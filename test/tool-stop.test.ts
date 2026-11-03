import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { Agent, tool } from "../src/index.ts";
import { loadSessionDir, sessionDirFor, JOURNAL_FILE } from "../src/session/store.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accel-stop-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => {});

const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const text = (t: string) => json({ id: "r", choices: [{ message: { role: "assistant", content: t }, finish_reason: "stop" }], usage });
const sse = (...chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
const streamedCall = (name: string) =>
  sse(
    { id: "r", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name, arguments: "{}" } }] } }] },
    { id: "r", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }
  );
const calls = (...names: string[]) => callsWith({}, ...names);
const callsWith = (args: Record<string, unknown>, ...names: string[]) =>
  json({
    id: "r",
    choices: [
      {
        finish_reason: "tool_calls",
        message: { role: "assistant", content: "calling", tool_calls: names.map((n, i) => ({ id: `call_${i}`, type: "function", function: { name: n, arguments: JSON.stringify(args) } })) },
      },
    ],
    usage,
  });

function mk(tools: Record<string, any>, answers: Array<() => Response>, extra: Record<string, unknown> = {}) {
  const bodies: any[] = [];
  let n = 0;
  const agent = new Agent({
    model: "groq/test-model",
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    sessionId: "s1",
    tools,
    runRetries: 0,
    fetch: (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), answers[Math.min(n++, answers.length - 1)]!())) as unknown as typeof fetch,
    ...extra,
  });
  return { agent, bodies };
}
const pay = (ask: () => boolean | Promise<boolean>, ran: { after: boolean }) =>
  tool({
    description: "pay",
    input: z.object({}),
    execute: async (_i, ctx) => {
      if (!(await ask())) ctx.stop("user declined the payment");
      ran.after = true; // must never run after a stop
      return "paid";
    },
  });

describe("ctx.stop", () => {
  it("ends the run with finishReason stopped, records the reason as the result and makes no further model turn", async () => {
    const ran = { after: false };
    const { agent, bodies } = mk({ pay: pay(async () => false, ran) }, [() => calls("pay"), () => text("never asked")]);
    const res = await agent.run("pay the invoice");
    expect(res.finishReason).toBe("stopped");
    expect(bodies).toHaveLength(1);
    expect(ran.after).toBe(false); // ctx.stop unwinds the tool's code
    expect(res.toolResults).toHaveLength(1);
    expect(res.toolResults[0]).toMatchObject({ name: "pay", result: "user declined the payment", isError: false, stopped: true });
    expect(res.text).toBe("calling"); // the last thing the model said
  });

  it("the agent waits for the next user message, and the model then sees the reason as the tool's result", async () => {
    const ran = { after: false };
    const { agent, bodies } = mk({ pay: pay(async () => false, ran) }, [() => calls("pay"), () => text("ok, cancelled")]);
    await agent.run("pay the invoice");
    const next = await agent.run("never mind, cancel it");
    expect(next.text).toBe("ok, cancelled");
    const roles = bodies[1].messages.map((m: any) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "user"]); // a bridge turn keeps strict APIs happy
    expect(bodies[1].messages.find((m: any) => m.role === "tool").content).toBe("user declined the payment");
  });

  it("lets every other call of the same batch finish before the run ends", async () => {
    const order: string[] = [];
    const a = tool({ description: "a", input: z.object({}), execute: async (_i, ctx) => (order.push("a stops"), ctx.stop("no")) });
    const b = tool({ description: "b", input: z.object({}), execute: async () => (await settle(40), order.push("b done"), "B result") });
    const { agent, bodies } = mk({ a, b }, [() => calls("a", "b"), () => text("never")]);
    const res = await agent.run("go");
    expect(order).toEqual(["a stops", "b done"]);
    expect(res.finishReason).toBe("stopped");
    expect(res.toolResults.map((r) => [r.name, r.result])).toEqual([["a", "no"], ["b", "B result"]]);
    expect(bodies).toHaveLength(1);
  });

  it("is never retried, even for an idempotent tool", async () => {
    let runs = 0;
    const t = tool({ description: "t", input: z.object({}), idempotent: true, execute: async (_i, ctx) => (runs++, ctx.stop("denied")) });
    const { agent } = mk({ t }, [() => calls("t")]);
    expect((await agent.run("go")).finishReason).toBe("stopped");
    expect(runs).toBe(1);
  });

  it("still stops the run when the tool catches the signal and returns normally", async () => {
    const t = tool({
      description: "t",
      input: z.object({}),
      execute: async (_i, ctx) => {
        try {
          ctx.stop("denied");
        } catch {
          // swallowed on purpose
        }
        return "carried on";
      },
    });
    const { agent, bodies } = mk({ t }, [() => calls("t"), () => text("never")]);
    const res = await agent.run("go");
    expect(res.finishReason).toBe("stopped");
    expect(res.toolResults[0]!.result).toBe("denied");
    expect(bodies).toHaveLength(1);
  });

  it("does not turn into max_turns when it happens on the last allowed turn", async () => {
    const ran = { after: false };
    const { agent } = mk({ pay: pay(async () => false, ran) }, [() => calls("pay")], { maxTurns: 1 });
    expect((await agent.run("go")).finishReason).toBe("stopped");
  });

  it("works in a stream: tool_result, then done with finishReason stopped and no second request", async () => {
    const ran = { after: false };
    const { agent, bodies } = mk({ pay: pay(async () => false, ran) }, [() => streamedCall("pay"), () => text("never")]);
    const stream = agent.stream("go");
    const types: string[] = [];
    let doneReason: string | undefined;
    for await (const e of stream) {
      types.push(e.type);
      if (e.type === "done") doneReason = e.finishReason;
    }
    const res = await stream.result();
    expect(types).toContain("tool_result");
    expect(doneReason).toBe("stopped");
    expect(res.finishReason).toBe("stopped");
    expect(res.toolResults[0]!.result).toBe("user declined the payment");
    expect(bodies).toHaveLength(1);
  });

  it("a steer typed while the batch runs becomes the next run instead of being injected", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const t = tool({ description: "t", input: z.object({}), execute: async (_i, ctx) => (await held, ctx.stop("denied")) });
    const { agent, bodies } = mk({ t }, [() => calls("t"), () => text("handled the steer")]);
    const run = agent.run("start");
    await settle();
    const steered = agent.steer("also check Rome");
    release();
    const first = await run;
    expect(first.finishReason).toBe("stopped");
    const second = await steered;
    expect(second.text).toBe("handled the steer"); // it ran as its own follow-up run
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: "user", content: "also check Rome" });
  });

  it("can guard a built-in tool by wrapping it on the agent", async () => {
    const { agent, bodies } = mk({}, [() => callsWith({ tasks: [{ task: "look it up" }] }, "spawn_subagents"), () => text("never")], {
      subagentModel: "groq/worker-model",
      dynamicSubagents: { enabled: true },
    });
    const original = agent.tools["spawn_subagents"]!;
    let workersStarted = 0;
    agent.tools["spawn_subagents"] = {
      ...original,
      execute: async (input: any, ctx: any) => {
        ctx.stop("spawning needs approval");
        workersStarted++;
        return original.execute(input, ctx);
      },
    };
    const res = await agent.run("research this");
    expect(res.finishReason).toBe("stopped");
    expect(workersStarted).toBe(0);
    expect(bodies).toHaveLength(1);
  });
});

describe("ctx.stop and persistence", () => {
  const persisted = (tools: Record<string, any>, answers: Array<() => Response>, root = tmp(), extra: Record<string, unknown> = {}) => ({
    root,
    ...mk(tools, answers, { persist: { dir: root }, ...extra }),
  });

  it("saves the stop: the run ends as stopped, the tool log says why, and the result keeps its flag", async () => {
    const ran = { after: false };
    const t = persisted({ pay: pay(async () => false, ran) }, [() => calls("pay")]);
    await t.agent.run("go");
    await settle();
    const dir = sessionDirFor(t.root, "s1");
    expect(loadSessionDir(dir)!.session.runs!.map((r) => r.end)).toEqual(["stopped"]);
    const toolMessage = loadSessionDir(dir)!.session.messages.find((m) => m.role === "tool")!;
    expect((toolMessage.content as any[])[0]).toMatchObject({ result: "user declined the payment", stopped: true });
    const log = fs.readFileSync(path.join(dir, "tool-logs", "001-pay.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(log.map((l) => l.phase)).toContain("call_stopped");
    expect(log.find((l) => l.phase === "call_stopped").reason).toBe("user declined the payment");
  });

  it("after a crash the denial still holds: a finished-batch stop is closed without calling the model", async () => {
    const ran = { after: false };
    const t = persisted({ pay: pay(async () => false, ran) }, [() => calls("pay")]);
    await t.agent.run("go");
    await settle();
    const file = path.join(sessionDirFor(t.root, "s1"), JOURNAL_FILE);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("\n").filter((l) => !l.includes('"t":"end"')).join("\n")); // the ending note was lost
    let modelCalls = 0;
    const again = mk({ pay: pay(async () => true, ran) }, [() => (modelCalls++, text("no"))], { persist: { dir: t.root }, resume: "explicit" }).agent;
    expect(again.interrupted()).toHaveLength(1);
    expect(await again.resume()).toBeUndefined();
    expect(modelCalls).toBe(0);
    expect(again.interrupted()).toEqual([]);
    expect(ran.after).toBe(false);
  });

  it("after a crash in the middle of a batch the saved stop still ends the run, and only the unfinished call runs", async () => {
    const root = tmp();
    const a = tool({ description: "a", input: z.object({}), execute: async (_i, ctx) => ctx.stop("denied") });
    let bRuns = 0;
    const bHangs = tool({ description: "b", input: z.object({}), execute: () => (bRuns++, never()) });
    mk({ a, b: bHangs }, [() => calls("a", "b")], { persist: { dir: root }, resume: "explicit" }).agent.run("go"); // dies with b in flight
    await settle(60);
    const bAgain = tool({ description: "b", input: z.object({}), execute: async () => (bRuns++, "B finished") });
    let modelCalls = 0;
    const { agent } = mk({ a, b: bAgain }, [() => (modelCalls++, text("no"))], { persist: { dir: root }, resume: "explicit" });
    const res = await agent.resume();
    expect(res!.finishReason).toBe("stopped");
    expect(bRuns).toBe(2); // b ran again, a was not repeated
    expect(modelCalls).toBe(0);
  });
});

describe("needsApproval is gone", () => {
  it("tool() no longer carries it", () => {
    const t = tool({ description: "t", execute: async () => "x", needsApproval: true } as never) as unknown as Record<string, unknown>;
    expect("needsApproval" in t).toBe(false);
  });
});
