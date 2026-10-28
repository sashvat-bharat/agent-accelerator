import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SessionTelemetry,
  buildSessionData,
  serializeSession,
  deserializeSession,
  loadSessionFile,
  saveSessionFile,
  saveSessionDir,
  loadSessionDir,
  inspectSessionPayload,
  findLatestSessionDir,
  computeSessionTurnCost,
  getSessionContextWindow,
  formatSessionBanner,
  emptyTotals,
  type PersistedAgentSession,
} from "../src/session/store.ts";
import { Agent } from "../src/agent/agent.ts";
import { SessionLoadError } from "../src/types/errors.ts";

describe("session telemetry", () => {
  it("accumulates totals and prefers provider cost", () => {
    const t = new SessionTelemetry();
    const turnCost = t.add(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: { totalCost: 0.02 } },
      "google/gemini-3.5-flash-lite"
    );
    expect(turnCost).toBe(0.02);
    expect(t.totals.input).toBe(100);
    expect(t.totals.output).toBe(50);
    expect(t.totals.cost).toBeCloseTo(0.02, 8);
  });

  it("round-trips totals via fromSaved", () => {
    const t = SessionTelemetry.fromSaved({ totals: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, cost: 6 } });
    expect(t.totals).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, cost: 6 });
    expect(SessionTelemetry.fromSaved(null).totals).toEqual(emptyTotals());
  });

  it("computes catalog cost when provider omits it", () => {
    const cost = computeSessionTurnCost(
      { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
      "google/gemini-3.5-flash-lite"
    );
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("returns a sane context window fallback", () => {
    expect(getSessionContextWindow("google/gemini-3.5-flash-lite")).toBeGreaterThan(0);
    expect(getSessionContextWindow("definitely/not-a-model-xyz")).toBe(1_048_576);
  });

  it("tracks turn vs total cache-hit rates like 03-multi_agent", () => {
    const t = new SessionTelemetry();
    t.add({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedTokens: 80 }, "m");
    expect(t.turnHitRate({ inputTokens: 100, totalTokens: 100, cachedTokens: 80 } as any).toFixed(1)).toBe("80.0");
    expect(t.totalHitRate().toFixed(1)).toBe("80.0");
    t.add({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedTokens: 20 }, "m");
    expect(t.totalHitRate().toFixed(1)).toBe("50.0");
    expect(t.turnHitRate({ inputTokens: 0, totalTokens: 0 } as any)).toBe(0);
  });

  it("formats resume vs fresh banners", () => {
    const saved: PersistedAgentSession = {
      version: 1,
      sessionId: "accel-abcdef123456",
      model: "google/gemini-3.5-flash-lite",
      thinkingLevel: "medium",
      messages: [{ role: "user", content: "hi" } as any],
      totals: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, reasoning: 0, cost: 0.01 },
    };
    const banner = formatSessionBanner(saved, SessionTelemetry.fromSaved(saved), ".session.json");
    expect(banner).toContain("Previous session loaded");
    expect(banner).toContain("total-CH50.0%");
    expect(formatSessionBanner(null, new SessionTelemetry(), ".session.json")).toContain("New session");
  });
});

