import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  Agent,
  tool,
  resolveModel,
  validateModelThinking,
  GoogleInteractionsProvider,
  OpenAICompatibleChatProvider,
  ConfigError,
  ValidationError,
  BudgetExceededError,
  ThinkingLevelError,
  AgentAccelError,
} from "../src/index.ts";

// A thrown error, or what a promise rejects with.
const caught = async (fn: () => unknown): Promise<any> => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
const calls = (n: number) =>
  new Response(
    JSON.stringify({
      id: "r",
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: Array.from({ length: n }, (_, i) => ({ id: `call_${i}`, type: "function", function: { name: "work", arguments: "{}" } })) } }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
const agentWith = (limits: Record<string, number>, toolMs = 0) =>
  new Agent({
    model: "groq/test-model",
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    runRetries: 0,
    limits,
    tools: { work: tool({ description: "w", input: z.object({}), repeatable: true, execute: async () => (await new Promise((r) => setTimeout(r, toolMs)), "ok") }) },
    fetch: (async () => calls(2)) as unknown as typeof fetch,
  });

describe("every SDK error is typed", () => {
  it("setup problems are ConfigErrors: no model, a removed provider, a missing key, Gemini 2.x", async () => {
    const errors = [
      await caught(() => resolveModel("")),
      await caught(() => resolveModel("opencode/some-model")),
      await caught(() => new OpenAICompatibleChatProvider("nokeyprefix", { baseUrl: "https://example.test/v1" }).generate("m", { messages: [{ role: "user", content: "hi" }] })),
      await caught(() => new GoogleInteractionsProvider().generate("gemini-2.5-flash", { messages: [{ role: "user", content: "hi" }] }, { apiKey: "k" })),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.code).toBe("config");
      expect(err.retryable).toBe(false);
    }
  });

  it("an empty prompt is a ValidationError, thrown at once by run() and stream()", () => {
    const agent = agentWith({});
    expect(() => agent.run([])).toThrow(ValidationError);
    expect(() => agent.stream([])).toThrow(ValidationError);
  });

  it("a thinking level the model cannot use is a one-line ConfigError that keeps its details", async () => {
    const err = await caught(() => validateModelThinking("google", "gemini-3.8-flash", "none"));
    expect(err).toBeInstanceOf(ThinkingLevelError);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toBeInstanceOf(AgentAccelError);
    expect(err.name).toBe("ThinkingLevelError");
    expect(err.message).not.toContain("\n");
    expect(err.allowedLevels.length).toBeGreaterThan(0);
  });

  it("limits.maxToolCallsPerRun and limits.deadlineMs end the run with a BudgetExceededError", async () => {
    const tooMany = await caught(() => agentWith({ maxToolCallsPerRun: 1 }).run("go"));
    expect(tooMany).toBeInstanceOf(BudgetExceededError);
    expect(tooMany.code).toBe("budget_exceeded");
    const late = await caught(() => agentWith({ deadlineMs: 5 }, 20).run("go"));
    expect(late).toBeInstanceOf(BudgetExceededError);
    expect(String(late.message)).toContain("deadline");
  });
});
