import { afterEach, describe, expect, test } from "bun:test";
import { Agent, setConfigs, setModels } from "../src/index.ts";
import { SETTING_KEYS } from "../src/config/settings.ts";
import { resetModels } from "../src/config/models.ts";
import { resolveHome } from "../src/utils/home.ts";
import { getCacheDir } from "../src/models/catalog.ts";
import { GoogleInteractionsProvider } from "../src/providers/google.ts";
import { OpenAIResponsesProvider } from "../src/providers/openai.ts";
import { OpenRouterChatCompletionsProvider } from "../src/providers/openrouter.ts";
import { OpenAICompatibleChatProvider } from "../src/providers/openai-compat.ts";
import * as path from "node:path";

const settings = (values: Record<string, unknown> = {}) =>
  setConfigs({ values: { catalog_refresh: "off", ...values }, editable: [...SETTING_KEYS] });

const RETIRED: Record<string, string> = {
  MODEL: "groq/env-model",
  MODEL_NAME: "groq/env-model",
  SUB_AGENT_MODEL: "groq/env-sub",
  GOOGLE_BASE_URL: "http://env.test/google",
  OPENAI_BASE_URL: "http://env.test/openai",
  OPENAI_API_BASE: "http://env.test/openai",
  OPENROUTER_BASE_URL: "http://env.test/or",
  GROQ_BASE_URL: "http://env.test/groq",
  OPENROUTER_SORT: "price",
  OPENROUTER_USER: "env-user",
  COMPAT_NO_STREAM_OPTIONS: "1",
  COMPAT_NO_SESSION_HEADERS: "1",
  AGENT_ACCEL_USAGE_LIMIT_USD: "1",
  AGENT_ACCEL_SCHEDULED_BUDGET_USD: "1",
  AGENT_ACCEL_HOME: "/tmp/env-home-should-be-ignored",
  AGENT_CACHE_DIR: "/tmp/env-cache-should-be-ignored",
  AGENT_CATALOG_REFRESH: "off",
  MODELS_DEV_SHA256: "0".repeat(64),
};
const saved: Record<string, string | undefined> = {};
const useRetiredEnv = () => {
  for (const [k, v] of Object.entries(RETIRED)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
};
afterEach(() => {
  for (const k of Object.keys(RETIRED)) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  resetModels();
  (globalThis as any).fetch = ORIGINAL_FETCH;
});
const ORIGINAL_FETCH = globalThis.fetch;

// Sends one request through a provider with a captured fetch; returns the URL, headers and body it used.
async function capture(run: (fetchFn: typeof fetch) => Promise<unknown>): Promise<{ url: string; headers: Record<string, string>; body: any }> {
  const seen = { url: "", headers: {} as Record<string, string>, body: undefined as any };
  const fetchFn = (async (url: string, init: any) => {
    seen.url = url;
    seen.headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    seen.body = init.body ? JSON.parse(init.body) : undefined;
    return new Response(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  await run(fetchFn).catch(() => {}); // the reply shape does not matter, only the request
  return seen;
}
const ctx = { messages: [{ role: "user" as const, content: "hi" }] };

describe("retired env vars are not read any more", () => {
  test("no model from MODEL / SUB_AGENT_MODEL: an Agent without a model has none", async () => {
    useRetiredEnv();
    settings();
    await expect(new Agent({ apiKey: "k" }).run("hi")).rejects.toThrow(/No model specified/);
  });

  test("the home is not read from AGENT_ACCEL_HOME, the cache folder not from AGENT_CACHE_DIR", () => {
    useRetiredEnv();
    settings();
    expect(resolveHome()).toBe(path.resolve(".agent-accel"));
    expect(getCacheDir()).toBe(path.resolve(".agent-accel", "catalog"));
  });

  test("a custom prefix gets no base URL from {PREFIX}_BASE_URL", async () => {
    useRetiredEnv();
    settings();
    process.env.GROQ_API_KEY = "k";
    const p = new OpenAICompatibleChatProvider("groq");
    await expect(p.generate("groq/m", ctx, {})).rejects.toThrow(/Missing base URL for "groq"/);
    delete process.env.GROQ_API_KEY;
  });

  test("the first-class providers ignore *_BASE_URL and OPENROUTER_* vars", async () => {
    useRetiredEnv();
    settings();
    const g = await capture((f) => new GoogleInteractionsProvider().generate("gemini-3.5-flash", ctx, { apiKey: "k", fetch: f }));
    expect(g.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    const o = await capture((f) => new OpenAIResponsesProvider().generate("gpt-5.4-nano", ctx, { apiKey: "k", fetch: f }));
    expect(o.url).toBe("https://api.openai.com/v1/responses");
    const r = await capture((f) => new OpenRouterChatCompletionsProvider().generate("x/y", ctx, { apiKey: "k", fetch: f }));
    expect(r.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(r.body.provider).toBeUndefined();
    expect(r.body.user).toBeUndefined();
  });

  test("the spending caps are not read from AGENT_ACCEL_* vars", () => {
    useRetiredEnv();
    settings();
    expect(new Agent({ model: "groq/p", apiKey: "k", baseUrl: "https://x/v1" }).chat).toBeUndefined();
  });

  test("a compat endpoint still sends stream_options and session headers despite COMPAT_NO_*", async () => {
    useRetiredEnv();
    settings({ base_urls: { groq: "http://localhost:1/v1" } });
    const body = await capture(async (f) => {
      const s = new OpenAICompatibleChatProvider("groq").stream("groq/m", ctx, { apiKey: "k", fetch: f, sessionId: "sess-1" });
      await s.result();
    });
    expect(body.body.stream_options).toEqual({ include_usage: true });
    expect(body.headers["x-session-id"]).toBe("sess-1");
  });

  test("API keys are still read from the environment", async () => {
    process.env.GROQ_API_KEY = "gsk_from_env";
    settings({ base_urls: { groq: "http://localhost:1/v1" } });
    const seen = await capture((f) => new OpenAICompatibleChatProvider("groq").generate("groq/m", ctx, { fetch: f }));
    expect(seen.headers["authorization"]).toBe("Bearer gsk_from_env");
    delete process.env.GROQ_API_KEY;
  });
});

describe("the settings are read where the env vars were", () => {
  test("base_urls: google, openai, openrouter, a custom prefix", async () => {
    settings({ base_urls: { google: "http://g.test/v1beta", openai: "http://o.test/v1", openrouter: "http://r.test/api", groq: "http://q.test/v1" } });
    const o = await capture((f) => new OpenAIResponsesProvider().generate("gpt-5.4-nano", ctx, { apiKey: "k", fetch: f }));
    expect(o.url).toBe("http://o.test/v1/responses");
    const r = await capture((f) => new OpenRouterChatCompletionsProvider().generate("x/y", ctx, { apiKey: "k", fetch: f }));
    expect(r.url).toBe("http://r.test/api/chat/completions");
    const c = await capture((f) => new OpenAICompatibleChatProvider("groq").generate("m", ctx, { apiKey: "k", fetch: f }));
    expect(c.url).toBe("http://q.test/v1/chat/completions");
  });

  test("base_urls.google and the gemini alias", async () => {
    settings({ base_urls: { gemini: "http://g.test/v1beta/" } });
    const g = await capture((f) => new GoogleInteractionsProvider().generate("gemini-3.5-flash", ctx, { apiKey: "k", fetch: f }));
    expect(g.url).toBe("http://g.test/v1beta/interactions");
  });

  test("an explicit baseUrl option wins over base_urls", async () => {
    settings({ base_urls: { openai: "http://o.test/v1" } });
    const o = await capture((f) => new OpenAIResponsesProvider().generate("gpt-5.4-nano", ctx, { apiKey: "k", fetch: f, baseUrl: "http://own.test/v1" }));
    expect(o.url).toBe("http://own.test/v1/responses");
  });

  test("base_urls.openai makes a bare model id route to OpenAI", async () => {
    const { resolveModel } = await import("../src/index.ts");
    settings({ base_urls: { openai: "http://o.test/v1" } });
    expect(resolveModel("some-private-model").provider.id).toBe("openai");
  });

  test("compat.no_stream_options and compat.no_session_headers", async () => {
    settings({ base_urls: { groq: "http://localhost:1/v1" }, compat: { no_stream_options: true, no_session_headers: true } });
    const seen = await capture(async (f) => {
      await new OpenAICompatibleChatProvider("groq").stream("groq/m", ctx, { apiKey: "k", fetch: f, sessionId: "sess-1" }).result();
    });
    expect(seen.body.stream_options).toBeUndefined();
    expect(seen.headers["x-session-id"]).toBeUndefined();
    expect(seen.headers["x-client-request-id"]).toBeUndefined();
  });

  test("catalog_cache_dir moves the cache folder, and clearing it moves it back", () => {
    settings({ catalog_cache_dir: "/tmp/somewhere-else" });
    expect(getCacheDir()).toBe(path.resolve("/tmp/somewhere-else"));
    settings();
    expect(getCacheDir()).toBe(path.resolve(".agent-accel", "catalog"));
  });

  test("a model from the list's default is used when an Agent names none", () => {
    settings();
    setModels({ default: { model: "groq/main", sub_agent_model: "groq/worker" }, providers: { groq: { models: ["main", "worker"] } } });
    const a = new Agent({ apiKey: "k", baseUrl: "https://x/v1", dynamicSubagents: { enabled: true } });
    expect(a.modelStringOrSpec).toBe("groq/main");
    expect(a.subagentModel).toBe("groq/worker");
  });
});
