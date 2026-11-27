import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { Agent, tool, ConfigError, telemetryBus } from "../src/index.ts";
import { loadSessionDir, sessionDirFor, JOURNAL_FILE } from "../src/session/store.ts";
import { finishedTurns } from "../src/agent/turns.ts";

const roots: string[] = [];
const children: Array<{ kill: (signal?: NodeJS.Signals | number) => void }> = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accel-resume-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => {});

const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const textReply = (text: string) => json({ id: "r", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
const callsReply = (names: string[]) =>
  json({
    id: "r",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: names.map((n) => ({ id: `call_${n}`, type: "function", function: { name: n, arguments: "{}" } })),
        },
      },
    ],
    usage,
  });
const mk = (root: string, fetchImpl: (body: any) => Promise<Response>, extra: Record<string, unknown> = {}) =>
  new Agent({
    model: "groq/test-model",
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    sessionId: "s1",
    persist: { dir: root },
    fetch: (async (_url: string, init: RequestInit) => fetchImpl(JSON.parse(String(init.body)))) as unknown as typeof fetch,
    ...extra,
  });
const lastUser = (body: any): string => [...body.messages].reverse().find((m: any) => m.role === "user")?.content;

describe("resume after a cut-off run", () => {
  it("a clean run leaves nothing to resume and nothing is loaded", async () => {
    const root = tmp();
    await mk(root, async () => textReply("hi")).run("one");
    await settle();
    const again = mk(root, async () => textReply("never"));
    expect(again.interrupted()).toEqual([]);
    expect(again.context.messages).toHaveLength(0);
    expect(await again.resume()).toBeUndefined();
  });

  it("the disk is up to date the moment `await run()` returns, including how the run ended", async () => {
    const root = tmp();
    const agent = mk(root, async () => textReply("hi"));
    await agent.run("one");
    // No waiting: the run's ending is already saved.
    expect(loadSessionDir(sessionDirFor(root, "s1"))!.session.runs!.map((r) => r.end)).toEqual(["done"]);
  });

  it("explicit mode loads nothing to run, lists the cut-off run and resume() continues it from the saved conversation", async () => {
    const root = tmp();
    mk(root, () => never(), { resume: "explicit" }).run("write the report"); // hangs: the process 'dies' here
    await settle();
    const seen: any[] = [];
    const agent = mk(root, async (body) => (seen.push(body), textReply("report done")), { resume: "explicit" });
    await settle();
    expect(seen).toHaveLength(0); // explicit: nothing ran by itself
    const [cut] = agent.interrupted();
    expect(cut!.prompt).toBe("write the report");
    expect(cut!.pendingToolCalls).toEqual([]);
    const res = await agent.resume();
    expect(res!.text).toBe("report done");
    expect(seen).toHaveLength(1);
    expect(lastUser(seen[0])).toBe("write the report"); // the saved prompt, sent once, not repeated
    expect(seen[0].messages.filter((m: any) => m.role === "user")).toHaveLength(1);
    expect(agent.interrupted()).toEqual([]);
    await settle();
    const runs = loadSessionDir(sessionDirFor(root, "s1"))!.session.runs!;
    expect(runs.map((r) => r.end)).toEqual(["done"]);
  });

  it("finishes only the tool calls that have no saved result", async () => {
    const root = tmp();
    const runs = { a: 0, b: 0 };
    let hangB = true;
    const tools = {
      tool_a: tool({ description: "a", input: z.object({}), execute: async () => `A:${++runs.a}` }),
      tool_b: tool({ description: "b", input: z.object({}), replay: "safe", execute: async () => (runs.b++, hangB ? never() : `B:${runs.b}`) }),
    };
    mk(root, async () => callsReply(["tool_a", "tool_b"]), { tools, resume: "explicit" }).run("do both"); // tool_b hangs forever
    await settle(60);
    expect(runs).toEqual({ a: 1, b: 1 });
    hangB = false;
    const seen: any[] = [];
    const agent = mk(root, async (body) => (seen.push(body), textReply("both done")), { tools, resume: "explicit" });
    expect(agent.interrupted()[0]!.pendingToolCalls.sort()).toEqual(["tool_a", "tool_b"]);
    const res = await agent.resume();
    expect(res!.text).toBe("both done");
    expect(runs).toEqual({ a: 1, b: 2 }); // A was NOT run again; B was
    const results = seen[0].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    expect(results).toEqual(["A:1", "B:2"]); // A's saved result, B's fresh one, in call order
    expect(res!.toolResults.map((r) => r.name)).toEqual(["tool_a", "tool_b"]);
  });

  it("a cut-off call of a tool that is not replay-safe is NOT run again: the model gets an interrupted result", async () => {
    const root = tmp();
    const runs = { mail: 0, read: 0, safe: 0 };
    const mkTools = (hang: boolean) => ({
      send_mail: tool({ description: "m", input: z.object({}), execute: async () => (runs.mail++, hang ? never() : "sent") }),
      read_file: tool({ description: "r", input: z.object({}), idempotent: true, execute: async () => (runs.read++, hang ? never() : "file") }),
      lookup: tool({ description: "l", input: z.object({}), replay: "safe", execute: async () => (runs.safe++, hang ? never() : "found") }),
    });
    mk(root, async () => callsReply(["send_mail", "read_file", "lookup"]), { tools: mkTools(true), resume: "explicit" }).run("go");
    await settle(60);
    expect(runs).toEqual({ mail: 1, read: 1, safe: 1 });
    const seen: any[] = [];
    const events: string[] = [];
    const off = telemetryBus.onEvent((e) => e.code === "tool.call_interrupted" && events.push(String((e.data as any).toolName)));
    const agent = mk(root, async (body) => (seen.push(body), textReply("ok")), { tools: mkTools(false), resume: "explicit" });
    const res = await agent.resume();
    off();
    expect(res!.text).toBe("ok");
    expect(runs).toEqual({ mail: 1, read: 2, safe: 2 }); // the mail was not sent a second time
    const results = seen[0].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    expect(results[0]).toMatch(/send_mail.*interrupted/);
    expect(results.slice(1)).toEqual(["file", "found"]);
    expect(res!.toolResults[0]!.isError).toBe(true);
    expect(events).toEqual(["send_mail"]);
    // the note is saved: a second restart does not decide again
    expect(agent.toolRecords.map((t) => t.name).sort()).toEqual(["lookup", "read_file", "send_mail"]);
  });

  it("automatic mode resumes at construction, a run() right after queues behind it, and waiting prompts follow in order", async () => {
    const root = tmp();
    const first = mk(root, () => never(), { resume: "explicit" });
    first.run("busy");
    await settle();
    void first.steer("steer text");
    void first.queue("queued text");
    await settle();
    const seen: string[] = [];
    const agent = mk(root, async (body) => (seen.push(lastUser(body)), textReply(`re: ${lastUser(body)}`)));
    expect(agent.pendingCount).toBe(2); // restored from the journal
    const after = agent.run("typed right after the restart");
    await after;
    expect(seen).toEqual(["busy", "steer text", "queued text", "typed right after the restart"]);
  });

  it("a new run() in explicit mode closes the cut-off one as abandoned", async () => {
    const root = tmp();
    mk(root, () => never(), { resume: "explicit" }).run("lost");
    await settle();
    const agent = mk(root, async () => textReply("fresh"), { resume: "explicit" });
    await agent.run("something else");
    await settle();
    expect(agent.interrupted()).toEqual([]);
    expect(loadSessionDir(sessionDirFor(root, "s1"))!.session.runs!.map((r) => r.end)).toEqual(["abandoned", "done"]);
  });

  it("a new run() after a cut-off batch tells the model the real result of a tool that finished", async () => {
    const root = tmp();
    const runs = { a: 0, b: 0 };
    const tools = {
      tool_a: tool({ description: "a", input: z.object({}), execute: async () => `sent email #${++runs.a}` }),
      tool_b: tool({ description: "b", input: z.object({}), execute: async () => (runs.b++, never()) }),
    };
    mk(root, async () => callsReply(["tool_a", "tool_b"]), { tools, resume: "explicit" }).run("do both"); // tool_b hangs: cut off
    await settle(60);
    const seen: any[] = [];
    const agent = mk(root, async (body) => (seen.push(body), textReply("ok")), { tools, resume: "explicit" });
    await agent.run("what happened?");
    expect(runs).toEqual({ a: 1, b: 1 }); // nothing ran again
    const results = seen[0].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
    expect(results[0]).toBe("sent email #1"); // the real result, not "interrupted"
    expect(results[1]).toMatch(/^Error: tool_call 'tool_b' \(call_tool_b\) has no result because the run was interrupted/);
    expect(lastUser(seen[0])).toBe("what happened?");
    // The saved conversation keeps the real result too, and the cut-off run is closed.
    const saved = loadSessionDir(sessionDirFor(root, "s1"))!.session;
    const savedA = saved.messages.flatMap((m: any) => (m.role === "tool" ? m.content : [])).find((p: any) => p.id === "call_tool_a");
    expect(savedA.result).toBe("sent email #1");
    expect(saved.runs!.map((r) => r.end)).toEqual(["abandoned", "done"]);
    // The new run starts after the recovered results: its turn begins with its own prompt.
    expect(finishedTurns(agent.context.messages, agent.runMarks).map((t) => t.prompt)).toEqual(["what happened?"]);
  });

  it("a complete answer whose ending note was lost is closed without calling the model", async () => {
    const root = tmp();
    await mk(root, async () => textReply("all good")).run("question");
    await settle();
    const file = path.join(sessionDirFor(root, "s1"), JOURNAL_FILE);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("\n").filter((l) => !l.includes('"t":"end"')).join("\n"));
    let calls = 0;
    const agent = mk(root, async () => (calls++, textReply("no")), { resume: "explicit" });
    expect(agent.interrupted()).toHaveLength(1);
    expect(await agent.resume()).toBeUndefined();
    expect(calls).toBe(0);
    expect(agent.interrupted()).toEqual([]);
  });

  it("resume() on a busy agent says so, and a second resume() shares the first", async () => {
    const root = tmp();
    mk(root, () => never(), { resume: "explicit" }).run("cut");
    await settle();
    const agent = mk(root, () => never(), { resume: "explicit" });
    const a = agent.resume();
    expect(agent.resume()).toBe(a);
    const busy = mk(tmp(), () => never());
    busy.run("x");
    expect(() => busy.resume()).toThrow(/idle/);
  });

  it("an automatic resume that fails is reported on the bus, not thrown from the constructor", async () => {
    const root = tmp();
    mk(root, () => never(), { resume: "explicit" }).run("cut");
    await settle();
    const seen: string[] = [];
    const off = telemetryBus.onEvent((e) => seen.push(e.code));
    try {
      mk(root, async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }));
      await settle(30);
      expect(seen).toContain("agent.resumed");
      expect(seen).toContain("agent.resume_failed");
    } finally {
      off();
    }
  });

  it("rejects an unknown resume option", () => {
    expect(() => new Agent({ model: "google/gemini-3.5-flash-lite", resume: "sometimes" as never })).toThrow(ConfigError);
  });
});

