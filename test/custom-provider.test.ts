import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  resolveModel,
  getProvider,
  ModelProvider,
  ensureCustomProvider,
  OpenAICompatibleProvider,
} from "../src/index.ts";

describe("Unified Multi-Provider Layer (no OpenRouter fee)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    delete process.env.GROQ_BASE_URL;
    delete process.env.GROQ_API_KEY;
    delete process.env.CEREBRAS_BASE_URL;
    delete process.env.CEREBRAS_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("MODEL=groq/... routes to auto-created custom provider (env-only, zero code)", () => {
    process.env.GROQ_API_KEY = "gsk_test123";
    process.env.GROQ_BASE_URL = "https://api.groq.com/openai/v1";

    const resolved = resolveModel("groq/llama-3.3-70b-versatile");
    expect(resolved.provider.id).toBe("groq");
    expect(resolved.modelId).toBe("llama-3.3-70b-versatile");
    expect(resolved.provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  test("different prefixes get isolated providers (multi-provider in one process)", () => {
    process.env.GROQ_BASE_URL = "https://api.groq.com/openai/v1";
    process.env.GROQ_API_KEY = "gsk_a";
    process.env.CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";
    process.env.CEREBRAS_API_KEY = "csk_b";

    const groq = resolveModel("groq/llama-3.3-70b-versatile");
    const cerebras = resolveModel("cerebras/gpt-oss-120b");

    expect(groq.provider.id).toBe("groq");
    expect(cerebras.provider.id).toBe("cerebras");
    expect(groq.provider).not.toBe(cerebras.provider);
    expect(groq.modelId).toBe("llama-3.3-70b-versatile");
    expect(cerebras.modelId).toBe("gpt-oss-120b");
  });

  test("scoped OpenRouter shorthand still routes to openrouter (no regression)", () => {
    const resolved = resolveModel("openrouter/z-ai/glm-5.2:free");
    expect(resolved.provider.id).toBe("openrouter");
    expect(resolved.modelId).toBe("z-ai/glm-5.2:free");
  });

  test("z-ai scope without dedicated env stays openrouter; with env becomes custom", () => {
    const asScope = resolveModel("z-ai/glm-5.2:free");
    expect(asScope.provider.id).toBe("openrouter");

    process.env.Z_AI_BASE_URL = "https://api.z.ai/api/paas/v4";
    process.env.Z_AI_API_KEY = "zkey";
    const asCustom = resolveModel("z-ai/glm-5.2:free");
    expect(asCustom.provider.id).toBe("z-ai");
  });

  test("getProvider auto-creates custom instead of throwing", () => {
    const p = getProvider("together");
    expect(p.id).toBe("together");
  });

  test("ensureCustomProvider registers with explicit baseUrl/apiKey (no env needed)", () => {
    ensureCustomProvider("fireworks", {
      baseUrl: "https://api.fireworks.ai/inference/v1",
      apiKey: "fw_test",
    });
    const resolved = resolveModel("fireworks/llama-v3p3-70b-instruct");
    expect(resolved.provider.id).toBe("fireworks");
    expect(resolved.modelId).toBe("llama-v3p3-70b-instruct");
  });

  test("ModelProvider.Custom helper wires model + key + baseUrl", () => {
    const inst = ModelProvider.Custom("groq/llama-3.3-70b-versatile", "gsk_x", {
      baseUrl: "https://api.groq.com/openai/v1",
    });
    expect(inst.model).toBe("groq/llama-3.3-70b-versatile");
    expect(inst.apiKey).toBe("gsk_x");
    expect(inst.baseUrl).toBe("https://api.groq.com/openai/v1");

    const resolved = resolveModel(inst.model);
    expect(resolved.provider.id).toBe("groq");
  });

  test("custom provider hits {PREFIX}_BASE_URL (not OpenAI cloud)", async () => {
    process.env.GROQ_BASE_URL = "https://api.groq.com/openai/v1";
    process.env.GROQ_API_KEY = "gsk_secret";

    const provider = ensureCustomProvider("groq");
    const originalFetch = globalThis.fetch;
    let url = "";
    let headers: any = {};
    (globalThis as any).fetch = async (u: string, init: any) => {
      url = u;
      headers = init.headers;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-groq",
          choices: [{ message: { role: "assistant", content: "hi from groq" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    try {
      const res = await provider.generate("groq/llama-3.3-70b-versatile", {
        messages: [{ role: "user", content: "hi" }],
      });
      expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
      expect(headers["Authorization"]).toBe("Bearer gsk_secret");
      expect(res.text).toBe("hi from groq");
      expect(res.provider).toBe("groq");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("thinking preflight: catalog-known non-reasoning throws, unknown is permissive", async () => {
    const { validateModelThinking } = await import("../src/index.ts");
    // groq/llama-3.3-70b-versatile exists in models.dev with reasoning:false → strict is correct.
    expect(() => validateModelThinking("groq", "llama-3.3-70b-versatile", "none")).not.toThrow();
    expect(() => validateModelThinking("groq", "llama-3.3-70b-versatile", "medium")).toThrow();
    // Brand-new / private ids have no catalog entry → permissive (any level allowed).
    expect(() => validateModelThinking("cerebras", "anything-brand-new-xyz", "high")).not.toThrow();
    expect(() => validateModelThinking("myproxy", "my-private-model-v9", "medium")).not.toThrow();
  });

  test("Agent works end-to-end on custom provider with mocked fetch", async () => {
    const { Agent } = await import("../src/index.ts");
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1";
    process.env.OLLAMA_API_KEY = "ollama";

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-local",
          choices: [{ message: { role: "assistant", content: "local hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    try {
      const agent = new Agent({ model: "ollama/qwen2.5-coder" });
      const res = await agent.run("hi");
      expect(res.text).toBe("local hello");
      expect(res.provider).toBe("ollama");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
