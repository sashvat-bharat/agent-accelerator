import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, telemetryBus, findLatestSessionDir } from "../src/index.ts";
import { sessionDirFor } from "../src/session/store.ts";
import { resetTelemetryFile } from "../src/telemetry-file.ts";

const roots: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accel-telsess-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  resetTelemetryFile();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

// An Agent that persists sessions under <home>/sessions and writes telemetry; in: its home and session id, out: the Agent.
const agent = (home: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  new Agent({ model: "groq/x", apiKey: "k", baseUrl: "https://example.test/v1", home, sessionId, persist: {}, telemetry: { persist: true }, ...extra });
const emit = (code: string, sessionId?: string) => telemetryBus.emit({ code, message: code, ...(sessionId ? { data: { sessionId } } : {}) });
const read = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).code) : []);
const daily = (home: string): string[] => {
  const dir = path.join(home, "telemetry");
  return fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((f) => read(path.join(dir, f))) : [];
};

describe("per-session telemetry files", () => {
  it("writes a session's events next to its journal and everything else to the daily file", () => {
    const home = tmp();
    agent(home, "s1");
    emit("tool.call_started", "s1");
    emit("provider_warning");
    emit("tool.call_started", "some-other-session");
    const own = path.join(sessionDirFor(path.join(home, "sessions"), "s1"), "telemetry.ndjson");
    expect(read(own)).toEqual(["tool.call_started"]);
    expect(daily(home)).toEqual(["provider_warning", "tool.call_started"]);
  });

  it("never writes reasoning text, in either place", () => {
    const home = tmp();
    agent(home, "s1");
    telemetryBus.emit({ code: "turn.thinking", message: "secret", data: { sessionId: "s1", thinking: "x" } });
    telemetryBus.emit({ code: "turn.thinking", message: "secret", data: { thinking: "x" } });
    expect(fs.existsSync(path.join(sessionDirFor(path.join(home, "sessions"), "s1"), "telemetry.ndjson"))).toBe(false);
    expect(daily(home)).toEqual([]);
  });

  it("a worker's events go to the worker's own folder", async () => {
    const home = tmp();
    const ok = (async () =>
      new Response(JSON.stringify({ id: "r", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const parent = agent(home, "p1", { fetch: ok, dynamicSubagents: { model: "groq/w", tools: {} } });
    const r = await parent.workers.spawn({ name: "r", task: "go" });
    const workerSession = r.metadata.sessionId!;
    emit("tool.call_failed", workerSession);
    emit("tool.call_started", "p1");
    const parentDir = sessionDirFor(path.join(home, "sessions"), "p1");
    const workerDir = path.join(parentDir, "workers", workerSession);
    expect(read(path.join(workerDir, "telemetry.ndjson"))).toEqual(["tool.call_failed"]);
    expect(read(path.join(parentDir, "telemetry.ndjson"))).toEqual(["tool.call_started"]);
  });

  it("stays inside the home: a session folder outside every enabled home falls back to the daily file", () => {
    const home = tmp();
    const elsewhere = tmp();
    new Agent({ model: "groq/x", apiKey: "k", baseUrl: "https://example.test/v1", home, sessionId: "out1", persist: { dir: elsewhere }, telemetry: { persist: true } });
    emit("tool.call_started", "out1");
    expect(fs.existsSync(path.join(sessionDirFor(elsewhere, "out1"), "telemetry.ndjson"))).toBe(false); // nothing is written outside the home
    expect(daily(home)).toEqual(["tool.call_started"]);
  });

  it("after disposeSession the session's events fall back to the daily file", () => {
    const home = tmp();
    const a = agent(home, "s1");
    emit("tool.call_started", "s1");
    a.disposeSession("s1");
    emit("tool.call_succeeded", "s1");
    const own = path.join(sessionDirFor(path.join(home, "sessions"), "s1"), "telemetry.ndjson");
    expect(read(own)).toEqual(["tool.call_started"]);
    expect(daily(home)).toEqual(["tool.call_succeeded"]);
  });

  it("importSession moves the routing to the new session id", () => {
    const home = tmp();
    const a = agent(home, "old1");
    a.importSession({ version: 1, sessionId: "new1", model: "groq/x", messages: [] });
    emit("tool.call_started", "old1");
    emit("tool.call_started", "new1");
    const sessions = path.join(home, "sessions");
    expect(read(path.join(sessionDirFor(sessions, "new1"), "telemetry.ndjson"))).toEqual(["tool.call_started"]);
    expect(fs.existsSync(path.join(sessionDirFor(sessions, "old1"), "telemetry.ndjson"))).toBe(false);
    expect(daily(home)).toEqual(["tool.call_started"]);
  });

  it("a stateless Agent (and a fork) registers nothing", () => {
    const home = tmp();
    agent(home, "st1", { stateless: true });
    emit("tool.call_started", "st1");
    expect(fs.existsSync(path.join(home, "sessions", "st1"))).toBe(false);
    expect(daily(home)).toEqual(["tool.call_started"]);
  });

  it("an Agent without telemetry.persist still gets its session events routed once any home enabled it", () => {
    const home = tmp();
    agent(home, "a1");
    new Agent({ model: "groq/x", apiKey: "k", baseUrl: "https://example.test/v1", home, sessionId: "b1", persist: {} });
    emit("tool.call_started", "b1");
    expect(read(path.join(sessionDirFor(path.join(home, "sessions"), "b1"), "telemetry.ndjson"))).toEqual(["tool.call_started"]);
  });

  it("two enabled homes: a session event is written once, a plain event once per home", () => {
    const h1 = tmp();
    const h2 = tmp();
    agent(h1, "s1");
    agent(h2, "s2");
    emit("tool.call_started", "s1");
    emit("provider_warning");
    expect(read(path.join(sessionDirFor(path.join(h1, "sessions"), "s1"), "telemetry.ndjson"))).toEqual(["tool.call_started"]);
    expect(read(path.join(sessionDirFor(path.join(h2, "sessions"), "s2"), "telemetry.ndjson"))).toEqual([]);
    expect(daily(h1)).toEqual(["provider_warning"]);
    expect(daily(h2)).toEqual(["provider_warning"]);
  });

  it("telemetryBus.clear() does not kill the sink: the next Agent that enables it brings it back", () => {
    const home = tmp();
    agent(home, "s1");
    telemetryBus.clear();
    agent(home, "s2");
    emit("tool.call_started", "s2");
    expect(read(path.join(sessionDirFor(path.join(home, "sessions"), "s2"), "telemetry.ndjson"))).toEqual(["tool.call_started"]);
  });

  it("a deleted home is not recreated by a stray event", () => {
    const home = tmp();
    agent(home, "s1");
    fs.rmSync(home, { recursive: true, force: true });
    emit("provider_warning");
    expect(fs.existsSync(home)).toBe(false);
  });

  it("a folder that holds only telemetry.ndjson is not a session: nothing resumes from it and it is not 'latest'", () => {
    const home = tmp();
    const sessions = path.join(home, "sessions");
    agent(home, "s1");
    emit("tool.call_started", "s1"); // creates sessions/s1/telemetry.ndjson, before any session.json exists
    expect(findLatestSessionDir(sessions)).toBeNull();
    const again = agent(home, "s1"); // same id after a "restart": nothing to recover, no error
    expect(again.interrupted()).toEqual([]);
    expect(again.context.messages).toEqual([]);
  });

  it("a real kill -9 keeps every line already written", async () => {
    const home = tmp();
    const src = new URL("../src/index.ts", import.meta.url).href;
    const script = path.join(tmp(), "child.ts");
    fs.writeFileSync(
      script,
      `import { Agent, telemetryBus } from ${JSON.stringify(src)};
new Agent({ model: "groq/x", apiKey: "k", baseUrl: "https://example.test/v1", home: ${JSON.stringify(home)}, sessionId: "k1", persist: {}, telemetry: { persist: true } });
telemetryBus.emit({ code: "tool.call_started", message: "m", data: { sessionId: "k1" } });
telemetryBus.emit({ code: "tool.progress", message: "m", data: { sessionId: "k1" } });
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`
    );
    const proc = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENT_CATALOG_REFRESH: "off" } });
    const reader = proc.stdout.getReader();
    let text = "";
    while (!text.includes("ready")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain("ready");
    proc.kill("SIGKILL");
    await proc.exited;
    expect(read(path.join(sessionDirFor(path.join(home, "sessions"), "k1"), "telemetry.ndjson"))).toEqual(["tool.call_started", "tool.progress"]);
  });
});