describe("session serialize/deserialize", () => {
  const sample: PersistedAgentSession = {
    version: 1,
    sessionId: "accel-test",
    model: "google/gemini-3.5-flash-lite",
    thinkingLevel: "medium",
    messages: [{ role: "user", content: "hi" }],
    totals: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.001 },
  };

  it("round-trips new single-JSON snapshots", () => {
    const back = deserializeSession(serializeSession(sample));
    expect(back?.sessionId).toBe("accel-test");
    expect(back?.messages).toHaveLength(1);
    expect(back?.totals?.input).toBe(10);
  });

  it("reads legacy JSONL session files", () => {
    const jsonl = [
      JSON.stringify({ type: "session", id: "accel-legacy", cache: { retention: "implicit" } }),
      JSON.stringify({ type: "mainModel", id: "google/gemini-3.5-flash-lite", thinkingLevel: "low" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "metrics", metrics: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 } }),
    ].join("\n");
    const back = deserializeSession(jsonl);
    expect(back?.sessionId).toBe("accel-legacy");
    expect(back?.model).toBe("google/gemini-3.5-flash-lite");
    expect(back?.thinkingLevel).toBe("low");
    expect(back?.messages).toHaveLength(1);
    expect(back?.totals?.input).toBe(7);
  });

  it("returns null on empty/corrupt input", () => {
    expect(deserializeSession("")).toBeNull();
    expect(deserializeSession("not json")).toBeNull();
  });

  it("writes one line per field with totals before messages and no duplicated instructions", () => {
    const a = new Agent({ model: "google/gemini-3.5-flash-lite", instructions: "Be brief." });
    a.context.messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ] as any;
    const t = new SessionTelemetry({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 });
    const text = serializeSession(buildSessionData(a as any, t));
    // Still valid JSON with both turns intact.
    expect(deserializeSession(text)?.messages).toHaveLength(2);
    // No duplicated base instructions (systemPrompt already embeds them).
    expect(text).not.toContain('"instructions"');
    // Totals sit right before the messages block.
    const totalsAt = text.indexOf('"totals"');
    const messagesAt = text.indexOf('"messages"');
    expect(totalsAt).toBeGreaterThan(-1);
    expect(messagesAt).toBeGreaterThan(totalsAt);
    // Each conversation turn gets exactly one line holding complete JSON.
    const lines = text.split("\n");
    const openIdx = lines.findIndex((l) => l.includes('"messages"'));
    expect(lines[openIdx]).toContain("[");
    const turnLines: string[] = [];
    for (let i = openIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (trimmed.startsWith("]")) break;
      turnLines.push(trimmed.replace(/,$/, ""));
    }
    expect(turnLines).toHaveLength(2);
    expect(turnLines.every((l) => {
      const parsed = JSON.parse(l) as { role?: string };
      return typeof parsed.role === "string";
    })).toBe(true);
  });

  it("preserves full thinking text and thought signatures through snapshots", () => {
    const a = new Agent({ model: "google/gemini-3.5-flash-lite", instructions: "Be brief." });
    const thinkingText = "First I will check the metrics, then summarize in two sentences. ".repeat(200);
    a.context.addAssistantMessage("Summary done.", undefined, thinkingText, "c2lnbmF0dXJlLWFiYw==");
    const back = deserializeSession(serializeSession(buildSessionData(a as any, null)));
    const parts = (back?.messages ?? []).flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
    const thinkingPart = parts.find((p: any) => p?.type === "thinking");
    const textPart = parts.find((p: any) => p?.type === "text");
    // Full text, no truncation cap.
    expect(thinkingPart?.thinking).toBe(thinkingText);
    // Signature rides on the text part (and message) when text is present.
    expect(textPart?.thoughtSignature).toBe("c2lnbmF0dXJlLWFiYw==");
  });

  it("keeps worker reasoning on deduped steps (drops only repeated text)", () => {    const fake = {
      sessionId: "accel-test",
      modelStringOrSpec: "google/gemini-3.5-flash-lite",
      context: { messages: [] },
      subagentTraces: {
        abc123: {
          trackingId: "abc123",
          name: "W",
          sessionId: "s",
          parentSessionId: "p",
          status: "done",
          task: "t",
          turns: 1,
          steps: [
            { turn: 1, type: "assistant", text: "FINAL", thinking: "why final", thoughtSignature: "c2ln", isError: false, timestamp: 1 },
          ],
          text: "FINAL",
        },
      },
    };
    const data = buildSessionData(fake as any, null);
    const step = (data.subagents as any)["abc123"].steps[0];
    expect(step.text).toBeUndefined();
    expect(step.thinking).toBe("why final");
    expect(step.thoughtSignature).toBe("c2ln");
    expect(step.turn).toBe(1);
  });

  it("drops tool-call rawArguments that re-parse to the stored arguments", () => {
    const a = new Agent({ model: "google/gemini-3.5-flash-lite" });
    a.context.messages = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "w", arguments: { a: 1 }, rawArguments: '{"a":1}' }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c2", name: "w", arguments: { a: 1 }, rawArguments: "{}{\"a\":1}" }],
      },
    ] as any;
    const data = buildSessionData(a as any, null);
    const calls = (data.messages as any[]).flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
    expect(calls[0].rawArguments).toBeUndefined();
    // Unparseable wire strings are kept: they carry info parsing lost.
    expect(calls[1].rawArguments).toBe('{}{"a":1}');
  });

  it("drops cache.sessionId echoing the top-level sessionId", () => {
    const a = new Agent({ model: "google/gemini-3.5-flash-lite", cache: { retention: "implicit" } });
    const data = buildSessionData(a as any, null);
    expect(data.sessionId).toBe(a.sessionId);
    expect(data.cache).toEqual({ retention: "implicit" });
  });
});

