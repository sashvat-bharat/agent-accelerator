import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readDeliveries, readTasks } from "../src/scheduler/store.ts";

// Real child processes share one home. Each child has its own Agent "Main" with a mock provider, a fixed fake clock
// and takes commands on stdin; the parent makes them act at the same instant and then reads the files they left.

const roots: string[] = [];
const kids: Child[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.proc.kill("SIGKILL");
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

// Writes the child program once per test and returns its path; in: a temp folder, out: the script path.
function writeChildScript(dir: string): string {
  const file = path.join(dir, "child.ts");
  fs.writeFileSync(
    file,
    `import * as fs from "node:fs";
import { Agent, telemetryBus } from ${JSON.stringify(path.resolve("src/index.ts"))};
import { getScheduler } from ${JSON.stringify(path.resolve("src/scheduler/scheduler.ts"))};
const [home, dir] = process.argv.slice(2) as [string, string];
const events: Array<{ code: string; data: unknown }> = [];
telemetryBus.onEvent((e) => { if (e.code.startsWith("scheduled_action.")) events.push({ code: e.code, data: e.data }); });
const fetchFn = (async () => {
  fs.appendFileSync(dir + "/calls.log", process.pid + "\\n");
  if (process.env.BEHAVE === "hang") while (!fs.existsSync(dir + "/release")) await Bun.sleep(20);
  return new Response(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
}) as unknown as typeof fetch;
const agent = new Agent({
  name: "Main", model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", fetch: fetchFn, retry: { maxRetries: 0 }, home,
  telemetry: process.env.TELEMETRY ? { persist: true } : undefined,
  dynamicSubagents: { enabled: false, model: "groq/test-model", allowScheduledActions: true, tools: {} },
});
const s = getScheduler(home);
s.tickMs = 3_600_000;
const reply = (o: unknown) => console.log(JSON.stringify(o));
const waitUntil = (at: number) => { while (Date.now() < at) { /* all processes act at the same instant */ } };
const input = (n: number) => ({ instructions: "You write briefs.", task: "Write the brief.", tools: [], scheduled_action: { name: "Check " + n, id: "check", timeToDeliver: "00:07:00", meridiem: "PM", startCookingInAdvance: "00:00:10" } });
async function handle(line: string): Promise<unknown> {
  const [cmd, a, b] = line.split(" ");
  if (cmd === "clock") { s.now = () => new Date(a!); return { ok: true }; }
  if (cmd === "tickAt") { waitUntil(Number(a)); s.tick(); return { ok: true }; }
  if (cmd === "settle") { await Promise.all([...s.running.values()].map((r) => r.done)); return { ok: true }; }
  if (cmd === "create") { const ids: string[] = []; for (let i = 0; i < Number(a); i++) ids.push(agent.scheduled.create(input(i) as never).id); return { ids }; }
  if (cmd === "deleteAt") { waitUntil(Number(a)); return await agent.scheduled.delete(b!); }
  if (cmd === "runNow") { agent.scheduled.run(a!); await Promise.all([...s.running.values()].map((r) => r.done)); return { ok: true }; }
  if (cmd === "emitAt") { waitUntil(Number(a)); for (let i = 0; i < Number(b); i++) telemetryBus.emit({ code: "test.load", message: "x".repeat(300), level: "info", data: { pid: process.pid, i } }); return { ok: true }; }
  if (cmd === "dump") return { pid: process.pid, events };
  if (cmd === "exit") process.exit(0);
  return { error: "unknown " + cmd };
}
reply({ ready: true, pid: process.pid });
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    reply(await handle(line));
  }
}
`
  );
  return file;
}

class Child {
  proc: ReturnType<typeof Bun.spawn>;
  pid = 0;
  private replies: any[] = [];
  private waiting: Array<(v: any) => void> = [];
  constructor(script: string, home: string, dir: string, env: Record<string, string> = {}) {
    this.proc = Bun.spawn(["bun", script, home, dir], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, ...env } });
    kids.push(this);
    void this.pump();
  }
  // Reads the child's stdout and hands each JSON line to whoever waits for a reply; in: the constructor, out: next().
  private async pump(): Promise<void> {
    let buf = "";
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buf += new TextDecoder().decode(chunk);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.startsWith("{")) continue;
        const value = JSON.parse(line);
        const w = this.waiting.shift();
        if (w) w(value);
        else this.replies.push(value);
      }
    }
  }
  // The next reply line of the child; in: send and start, out: a parsed object.
  next(): Promise<any> {
    const ready = this.replies.shift();
    return ready ? Promise.resolve(ready) : new Promise((r) => this.waiting.push(r));
  }
  // Sends one command and waits for its reply; in: tests, out: the child's answer.
  async send(cmd: string): Promise<any> {
    (this.proc.stdin as { write(s: string): number; flush(): void }).write(cmd + "\n");
    (this.proc.stdin as { flush(): void }).flush();
    return this.next();
  }
}

