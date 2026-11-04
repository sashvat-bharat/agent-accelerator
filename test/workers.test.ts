import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { Agent, tool, ValidationError } from "../src/index.ts";
import { sessionDirFor } from "../src/session/store.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accel-workers-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
const sseFrame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
// The same text as a streamed or a plain reply, whichever the request asks for.
const reply = (text: string, body: any): Response =>
  body.stream
    ? new Response(
        sseFrame({ id: "r", choices: [{ delta: { content: text } }] }) + sseFrame({ id: "r", choices: [{ delta: {}, finish_reason: "stop" }], usage }) + "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    : new Response(JSON.stringify({ id: "r", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
const lastUser = (body: any): string => [...body.messages].reverse().find((m: any) => m.role === "user")?.content;
const users = (body: any): string[] => body.messages.filter((m: any) => m.role === "user").map((m: any) => m.content);

type Handler = (body: any, init: RequestInit) => Promise<Response> | Response;
// A parent whose workers (model "w") and its own runs (model "p") both go to `handler`; `root` undefined = nothing is saved.
const mk = (root: string | undefined, handler: Handler, extra: Record<string, unknown> = {}) =>
  new Agent({
    model: "groq/p",
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    sessionId: "p1",
    instructions: "PARENT RULES",
    ...(root ? { persist: { dir: root } } : {}),
    fetch: (async (_url: string, init: RequestInit) => handler(JSON.parse(String(init.body)), init)) as unknown as typeof fetch,
    dynamicSubagents: { model: "groq/w", maxSpawn: 4, tools: { lookup: tool({ description: "d", input: z.object({}), execute: () => "x" }) } },
    ...extra,
  });
const echo: Handler = (body) => reply(`echo:${lastUser(body)}`, body);
const spec = { name: "Researcher", role: "analyst", instructions: "You are R.", task: "find x" };

describe("worker registry: spawn, message, close, list", () => {
  it("runs a worker with its own instructions and saves it under the parent's session folder", async () => {
    const root = tmp();
    const seen: any[] = [];
    const parent = mk(root, (body, init) => (seen.push(body), echo(body, init)));
    const r = await parent.workers.spawn(spec);
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("echo:find x");
    expect(r.id).toMatch(/^researcher-[0-9a-f]{8}$/);
    expect(seen[0].model).toBe("w");
    expect(seen[0].messages[0].content).toContain("You are R.");
    expect(JSON.stringify(seen[0])).not.toContain("PARENT RULES");
    expect(r.metadata.usage.totalTokens).toBe(4);
    expect(parent.track(r.metadata.trackingId!)?.status).toBe("done");

    expect(parent.workers.list()).toEqual([{ id: r.id, name: "Researcher", role: "analyst", tools: [], busy: false }]);
    const folder = path.join(sessionDirFor(root, "p1"), "workers");
    const [dir] = fs.readdirSync(folder).filter((f) => fs.statSync(path.join(folder, f)).isDirectory());
    expect(fs.existsSync(path.join(folder, dir!, "worker.json"))).toBe(true);
    expect(fs.existsSync(path.join(folder, dir!, "session.json"))).toBe(true);
  });

  it("remembers the conversation across messages, also without any persistence", async () => {
    for (const root of [tmp(), undefined]) {
      const seen: any[] = [];
      const parent = mk(root, (body, init) => (seen.push(body), echo(body, init)));
      const first = await parent.workers.spawn(spec);
      const second = await parent.workers.message(first.id, "and y?");
      expect(second.text).toBe("echo:and y?");
      expect(users(seen[1])).toEqual(["find x", "and y?"]);
      expect(seen[1].messages.some((m: any) => m.role === "assistant" && m.content === "echo:find x")).toBe(true);
    }
  });

  it("copies the first N finished parent turns into the worker, and nothing for history none", async () => {
    const seen: any[] = [];
    const parent = mk(tmp(), (body) => (seen.push(body), reply(body.model === "p" ? "hi there" : "ok", body)));
    await parent.run("hello");
    expect(parent.workers.turns().map((t) => t.prompt)).toEqual(["hello"]);

    seen.length = 0;
    await parent.workers.spawn({ ...spec, name: "with", history: 1 });
    expect(users(seen[0])).toEqual(["hello", "find x"]);
    expect(seen[0].messages.some((m: any) => m.role === "assistant" && m.content === "hi there")).toBe(true);

    seen.length = 0;
    await parent.workers.spawn({ ...spec, name: "without", history: "none" });
    expect(users(seen[0])).toEqual(["find x"]);

    await expect(parent.workers.spawn({ ...spec, history: 2 })).rejects.toThrow("from 1 to 1");
  });

  it("closes a worker: it leaves the list, cannot be messaged, and stays on disk", async () => {
    const root = tmp();
    const parent = mk(root, echo);
    const a = await parent.workers.spawn({ ...spec, name: "a" });
    const b = await parent.workers.spawn({ ...spec, name: "b" });
    expect(parent.workers.close(a.id).id).toBe(a.id);
    expect(parent.workers.list().map((w) => w.id)).toEqual([b.id]);
    await expect(parent.workers.message(a.id, "hi")).rejects.toThrow("is closed");
    await expect(parent.workers.message("nope-123", "hi")).rejects.toThrow(ValidationError);
    const folder = path.join(sessionDirFor(root, "p1"), "workers");
    expect(fs.readdirSync(folder).filter((f) => fs.statSync(path.join(folder, f)).isDirectory())).toHaveLength(2);
  });

  it("rebuilds workers after a restart, with their history, and keeps closed ones closed", async () => {
    const root = tmp();
    const before = mk(root, echo);
    const a = await before.workers.spawn({ ...spec, name: "a" });
    const b = await before.workers.spawn({ ...spec, name: "b" });
    before.workers.close(b.id);

    const seen: any[] = [];
    const after = mk(root, (body, init) => (seen.push(body), echo(body, init)));
    expect(after.workers.list().map((w) => w.id)).toEqual([a.id]);
    const again = await after.workers.message(a.id, "again");
    expect(again.text).toBe("echo:again");
    expect(users(seen[0])).toEqual(["find x", "again"]);
    await expect(after.workers.message(b.id, "x")).rejects.toThrow("is closed");
  });

  it("checks a request before it spends anything: tools, open-worker limit, busy worker", async () => {
    const parent = mk(tmp(), echo, { dynamicSubagents: { model: "groq/w", maxSpawn: 1, tools: { lookup: tool({ description: "d", input: z.object({}), execute: () => "x" }) } } });
    await expect(parent.workers.spawn({ ...spec, tools: ["nope"] })).rejects.toThrow('unknown worker tool(s) "nope"; the pool is [lookup]');
    await expect(parent.workers.spawn({ ...spec, task: "  " })).rejects.toThrow("task: required");
    const ok = await parent.workers.spawn({ ...spec, tools: ["lookup"] });
    expect(parent.workers.list()[0]!.tools).toEqual(["lookup"]);
    await expect(parent.workers.spawn({ ...spec, name: "second" })).rejects.toThrow("Too many open workers (1");

    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const busyParent = mk(undefined, async (body) => (await hold, reply("done", body)));
    const pending = busyParent.workers.spawn(spec);
    await settle();
    const [w] = busyParent.workers.list();
    expect(w!.busy).toBe(true);
    await expect(busyParent.workers.message(w!.id, "more")).rejects.toThrow("is busy");
    expect(() => busyParent.workers.close(w!.id)).toThrow("is busy");
    release();
    expect((await pending).text).toBe("done");
    expect(ok.error).toBeUndefined();
  });

  it("reports a failing worker as a reply with an error, and the worker stays usable", async () => {
    let fail = true;
    const parent = mk(tmp(), (body) => (fail ? new Response('{"error":{"message":"bad key"}}', { status: 401 }) : reply("fine", body)));
    const first = await parent.workers.spawn(spec);
    expect(first.error).toContain("bad key");
    expect(first.metadata.isError).toBe(true);
    fail = false;
    expect((await parent.workers.message(first.id, "retry")).text).toBe("fine");
  });

  it("aborts a running worker with the signal and keeps it open", async () => {
    let started!: () => void;
    const requested = new Promise<void>((r) => (started = r));
    const parent = mk(tmp(), (body, init) => {
      if (lastUser(body) !== "slow") return reply("quick", body);
      started();
      return new Promise<Response>((_, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init.signal!.aborted) abort();
        else init.signal!.addEventListener("abort", abort);
      });
    });
    const ctrl = new AbortController();
    const pending = parent.workers.spawn({ ...spec, task: "slow" }, { signal: ctrl.signal });
    await requested;
    ctrl.abort();
    const r = await pending;
    expect(r.error).toBeDefined();
    expect(parent.workers.list()).toHaveLength(1);
    expect((await parent.workers.message(r.id, "fast")).text).toBe("quick");
  });
});

