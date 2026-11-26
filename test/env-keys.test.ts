import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Agent } from "../src/index.ts";
import { getApiKey } from "../src/utils/env.ts";

// Which variables hold a provider's key, and that a per-call `env` reads the same names, in the same order, as process.env.
const NAMES = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_API_KEY",
  "GOOGLEPROXY_API_KEY",
  "GOOGLEPROXY_BASE_API_KEY",
  "ACME_API_KEY",
  "ACME_BASE_API_KEY",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

// The key found for `provider` with `vars` given as a per-call env, and with the same `vars` in process.env.
const both = (provider: string, vars: Record<string, string>): [string | undefined, string | undefined] => {
  const fromCall = getApiKey(provider, undefined, vars);
  Object.assign(process.env, vars);
  const fromProcess = getApiKey(provider);
  for (const name of Object.keys(vars)) delete process.env[name];
  return [fromCall, fromProcess];
};

describe("API keys from a per-call env and from process.env", () => {
  it("never gives the Google key to a custom provider whose name starts with google", async () => {
    const gemini = { GEMINI_API_KEY: "gemini-secret", GOOGLE_API_KEY: "google-secret", GOOGLE_GENAI_API_KEY: "genai-secret" };
    expect(both("googleproxy", gemini)).toEqual([undefined, undefined]);
    expect(both("googleproxy", { ...gemini, GOOGLEPROXY_API_KEY: "own" })).toEqual(["own", "own"]);
    // End to end: the request is refused before the network, and the Gemini key is never sent.
    const sent: string[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.stringify(init.headers ?? {}));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const agent = new Agent({ model: "googleproxy/m", baseUrl: "https://proxy.test/v1", env: gemini, fetch, runRetries: 0 });
    const error = await agent.run("hi").catch((e: Error) => e);
    expect(String(error)).toContain('Missing API key for "googleproxy"');
    expect(sent).toEqual([]);
  });

  it("reads the three Google names in the documented order on both paths", () => {
    expect(both("google", { GOOGLE_API_KEY: "b", GEMINI_API_KEY: "a" })).toEqual(["a", "a"]);
    expect(both("google", { GOOGLE_GENAI_API_KEY: "c", GOOGLE_API_KEY: "b" })).toEqual(["b", "b"]);
    expect(both("google", { GOOGLE_GENAI_API_KEY: "c" })).toEqual(["c", "c"]);
    expect(both("gemini", { GOOGLE_API_KEY: "b" })).toEqual(["b", "b"]);
  });

  it("reads OPENAI_BASE_API_KEY before OPENAI_API_KEY on both paths", () => {
    expect(both("openai", { OPENAI_API_KEY: "a", OPENAI_BASE_API_KEY: "b" })).toEqual(["b", "b"]);
    expect(both("openai", { OPENAI_API_KEY: "a" })).toEqual(["a", "a"]);
  });

  it("reads a custom service's <PREFIX>_BASE_API_KEY from process.env too, after <PREFIX>_API_KEY", () => {
    expect(both("acme", { ACME_BASE_API_KEY: "base" })).toEqual(["base", "base"]);
    expect(both("acme", { ACME_BASE_API_KEY: "base", ACME_API_KEY: "api" })).toEqual(["api", "api"]);
    // A per-call env wins over process.env, and an explicit key over both.
    process.env.ACME_API_KEY = "process";
    expect(getApiKey("acme", undefined, { ACME_BASE_API_KEY: "call" })).toBe("call");
    expect(getApiKey("acme", " 'explicit' ", { ACME_API_KEY: "call" })).toBe("explicit");
  });
});
