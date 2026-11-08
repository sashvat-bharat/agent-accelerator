import { describe, it, expect, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileDurable, readWithBackup } from "../src/utils/durable.ts";
import { Agent } from "../src/agent/agent.ts";
import { loadSessionFile, loadSessionDir, saveSessionFile } from "../src/session/store.ts";
import { createTask, readTasks, updateTask } from "../src/scheduler/store.ts";
import { telemetryBus } from "../src/telemetry.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accel-durable-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("writeFileDurable", () => {
  it("writes the content with mode 0600 and leaves no temp file", () => {
    const dir = tmp();
    const file = path.join(dir, "a", "b.json");
    writeFileDurable(file, '{"ok":1}');
    expect(fs.readFileSync(file, "utf8")).toBe('{"ok":1}');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["b.json"]);
  });

  it("flushes the file and its folder to disk", () => {
    const dir = tmp();
    const spy = spyOn(fs, "fsyncSync");
    try {
      writeFileDurable(path.join(dir, "x.json"), "1");
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2); // the file, then the folder
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the previous version as .bak, always the one before the latest", () => {
    const dir = tmp();
    const file = path.join(dir, "s.json");
    writeFileDurable(file, "one");
    expect(fs.existsSync(`${file}.bak`)).toBe(false); // nothing to back up yet
    writeFileDurable(file, "two");
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe("one");
    writeFileDurable(file, "three");
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe("two");
    expect(fs.readFileSync(file, "utf8")).toBe("three");
  });

  it("backup: false writes no .bak", () => {
    const dir = tmp();
    const file = path.join(dir, "c.json");
    writeFileDurable(file, "one", { backup: false });
    writeFileDurable(file, "two", { backup: false });
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it("removes its temp file and rethrows when the write fails", () => {
    const dir = tmp();
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x");
    expect(() => writeFileDurable(path.join(blocker, "inner.json"), "1")).toThrow();
    expect(fs.readdirSync(dir)).toEqual(["file"]);
  });

  it("writes bytes too", () => {
    const dir = tmp();
    const file = path.join(dir, "b.bin");
    writeFileDurable(file, new Uint8Array([1, 2, 3]));
    expect([...fs.readFileSync(file)]).toEqual([1, 2, 3]);
  });
});

describe("readWithBackup", () => {
  const isJson = (t: string): boolean => {
    try {
      JSON.parse(t);
      return true;
    } catch {
      return false;
    }
  };

  it("returns the file when valid, undefined when missing", () => {
    const dir = tmp();
    const file = path.join(dir, "f.json");
    expect(readWithBackup(file, isJson)).toBeUndefined();
    fs.writeFileSync(file, "[1]");
    expect(readWithBackup(file, isJson)).toEqual({ text: "[1]", fromBackup: false });
  });

  it("falls back to the .bak when the file is damaged", () => {
    const dir = tmp();
    const file = path.join(dir, "f.json");
    writeFileDurable(file, "[1]");
    writeFileDurable(file, "[2]");
    fs.writeFileSync(file, "{broken");
    expect(readWithBackup(file, isJson)).toEqual({ text: "[1]", fromBackup: true });
  });

  it("returns the damaged text when there is no usable backup", () => {
    const dir = tmp();
    const file = path.join(dir, "f.json");
    fs.writeFileSync(file, "{broken");
    expect(readWithBackup(file, isJson)).toEqual({ text: "{broken", fromBackup: false });
  });

  it("does not resurrect a deleted file from its backup", () => {
    const dir = tmp();
    const file = path.join(dir, "f.json");
    writeFileDurable(file, "[1]");
    writeFileDurable(file, "[2]");
    fs.rmSync(file);
    expect(readWithBackup(file, isJson)).toBeUndefined();
  });
});

describe("recovery from the backup", () => {
  it("restores a task.json from its .bak, quarantining the damaged file", () => {
    const home = tmp();
    const warnings: string[] = [];
    const off = telemetryBus.onEvent((e) => warnings.push(e.code));
    try {
      createTask(home, () => "a-bcdef1", (id) => ({ id, name: "first" }) as never);
      updateTask(home, "a-bcdef1", (t) => void ((t as { name: string }).name = "second"));
      const file = path.join(home, "scheduled", "a-bcdef1", "task.json");
      fs.writeFileSync(file, "{not json"); // hand damage after two good writes: .bak holds the first write
      const tasks = readTasks(home);
      expect(tasks.map((t) => t.name)).toEqual(["first"]);
      expect(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith("task.json.corrupt-"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).task.name).toBe("first"); // the file is healthy again
      expect(warnings).toContain("scheduled_action.store_corrupt");
    } finally {
      off();
    }
  });

  it("loads a session from its .bak when session.json is damaged", () => {
    const root = tmp();
    const agent = new Agent({ model: "google/gemini-3.5-flash-lite" });
    const file = path.join(root, "s.session.json");
    agent.context.messages.push({ role: "user", content: "first" });
    saveSessionFile(file, agent, null);
    agent.context.messages.push({ role: "user", content: "second" });
    saveSessionFile(file, agent, null);
    fs.writeFileSync(file, "{truncated");
    expect(loadSessionFile(file)?.messages).toHaveLength(1);
    expect(loadSessionDir(file)?.session.messages).toHaveLength(1);
  });
});
