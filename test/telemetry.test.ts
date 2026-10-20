import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  telemetryBus,
  emitProviderWarning,
  clearEmittedWarnings,
  AssistantMessageEventStream,
  GoogleInteractionsProvider,
  clearInteractionChains,
  clearSessionRouting,
} from "../src/index.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_WARN = console.warn;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.warn = ORIGINAL_WARN;
  clearInteractionChains();
  clearSessionRouting();
});

function collect(): { events: Array<{ code: string; data?: any; level?: string }>; off: () => void } {
  const events: Array<{ code: string; data?: any; level?: string }> = [];
  const off = telemetryBus.onEvent((e) => events.push(e));
  return { events, off };
}

describe("telemetry bus is the single sink", () => {
  it("provider capability warnings reach the bus (and still the console for legacy tooling)", () => {
    const { events, off } = collect();
    const warned: string[] = [];
    console.warn = (m: unknown) => void warned.push(String(m));
    try {
      clearEmittedWarnings();
      emitProviderWarning({ provider: "google", capability: "cache retention", requested: "long", reason: "r", fallback: "f" });
      const ev = events.find((e) => e.code === "provider_warning");
      expect(ev?.level).toBe("warn");
      expect(ev?.data).toMatchObject({ provider: "google", capability: "cache retention", requested: "long" });
      expect(warned.length).toBe(1);
      // Deduped: a repeat does not re-emit.
      emitProviderWarning({ provider: "google", capability: "cache retention", requested: "long", reason: "r", fallback: "f" });
      expect(events.filter((e) => e.code === "provider_warning")).toHaveLength(1);
    } finally {
      off();
    }
  });

  it("Google chain expiry is reported on the bus", async () => {
    const { events, off } = collect();
    const ok = {
      id: "v1_t",
      object: "interaction",
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }],
      usage: { total_tokens: 3, total_input_tokens: 1, total_output_tokens: 2 },
    };
    (globalThis as any).fetch = async () => new Response(JSON.stringify(ok), { status: 200 });
    const provider = new GoogleInteractionsProvider();
    const realNow = Date.now;
    try {
      await provider.generate("gemini-3.5-flash-lite", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-bus" });
      (Date as any).now = () => realNow() + 24 * 3600 * 1000;
      await provider.generate(
        "gemini-3.5-flash-lite",
        { messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: "again" }] },
        { apiKey: "k", sessionId: "s-bus" }
      );
      expect(events.some((e) => e.code === "interaction_chain_ttl_expired")).toBe(true);
    } finally {
      (Date as any).now = realNow;
      off();
    }
  });

  it("stream buffer overflow is reported on the bus", () => {
    const { events, off } = collect();
    try {
      const s = new AssistantMessageEventStream({ maxBufferedEvents: 2 });
      for (let i = 0; i < 5; i++) s.push({ type: "text_delta", delta: String(i) });
      expect(s.getDroppedCount()).toBe(3);
      expect(events.filter((e) => e.code === "stream_buffer_overflow")).toHaveLength(3);
    } finally {
      off();
    }
  });

  it("a catalog cache that cannot be written is reported (subprocess: catalog state is module-global)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accel-tel-"));
    try {
      const blocker = path.join(dir, "not-a-dir"); // a FILE where the cache dir should be
      fs.writeFileSync(blocker, "x");
      const script = path.join(dir, "probe.ts");
      fs.writeFileSync(
        script,
        `import { refreshModelCatalog, telemetryBus } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/index.ts"))};
const seen = [];
telemetryBus.onEvent((e) => seen.push(e.code));
const mk = () => ({ models: { m: { id: "m", name: "m" } } });
globalThis.fetch = async () => new Response(JSON.stringify({ google: mk(), openai: mk(), openrouter: mk() }), { status: 200 });
const st = await refreshModelCatalog({ force: true });
console.log(JSON.stringify({ loaded: st.loaded, seen }));`
      );
      const env: Record<string, string> = { ...(process.env as Record<string, string>), AGENT_CACHE_DIR: blocker };
      delete env.AGENT_CATALOG_REFRESH;
      const proc = Bun.spawn([process.execPath, script], { env, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const res = JSON.parse(out.trim().split("\n").pop()!);
      expect(res.loaded).toBe(true); // in-memory catalog still served
      expect(res.seen).toContain("catalog_cache_write_failed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