describe("a real kill -9", () => {
  it("never repeats a tool that already finished, and finishes the one that did not", async () => {
    const root = tmp();
    const work = tmp();
    const srcIndex = path.resolve(import.meta.dir, "../src/index.ts");
    const code = `
      import { Agent, tool, setConfigs } from ${JSON.stringify(srcIndex)};
      import { z } from "zod";
      import * as fs from "node:fs";
      setConfigs({ values: { catalog_refresh: "off" } });
      const bump = (f) => fs.appendFileSync(process.env.WORK + "/" + f, "x");
      const tools = {
        tool_a: tool({ description: "a", input: z.object({}), execute: async () => { bump("a"); return "A-result"; } }),
        tool_b: tool({ description: "b", input: z.object({}), execute: async () => { await new Promise((r) => setTimeout(r, 200)); bump("b"); console.log("ready"); await new Promise(() => {}); } }),
      };
      const fetchImpl = async () => new Response(JSON.stringify({ id: "r", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [
        { id: "call_a", type: "function", function: { name: "tool_a", arguments: "{}" } },
        { id: "call_b", type: "function", function: { name: "tool_b", arguments: "{}" } } ] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
      const agent = new Agent({ model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", fetch: fetchImpl, persist: { dir: process.env.ROOT }, sessionId: "crash", tools });
      await agent.run("do both");
    `;
    const child = Bun.spawn(["bun", "-e", code], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, ROOT: root, WORK: work },
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    const reader = child.stdout.getReader();
    let seen = "";
    while (!seen.includes("ready")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("child ended early: " + (await new Response(child.stderr).text()));
      seen += new TextDecoder().decode(value);
    }
    child.kill("SIGKILL");
    await child.exited;

    const count = (f: string): number => (fs.existsSync(path.join(work, f)) ? fs.readFileSync(path.join(work, f), "utf8").length : 0);
    expect({ a: count("a"), b: count("b") }).toEqual({ a: 1, b: 1 });
    const bodies: any[] = [];
    const agent = new Agent({
      model: "groq/test-model",
      apiKey: "k",
      baseUrl: "https://example.test/v1",
      sessionId: "crash",
      persist: { dir: root },
      resume: "explicit",
      fetch: (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), textReply("finished"))) as unknown as typeof fetch,
      tools: {
        tool_a: tool({ description: "a", input: z.object({}), execute: async () => (fs.appendFileSync(path.join(work, "a"), "x"), "A-again") }),
        tool_b: tool({ description: "b", input: z.object({}), replay: "safe", execute: async () => (fs.appendFileSync(path.join(work, "b"), "x"), "B-result") }),
      },
    });
    expect(agent.interrupted()).toHaveLength(1);
    const res = await agent.resume();
    expect(res!.text).toBe("finished");
    expect({ a: count("a"), b: count("b") }).toEqual({ a: 1, b: 2 }); // the finished tool was not repeated
    expect(bodies[0].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content)).toEqual(["A-result", "B-result"]);
  });
});

describe("reset()", () => {
  it("clears the run's saved tool results and run marks but keeps the spending totals", async () => {
    const root = tmp();
    const replies = [() => callsReply(["ping"]), () => textReply("done")];
    const agent = mk(root, async () => replies.shift()!(), {
      tools: { ping: tool({ description: "ping", input: z.object({}), execute: () => "pong" }) },
    });
    await agent.run("go");
    expect(agent.toolRecords).toHaveLength(1);
    const turns = agent.usageTotals.turns;
    expect(turns).toBe(2);

    agent.reset();
    expect(agent.toolRecords).toHaveLength(0);
    expect(agent.runMarks).toHaveLength(0);
    expect(agent.usageTotals.turns).toBe(turns); // spending is not conversation
    expect(agent.usageReport().agent.turns).toBe(turns);

    agent.persistNow();
    await settle();
    const journal = fs.readFileSync(path.join(sessionDirFor(root, "s1"), JOURNAL_FILE), "utf8");
    expect(journal).not.toContain('"t":"tool"'); // the fresh snapshot carries no tool results of the cleared run
  });
});
