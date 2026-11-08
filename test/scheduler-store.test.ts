import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTask, deleteTask, readDeliveries, readTask, readTasks, updateDeliveries, updateTask, writeRunFile } from "../src/scheduler/store.ts";
import type { PendingDelivery } from "../src/scheduler/store.ts";
import { telemetryBus } from "../src/telemetry.ts";

const homes: string[] = [];
// Makes a temp home removed after the test; in: nothing, out: its path.
function home(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aa-store-"));
  homes.push(d);
  return d;
}
afterEach(() => {
  for (const d of homes.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
// A minimal record for a test; in: an id, out: a record (the store does not validate).
const rec = (id: string, extra: Record<string, unknown> = {}): never => ({ id, name: id, createdAt: "2026-10-26T08:00:00", ...extra }) as never;
const delivery = (id: string, n: number): PendingDelivery => ({ id, file: `${id}/${n}.md`, status: "ok", readyAt: "2026-10-26T18:50:00", deliverAt: `2026-10-26T19:0${n}:00` });

describe("sharded scheduler store", () => {
  it("keeps each action in its own folder and changing one never touches another's files", () => {
    const h = home();
    createTask(h, () => "alpha-aaaaaa", (id) => rec(id));
    createTask(h, () => "beta-bbbbbb", (id) => rec(id));
    const betaFile = path.join(h, "scheduled", "beta-bbbbbb", "task.json");
    const before = fs.statSync(betaFile).mtimeMs;
    updateTask(h, "alpha-aaaaaa", (t) => void ((t as { name: string }).name = "changed"));
    expect(fs.statSync(betaFile).mtimeMs).toBe(before);
    expect(readTasks(h).map((t) => t.name)).toEqual(["changed", "beta-bbbbbb"]);
    expect(fs.existsSync(path.join(h, "scheduled", "tasks.json"))).toBe(false);
  });

  it("writes nothing when the callback changed nothing, and nothing when it throws", () => {
    const h = home();
    createTask(h, () => "a-aaaaaa", (id) => rec(id));
    const file = path.join(h, "scheduled", "a-aaaaaa", "task.json");
    const m = fs.statSync(file).mtimeMs;
    updateTask(h, "a-aaaaaa", () => 1);
    expect(fs.statSync(file).mtimeMs).toBe(m);
    expect(() => updateTask(h, "a-aaaaaa", (t) => { (t as { name: string }).name = "x"; throw new Error("no"); })).toThrow("no");
    expect(readTask(h, "a-aaaaaa")!.name).toBe("a-aaaaaa");
    expect(fs.existsSync(path.join(h, "scheduled", "a-aaaaaa", ".mutex"))).toBe(false);
  });

  it("a missing action gives the callback undefined and creates no folder; an unsafe id is treated as missing", () => {
    const h = home();
    expect(updateTask(h, "ghost-abc123", (t) => t)).toBeUndefined();
    expect(updateTask(h, "../escape", (t) => t)).toBeUndefined();
    expect(readTask(h, "../escape")).toBeUndefined();
    expect(fs.existsSync(path.join(h, "scheduled", "ghost-abc123"))).toBe(false);
  });

  it("createTask never reuses an id that has a folder, even one without a record", () => {
    const h = home();
    fs.mkdirSync(path.join(h, "scheduled", "taken-aaaaaa"), { recursive: true }); // e.g. an old purged-run folder
    const ids = ["taken-aaaaaa", "taken-aaaaaa", "free-bbbbbb"];
    const made = createTask(h, () => ids.shift()!, (id) => rec(id));
    expect(made.id).toBe("free-bbbbbb");
    expect(ids).toEqual([]);
  });

  it("lists oldest first and skips folders without a record, dot folders and non-action names", () => {
    const h = home();
    createTask(h, () => "b-bbbbbb", (id) => rec(id, { createdAt: "2026-10-26T09:00:00" }));
    createTask(h, () => "a-aaaaaa", (id) => rec(id, { createdAt: "2026-10-26T10:00:00" }));
    for (const d of ["empty-cccccc", ".hidden", "Not An Id"]) fs.mkdirSync(path.join(h, "scheduled", d));
    fs.writeFileSync(path.join(h, "scheduled", "stray.txt"), "x");
    expect(readTasks(h).map((t) => t.id)).toEqual(["b-bbbbbb", "a-aaaaaa"]);
  });

  it("skips (and warns once) a record whose id is not its folder's name", () => {
    const h = home();
    const codes: string[] = [];
    const off = telemetryBus.onEvent((e) => codes.push(e.code));
    try {
      const dir = path.join(h, "scheduled", "right-aaaaaa");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ version: 2, task: rec("other-bbbbbb") }));
      expect(readTasks(h)).toEqual([]);
      expect(readTasks(h)).toEqual([]);
      expect(codes.filter((c) => c === "scheduled_action.invalid")).toHaveLength(1);
    } finally {
      off();
    }
  });

  it("deleteTask removes the record and the saved deliveries, keeps run files, and removes a folder it emptied", () => {
    const h = home();
    createTask(h, () => "keep-aaaaaa", (id) => rec(id));
    createTask(h, () => "gone-bbbbbb", (id) => rec(id));
    updateDeliveries(h, "keep-aaaaaa", (p) => void p.push(delivery("keep-aaaaaa", 1)));
    writeRunFile(h, "keep-aaaaaa", new Date(2026, 9, 26, 19), { id: "keep-aaaaaa", name: "k", status: "ok", startedAt: "a", finishedAt: "b", deliverAt: "c", late: false }, "result");
    expect(deleteTask(h, "keep-aaaaaa")).toBe(true);
    expect(deleteTask(h, "gone-bbbbbb")).toBe(true);
    expect(deleteTask(h, "gone-bbbbbb")).toBe(false);
    expect(readTasks(h)).toEqual([]);
    expect(readDeliveries(h)).toEqual([]);
    expect(fs.readdirSync(path.join(h, "scheduled", "keep-aaaaaa"))).toEqual(["26-october-2026.md"]);
    expect(fs.existsSync(path.join(h, "scheduled", "gone-bbbbbb"))).toBe(false);
  });

  it("deliveries: per action, sorted by delivery time across actions, the file goes away when the list is empty", () => {
    const h = home();
    createTask(h, () => "a-aaaaaa", (id) => rec(id));
    createTask(h, () => "b-bbbbbb", (id) => rec(id));
    updateDeliveries(h, "a-aaaaaa", (p) => void p.push(delivery("a-aaaaaa", 5)));
    updateDeliveries(h, "b-bbbbbb", (p) => void p.push(delivery("b-bbbbbb", 2), delivery("b-bbbbbb", 3)));
    expect(readDeliveries(h).map((d) => d.file)).toEqual(["b-bbbbbb/2.md", "b-bbbbbb/3.md", "a-aaaaaa/5.md"]);
    updateDeliveries(h, "b-bbbbbb", (p) => void p.splice(0));
    expect(fs.existsSync(path.join(h, "scheduled", "b-bbbbbb", "delivery.json"))).toBe(false);
    expect(fs.existsSync(path.join(h, "scheduled", "b-bbbbbb", "delivery.json.bak"))).toBe(false);
    expect(readDeliveries(h).map((d) => d.file)).toEqual(["a-aaaaaa/5.md"]);
  });

  it("real processes changing the same action lose no update, and different actions never wait for each other", async () => {
    const h = home();
    createTask(h, () => "shared-aaaaaa", (id) => rec(id, { count: 0 }));
    createTask(h, () => "other-bbbbbb", (id) => rec(id, { count: 0 }));
    const script = path.join(h, "worker.ts");
    fs.writeFileSync(
      script,
      `import { updateTask } from ${JSON.stringify(path.resolve("src/scheduler/store.ts"))};
const [home, id, n] = process.argv.slice(2);
for (let i = 0; i < Number(n); i++) updateTask(home!, id!, (t) => { (t as any).count += 1; });`
    );
    const procs = [
      ...Array.from({ length: 5 }, () => Bun.spawn(["bun", script, h, "shared-aaaaaa", "60"], { stderr: "inherit" })),
      Bun.spawn(["bun", script, h, "other-bbbbbb", "60"], { stderr: "inherit" }),
    ];
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0, 0, 0]);
    expect((readTask(h, "shared-aaaaaa") as unknown as { count: number }).count).toBe(300);
    expect((readTask(h, "other-bbbbbb") as unknown as { count: number }).count).toBe(60);
  }, 90_000);

  it("real processes creating actions at once never share an id", async () => {
    const h = home();
    const script = path.join(h, "creator.ts");
    fs.writeFileSync(
      script,
      `import { createTask } from ${JSON.stringify(path.resolve("src/scheduler/store.ts"))};
const [home] = process.argv.slice(2);
let first = true;
for (let i = 0; i < 20; i++) { first = true; createTask(home!, () => (first ? ((first = false), "same-aaaaaa") : "x-" + Math.random().toString(36).slice(2, 8)), (id) => ({ id, name: id }) as never); }`
    );
    const procs = Array.from({ length: 4 }, () => Bun.spawn(["bun", script, h], { stderr: "inherit" }));
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0]);
    const ids = readTasks(h).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(80); // none lost: the clash moved to a random id
    expect(ids).toContain("same-aaaaaa");
  }, 90_000);
});

describe("leftovers of a killed writer", () => {
  it("an update sweeps the temp files of an unfinished task.json / delivery.json write, never a run file's", () => {
    const h = home();
    createTask(h, () => "a-aaaaaa", (id) => rec(id));
    const dir = path.join(h, "scheduled", "a-aaaaaa");
    const dead = [`task.json.tmp-4242-1a2b3c4d`, `delivery.json.tmp-4242-1a2b3c4d`];
    const live = [`26-october-2026.md.tmp-4242-1a2b3c4d`, "notes.tmp"]; // another process may be writing a run file right now
    for (const f of [...dead, ...live]) fs.writeFileSync(path.join(dir, f), "x");
    updateTask(h, "a-aaaaaa", () => 1);
    for (const f of dead) expect(fs.existsSync(path.join(dir, f))).toBe(false);
    for (const f of live) expect(fs.existsSync(path.join(dir, f))).toBe(true);
  });
});
