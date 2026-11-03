import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lockFolder, writeFileDurable } from "../src/utils/durable.ts";
import { Agent } from "../src/agent/agent.ts";
import { ConfigError } from "../src/types/errors.ts";
import { listScheduledActions, resetSchedulers } from "../src/scheduler/scheduler.ts";

const roots: string[] = [];
const children: Array<{ kill: (signal?: number | string) => void }> = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accel-lock-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  resetSchedulers();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const durablePath = path.resolve(import.meta.dir, "../src/utils/durable.ts");

// Starts a second process that locks `dir` and stays alive; resolves once it holds the lock.
async function otherProcessHolding(dir: string): Promise<{ pid: number; kill: (signal?: number | string) => void; exited: Promise<number> }> {
  const code = `import { lockFolder } from ${JSON.stringify(durablePath)}; lockFolder(${JSON.stringify(dir)}); console.log("locked"); setInterval(() => {}, 1000);`;
  const child = Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const reader = child.stdout.getReader();
  let seen = "";
  while (!seen.includes("locked")) {
    const { done, value } = await reader.read();
    if (done) throw new Error("child exited before locking: " + (await new Response(child.stderr).text()));
    seen += new TextDecoder().decode(value);
  }
  return child;
}

describe("lockFolder", () => {
  it("is re-entrant inside one process and leaves a lock file with our pid", () => {
    const dir = tmp();
    lockFolder(dir);
    lockFolder(dir);
    const owner = JSON.parse(fs.readFileSync(path.join(dir, ".lock"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(owner.host).toBe(os.hostname());
  });

  it("fails fast with a clear error while another live process holds the folder", async () => {
    const dir = tmp();
    const child = await otherProcessHolding(dir);
    let error: unknown;
    try {
      lockFolder(dir);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(`process ${child.pid}`);
    expect((error as Error).message).toContain(path.join(dir, ".lock"));
  });

  it("takes over the lock of a process that was killed", async () => {
    const dir = tmp();
    const child = await otherProcessHolding(dir);
    child.kill("SIGKILL");
    await child.exited;
    expect(fs.existsSync(path.join(dir, ".lock"))).toBe(true); // a kill leaves the lock behind
    lockFolder(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".lock"), "utf8")).pid).toBe(process.pid);
  });

  it("takes over a lock whose pid no longer exists", async () => {
    const dir = tmp();
    const dead = Bun.spawn(["bun", "-e", "0"]);
    await dead.exited;
    fs.writeFileSync(path.join(dir, ".lock"), JSON.stringify({ pid: dead.pid, host: os.hostname(), startedAt: "x" }));
    lockFolder(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".lock"), "utf8")).pid).toBe(process.pid);
  });

  it("takes over an unreadable (garbage) lock after a short wait", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".lock"), "{garbage");
    lockFolder(dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".lock"), "utf8")).pid).toBe(process.pid);
  });

  it("refuses a lock held from another host", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ".lock"), JSON.stringify({ pid: 1, host: "some-other-machine", startedAt: "x" }));
    expect(() => lockFolder(dir)).toThrow(/some-other-machine/);
  });

  it("sweeps leftover temp files of unfinished writes, and only those", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "sessions", "abc"), { recursive: true });
    const leftovers = [path.join(dir, "tasks.json.tmp-4242-1a2b3c4d"), path.join(dir, "sessions", "abc", "session.json.tmp-7-deadbeef")];
    const keep = [path.join(dir, "tasks.json"), path.join(dir, "notes.tmp"), path.join(dir, "sessions", "abc", "session.json.bak")];
    for (const f of [...leftovers, ...keep]) fs.writeFileSync(f, "x");
    lockFolder(dir);
    for (const f of leftovers) expect(fs.existsSync(f)).toBe(false);
    for (const f of keep) expect(fs.existsSync(f)).toBe(true);
  });

  it("a write that dies half-way leaves a temp file that the next start sweeps", () => {
    const dir = tmp();
    writeFileDurable(path.join(dir, "a.json"), "1");
    fs.writeFileSync(path.join(dir, `a.json.tmp-${process.pid}-0badc0de`), "half");
    lockFolder(dir);
    expect(fs.readdirSync(dir).sort()).toEqual([".lock", "a.json"]);
  });
});

describe("what takes the lock", () => {
  const model = "google/gemini-3.5-flash-lite";

  it("an Agent with persist refuses a folder another process holds", async () => {
    const dir = tmp();
    await otherProcessHolding(dir);
    expect(() => new Agent({ model, persist: { dir } })).toThrow(ConfigError);
    expect(() => new Agent({ model, persist: { file: path.join(dir, "chat.session.json") } })).toThrow(ConfigError);
  });

  it("persist: {} locks the home, not the sessions folder", async () => {
    const home = tmp();
    await otherProcessHolding(home);
    expect(() => new Agent({ model, home, persist: {} })).toThrow(ConfigError);
  });

  it("telemetry.persist and scheduled actions lock the home", async () => {
    const home = tmp();
    await otherProcessHolding(home);
    expect(() => new Agent({ model, home, telemetry: { persist: true } })).toThrow(ConfigError);
    expect(() => listScheduledActions({ home })).toThrow(ConfigError);
    expect(
      () => new Agent({ model, home, subagentModel: model, dynamicSubagents: { allowScheduledActions: true } })
    ).toThrow(ConfigError);
  });

  it("an Agent that writes nothing never takes a lock", async () => {
    const dir = tmp();
    await otherProcessHolding(dir);
    expect(() => new Agent({ model, home: dir })).not.toThrow();
  });
});
