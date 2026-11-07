import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { Agent, tool, listScheduledActions, runScheduledAction } from "../src/index.ts";
import { getScheduler, resetSchedulers } from "../src/scheduler/scheduler.ts";

// Real kill -9 matrix: a child process is SIGKILLed at a chosen point, then a fresh Agent (this process) restarts from the
// same folder. Each case checks that no finished work is repeated, no waiting prompt is lost and the files repair.

const roots: string[] = [];
const children: Array<{ kill: (signal?: number | string) => void }> = [];
afterEach(() => {
  resetSchedulers();
  for (const c of children.splice(0)) c.kill("SIGKILL");
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const repo = path.resolve(import.meta.dir, "..");
const srcIndex = path.resolve(import.meta.dir, "../src/index.ts");
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
const textReply = (text: string) => json({ id: "r", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
const lastUser = (body: any): string => [...body.messages].reverse().find((m: any) => m.role === "user")?.content;

// A fresh temp folder that the test removes afterwards; in: nothing, out: its path.
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accel-crash-"));
  roots.push(d);
  return d;
}

// Runs `body` in a child process (the prelude supplies the SDK and a hanging/scripted fetch), waits until it prints "ready", then kills it with SIGKILL; in: the child's code + env, out: everything it printed before the kill.
async function crashChild(body: string, env: Record<string, string>): Promise<string> {
  const code = `import { Agent, tool, createScheduledAction, runScheduledAction } from ${JSON.stringify(srcIndex)};\nimport { z } from "zod";\nimport * as fs from "node:fs";\n${body}`;
  const child = Bun.spawn(["bun", "-e", code], { cwd: repo, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
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
  return seen;
}

// The Agent options every case shares (a mocked OpenAI-compatible endpoint); in: the folder + a fetch body handler, out: AgentConfig fields.
function config(root: string, handler: (body: any) => Response | Promise<Response>): Record<string, unknown> {
  return {
    model: "groq/test-model",
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    sessionId: "crash",
    persist: { dir: root },
    resume: "explicit",
    fetch: (async (_u: string, init: RequestInit) => handler(JSON.parse(String(init.body)))) as unknown as typeof fetch,
  };
}

// Child-side fetch text shared by the cases: a request that never answers (the process "dies" inside it).
const HANG = `const hang = () => { setTimeout(() => console.log("ready"), 80); return new Promise(() => {}); };`;
// Child-side Agent options (same endpoint and session as config()).
const CHILD_AGENT = `model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", sessionId: "crash"`;

describe("kill -9 matrix", () => {
  it("killed while the model call is in flight: the prompt is sent once after the restart", async () => {
    const root = tmp();
    await crashChild(`${HANG}
      const agent = new Agent({ ${CHILD_AGENT}, persist: { dir: process.env.ROOT }, fetch: hang });
      await agent.run("write the report");`, { ROOT: root });
    const seen: any[] = [];
    const agent = new Agent(config(root, (b) => (seen.push(b), textReply("report done"))) as never);
    expect(agent.interrupted().map((r) => r.prompt)).toEqual(["write the report"]);
    expect((await agent.resume())!.text).toBe("report done");
    expect(seen).toHaveLength(1);
    expect(seen[0].messages.filter((m: any) => m.role === "user")).toHaveLength(1);
  });

  it("killed with a steer and a queued prompt waiting: both come back, in order, after the cut-off run", async () => {
    const root = tmp();
    await crashChild(`${HANG}
      const agent = new Agent({ ${CHILD_AGENT}, persist: { dir: process.env.ROOT }, fetch: hang });
      agent.run("busy");
      setTimeout(() => { agent.steer("steer text").catch(() => {}); agent.queue("queued text").catch(() => {}); }, 40);`, { ROOT: root });
    const order: string[] = [];
    const agent = new Agent({ ...config(root, (b) => (order.push(lastUser(b)), textReply("ok"))), resume: "automatic" } as never);
    expect(agent.pendingCount).toBe(2);
    await agent.run("typed after the restart");
    expect(order).toEqual(["busy", "steer text", "queued text", "typed after the restart"]);
  });

  it("killed after a tool finished, during the next model call: the tool is not run again and its result reaches the model", async () => {
    const root = tmp();
    const work = tmp();
    await crashChild(`
      let n = 0;
      const tools = { tool_a: tool({ description: "a", input: z.object({}), execute: async () => { fs.appendFileSync(process.env.WORK + "/a", "x"); return "A-result"; } }) };
      const fetchImpl = async () => {
        if (n++ === 0) return new Response(JSON.stringify({ id: "r", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "tool_a", arguments: "{}" } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
        setTimeout(() => console.log("ready"), 80);
        return new Promise(() => {});
      };
      const agent = new Agent({ ${CHILD_AGENT}, persist: { dir: process.env.ROOT }, fetch: fetchImpl, tools });
      await agent.run("use the tool");`, { ROOT: root, WORK: work });
    const seen: any[] = [];
    const agent = new Agent({
      ...config(root, (b) => (seen.push(b), textReply("finished"))),
      tools: { tool_a: tool({ description: "a", input: z.object({}), execute: async () => (fs.appendFileSync(path.join(work, "a"), "x"), "A-again") }) },
    } as never);
    expect((await agent.resume())!.text).toBe("finished");
    expect(fs.readFileSync(path.join(work, "a"), "utf8")).toBe("x"); // run once, before the kill
    expect(seen[0].messages.filter((m: any) => m.role === "tool").map((m: any) => m.content)).toEqual(["A-result"]);
  });

  it("killed inside a worker call: the replayed `subagents` call continues the same worker and sends its task once", async () => {
    const root = tmp();
    await crashChild(`
      let n = 0;
      const fetchImpl = async (_u, init) => {
        const body = JSON.parse(init.body);
        if (body.tools?.some((t) => t.function.name === "subagents")) {
          return new Response(JSON.stringify({ id: "r", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_spawn", type: "function", function: { name: "subagents", arguments: JSON.stringify({ command: "spawn", name: "helper", task: "do the thing" }) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
        }
        setTimeout(() => console.log("ready"), 100);
        return new Promise(() => {});
      };
      const agent = new Agent({ ${CHILD_AGENT}, persist: { dir: process.env.ROOT }, fetch: fetchImpl, dynamicSubagents: { enabled: true, model: "groq/test-model", maxDepth: 1 } });
      await agent.run("delegate");`, { ROOT: root });
    const workerBodies: any[] = [];
    const agent = new Agent({
      ...config(root, (b) => {
        if (b.tools?.some((t: any) => t.function.name === "subagents")) return textReply("parent done");
        workerBodies.push(b);
        return textReply("worker answer");
      }),
      dynamicSubagents: { enabled: true, model: "groq/test-model", maxDepth: 1 },
    } as never);
    expect((await agent.resume())!.text).toBe("parent done");
    expect(workerBodies).toHaveLength(1);
    expect(workerBodies[0].messages.filter((m: any) => m.role === "user").map((m: any) => m.content)).toEqual(["do the thing"]);
    expect(agent.workers.list()).toHaveLength(1); // the replay found the saved worker instead of creating a second one
  });

  it("killed while a scheduled action cooks: the restart marks it missed and run_now then finishes and delivers it", async () => {
    const home = tmp();
    const out = await crashChild(`${HANG}
      const agent = new Agent({ ${CHILD_AGENT}, home: process.env.HOME_DIR, fetch: hang, dynamicSubagents: { allowScheduledActions: true, model: "groq/test-model" } });
      const rec = createScheduledAction(agent, { instructions: "i", task: "t", scheduled_action: { name: "Job", id: "job", timeToDeliver: "01:07:00", meridiem: "AM" } });
      console.log("id:" + rec.id);
      runScheduledAction(rec.id, { home: process.env.HOME_DIR });`, { HOME_DIR: home });
    const id = /id:(\S+)/.exec(out)![1]!;
    const agent = new Agent({
      ...config(home, () => textReply("job done")),
      persist: undefined,
      home,
      dynamicSubagents: { allowScheduledActions: true, model: "groq/test-model" },
    } as never);
    const scheduler = getScheduler(agent.home);
    scheduler.tick(); // the first tick sweeps what the dead process left
    expect(listScheduledActions({ home }).find((t) => t.id === id)!.state).toBe("missed");
    runScheduledAction(id, { home });
    await scheduler.running.get(id)!.done;
    scheduler.tick();
    const after = listScheduledActions({ home }).find((t) => t.id === id)!;
    expect(after.state).toBe("done");
    expect(after.lastRun!.status).toBe("ok");
  });
});
