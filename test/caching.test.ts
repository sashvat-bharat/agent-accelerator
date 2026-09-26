import { describe, it, expect } from "bun:test";
import {
  buildSessionHeaders,
  createSessionId,
} from "../src/index.ts";

describe("Caching & Session Affinity", () => {
  it("should generate proper session headers for OpenRouter (x-session-id)", () => {
    const sessionId = "session_or_999";
    const headers = buildSessionHeaders("openrouter", { sessionId });
    expect(headers["x-session-id"]).toBe(sessionId);
    expect(headers["X-Title"]).toBe("Agent Accelerator");
  });

  it("should generate proper headers for Google (x-goog-api-client & session headers)", () => {
    const sessionId = "session_goog_777";
    const headers = buildSessionHeaders("google", { sessionId });
    expect(headers["x-goog-api-client"]).toBe("agent-accel/1.0");
    expect(headers["x-session-id"]).toBe(sessionId);
    expect(headers["x-client-request-id"]).toBe(sessionId);
  });

  it("should default SubAgent cache config to retention short", async () => {
    const { SubAgent } = await import("../src/index.ts");
    const sub = new SubAgent({
      name: "analyst",
      instructions: "Analyze data",
      model: "google/gemini-3.5-flash-lite",
    });
    expect(sub.cacheConfig?.retention).toBe("short");
  });

  it("should send session affinity headers on native custom requests", async () => {
    const { OpenAICompatibleChatProvider } = await import("../src/index.ts");
    const provider = new OpenAICompatibleChatProvider("groq", {
      baseUrl: "https://api.groq.com/openai/v1",
    });
    const originalFetch = globalThis.fetch;
    let sentHeaders: any = null;
    let sentBody: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentHeaders = req.headers;
      sentBody = JSON.parse(req.body);
      return new Response(
        JSON.stringify({
          id: "c",
          choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 }
      );
    };
    try {
      await provider.generate(
        "llama-3.3-70b-versatile",
        { messages: [{ role: "user", content: "hi" }] },
        { apiKey: "k", sessionId: "test-sess-456" }
      );
      // Headers-only affinity (strict endpoints reject unknown body properties).
      expect(sentHeaders["x-session-id"]).toBe("test-sess-456");
      expect(sentBody.session_id).toBeUndefined();
      expect(sentBody.prompt_cache_key).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
