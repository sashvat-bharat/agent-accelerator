import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutex } from "../src/utils/durable.ts";

const dirs: string[] = [];
// Makes a temp folder removed after the test; in: nothing, out: its path.
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aa-mutex-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("withFileMutex", () => {
  it("runs fn, returns its value and removes the lock file", () => {
    const d = tmp();
    const lock = path.join(d, "m.lock");
    expect(withFileMutex(lock, () => (fs.existsSync(lock) ? 7 : 0))).toBe(7);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("releases the lock when fn throws", () => {
    const d = tmp();
    const lock = path.join(d, "m.lock");
    expect(() => withFileMutex(lock, () => { throw new Error("boom"); })).toThrow("boom");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("a nested use of the same lock throws instead of deadlocking", () => {
    const d = tmp();
    const lock = path.join(d, "m.lock");
    expect(() => withFileMutex(lock, () => withFileMutex(lock, () => 1))).toThrow("nested");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("takes over a lock whose owner process is dead", () => {
    const d = tmp();
    const lock = path.join(d, "m.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), at: Date.now() }));
    expect(withFileMutex(lock, () => "ok")).toBe("ok");
  });

  it("takes over an unreadable lock after a short grace", () => {
    const d = tmp();
    const lock = path.join(d, "m.lock");
    fs.writeFileSync(lock, "not json");
    expect(withFileMutex(lock, () => "ok")).toBe("ok");
  });

  it("takes over a lock held by a live process for longer than 30 s", () => {
    const d = tmp();
    const lock = path.join(d, "m.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), at: 0 }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(withFileMutex(lock, () => "ok")).toBe("ok");
  });

  it("real processes racing on one counter file lose no update", async () => {
    const d = tmp();
    const counter = path.join(d, "counter.txt");
    const lock = path.join(d, "counter.lock");
    fs.writeFileSync(counter, "0");
    const script = path.join(d, "worker.ts");
    fs.writeFileSync(
      script,
      `import * as fs from "node:fs";
import { withFileMutex } from ${JSON.stringify(path.resolve("src/utils/durable.ts"))};
const [counter, lock, n] = process.argv.slice(2);
for (let i = 0; i < Number(n); i++) {
  withFileMutex(lock, () => { fs.writeFileSync(counter, String(Number(fs.readFileSync(counter, "utf8")) + 1)); });
}`
    );
    const procs = Array.from({ length: 6 }, () => Bun.spawn(["bun", script, counter, lock, "100"], { stdout: "inherit", stderr: "inherit" }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Number(fs.readFileSync(counter, "utf8"))).toBe(600);
  }, 60_000);

  it("a process killed while holding the lock does not block the others", async () => {
    const d = tmp();
    const lock = path.join(d, "m.lock");
    const script = path.join(d, "hold.ts");
    fs.writeFileSync(
      script,
      `import { withFileMutex } from ${JSON.stringify(path.resolve("src/utils/durable.ts"))};
withFileMutex(process.argv[2]!, () => { console.log("held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); });`
    );
    const p = Bun.spawn(["bun", script, lock], { stdout: "pipe", stderr: "inherit" });
    const reader = p.stdout.getReader();
    await reader.read(); // "held"
    expect(fs.existsSync(lock)).toBe(true);
    p.kill("SIGKILL");
    await p.exited;
    expect(fs.existsSync(lock)).toBe(true); // a killed holder leaves the file
    expect(withFileMutex(lock, () => "ok")).toBe("ok");
  }, 30_000);
});