describe("agent export/import + file round-trip", () => {
  it("exports and re-imports conversation without direct mutation", () => {
    const a = new Agent({ model: "google/gemini-3.5-flash-lite", instructions: "Be brief." });
    a.context.messages = [{ role: "user", content: "ping" } as any];
    const snap = a.exportSession(new SessionTelemetry({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 }));
    expect(snap.model).toContain("gemini");
    expect(snap.messages).toHaveLength(1);

    const b = new Agent({ model: "google/gemini-3.5-flash-lite" });
    b.importSession(snap);
    expect(b.context.messages).toHaveLength(1);
    expect(b.sessionId).toBe(a.sessionId);
    b.importSession(null); // no-op, must not throw
  });

  it("saves and loads a file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accel-sess-test-"));
    const file = path.join(dir, "chat.json");
    try {
      const a = new Agent({ model: "google/gemini-3.5-flash-lite" });
      a.context.messages = [{ role: "user", content: "hello" } as any];
      const t = new SessionTelemetry();
      t.add({ inputTokens: 12, outputTokens: 4, totalTokens: 16 }, "google/gemini-3.5-flash-lite");
      saveSessionFile(file, a, t);
      expect(fs.existsSync(file)).toBe(true);
      const rawFile = fs.readFileSync(file, "utf8");
      expect(rawFile).toContain('\n  "sessionId"');
      const loaded = loadSessionFile(file);
      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.totals?.input).toBe(12);
      expect(buildSessionData(a as any, t).totals?.input).toBe(12);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadSessionFile returns null when missing", () => {
    expect(loadSessionFile(path.join(os.tmpdir(), "accel-does-not-exist-12345.json"))).toBeNull();
  });
});

