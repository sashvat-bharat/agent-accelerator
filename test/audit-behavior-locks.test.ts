import { describe, it, expect } from "bun:test";
import { AgentContext } from "../src/agent/context.ts";
import { toConciseProviderError } from "../src/utils/errors.ts";
import { clampCacheKey } from "../src/utils/cache.ts";
import { SSEParser } from "../src/streaming/sse-parser.ts";
import { createChildSessionId, createFixedChildSessionId } from "../src/agent/delegation.ts";
import { writeFileAtomic } from "../src/session/store.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Q-01: §3 behavior locks must not regress.
describe("audit §3 behavior locks", () => {
  it("cache invariant cached<=input", () => {
    expect(clampCacheKey("a".repeat(100))!.length).toBeLessThanOrEqual(64);
  });
  it("AgentContext drops fully-empty turns", () => {
    const c = new AgentContext("sys");
    c.addAssistantMessage("", [], undefined, undefined);
    expect(c.messages.length).toBe(0);
  });
  it("SSE parser splits across chunks (WHATWG)", () => {
    const p = new SSEParser();
    const a = p.feed("data: hel");
    const b = p.feed("lo\n\n");
    expect([...a, ...b].length).toBe(1);
  });
  it("child session ids stay <=64 chars", () => {
    const parent = "accel-" + "x".repeat(50);
    expect(createChildSessionId(parent, "tag").length).toBeLessThanOrEqual(64);
    expect(createFixedChildSessionId(parent, "tool").length).toBeLessThanOrEqual(64);
  });
  it("concise errors are one-line with non-enumerable details", () => {
    const e: any = new Error("boom");
    e.statusCode = 500; e.responseBody = "x".repeat(600); e.url = "https://x.test/?k=1";
    const c: any = toConciseProviderError(e, "openai", "gpt-4o");
    expect(c.message.split("\n").length).toBe(1);
    expect(Object.keys(c)).not.toContain("responseBody");
  });
  it("atomic writes never leave half-written JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
    const f = path.join(dir, "s.json");
    writeFileAtomic(f, JSON.stringify({ ok: 1 }));
    expect(JSON.parse(fs.readFileSync(f, "utf8")).ok).toBe(1);
  });
});
