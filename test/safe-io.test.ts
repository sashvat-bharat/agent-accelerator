import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertPathAllowed,
  enforceFileAccess,
  fetchRemoteBytes,
  isPrivateAddress,
  isLocalPathInput,
  RemoteFetchError,
} from "../src/utils/safe-io.ts";
import { Agent } from "../src/index.ts";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("private address detection", () => {
  it("flags loopback, LAN, link-local, CGNAT and unique-local ranges", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "[::1]"]) {
      expect(isPrivateAddress(a)).toBe(true);
    }
    for (const a of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(a)).toBe(false);
    }
  });
});

describe("local path containment", () => {
  it("allows files inside roots, rejects siblings, traversal, symlink escapes and URL schemes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "accel-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "accel-outside-"));
    fs.writeFileSync(path.join(root, "ok.txt"), "x");
    fs.writeFileSync(path.join(outside, "no.txt"), "x");
    fs.symlinkSync(outside, path.join(root, "link"));
    await assertPathAllowed(path.join(root, "ok.txt"), [root]);
    await expect(assertPathAllowed(path.join(outside, "no.txt"), [root])).rejects.toThrow(/outside the allowed/);
    await expect(assertPathAllowed(path.join(root, "..", path.basename(outside), "no.txt"), [root])).rejects.toThrow();
    await expect(assertPathAllowed(path.join(root, "link", "no.txt"), [root])).rejects.toThrow(/outside the allowed/);
    await expect(assertPathAllowed("file:///etc/passwd", [root])).rejects.toThrow(/URL scheme/);
    await expect(assertPathAllowed(path.join(root, "ok.txt"), [])).rejects.toThrow(/no local paths/);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("classifies media strings like normalizeMediaInput", () => {
    expect(isLocalPathInput("/etc/passwd")).toBe(true);
    expect(isLocalPathInput("./a.png")).toBe(true);
    expect(isLocalPathInput("https://x/y.png")).toBe(false);
    expect(isLocalPathInput("data:image/png;base64,AAAA")).toBe(false);
    expect(isLocalPathInput("QUJD".repeat(40))).toBe(false);
  });

  it("enforceFileAccess scans media parts only", async () => {
    const msgs: any[] = [
      { role: "user", content: [{ type: "text", text: "/etc/passwd" }, { type: "image", image: "https://x/y.png" }] },
    ];
    await enforceFileAccess(msgs, []);
    msgs.push({ role: "user", content: [{ type: "image", image: "/etc/passwd" }] });
    await expect(enforceFileAccess(msgs, [os.tmpdir()])).rejects.toThrow(/outside the allowed/);
  });

  it("Agent with fileAccess.roots rejects out-of-root media before any network call", async () => {
    let called = false;
    (globalThis as any).fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    const agent = new Agent({
      model: "google/gemini-3.5-flash-lite",
      apiKey: "k",
      fileAccess: { roots: [os.tmpdir()] },
    });
    await expect(
      agent.run([{ type: "text", text: "describe" }, { type: "image", image: "/etc/hostname" }] as any)
    ).rejects.toThrow(/outside the allowed fileAccess roots/);
    expect(called).toBe(false);
  });
});

describe("fetchRemoteBytes", () => {
  it("blocks private hosts when allowPrivateNetwork is false", async () => {
    (globalThis as any).fetch = async () => {
      throw new Error("network must not be reached");
    };
    await expect(fetchRemoteBytes("http://169.254.169.254/x", { allowPrivateNetwork: false })).rejects.toBeInstanceOf(RemoteFetchError);
    await expect(fetchRemoteBytes("http://localhost:8080/x", { allowPrivateNetwork: false })).rejects.toThrow(/private\/internal host/);
    await expect(fetchRemoteBytes("ftp://example.com/x")).rejects.toThrow(/Only http/);
  });

  it("re-validates every redirect hop", async () => {
    const seen: string[] = [];
    (globalThis as any).fetch = async (url: string) => {
      seen.push(url);
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    };
    await expect(fetchRemoteBytes("https://8.8.8.8/start", { allowPrivateNetwork: false })).rejects.toThrow(/private\/internal host/);
    expect(seen).toEqual(["https://8.8.8.8/start"]);
  });

  it("enforces the byte cap while streaming (declared and undeclared sizes)", async () => {
    (globalThis as any).fetch = async () => new Response(new Uint8Array(2000), { status: 200 });
    await expect(fetchRemoteBytes("https://8.8.8.8/big", { maxBytes: 1000 })).rejects.toMatchObject({ reason: "too_large" });
    (globalThis as any).fetch = async () =>
      new Response(new Uint8Array(10), { status: 200, headers: { "content-length": "999999999" } });
    await expect(fetchRemoteBytes("https://8.8.8.8/big", { maxBytes: 1000 })).rejects.toMatchObject({ reason: "too_large" });
  });

  it("returns bytes and content type for a normal response", async () => {
    (globalThis as any).fetch = async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
    const res = await fetchRemoteBytes("https://8.8.8.8/ok.png");
    expect(res.ok).toBe(true);
    expect(res.contentType).toBe("image/png");
    expect([...res.bytes]).toEqual([1, 2, 3]);
  });
});
