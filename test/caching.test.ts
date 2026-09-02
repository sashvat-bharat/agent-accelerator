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

  it("should estimate tokens accurately", () => {
    const text = "Hello world! This is a test sentence for token counting.";
    const count = countTokens(text);
    expect(count).toBeGreaterThan(5);
    expect(count).toBeLessThan(30);
  });
});