describe("worker registry: exactly once across a crash", () => {
  it("a replayed spawn finds its worker and returns the saved answer without running it again", async () => {
    const root = tmp();
    let requests = 0;
    const handler: Handler = (body) => (requests++, reply("answer", body));
    const first = await mk(root, handler).workers.spawn(spec, { callId: "call_1" });
    const replay = await mk(root, handler).workers.spawn(spec, { callId: "call_1" });
    expect(replay.id).toBe(first.id);
    expect(replay.text).toBe("answer");
    expect(requests).toBe(1);
    expect(mk(root, handler).workers.list()).toHaveLength(1);
    // A different call, even with the same name and task, is a new worker.
    const other = await mk(root, handler).workers.spawn(spec, { callId: "call_2" });
    expect(other.id).not.toBe(first.id);
    expect(requests).toBe(2);
  });

  it("a replayed spawn whose worker was cut off continues that run instead of sending the task twice", async () => {
    const root = tmp();
    const hang = mk(root, () => new Promise<Response>(() => {}));
    void hang.workers.spawn(spec, { callId: "call_1" }); // the process "dies" here: the request never answers
    await settle(60);

    const seen: any[] = [];
    const restarted = mk(root, (body) => (seen.push(body), reply("finished", body)));
    const r = await restarted.workers.spawn(spec, { callId: "call_1" });
    expect(r.text).toBe("finished");
    expect(r.error).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(users(seen[0])).toEqual(["find x"]); // one task message, not two
    expect(restarted.workers.list()).toHaveLength(1);
  });

  it("a replayed message returns the answer already given, a new message with the same text runs", async () => {
    const root = tmp();
    let requests = 0;
    const handler: Handler = (body) => (requests++, reply(`r${requests}`, body));
    const parent = mk(root, handler);
    const { id } = await parent.workers.spawn(spec);
    expect((await parent.workers.message(id, "go", { callId: "m1" })).text).toBe("r2");
    expect((await mk(root, handler).workers.message(id, "go", { callId: "m1" })).text).toBe("r2");
    expect(requests).toBe(2);
    expect((await parent.workers.message(id, "go", { callId: "m2" })).text).toBe("r3");
    expect((await parent.workers.message(id, "go")).text).toBe("r4");
  });
});