describe("session directories with media/", () => {
  it("extracts binary + data-URL media to files and reloads as paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "accel-sessdir-test-"));
    try {
      const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
      const a = new Agent({ model: "google/gemini-3.5-flash-lite" });
      a.context.messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", image: pngBytes, mimeType: "image/png" },
            { type: "image", image: "https://example.com/remote.png" },
            { type: "file", file: "data:application/pdf;base64,AQID", mimeType: "application/pdf", filename: "doc.pdf" },
          ],
        } as any,
      ];
      const dir = saveSessionDir(root, a, new SessionTelemetry());
      expect(fs.existsSync(path.join(dir, "session.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "media", "image-001.png"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "media", "file-001.pdf"))).toBe(true);

      const stored = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
      const mediaVals = stored.messages[0].content.filter((p: any) => p.type !== "text").map((p: any) => p.image ?? p.file);
      expect(mediaVals[0]).toBe("media/image-001.png");
      expect(mediaVals[1]).toBe("https://example.com/remote.png"); // remote refs untouched
      expect(mediaVals[2]).toBe("media/file-001.pdf");

      const loaded = loadSessionDir(dir);
      expect(loaded?.session.messages).toHaveLength(1);
      const reloaded = (loaded!.session.messages[0] as any).content[1];
      expect(reloaded.image).toBe(path.join(dir, "media/image-001.png"));
      expect(fs.existsSync(reloaded.image)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds the latest session and loads legacy single files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "accel-sessdir-latest-"));
    try {
      const a = new Agent({ model: "google/gemini-3.5-flash-lite" });
      const dir = saveSessionDir(root, a, null);
      expect(findLatestSessionDir(root)).toBe(dir);
      expect(findLatestSessionDir(path.join(root, "missing"))).toBeNull();
      // legacy single-file path still loads through the dir loader
      const file = path.join(root, "legacy.json");
      saveSessionFile(file, a, null);
      expect(loadSessionDir(file)?.session.sessionId).toBe(a.sessionId);
      expect(loadSessionDir(path.join(root, "empty"))).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("session persistence: over-limit vs corrupt", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "accel-sess-"));

  it("classifies payloads: ok / empty / corrupt / over_limit", () => {
    const a = new Agent({ model: "google/gemini-3.5-flash-lite" });
    const raw = serializeSession(buildSessionData(a as any, null));
    expect(inspectSessionPayload(raw).status).toBe("ok");
    expect(inspectSessionPayload("   ").status).toBe("empty");
    expect(inspectSessionPayload("{not json").status).toBe("corrupt");
    expect(inspectSessionPayload(raw, { maxBytes: 10 }).status).toBe("over_limit");
    a.context.messages.push({ role: "user", content: "a" }, { role: "user", content: "b" });
    const big = serializeSession(buildSessionData(a as any, null));
    expect(inspectSessionPayload(big, { maxMessages: 1 }).status).toBe("over_limit");
  });

  it("never quarantines a healthy snapshot, however many times it is re-saved", () => {
    const root = tmp();
    try {
      const a = new Agent({ model: "google/gemini-3.5-flash-lite" });
      for (let i = 0; i < 6; i++) a.context.messages.push({ role: "user", content: `m${i}` });
      const file = path.join(root, "s.session.json");
      // Simulates a session already beyond a (tiny) load limit: it must stay one file.
      saveSessionFile(file, a, null);
      const original = fs.readFileSync(file, "utf8");
      expect(inspectSessionPayload(original, { maxMessages: 2 }).status).toBe("over_limit");
      for (let i = 0; i < 5; i++) saveSessionFile(file, a, null);
      const leftovers = fs.readdirSync(root).filter((f) => f.includes(".corrupt-"));
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("still quarantines genuinely corrupt files", () => {
    const root = tmp();
    try {
      const a = new Agent({ model: "google/gemini-3.5-flash-lite" });
      const file = path.join(root, "s.session.json");
      fs.writeFileSync(file, "{truncated");
      saveSessionFile(file, a, null);
      expect(fs.readdirSync(root).some((f) => f.includes(".corrupt-"))).toBe(true);
      expect(loadSessionFile(file)?.sessionId).toBe(a.sessionId);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("loading a valid over-limit file throws SessionLoadError and leaves it untouched", () => {
    const root = tmp();
    try {
      const a = new Agent({ model: "google/gemini-3.5-flash-lite" });
      for (let i = 0; i < 4; i++) a.context.messages.push({ role: "user", content: `m${i}` });
      const dir = saveSessionDir(root, a, null);
      const file = path.join(dir, "session.json");
      const before = fs.readFileSync(file, "utf8");
      expect(() => loadSessionDir(dir, { maxMessages: 2 })).toThrow(SessionLoadError);
      expect(() => loadSessionFile(file, { maxMessages: 2 })).toThrow(SessionLoadError);
      expect(fs.readFileSync(file, "utf8")).toBe(before);
      expect(loadSessionDir(dir)?.session.messages).toHaveLength(4);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("binary media survives rollback and file persistence", () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  it("checkpoint/rollback keeps Uint8Array media intact", async () => {
    const { AgentContext } = await import("../src/agent/context.ts");
    const ctx = new AgentContext("sys");
    ctx.addUserMessage([{ type: "text", text: "see" }, { type: "image", image: png, mimeType: "image/png" }]);
    const cp = ctx.checkpoint();
    ctx.addAssistantMessage("partial work");
    ctx.rollback(cp);
    expect(ctx.messages).toHaveLength(1);
    const part: any = (ctx.messages[0]!.content as any[])[1];
    expect(part.image).toBeInstanceOf(Uint8Array);
    expect([...part.image]).toEqual([...png]);
    // The snapshot is detached: mutating live bytes later cannot corrupt it.
    png[0] = 137;
  });

  it("persist:{file} snapshots inline bytes as data URLs that reload and normalize", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "accel-bin-"));
    try {
      const a = new Agent({ model: "google/gemini-3.5-flash-lite" });
      a.context.addUserMessage([{ type: "image", image: png, mimeType: "image/png" }]);
      const file = path.join(root, "s.session.json");
      saveSessionFile(file, a, null);
      const back = loadSessionFile(file)!;
      const stored: any = (back.messages[0]!.content as any[])[0];
      expect(typeof stored.image).toBe("string");
      expect(stored.image.startsWith("data:image/png;base64,")).toBe(true);
      const { normalizeMediaInput } = await import("../src/utils/media.ts");
      const norm = await normalizeMediaInput(stored.image);
      expect(norm.mimeType).toBe("image/png");
      expect(norm.base64Data).toBe(Buffer.from(png).toString("base64"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("untrusted session files", () => {
  it("rejects structurally invalid messages at load and at import", async () => {
    const bad = JSON.stringify({ version: 1, sessionId: "s1", model: "m", messages: [{ role: "user", content: "ok" }, { role: "hacker", content: 5 }] });
    expect(deserializeSession(bad)).toBeNull();
    expect(inspectSessionPayload(bad).status).toBe("corrupt");
    const agent = new Agent({ model: "google/gemini-3.5-flash-lite" });
    expect(() =>
      agent.importSession({ version: 1, sessionId: "s1", model: "m", messages: [{ role: "user" } as any] })
    ).toThrow(SessionLoadError);
    expect(agent.context.messages).toHaveLength(0);
  });

  it("warns on the telemetry bus when an import references local files without a roots policy", async () => {
    const { telemetryBus } = await import("../src/session/store.ts");
    const seen: string[] = [];
    const off = telemetryBus.onEvent((e) => seen.push(e.code));
    try {
      const msgs = [{ role: "user", content: [{ type: "image", image: "/home/me/.aws/credentials" }] }] as any;
      new Agent({ model: "google/gemini-3.5-flash-lite" }).importSession({ version: 1, sessionId: "s2", model: "m", messages: msgs });
      expect(seen).toContain("session.local_media_paths");
      seen.length = 0;
      new Agent({ model: "google/gemini-3.5-flash-lite", fileAccess: { roots: [os.tmpdir()] } }).importSession({
        version: 1, sessionId: "s3", model: "m", messages: msgs,
      });
      expect(seen).not.toContain("session.local_media_paths");
    } finally {
      off();
    }
  });
});
