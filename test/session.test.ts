import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  SessionTelemetry,
  buildSessionData,
  serializeSession,
  deserializeSession,
  loadSessionFile,
  saveSessionFile,
  computeSessionTurnCost,
  getSessionContextWindow,
  formatSessionBanner,
  emptyTotals,
  type PersistedAgentSession,
} from "../src/session/store.ts";
import { Agent } from "../src/agent/agent.ts";

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
    const dir = fs.mkdtempSync(path.join(process.cwd(), "src/data/.sess-test-"));
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
    expect(loadSessionFile(path.join(process.cwd(), "src/data/.does-not-exist-12345.json"))).toBeNull();
  });
});
