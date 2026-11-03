import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { loadSessionDir, findLatestSessionDir, saveSessionDir, sessionDirFor, JOURNAL_FILE } from "../src/session/store.ts";
import { telemetryBus } from "../src/telemetry.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accel-journal-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const model = "google/gemini-3.5-flash-lite";
// A persisted agent plus helpers: write the current state now, read the files back.
function persisted() {
  const root = tmp();
  const agent = new Agent({ model, persist: { dir: root } });
  const dir = sessionDirFor(root, agent.sessionId);
  const flush = async (): Promise<void> => {
    agent.persistNow();
    await new Promise((r) => setTimeout(r, 0));
  };
  const journal = (): string[] => fs.readFileSync(path.join(dir, JOURNAL_FILE), "utf8").split("\n").filter(Boolean);
  const snapshot = (): string => fs.readFileSync(path.join(dir, "session.json"), "utf8");
  return { root, agent, dir, flush, journal, snapshot };
}
const user = (text: string) => ({ role: "user" as const, content: text });

describe("session journal", () => {
  it("writes a snapshot with an epoch first, then appends one line per new message without touching it", async () => {
    const t = persisted();
    t.agent.context.messages.push(user("one"));
    await t.flush();
    const first = t.snapshot();
    expect(JSON.parse(first).epoch).toBeString();
    expect(t.journal()).toHaveLength(1); // the header only
    t.agent.context.messages.push(user("two"), user("three"));
    await t.flush();
    t.agent.context.messages.push(user("four"));
    await t.flush();
    expect(t.snapshot()).toBe(first); // constant cost per step: the snapshot is not rewritten
    const lines = t.journal().map((l) => JSON.parse(l));
    expect(lines.map((l) => l.t)).toEqual(["base", "msg", "msg", "msg"]);
    expect(lines.slice(1).map((l) => l.i)).toEqual([1, 2, 3]);
    expect(loadSessionDir(t.dir)!.session.messages.map((m) => m.content)).toEqual(["one", "two", "three", "four"]);
  });

  it("appends a meta record when the system prompt or config changes, and replays it", async () => {
    const t = persisted();
    t.agent.context.messages.push(user("one"));
    await t.flush();
    t.agent.context.systemPrompt = "new rules";
    await t.flush();
    expect(t.journal().map((l) => JSON.parse(l).t)).toEqual(["base", "meta"]);
    expect(loadSessionDir(t.dir)!.session.systemPrompt).toBe("new rules");
  });

  it("ignores a torn last line", async () => {
    const t = persisted();
    t.agent.context.messages.push(user("one"));
    await t.flush();
    t.agent.context.messages.push(user("two"));
    await t.flush();
    fs.appendFileSync(path.join(t.dir, JOURNAL_FILE), '{"t":"msg","i":2,"m":{"role":"us'); // a write cut by a crash
    const seen: string[] = [];
    const off = telemetryBus.onEvent((e) => seen.push(e.code));
    try {
      expect(loadSessionDir(t.dir)!.session.messages).toHaveLength(2);
      expect(seen).not.toContain("session.journal_corrupt");
    } finally {
      off();
    }
  });

  it("stops at damage in the middle, keeps what came before and says so", async () => {
    const t = persisted();
    t.agent.context.messages.push(user("one"));
    await t.flush();
    t.agent.context.messages.push(user("two"));
    await t.flush();
    t.agent.context.messages.push(user("three"));
    await t.flush();
    const lines = fs.readFileSync(path.join(t.dir, JOURNAL_FILE), "utf8").split("\n");
    lines[1] = "{garbage"; // line 0 is the header, line 1 the record of "two" ("one" is in the snapshot)
    fs.writeFileSync(path.join(t.dir, JOURNAL_FILE), lines.join("\n"));
    const seen: string[] = [];
    const off = telemetryBus.onEvent((e) => seen.push(e.code));
    try {
      expect(loadSessionDir(t.dir)!.session.messages.map((m) => m.content)).toEqual(["one"]);
      expect(seen).toContain("session.journal_corrupt");
    } finally {
      off();
    }
  });

  it("a rollback writes a fresh snapshot and the rolled-back messages never come back", async () => {
    const t = persisted();
    t.agent.context.messages.push(user("one"));
    await t.flush();
    const before = JSON.parse(t.snapshot()).epoch;
    t.agent.context.messages.push(user("two"), user("three"));
    await t.flush();
    const { messages, signatures } = t.agent.context.checkpoint();
    t.agent.context.messages.pop(); // history shrinks (what a failed run's rollback does)
    t.agent.context.rollback({ messages: messages.slice(0, 2), signatures });
    await t.flush();
    expect(JSON.parse(t.snapshot()).epoch).not.toBe(before);
    expect(t.journal()).toHaveLength(1);
    expect(loadSessionDir(t.dir)!.session.messages.map((m) => m.content)).toEqual(["one", "two"]);
  });

  it("ignores a journal left from before the snapshot (crash between the two writes)", async () => {
    const t = persisted();
    t.agent.context.messages.push(user("one"), user("two"));
    await t.flush();
    t.agent.context.messages.push(user("three"));
    await t.flush();
    const old = fs.readFileSync(path.join(t.dir, JOURNAL_FILE), "utf8");
    t.agent.context.messages = [user("fresh")]; // new history: snapshot + new journal
    await t.flush();
    fs.writeFileSync(path.join(t.dir, JOURNAL_FILE), old); // as if the journal reset never happened
    expect(loadSessionDir(t.dir)!.session.messages.map((m) => m.content)).toEqual(["fresh"]);
  });

  it("folds the journal into a snapshot once it is long, without losing a message", async () => {
    const t = persisted();
    t.agent.context.messages.push(user("m0"));
    await t.flush();
    const epoch = JSON.parse(t.snapshot()).epoch;
    for (let i = 1; i <= 2; i++) {
      for (let k = 0; k < 250; k++) t.agent.context.messages.push(user(`m${i}-${k}`));
      await t.flush();
    }
    expect(JSON.parse(t.snapshot()).epoch).not.toBe(epoch); // compacted
    expect(t.journal()).toHaveLength(1);
    expect(JSON.parse(t.snapshot()).messages).toHaveLength(501);
    expect(loadSessionDir(t.dir)!.session.messages).toHaveLength(501);
  });

  it("stores media once, by content, and the loaded session points at the files", async () => {
    const t = persisted();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    t.agent.context.messages.push({ role: "user", content: [{ type: "image", image: png, mimeType: "image/png" }] });
    await t.flush();
    t.agent.context.messages.push({ role: "user", content: [{ type: "image", image: new Uint8Array(png), mimeType: "image/png" }] });
    await t.flush();
    const files = fs.readdirSync(path.join(t.dir, "media"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^image-h[0-9a-f]{16}\.png$/);
    expect(t.journal()[1]).toContain(`media/${files[0]}`);
    const loaded = loadSessionDir(t.dir)!.session;
    const part = (loaded.messages[1]!.content as any[])[0];
    expect(part.image).toBe(path.join(t.dir, "media", files[0]!));
    expect([...fs.readFileSync(part.image)]).toEqual([...png]);
    t.agent.context.messages = t.agent.context.messages.slice(0, 1); // a snapshot re-uses the file
    await t.flush();
    expect(fs.readdirSync(path.join(t.dir, "media"))).toEqual(files);
  });

  it("a snapshot without an epoch (older file, or saveSessionDir) never replays a journal", async () => {
    const t = persisted();
    t.agent.context.messages.push(user("one"));
    await t.flush();
    t.agent.context.messages.push(user("two"));
    await t.flush();
    saveSessionDir(t.root, t.agent, null); // explicit full save: no epoch
    expect(loadSessionDir(t.dir)!.session.messages).toHaveLength(2);
    fs.appendFileSync(path.join(t.dir, JOURNAL_FILE), JSON.stringify({ t: "msg", i: 2, m: user("stray") }) + "\n");
    expect(loadSessionDir(t.dir)!.session.messages).toHaveLength(2);
  });

  it("findLatestSessionDir counts journal writes as activity", async () => {
    const root = tmp();
    const a = new Agent({ model, persist: { dir: root }, sessionId: "older" });
    const b = new Agent({ model, persist: { dir: root }, sessionId: "newer" });
    a.context.messages.push(user("a"));
    b.context.messages.push(user("b"));
    a.persistNow();
    b.persistNow();
    await new Promise((r) => setTimeout(r, 20));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(root, "older", "session.json"), past, past);
    fs.utimesSync(path.join(root, "newer", "session.json"), past, past);
    a.context.messages.push(user("a2")); // only a journal append, session.json stays old
    a.persistNow();
    await new Promise((r) => setTimeout(r, 20));
    expect(findLatestSessionDir(root)).toBe(path.join(root, "older"));
  });

  it("persists a real run step by step (user, assistant) and reloads it", async () => {
    const root = tmp();
    const reply = () =>
      new Response(
        JSON.stringify({ id: "r1", choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    const agent = new Agent({ model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", fetch: (async () => reply()) as unknown as typeof fetch, persist: { dir: root } });
    await agent.run("hi");
    await agent.run("again");
    await new Promise((r) => setTimeout(r, 10));
    const loaded = loadSessionDir(sessionDirFor(root, agent.sessionId))!.session;
    expect(loaded.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(fs.readFileSync(path.join(sessionDirFor(root, agent.sessionId), JOURNAL_FILE), "utf8").split("\n").filter(Boolean).length).toBeGreaterThan(1);
  });
});

describe("run marks and waiting prompts", () => {
  const ok = () =>
    new Response(
      JSON.stringify({ id: "r1", choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const mk = (root: string, fetchImpl: () => Promise<Response>) =>
    new Agent({ model: "groq/test-model", apiKey: "k", baseUrl: "https://example.test/v1", fetch: fetchImpl as unknown as typeof fetch, persist: { dir: root } });
  const settle = () => new Promise((r) => setTimeout(r, 15));

  it("marks where each run began, saves it, and importSession restores it", async () => {
    const root = tmp();
    const agent = mk(root, async () => ok());
    await agent.run("one");
    await agent.run("two");
    await settle();
    const loaded = loadSessionDir(sessionDirFor(root, agent.sessionId))!.session;
    expect(loaded.runs!.map((r) => r.i)).toEqual([0, 2]); // user messages sit at 0 and 2
    expect(new Set(loaded.runs!.map((r) => r.id)).size).toBe(2);
    const other = new Agent({ model });
    other.importSession(loaded);
    expect(other.runMarks.map((r) => r.i)).toEqual([0, 2]);
  });

  it("run marks survive a fold into a snapshot", async () => {
    const root = tmp();
    const agent = mk(root, async () => ok());
    await agent.run("one");
    await settle();
    agent.context.messages = agent.context.messages.slice(); // new array, same objects: still a plain append
    for (let k = 0; k < 520; k++) agent.context.messages.push(user(`filler ${k}`)); // pushes the journal past 500 lines
    agent.persistNow();
    await settle();
    const dir = sessionDirFor(root, agent.sessionId);
    expect(fs.readFileSync(path.join(dir, JOURNAL_FILE), "utf8").split("\n").filter(Boolean)).toHaveLength(1); // folded
    expect(JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")).runs).toHaveLength(1);
    expect(loadSessionDir(dir)!.session.runs).toHaveLength(1);
  });

  it("a failed run keeps its prompt in history, so its mark stays valid", async () => {
    const root = tmp();
    let calls = 0;
    const agent = mk(root, async () =>
      calls++ === 0 ? new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }) : ok()
    );
    await expect(agent.run("first try")).rejects.toThrow();
    await agent.run("second try");
    await settle();
    const loaded = loadSessionDir(sessionDirFor(root, agent.sessionId))!.session;
    expect(loaded.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(loaded.runs!.map((r) => r.i)).toEqual([0, 1]); // each mark points at its own prompt
  });

  it("saves steers and follow-ups that are still waiting, and clears them once handled", async () => {
    const root = tmp();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    const agent = mk(root, async () => {
      if (first) {
        first = false;
        await held;
      }
      return ok();
    });
    const dir = sessionDirFor(root, agent.sessionId);
    const run = agent.run("busy");
    await settle();
    void agent.steer("also this");
    const queued = agent.queue("and then that", { additionalContext: "ctx" });
    await settle();
    const waiting = loadSessionDir(dir)!.session.pending!;
    expect(waiting.steer.map((p) => p.prompt)).toEqual(["also this"]);
    expect(waiting.queue).toEqual([{ prompt: "and then that", additionalContext: "ctx" }]);
    release();
    await run;
    await queued;
    await settle();
    expect(loadSessionDir(dir)!.session.pending).toBeUndefined();
  });

  it("waiting prompts survive a fold, and their media is stored as a file", async () => {
    const root = tmp();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    const agent = mk(root, async () => {
      if (first) {
        first = false;
        await held;
      }
      return ok();
    });
    const dir = sessionDirFor(root, agent.sessionId);
    const run = agent.run("busy");
    await settle();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]);
    const queued = agent.queue([{ type: "text", text: "look" }, { type: "image", image: png, mimeType: "image/png" }]);
    await settle();
    for (let k = 0; k < 520; k++) agent.context.messages.push(user(`filler ${k}`));
    agent.persistNow();
    await settle();
    const waiting = loadSessionDir(dir)!.session.pending!;
    expect(waiting.queue).toHaveLength(1);
    expect((waiting.queue[0]!.prompt as any[])[1].image).toMatch(/media\/image-h[0-9a-f]{16}\.png$/);
    expect(fs.readdirSync(path.join(dir, "media"))).toHaveLength(1);
    release();
    await run;
    await queued;
  });
});
