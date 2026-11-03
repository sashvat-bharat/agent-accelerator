import { describe, it, expect, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { Agent, tool } from "../src/index.ts";
import { loadSessionDir, sessionDirFor } from "../src/session/store.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accel-toollog-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const text = (t: string) => json({ id: "r", choices: [{ message: { role: "assistant", content: t }, finish_reason: "stop" }], usage });
const calls = (...names: string[]) =>
  json({
    id: "r",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: names.map((n, i) => ({ id: `call_${i}`, type: "function", function: { name: n, arguments: '{"to":"a@b.c"}' } })),
        },
      },
    ],
    usage,
  });

function setup(tools: Record<string, any>, answers: Array<() => Response>, extra: Record<string, unknown> = {}) {
  const root = tmp();
  const bodies: any[] = [];
  let n = 0;
  const agent = new Agent({
    model: "groq/test-model",
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    sessionId: "s1",
    persist: { dir: root },
    tools,
    fetch: (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), answers[Math.min(n++, answers.length - 1)]!())) as unknown as typeof fetch,
    ...extra,
  });
  const dir = sessionDirFor(root, "s1");
  const logs = (): string[] => (fs.existsSync(path.join(dir, "tool-logs")) ? fs.readdirSync(path.join(dir, "tool-logs")).sort() : []);
  const lines = (file: string): any[] =>
    fs.readFileSync(path.join(dir, "tool-logs", file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { agent, bodies, dir, root, logs, lines };
}

describe("tool logs", () => {
  it("writes one file per call with the automatic steps and the tool's own ctx.log lines", async () => {
    const send = tool({
      description: "send",
      input: z.object({ to: z.string() }),
      execute: async ({ to }, ctx) => {
        ctx.log("connecting", { host: "smtp" });
        ctx.log("sent 1 of 1");
        return `sent to ${to}`;
      },
    });
    const t = setup({ send_email: send }, [() => calls("send_email"), () => text("done")]);
    const res = await t.agent.run("mail it");
    expect(t.logs()).toEqual(["001-send_email.ndjson"]);
    const lines = t.lines("001-send_email.ndjson");
    expect(lines.map((l) => l.phase)).toEqual(["input", "call_started", "attempt_started", "log", "log", "result", "call_succeeded"]);
    expect(lines[0]).toMatchObject({ name: "send_email", input: { to: "a@b.c" } });
    expect(lines[3]).toMatchObject({ message: "connecting", data: { host: "smtp" } });
    expect(lines[5].result).toBe("sent to a@b.c");
    expect(lines[6].durationMs).toBeGreaterThanOrEqual(0);
    expect(lines.every((l) => typeof l.timestamp === "number")).toBe(true);
    // The session keeps only a reference, and the model never sees the log.
    expect(res.toolResults[0]!.logFile).toBe("tool-logs/001-send_email.ndjson");
    await settle();
    const saved = loadSessionDir(t.dir)!.session.messages.find((m) => m.role === "tool")!;
    expect((saved.content as any[])[0].logFile).toBe("tool-logs/001-send_email.ndjson");
    expect(JSON.stringify(t.bodies[1])).not.toContain("connecting");
    expect(JSON.stringify(t.bodies[1])).not.toContain("logFile");
  });

  it("logs a failure with the full error and the attempts of a retried call", async () => {
    let n = 0;
    const flaky = tool({
      description: "flaky",
      input: z.object({ to: z.string() }),
      idempotent: true,
      execute: async () => {
        if (++n < 2) throw Object.assign(new Error("boom 503"), { status: 503 });
        throw new Error("permanent failure");
      },
    });
    const t = setup({ flaky }, [() => calls("flaky"), () => text("ok")]);
    await t.agent.run("go");
    const phases = t.lines("001-flaky.ndjson").map((l) => l.phase);
    expect(phases).toEqual(["input", "call_started", "attempt_started", "attempt_failed", "retry_scheduled", "attempt_started", "attempt_failed", "call_failed"]);
    const failed = t.lines("001-flaky.ndjson").at(-1)!;
    expect(failed.error.message).toBe("permanent failure");
    expect(failed.error.stack).toContain("permanent failure"); // developers get the full detail
  });

  it("logs a call that was refused (unknown tool)", async () => {
    const t = setup({}, [() => calls("ghost"), () => text("ok")]);
    await t.agent.run("go");
    expect(t.lines("001-ghost.ndjson").map((l) => l.phase)).toEqual(["input", "call_blocked"]);
  });

  it("numbers files in start order, continues after earlier runs and a new Agent, and each parallel call gets its own", async () => {
    const t1 = setup({ a: tool({ description: "a", input: z.object({ to: z.string() }), execute: async () => "A" }), b: tool({ description: "b", input: z.object({ to: z.string() }), execute: async () => "B" }) }, [() => calls("a", "b"), () => text("ok"), () => calls("a"), () => text("ok")]);
    await t1.agent.run("first");
    expect(t1.logs()).toEqual(["001-a.ndjson", "002-b.ndjson"]);
    await t1.agent.run("second");
    expect(t1.logs()).toEqual(["001-a.ndjson", "002-b.ndjson", "003-a.ndjson"]);
    const again = new Agent({
      model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", sessionId: "s1", persist: { dir: t1.root },
      tools: { a: tool({ description: "a", input: z.object({ to: z.string() }), execute: async () => "A" }) },
      fetch: (async () => calls("a")) as unknown as typeof fetch, runRetries: 0, maxTurns: 1,
    });
    await again.run("third").catch(() => {});
    expect(t1.logs().at(-1)).toBe("004-a.ndjson");
  });

  it("flushes every line to disk as it is written", async () => {
    const spy = spyOn(fs, "fdatasyncSync");
    try {
      const t = setup({ t: tool({ description: "t", input: z.object({ to: z.string() }), execute: async (_i, ctx) => (ctx.log("one"), "r") }) }, [() => calls("t"), () => text("ok")]);
      await t.agent.run("go");
      const written = t.lines("001-t.ndjson").length;
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(written);
    } finally {
      spy.mockRestore();
    }
  });

  it("writes nothing without persist, with persist.file, or when stateless, and ctx.log is then a harmless no-op", async () => {
    let logged = 0;
    const t = tool({ description: "t", input: z.object({ to: z.string() }), execute: async (_i, ctx) => (ctx.log("x"), logged++, "r") });
    const noPersist = new Agent({ model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", tools: { t }, fetch: (async () => calls("t")) as unknown as typeof fetch, maxTurns: 1 });
    const res = await noPersist.run("go");
    expect(logged).toBe(1);
    expect(res.toolResults[0]!.logFile).toBeUndefined();
    const dir = tmp();
    const file = new Agent({ model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", tools: { t }, persist: { file: path.join(dir, "s.json") }, fetch: (async () => calls("t")) as unknown as typeof fetch, maxTurns: 1 });
    await file.run("go");
    expect(fs.readdirSync(dir)).not.toContain("tool-logs");
    const stateless = setup({ t }, [() => calls("t")], { stateless: true, maxTurns: 1 });
    await stateless.agent.run("go");
    expect(stateless.logs()).toEqual([]);
  });

  it("a tool that keeps logging after the call ended (a timeout) does not crash or write more", async () => {
    let late!: () => void;
    const slow = tool({
      description: "slow",
      input: z.object({ to: z.string() }),
      timeoutMs: 20,
      execute: async (_i, ctx) => {
        ctx.log("started");
        await new Promise<void>((r) => (late = r));
        ctx.log("finished long after the timeout");
        return "late";
      },
    });
    const t = setup({ slow }, [() => calls("slow"), () => text("ok")]);
    await t.agent.run("go");
    late();
    await settle(30);
    const lines = t.lines("001-slow.ndjson");
    expect(lines.map((l) => l.phase)).toContain("call_timed_out");
    expect(JSON.stringify(lines)).not.toContain("long after the timeout");
  });
});
