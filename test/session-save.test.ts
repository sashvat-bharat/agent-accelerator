import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { telemetryBus } from "../src/telemetry.ts";
import { saveSessionDir, saveSessionFile, loadSessionDir } from "../src/session/store.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const PNG2 = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9]);

// A scratch folder that is removed afterwards.
function scratch<T>(fn: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "accel-save-"));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The same for a test that awaits: the folder must live until the promise settles.
async function scratchAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "accel-save-"));
  try {
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// An agent whose conversation is one user message with the given parts.
function agentWith(parts: unknown[]): Agent {
  const a = new Agent({ model: "google/gemini-3.5-flash-lite", sessionId: "s1" }); // one id: every save goes to the same folder
  a.context.messages = [{ role: "user", content: [{ type: "text", text: "look" }, ...parts] } as never];
  return a;
}
const image = (bytes: Uint8Array) => ({ type: "image", image: bytes, mimeType: "image/png" });
const pdf = { type: "file", file: "data:application/pdf;base64,AQID", mimeType: "application/pdf", filename: "d.pdf" };

// Warnings on the bus while `fn` runs.
function warnings(fn: () => void): Array<{ code: string; message: string }> {
  const seen: Array<{ code: string; message: string }> = [];
  const off = telemetryBus.onEvent((e) => void seen.push({ code: e.code, message: e.message }));
  try {
    fn();
  } finally {
    off();
  }
  return seen;
}

describe("saving a session folder keeps the old snapshot usable until the new one is in place", () => {
  it("a failed session.json write throws and deletes none of the media the old snapshot uses", () =>
    scratch((root) => {
      const dir = saveSessionDir(root, agentWith([image(PNG), pdf]));
      expect(fs.existsSync(path.join(dir, "media", "image-001.png"))).toBe(true);

      // Make the next session.json write fail: a folder with a file in it cannot be replaced by a rename.
      fs.rmSync(path.join(dir, "session.json"), { force: true });
      fs.rmSync(path.join(dir, "session.json.bak"), { force: true });
      fs.mkdirSync(path.join(dir, "session.json"));
      fs.writeFileSync(path.join(dir, "session.json", "block"), "x");

      expect(() => saveSessionDir(root, agentWith([pdf]), undefined)).toThrow();
      expect(fs.existsSync(path.join(dir, "media", "image-001.png"))).toBe(true); // not deleted before the swap
      expect(fs.existsSync(path.join(dir, "media", "file-001.pdf"))).toBe(true);
    }));

  it("an unchanged media file is not rewritten, a changed one is", () =>
    scratch((root) => {
      const dir = saveSessionDir(root, agentWith([image(PNG)]));
      const file = path.join(dir, "media", "image-001.png");
      const inode = fs.statSync(file).ino;

      saveSessionDir(root, agentWith([image(PNG)]));
      expect(fs.statSync(file).ino).toBe(inode); // same bytes: left alone

      saveSessionDir(root, agentWith([image(PNG2)]));
      expect(new Uint8Array(fs.readFileSync(file))).toEqual(PNG2); // new bytes: replaced
      expect(fs.existsSync(`${file}.bak`)).toBe(false); // media files get no .bak copies
    }));

  it("media the new snapshot no longer uses is removed after the swap, and nothing else is", () =>
    scratch((root) => {
      const dir = saveSessionDir(root, agentWith([image(PNG), pdf]));
      fs.writeFileSync(path.join(dir, "media", "notes.txt"), "mine");

      saveSessionDir(root, agentWith([pdf]));
      expect(fs.existsSync(path.join(dir, "media", "image-001.png"))).toBe(false); // orphan removed
      expect(fs.existsSync(path.join(dir, "media", "file-001.pdf"))).toBe(true);
      expect(fs.readFileSync(path.join(dir, "media", "notes.txt"), "utf8")).toBe("mine"); // not ours: untouched
      expect(loadSessionDir(dir)?.session.messages).toHaveLength(1);
    }));

  it("a media file that cannot be written stays inside the session, with a warning", () =>
    scratch((root) => {
      const dir = path.join(root, "s1");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "media"), "a file where the media folder should be");

      const seen = warnings(() => void saveSessionDir(root, agentWith([image(PNG)]), undefined));
      expect(seen.some((w) => w.code === "session.media_write_failed")).toBe(true);
      const stored = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
      expect(String(stored.messages[0].content[1].image)).toStartWith("data:image/png;base64,"); // nothing lost
    }));
});

describe("a save that fails is not silent", () => {
  it("saveSessionFile throws when the file cannot be written", () =>
    scratch((root) => {
      const blocker = path.join(root, "blocker");
      fs.writeFileSync(blocker, "x");
      expect(() => saveSessionFile(path.join(blocker, "s.json"), agentWith([]))).toThrow();
    }));

  it("saveSessionDir throws when the folder cannot be made", () =>
    scratch((root) => {
      const blocker = path.join(root, "blocker");
      fs.writeFileSync(blocker, "x");
      expect(() => saveSessionDir(blocker, agentWith([]))).toThrow();
    }));

  it("persist.onPersistError is called for a `persist: { file }` agent whose file cannot be written", () =>
    scratchAsync(async (root) => {
      // The target is a folder with something in it, so the write cannot replace it (its parent is fine, so the agent can start).
      const target = path.join(root, "session.json");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "block"), "x");
      const errors: unknown[] = [];
      const a = new Agent({
        model: "google/gemini-3.5-flash-lite",
        persist: { file: target, onPersistError: (e: unknown) => void errors.push(e) },
      });
      a.persistNow();
      await Promise.resolve();
      await Promise.resolve();
      expect(errors).toHaveLength(1);
    }));
});