// Starts `n` children on one fresh home; in: a test, out: the home, the shared scratch folder and the ready children.
async function start(n: number, env: Array<Record<string, string>> = []): Promise<{ home: string; dir: string; kids: Child[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-proc-"));
  roots.push(dir);
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const script = writeChildScript(dir);
  const list = Array.from({ length: n }, (_, i) => new Child(script, home, dir, env[i] ?? {}));
  for (const c of list) c.pid = (await c.next()).pid;
  return { home, dir, kids: list };
}
const all = <T>(cs: Child[], fn: (c: Child, i: number) => Promise<T>): Promise<T[]> => Promise.all(cs.map(fn));
const soon = (): number => Date.now() + 500;
const calls = (dir: string): string[] => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") : []);
const count = (dumps: any[], code: string): number => dumps.reduce((n, d) => n + d.events.filter((e: any) => e.code === `scheduled_action.${code}`).length, 0);
const leftovers = (home: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (/\.tmp-\d+-/.test(e.name) || e.name === ".mutex") out.push(path.join(d, e.name));
    }
  };
  walk(path.join(home, "scheduled"));
  return out;
};

describe("scheduled actions across real processes", () => {
  it("four processes that own the Agent run an action once and deliver it once", async () => {
    const { home, dir, kids: cs } = await start(4);
    const { ids } = await cs[0]!.send("clock 2026-10-26T15:00:00").then(() => cs[0]!.send("create 1"));
    await all(cs, (c) => c.send("clock 2026-10-26T18:50:00"));
    const t1 = soon();
    await all(cs, (c) => c.send(`tickAt ${t1}`));
    await all(cs, (c) => c.send("settle"));
    expect(calls(dir)).toHaveLength(1); // one model call: one run
    expect(readDeliveries(home)).toHaveLength(1);
    expect(fs.readdirSync(path.join(home, "scheduled", ids[0])).filter((f) => f.endsWith(".md"))).toHaveLength(1);

    await all(cs, (c) => c.send("clock 2026-10-26T19:00:00"));
    const t2 = soon();
    await all(cs, (c) => c.send(`tickAt ${t2}`));
    const dumps = await all(cs, (c) => c.send("dump"));
    expect(count(dumps, "started")).toBe(1);
    expect(count(dumps, "ready")).toBe(1);
    expect(count(dumps, "delivered")).toBe(1); // exactly one process announced it
    expect(readDeliveries(home)).toEqual([]);
    expect(readTasks(home)[0]).toMatchObject({ state: "done", lastRun: { status: "ok" } });
    expect(leftovers(home)).toEqual([]);
  }, 60_000);

  it("a process killed with kill -9 in the middle of a run: a live owner leaves it alone, a survivor recovers it once the owner is dead", async () => {
    const { home, dir, kids: cs } = await start(2, [{ BEHAVE: "hang" }, {}]);
    const [owner, survivor] = cs as [Child, Child];
    await owner.send("clock 2026-10-26T15:00:00");
    const { ids } = await owner.send("create 1");
    const id = ids[0] as string;
    await owner.send("clock 2026-10-26T18:50:00");
    await owner.send(`tickAt ${Date.now()}`); // starts the run; the provider hangs
    for (let i = 0; i < 200 && calls(dir).length === 0; i++) await Bun.sleep(10);
    const heartbeat = path.join(home, "scheduled", id, ".heartbeat");
    expect(JSON.parse(fs.readFileSync(heartbeat, "utf8")).pid).toBe(owner.pid);
    expect(readTasks(home)[0]!.state).toBe("cooking");

    // The survivor owns an Agent with the same name but must not touch a run whose owner is alive.
    await survivor.send("clock 2026-10-26T18:55:00");
    await survivor.send(`tickAt ${Date.now()}`);
    expect(readTasks(home)[0]!.state).toBe("cooking");
    expect(count([await survivor.send("dump")], "missed")).toBe(0);

    owner.proc.kill("SIGKILL");
    await owner.proc.exited;
    await survivor.send("clock 2026-10-26T18:56:00"); // a minute later: the periodic look for dead owners is due
    await survivor.send(`tickAt ${Date.now()}`);
    expect(readTasks(home)[0]!.state).toBe("missed");
    const dump = await survivor.send("dump");
    expect(dump.events.filter((e: any) => e.code === "scheduled_action.missed").map((e: any) => e.data.reason)).toEqual(["interrupted"]);
    expect(calls(dir)).toHaveLength(1); // nothing was run twice

    await survivor.send(`runNow ${id}`); // the user resolves it
    expect(readDeliveries(home)).toHaveLength(1);
    expect(calls(dir)).toHaveLength(2);
  }, 60_000);

  it("a run that finished before its owner was killed is rebuilt once, without running again", async () => {
    // Crash window: run file written, delivery entry and task update lost. Simulated on disk, recovered by another real process.
    const { home, dir, kids: cs } = await start(2);
    const [a, b] = cs as [Child, Child];
    await a.send("clock 2026-10-26T15:00:00");
    const { ids } = await a.send("create 1");
    const id = ids[0] as string;
    await a.send("clock 2026-10-26T18:50:00");
    await a.send(`tickAt ${Date.now()}`);
    await a.send("settle");
    expect(calls(dir)).toHaveLength(1);
    a.proc.kill("SIGKILL");
    await a.proc.exited;
    const folder = path.join(home, "scheduled", id);
    fs.rmSync(path.join(folder, "delivery.json"), { force: true });
    fs.rmSync(path.join(folder, "delivery.json.bak"), { force: true });
    const task = JSON.parse(fs.readFileSync(path.join(folder, "task.json"), "utf8"));
    task.task.state = "cooking";
    task.task.current = { cookStartedAt: "2026-10-26T18:50:00", deliverAt: "2026-10-26T19:00:00" };
    fs.writeFileSync(path.join(folder, "task.json"), JSON.stringify(task));
    await b.send("clock 2026-10-26T18:55:00");
    await b.send(`tickAt ${Date.now()}`);
    expect(readDeliveries(home)).toHaveLength(1);
    expect(readTasks(home)[0]).toMatchObject({ state: "done" });
    expect(calls(dir)).toHaveLength(1);
  }, 60_000);

  it("four processes creating actions at once end up with every action and no id twice", async () => {
    const { home, kids: cs } = await start(4);
    await all(cs, (c) => c.send("clock 2026-10-26T15:00:00"));
    const made = await all(cs, (c) => c.send("create 10"));
    const ids = made.flatMap((m) => m.ids as string[]);
    expect(new Set(ids).size).toBe(40);
    expect(readTasks(home).map((t) => t.id).sort()).toEqual([...ids].sort());
    expect(leftovers(home)).toEqual([]);
  }, 60_000);

  it("four processes deleting the same action at once: exactly one succeeds", async () => {
    const { home, kids: cs } = await start(4);
    await cs[0]!.send("clock 2026-10-26T15:00:00");
    const { ids } = await cs[0]!.send("create 1");
    const at = soon();
    const results = await all(cs, (c) => c.send(`deleteAt ${at} ${ids[0]}`));
    expect(results.filter((r) => r.ok === true)).toHaveLength(1);
    expect(results.filter((r) => r.ok === false).every((r) => r.reason === "not_found")).toBe(true);
    expect(readTasks(home)).toEqual([]);
  }, 60_000);

  it("three processes writing telemetry to the same daily file never mix their lines", async () => {
    const { home, kids: cs } = await start(3, [{ TELEMETRY: "1" }, { TELEMETRY: "1" }, { TELEMETRY: "1" }]);
    const at = soon();
    await all(cs, (c) => c.send(`emitAt ${at} 300`));
    const dayDir = path.join(home, "telemetry");
    const lines = fs.readdirSync(dayDir).flatMap((f) => fs.readFileSync(path.join(dayDir, f), "utf8").split("\n").filter(Boolean));
    const load = lines.map((l) => JSON.parse(l)).filter((e) => e.code === "test.load"); // every line must parse
    expect(load).toHaveLength(900);
    for (const c of cs) expect(load.filter((e) => e.data.pid === c.pid)).toHaveLength(300);
  }, 60_000);
});
