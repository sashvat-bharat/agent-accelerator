import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCacheDir } from "../src/index.ts";

const SRC_INDEX = path.resolve(import.meta.dir, "../src/index.ts");

const catalog = () => ({
  google: { models: { "gemini-3.5-flash-lite": { id: "gemini-3.5-flash-lite", name: "G" } } },
  openai: { models: { "gpt-4o": { id: "gpt-4o", name: "O" } } },
  openrouter: { models: { "x/y": { id: "x/y", name: "R" } } },
});

/** Runs `body` in a fresh Bun process (catalog state is module-global) and returns its JSON line. */
async function inSubprocess(cacheDir: string, body: string): Promise<any> {
  const script = path.join(cacheDir, "probe.ts");
  fs.writeFileSync(
    script,
    `import { ensureModelCatalogFresh, getCatalogStatus } from ${JSON.stringify(SRC_INDEX)};\n${body}`
  );
  const env: Record<string, string> = { ...(process.env as Record<string, string>), AGENT_CACHE_DIR: cacheDir };
  delete env.AGENT_CATALOG_REFRESH;
  const proc = Bun.spawn([process.execPath, script], { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`probe failed: ${await new Response(proc.stderr).text()}`);
  return JSON.parse(out.trim().split("\n").pop()!);
}

describe("catalog cache location", () => {
  it("lives in <home>/catalog and follows setHome", async () => {
    const { setHome } = await import("../src/index.ts");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "accel-home-"));
    try {
      expect(getCacheDir()).toBe(path.resolve(".agent-accel", "catalog"));
      setHome(home);
      expect(getCacheDir()).toBe(path.join(path.resolve(home), "catalog"));
    } finally {
      setHome();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("ensureModelCatalogFresh: stale-while-revalidate + failure backoff", () => {
  it("an expired but loaded catalog never delays the caller, and a failed refresh is not retried for 10 minutes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accel-cat-"));
    try {
      fs.writeFileSync(
        path.join(dir, "models.dev.json"),
        JSON.stringify({ fetchedAt: Date.now() - 3_600_000, ttlMs: 1000, source: "test", version: "1.0", data: catalog() })
      );
      const res = await inSubprocess(
        dir,
        `
let calls = 0;
globalThis.fetch = async () => { calls++; await new Promise((r) => setTimeout(r, 300)); throw new Error("offline"); };
const before = getCatalogStatus();
const t0 = Date.now();
const s1 = await ensureModelCatalogFresh();
const waited = Date.now() - t0;
await new Promise((r) => setTimeout(r, 450));
const afterFirst = calls;
await ensureModelCatalogFresh();
await ensureModelCatalogFresh();
await new Promise((r) => setTimeout(r, 50));
console.log(JSON.stringify({ loaded: before.loaded, expired: before.isExpired, s1loaded: s1.loaded, waited, afterFirst, final: calls }));
`
      );
      expect(res.loaded).toBe(true);
      expect(res.expired).toBe(true);
      expect(res.s1loaded).toBe(true);
      expect(res.waited).toBeLessThan(150); // served stale immediately; fetch takes 300ms
      expect(res.afterFirst).toBe(1);
      expect(res.final).toBe(1); // backoff: no hammering after the failure
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a cold start (nothing loaded) waits for the download", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accel-cat-"));
    try {
      const res = await inSubprocess(
        dir,
        `
const payload = ${JSON.stringify(catalog())};
let calls = 0;
globalThis.fetch = async () => { calls++; await new Promise((r) => setTimeout(r, 120)); return new Response(JSON.stringify(payload), { status: 200 }); };
const before = getCatalogStatus();
const t0 = Date.now();
const s = await ensureModelCatalogFresh();
console.log(JSON.stringify({ before: before.loaded, after: s.loaded, waited: Date.now() - t0, calls, models: s.modelCount }));
`
      );
      expect(res.before).toBe(false);
      expect(res.after).toBe(true);
      expect(res.waited).toBeGreaterThanOrEqual(100);
      expect(res.calls).toBe(1);
      expect(res.models).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AGENT_CATALOG_REFRESH=off never touches the network automatically", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accel-cat-"));
    try {
      fs.writeFileSync(
        path.join(dir, "models.dev.json"),
        JSON.stringify({ fetchedAt: 1, ttlMs: 1000, source: "test", version: "1.0", data: catalog() })
      );
      const res = await inSubprocess(
        dir,
        `
process.env.AGENT_CATALOG_REFRESH = "off";
let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error("must not be called"); };
const s = await ensureModelCatalogFresh();
await new Promise((r) => setTimeout(r, 50));
console.log(JSON.stringify({ loaded: s.loaded, expired: s.isExpired, calls }));
`
      );
      expect(res).toEqual({ loaded: true, expired: true, calls: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
