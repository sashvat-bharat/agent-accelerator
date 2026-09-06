import { describe, it, expect } from "bun:test";
import {
  buildSessionHeaders,
  createSessionId,
  countTokens,
  estimateTokensFromText,
} from "../src/index.ts";

describe("Caching & Session Affinity", () => {
  it("should generate proper session headers for OpenCode (x-opencode-session)", () => {
    const sessionId = "session_12345";
    const headers = buildSessionHeaders("opencode", { sessionId });
    expect(headers["x-opencode-session"]).toBe(sessionId);
    expect(headers["x-session-id"]).toBe(sessionId);
  });

  it("should generate proper session headers for OpenRouter (x-session-id)", () => {
    const sessionId = "session_or_999";
    const headers = buildSessionHeaders("openrouter", { sessionId });
    expect(headers["x-session-id"]).toBe(sessionId);
    expect(headers["X-Title"]).toBe("Agent Accelerator");
  });

  it("should generate proper session headers for OpenCode Responses API (x-client-request-id & session_id)", () => {
    const sessionId = "session_12345";
    const headers = buildSessionHeaders("opencode", { sessionId });
    expect(headers["x-opencode-session"]).toBe(sessionId);
    expect(headers["x-session-id"]).toBe(sessionId);
    expect(headers["x-client-request-id"]).toBe(sessionId);
    expect(headers["session_id"]).toBe(sessionId);
  });

  it("should generate proper headers for Google (x-goog-api-client & session headers)", () => {
    const sessionId = "session_goog_777";
    const headers = buildSessionHeaders("google", { sessionId });
    expect(headers["x-goog-api-client"]).toBe("agent-accel/1.0");
    expect(headers["x-session-id"]).toBe(sessionId);
    expect(headers["x-client-request-id"]).toBe(sessionId);
  });

  it("should estimate tokens accurately", () => {
    const text = "Hello world! This is a test sentence for token counting.";
    const count = countTokens(text);
    expect(count).toBeGreaterThan(5);
    expect(count).toBeLessThan(30);
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

  it("should inject session_id into OpenRouter and OpenCode payloads", async () => {
    const { getProvider } = await import("../src/index.ts");
    const openrouter: any = getProvider("openrouter");
    const opencode: any = getProvider("opencode");

    const orPayload = await openrouter.buildPayload(
      "inclusionai/ling-3.0-flash-fin:free",
      { messages: [{ role: "user", content: "Hello" }] },
      { sessionId: "test-sess-123" }
    );
    expect(orPayload.session_id).toBe("test-sess-123");

    const ocPayload = await opencode.buildPayload(
      "gpt-5.4",
      { messages: [{ role: "user", content: "Hello" }] },
      { sessionId: "test-sess-456" }
    );
    expect(ocPayload.session_id).toBe("test-sess-456");
  });
});
