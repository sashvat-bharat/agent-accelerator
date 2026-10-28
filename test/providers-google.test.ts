import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { GoogleInteractionsProvider, clearInteractionChains } from "../src/providers/google.ts";
import { parseStreamedToolArguments } from "../src/providers.ts";
import { noteProviderTurn, clearSessionRouting } from "../src/providers.ts";
import {
  mapThinkingLevelToGoogle,
  mapServiceTierToGoogle,
  applyCacheForGoogle,
  normalizeToolChoice,
  noteProviderTurn,
  lastProviderFor,
  isMixedProviderSession,
  clearSessionRouting,
  clearEmittedWarnings,
} from "../src/providers.ts";
import { getProvider, resolveModel } from "../src/providers/registry.ts";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetchOnce(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  (globalThis as any).fetch = async (_url: unknown, _req: unknown) => {
    return new Response(text, {
      status: init?.status ?? 200,
      statusText: init?.status === 400 ? "Bad Request" : "OK",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  };
}

function captureWarnings(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  return { messages, restore: () => { console.warn = orig; } };
}

const TEXT_INTERACTION = {
  id: "v1_test123",
  object: "interaction",
  model: "gemini-3.5-flash-lite",
  status: "completed",
  created: "2026-09-22T00:00:00Z",
  updated: "2026-09-22T00:00:00Z",
  service_tier: "standard",
  steps: [
    { type: "thought", signature: "sig_abc" },
    { type: "model_output", content: [{ type: "text", text: "Hello there" }] },
  ],
  usage: {
    total_tokens: 10,
    total_input_tokens: 7,
    total_output_tokens: 3,
    total_cached_tokens: 2,
    total_thought_tokens: 1,
    total_tool_use_tokens: 0,
  },
};

const TOOL_INTERACTION = {
  ...TEXT_INTERACTION,
  id: "v1_tool1",
  status: "requires_action",
  steps: [
    { type: "thought", signature: "sig_x" },
    { type: "function_call", id: "call_1", name: "get_weather", arguments: { location: "Paris" } },
  ],
};

describe("Canonical provider contract", () => {
  it("maps thinking levels for Google (xhigh clamps, none warns, dynamic omits)", () => {
    const w = captureWarnings();
    try {
      expect(mapThinkingLevelToGoogle("low")).toEqual({ thinkingLevel: "low" });
      expect(mapThinkingLevelToGoogle("dynamic")).toEqual({});
      expect(mapThinkingLevelToGoogle(undefined)).toEqual({});
      expect(mapThinkingLevelToGoogle("xhigh")).toEqual({ thinkingLevel: "high" });
      expect(mapThinkingLevelToGoogle("none")).toEqual({});
      expect(w.messages.some((m) => m.includes("xhigh") || m.includes("high"))).toBe(true);
      expect(w.messages.some((m) => m.includes("none") || m.includes("off"))).toBe(true);
    } finally {
      w.restore();
    }
  });

  it("maps service tier (omit = standard)", () => {
    expect(mapServiceTierToGoogle("flex")).toBe("flex");
    expect(mapServiceTierToGoogle("priority")).toBe("priority");
    expect(mapServiceTierToGoogle(undefined)).toBeUndefined();
  });

  it("warns and drops Google cache retention instead of sending it", () => {
    const w = captureWarnings();
    try {
      applyCacheForGoogle({ retention: "long" }, "google/gemini-3.5-flash-lite");
      applyCacheForGoogle({ cachedContentId: "cachedContents/abc" }, "google/x");
      applyCacheForGoogle({ retention: "implicit" }, "google/x");
      applyCacheForGoogle(undefined, "google/x");
      expect(w.messages.length).toBe(2);
      expect(w.messages[0]).toMatch(/google.*cache retention/i);
      expect(w.messages[1]).toMatch(/cachedContentId|cached content/i);
    } finally {
      w.restore();
    }
  });

  it("normalizes tool choice without inventing modes", () => {
    expect(normalizeToolChoice(undefined, ["a"])).toBeUndefined();
    expect(normalizeToolChoice("auto", ["a"])).toBeUndefined();
    expect(normalizeToolChoice("none", ["a"])).toEqual({ mode: "none" });
    expect(normalizeToolChoice("required", ["a", "b"])).toEqual({ mode: "any", tools: ["a", "b"] });
    expect(normalizeToolChoice({ type: "function", function: { name: "a" } }, ["a"])).toEqual({
      mode: "any",
      tools: ["a"],
    });
  });

  it("tracks provider switches per session", () => {
    clearSessionRouting("sess-1");
    expect(lastProviderFor("sess-1")).toBeUndefined();
    noteProviderTurn("sess-1", "google");
    expect(lastProviderFor("sess-1")).toBe("google");
    expect(isMixedProviderSession("sess-1")).toBe(false);
    noteProviderTurn("sess-1", "openai");
    expect(isMixedProviderSession("sess-1")).toBe(true);
    clearSessionRouting("sess-1");
  });

  it("emits each distinct warning once (no per-turn spam)", () => {
    clearEmittedWarnings();
    const w = captureWarnings();
    try {
      applyCacheForGoogle({ retention: "long" }, "google/m");
      applyCacheForGoogle({ retention: "long" }, "google/m");
      applyCacheForGoogle({ retention: "long" }, "google/m");
      expect(w.messages.length).toBe(1);
    } finally {
      w.restore();
      clearEmittedWarnings();
    }
  });

  it("reconstructs streamed tool arguments (empty start + full delta, split partials, garbage)", () => {
    // Raw wire case: step.start carries {} and one delta carries complete JSON.
    expect(parseStreamedToolArguments("{}", '{"location":"Paris"}')).toEqual({ location: "Paris" });
    // Genuinely split partials still concatenate.
    expect(parseStreamedToolArguments('{"loc', 'ation":"Paris"}')).toEqual({ location: "Paris" });
    // Start-only complete call (no deltas).
    expect(parseStreamedToolArguments('{"a":1}', "")).toEqual({ a: 1 });
    // Unparseable stream degrades to {raw} for the existing Zod retry hint.
    expect(parseStreamedToolArguments("{bad", "!!!")).toEqual({ __truncated_raw: "{bad!!!" });
  });
});

describe("GoogleInteractionsProvider (REST, mocked)", () => {
  beforeEach(() => {
    clearInteractionChains();
    clearSessionRouting();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    clearInteractionChains();
    clearSessionRouting();
  });

  it("is registered for google/gemini prefixes", () => {
    expect(getProvider("google")).toBeInstanceOf(GoogleInteractionsProvider);
    expect(getProvider("gemini")).toBeInstanceOf(GoogleInteractionsProvider);
    const r = resolveModel("google/gemini-3.5-flash-lite");
    expect(r.provider.id).toBe("google");
    expect(r.modelId).toBe("gemini-3.5-flash-lite");
  });

  it("generates text and maps usage/ids without client-generated ids", async () => {
    let sentBody: any = null;
    let sentUrl = "";
    (globalThis as any).fetch = async (url: unknown, req: any) => {
      sentUrl = String(url);
      sentBody = JSON.parse(req.body);
      return new Response(JSON.stringify(TEXT_INTERACTION), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    const res = await provider.generate(
      "gemini-3.5-flash-lite",
      { messages: [{ role: "user", content: "Hi" }] },
      { apiKey: "k", sessionId: "s-text" }
    );
    expect(res.text).toBe("Hello there");
    expect(res.responseId).toBe("v1_test123");
    expect(res.thoughtSignature).toBe("sig_abc");
    expect(res.usage.inputTokens).toBe(7);
    expect(res.usage.outputTokens).toBe(4); // 3 output + 1 thought: Google bills thoughts as output
    expect(res.usage.cachedTokens).toBe(2);
    expect(res.usage.thinkingTokens).toBe(1);
    expect(res.finishReason).toBe("stop");
    // No client-generated ids anywhere in the request.
    expect(JSON.stringify(sentBody)).not.toContain("previous_interaction_id");
    expect(sentBody.model).toBe("gemini-3.5-flash-lite");
    expect(sentUrl).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
  });

  it("trims provider trailing blank lines when assembling thinking (no edge-tripling)", async () => {
    // Raw captures (e.g. 02-system-thinking.json) show summaries trailing
    // with `"...\n\n\n"`. Joining steps raw yields triple newlines in the
    // <think> block; trimming per-step keeps single-blank separation.
    mockFetchOnce({
      ...TEXT_INTERACTION,
      id: "v1_trim",
      steps: [
        { type: "thought", signature: "sig_1", summary: [{ type: "text", text: "Hello\n\n\n" }] },
        { type: "thought", signature: "sig_2", summary: [{ type: "text", text: "\nWorld\n" }] },
        { type: "model_output", content: [{ type: "text", text: "Hi" }] },
      ],
    });
    const provider = new GoogleInteractionsProvider();
    const res = await provider.generate(
      "m",
      { messages: [{ role: "user", content: "Hi" }] },
      { apiKey: "k", sessionId: "s-trim" }
    );
    expect(res.text).toBe("Hi");
    expect(res.thinking).toBe("Hello\nWorld");
    expect(res.thinking).not.toContain("\n\n\n");
  });

  it("returns function calls with requires_action and chains via previous_interaction_id", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      const b = JSON.parse(req.body);
      bodies.push(b);
      const payload = b.previous_interaction_id ? TEXT_INTERACTION : TOOL_INTERACTION;
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    const turn1 = await provider.generate(
      "gemini-3.5-flash-lite",
      { messages: [{ role: "user", content: "Weather in Paris?" }] },
      {
        apiKey: "k",
        sessionId: "s-chain",
        tools: [{ name: "get_weather", description: "d", parameters: { type: "object", properties: {} } }],
      }
    );
    expect(turn1.finishReason).toBe("tool_calls");
    expect(turn1.toolCalls?.[0]?.name).toBe("get_weather");
    expect(turn1.toolCalls?.[0]?.id).toBe("call_1");

    const turn2 = await provider.generate(
      "gemini-3.5-flash-lite",
      {
        messages: [
          { role: "user", content: "Weather in Paris?" },
          {
            role: "assistant",
            content: [
              { type: "tool_call", id: "call_1", name: "get_weather", arguments: { location: "Paris" } },
            ],
          },
          {
            role: "tool",
            name: "get_weather",
            content: [{ type: "tool_result", id: "call_1", name: "get_weather", result: "21C" }],
          },
        ],
      },
      {
        apiKey: "k",
        sessionId: "s-chain",
        tools: [{ name: "get_weather", description: "d", parameters: { type: "object", properties: {} } }],
      }
    );
    expect(turn2.text).toBe("Hello there");
    expect(bodies[1].previous_interaction_id).toBe("v1_tool1");
    // function_result echoes the provider call id; no invented ids.
    expect(JSON.stringify(bodies[1].input)).toContain("call_1");
  });

  it("chained turn after tools + a mid-run steer still sends the function_result (then the steer)", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      const b = JSON.parse(req.body);
      bodies.push(b);
      const payload = b.previous_interaction_id ? TEXT_INTERACTION : TOOL_INTERACTION;
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    const tools = [{ name: "get_weather", description: "d", parameters: { type: "object", properties: {} } }];
    await provider.generate(
      "gemini-3.5-flash-lite",
      { messages: [{ role: "user", content: "Weather in Paris?" }] },
      { apiKey: "k", sessionId: "s-steer", tools }
    );
    await provider.generate(
      "gemini-3.5-flash-lite",
      {
        messages: [
          { role: "user", content: "Weather in Paris?" },
          { role: "assistant", content: [{ type: "tool_call", id: "call_1", name: "get_weather", arguments: {} }] },
          { role: "tool", name: "get_weather", content: [{ type: "tool_result", id: "call_1", name: "get_weather", result: "21C" }] },
          { role: "user", content: "also check Rome" }, // steer injected after the tool results
        ],
      },
      { apiKey: "k", sessionId: "s-steer", tools }
    );
    expect(bodies[1].previous_interaction_id).toBe("v1_tool1");
    const steps = bodies[1].input;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.map((s: any) => s.type)).toEqual(["function_result", "user_input"]);
    expect(steps[0].call_id).toBe("call_1");
    expect(steps[1].content[0].text).toBe("also check Rome");
  });

  it("falls back to stateless full history after a provider switch", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      const b = JSON.parse(req.body);
      bodies.push(b);
      return new Response(JSON.stringify(TEXT_INTERACTION), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    noteProviderTurn("s-switch", "openai"); // another provider served last
    await provider.generate(
      "gemini-3.5-flash-lite",
      {
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: [{ type: "text", text: "Hello" }] },
          { role: "user", content: "Again" },
        ],
      },
      { apiKey: "k", sessionId: "s-switch" }
    );
    expect(bodies[0].store).toBe(false);
    expect(bodies[0].previous_interaction_id).toBeUndefined();
    expect(Array.isArray(bodies[0].input)).toBe(true);
  });

  it("sends full history (chainable) when a session has history but no chain yet", async () => {
    // Restored chat session after a restart, or the turn right after a
    // provider switch: multi-message history with no interaction chain must
    // not collapse to the latest turn alone. Default store (not false) so the
    // response establishes a fresh chain for the next turn.
    clearInteractionChains("s-restore");
    clearSessionRouting("s-restore");
    let sentBody: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentBody = JSON.parse(req.body);
      return new Response(JSON.stringify(TEXT_INTERACTION), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    await provider.generate(
      "gemini-3.5-flash-lite",
      {
        systemPrompt: "Be concise.",
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: [{ type: "text", text: "Hello" }] },
          { role: "user", content: "Again" },
        ],
      },
      { apiKey: "k", sessionId: "s-restore" }
    );
    expect(Array.isArray(sentBody.input)).toBe(true);
    expect(sentBody.input.length).toBeGreaterThan(1);
    expect(sentBody.previous_interaction_id).toBeUndefined();
    expect(sentBody.store).toBeUndefined();
    expect(JSON.stringify(sentBody.input)).toContain("Again");
  });

  it("clamps provider-reported cached tokens to input (never >100% hit rate)", async () => {
    mockFetchOnce({
      ...TEXT_INTERACTION,
      id: "v1_skewed",
      usage: {
        total_tokens: 13500,
        total_input_tokens: 1300,
        total_output_tokens: 2600,
        total_cached_tokens: 12200,
        total_thought_tokens: 0,
      },
    });
    const provider = new GoogleInteractionsProvider();
    const res = await provider.generate(
      "m",
      { messages: [{ role: "user", content: "Hi" }] },
      { apiKey: "k", sessionId: "s-clamp" }
    );
    expect(res.usage.inputTokens).toBe(1300);
    expect(res.usage.cachedTokens).toBeLessThanOrEqual(res.usage.inputTokens);
    expect(res.usage.cachedTokens).toBe(1300);
  });

  it("normalizes Google errors concisely while preserving raw payload", async () => {
    mockFetchOnce({ error: { message: "bad level", code: "invalid_request" } }, { status: 400 });
    const provider = new GoogleInteractionsProvider();
    const err = await provider
      .generate("x", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k" })
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain("[google/x]");
    expect(String(err.message)).toContain("bad level");
  });

  it("requires an API key instead of failing opaquely", async () => {
    const provider = new GoogleInteractionsProvider();
    const err = await provider
      .generate("x", { messages: [{ role: "user", content: "x" }] }, { env: {} })
      .then(() => null)
      .catch((e) => e);
    expect(String(err?.message ?? err)).toMatch(/GEMINI_API_KEY|API key/);
  });

  it("streams text + usage via SSE", async () => {
    const sse = [
      'event: interaction.created',
      'data: {"interaction":{"id":"v1_s","status":"in_progress","object":"interaction","model":"m"},"event_type":"interaction.created"}',
      "",
      "event: step.start",
      'data: {"index":0,"step":{"type":"thought"},"event_type":"step.start"}',
      "",
      "event: step.delta",
      'data: {"index":0,"delta":{"signature":"sig_s","type":"thought_signature"},"event_type":"step.delta"}',
      "",
      "event: step.stop",
      'data: {"index":0,"event_type":"step.stop"}',
      "",
      "event: step.start",
      'data: {"index":1,"step":{"type":"model_output"},"event_type":"step.start"}',
      "",
      "event: step.delta",
      'data: {"index":1,"delta":{"text":"Hi","type":"text"},"event_type":"step.delta"}',
      "",
      "event: step.stop",
      'data: {"index":1,"event_type":"step.stop"}',
      "",
      "event: interaction.completed",
      'data: {"interaction":{"id":"v1_s","status":"completed","usage":{"total_tokens":3,"total_input_tokens":2,"total_output_tokens":1,"total_cached_tokens":0,"total_thought_tokens":0}},"event_type":"interaction.completed"}',
      "",
      "event: done",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new GoogleInteractionsProvider();
    const stream = provider.stream(
      "m",
      { messages: [{ role: "user", content: "Hi" }] },
      { apiKey: "k", sessionId: "s-sse" }
    );
    const seen: string[] = [];
    for await (const e of stream) seen.push(e.type);
    const final = await stream.result();
    expect(final.text).toBe("Hi");
    expect(final.thoughtSignature).toBe("sig_s");
    expect(final.responseId).toBe("v1_s");
    expect(seen).toContain("text_delta");
    expect(seen).toContain("done");
    expect(final.raw.response?.status).toBe(200);
  });

  it("streams tool calls with empty-start + full-delta args (live wire shape)", async () => {
    const sse = [
      "event: interaction.created",
      'data: {"interaction":{"id":"v1_t","status":"in_progress","object":"interaction","model":"m"},"event_type":"interaction.created"}',
      "",
      "event: step.start",
      'data: {"index":0,"step":{"type":"thought"},"event_type":"step.start"}',
      "",
      "event: step.delta",
      'data: {"index":0,"delta":{"signature":"sig_t","type":"thought_signature"},"event_type":"step.delta"}',
      "",
      "event: step.stop",
      'data: {"index":0,"event_type":"step.stop"}',
      "",
      "event: step.start",
      'data: {"index":1,"step":{"id":"call_9","type":"function_call","name":"get_weather","arguments":{}},"event_type":"step.start"}',
      "",
      "event: step.delta",
      'data: {"index":1,"delta":{"arguments":"{\\"location\\":\\"Paris\\"}","type":"arguments_delta"},"event_type":"step.delta"}',
      "",
      "event: step.stop",
      'data: {"index":1,"event_type":"step.stop"}',
      "",
      "event: interaction.completed",
      'data: {"interaction":{"id":"v1_t","status":"requires_action","usage":{"total_tokens":5,"total_input_tokens":4,"total_output_tokens":1,"total_cached_tokens":0,"total_thought_tokens":0}},"event_type":"interaction.completed"}',
      "",
      "event: done",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new GoogleInteractionsProvider();
    const stream = provider.stream(
      "m",
      { messages: [{ role: "user", content: "Weather?" }] },
      { apiKey: "k", sessionId: "s-sse-tools" }
    );
    const toolEvents: any[] = [];
    for await (const e of stream) {
      if (e.type === "tool_call_complete") toolEvents.push(e.toolCall);
    }
    const final = await stream.result();
    expect(final.finishReason).toBe("tool_calls");
    expect(toolEvents.length).toBe(1);
    expect(toolEvents[0].name).toBe("get_weather");
    expect(toolEvents[0].arguments).toEqual({ location: "Paris" });
    expect(final.toolCalls?.[0]?.arguments).toEqual({ location: "Paris" });
  });

  it("stores canonical rawArguments for empty-start + full-delta streams (no {}{} artifact)", async () => {
    const sse = [
      "event: step.start",
      'data: {"index":0,"step":{"id":"call_c","type":"function_call","name":"w","arguments":{}},"event_type":"step.start"}',
      "",
      "event: step.delta",
      'data: {"index":0,"delta":{"arguments":"{\\"a\\":1}","type":"arguments_delta"},"event_type":"step.delta"}',
      "",
      "event: interaction.completed",
      'data: {"interaction":{"id":"v1_c","status":"requires_action","usage":{"total_tokens":3,"total_input_tokens":2,"total_output_tokens":1}},"event_type":"interaction.completed"}',
      "",
      "event: done",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new GoogleInteractionsProvider();
    const stream = provider.stream(
      "m",
      { messages: [{ role: "user", content: "Hi" }] },
      { apiKey: "k", sessionId: "s-canon" }
    );
    const toolEvents: any[] = [];
    for await (const e of stream) {
      if (e.type === "tool_call_complete") toolEvents.push(e.toolCall);
    }
    await stream.result();
    expect(toolEvents.length).toBe(1);
    // The winning candidate, not the "{}{...}" concatenation.
    expect(toolEvents[0].rawArguments).toBe('{"a":1}');
    expect(JSON.parse(toolEvents[0].rawArguments)).toEqual(toolEvents[0].arguments);
  });

  it("surfaces SSE error events instead of resolving empty success", async () => {
    const sse = [
      "event: interaction.created",
      'data: {"interaction":{"id":"v1_e","status":"in_progress","object":"interaction","model":"m"},"event_type":"interaction.created"}',
      "",
      "event: error",
      'data: {"error":{"message":"Rate limit exceeded for model m.","code":"rate_limit_exceeded"},"event_type":"error"}',
      "",
      "event: done",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new GoogleInteractionsProvider();
    const stream = provider.stream(
      "m",
      { messages: [{ role: "user", content: "Hi" }] },
      { apiKey: "k", sessionId: "s-sse-err" }
    );
    const seen: string[] = [];
    let iteratedError: unknown = null;
    try {
      for await (const e of stream) seen.push(e.type);
    } catch (e) {
      iteratedError = e;
    }
    const resultError: unknown = await stream.result().then(
      () => null,
      (e: unknown) => e
    );
    expect(String((resultError as Error)?.message ?? resultError)).toContain("Rate limit");
    expect(iteratedError ?? resultError).toBeTruthy();
  });

  it("falls back to stateless full history when another provider served last", async () => {
    clearSessionRouting("s-mixed");
    noteProviderTurn("s-mixed", "openrouter");
    let sentBody: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentBody = JSON.parse(req.body);
      return new Response(
        JSON.stringify({
          id: "v1_mixed",
          status: "completed",
          steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }],
          usage: { total_tokens: 3, total_input_tokens: 2, total_output_tokens: 1 },
        }),
        { status: 200 }
      );
    };
    const provider = new GoogleInteractionsProvider();
    const res = await provider.generate(
      "m",
      {
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: [{ type: "text", text: "Hello" }] },
          { role: "user", content: "Again" },
        ],
      },
      { apiKey: "k", sessionId: "s-mixed" }
    );
    expect(res.text).toBe("ok");
    expect(sentBody.store).toBe(false);
    expect(sentBody.previous_interaction_id).toBeUndefined();
    expect(Array.isArray(sentBody.input)).toBe(true);
    clearSessionRouting("s-mixed");
  });
});

describe("GoogleInteractionsProvider chain expiry & self-heal (mocked)", () => {
  beforeEach(() => {
    clearInteractionChains();
    clearSessionRouting();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    clearInteractionChains();
    clearSessionRouting();
    try { delete (globalThis as any).__agentAccelAnomaly; } catch {}
  });

  const HISTORY = {
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      { role: "user", content: "Again" },
    ],
  } as any;

  it("gates expired chains locally instead of wasting an RTT (free tier defaults to 23h)", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return new Response(JSON.stringify(TEXT_INTERACTION), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    await provider.generate("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-ttl" });
    const realNow = Date.now;
    (Date as any).now = () => realNow() + 24 * 3600 * 1000;
    try {
      await provider.generate("m", HISTORY, { apiKey: "k", sessionId: "s-ttl" });
    } finally {
      (Date as any).now = realNow;
    }
    // Expired pointer dropped locally: full-history reseed, no chained id.
    expect(bodies[1].previous_interaction_id).toBeUndefined();
    expect(Array.isArray(bodies[1].input)).toBe(true);
    expect(bodies[1].store).toBeUndefined();
  });

  it("keeps chains inside the paid-tier window (googleTier: paid)", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return new Response(JSON.stringify(TEXT_INTERACTION), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    await provider.generate("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-tier" });
    const realNow = Date.now;
    (Date as any).now = () => realNow() + 50 * 24 * 3600 * 1000;
    try {
      await provider.generate("m", HISTORY, { apiKey: "k", sessionId: "s-tier", googleTier: "paid" });
    } finally {
      (Date as any).now = realNow;
    }
    expect(bodies[1].previous_interaction_id).toBe("v1_test123");
  });

  it("self-heals a 404 chained pointer with one full-history retry and replaces the chain", async () => {
    const bodies: any[] = [];
    let calls = 0;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      calls++;
      bodies.push(JSON.parse(req.body));
      if (calls === 2) {
        return new Response(JSON.stringify({ error: { code: "not_found", message: "The requested resource was not found." } }), { status: 404 });
      }
      const id = calls === 1 ? "v1_seed" : calls === 3 ? "v1_healed" : "v1_next";
      return new Response(JSON.stringify({ ...TEXT_INTERACTION, id }), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    await provider.generate("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-heal" });
    const res = await provider.generate("m", HISTORY, { apiKey: "k", sessionId: "s-heal" });
    expect(res.text).toBe("Hello there");
    // Call 2 used the dead pointer; call 3 reseeded without it.
    expect(bodies[1].previous_interaction_id).toBe("v1_seed");
    expect(bodies[2].previous_interaction_id).toBeUndefined();
    expect(Array.isArray(bodies[2].input)).toBe(true);
    // The healed chain is live: the next turn chains to the new id.
    await provider.generate("m", HISTORY, { apiKey: "k", sessionId: "s-heal" });
    expect(bodies[3].previous_interaction_id).toBe("v1_healed");
  });

  it("does not retry chain-less 404s", async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: "not_found", message: "The requested resource was not found." } }), { status: 404 });
    };
    const provider = new GoogleInteractionsProvider();
    await expect(
      provider.generate("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-nochain" })
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("re-sends system_instruction and tools on chained turns (interaction-scoped params)", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return new Response(JSON.stringify(TEXT_INTERACTION), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    const tools = [{ name: "w", description: "d", parameters: { type: "object", properties: {} } }];
    await provider.generate("m", { systemPrompt: "Be concise.", messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-scoped", tools });
    await provider.generate("m", { systemPrompt: "Be concise.", ...HISTORY }, { apiKey: "k", sessionId: "s-scoped", tools });
    expect(bodies[1].previous_interaction_id).toBe("v1_test123");
    expect(bodies[1].system_instruction).toBe("Be concise.");
    expect(Array.isArray(bodies[1].tools)).toBe(true);
  });

  it("clears the dead chain and marks retryable on SSE not_found", async () => {
    const okSse = [
      "event: interaction.created",
      'data: {"interaction":{"id":"v1_sse_chain","status":"in_progress","object":"interaction","model":"m"},"event_type":"interaction.created"}',
      "",
      "event: step.delta",
      'data: {"index":0,"delta":{"text":"hi","type":"text"},"event_type":"step.delta"}',
      "",
      "event: interaction.completed",
      'data: {"interaction":{"id":"v1_sse_chain","status":"completed","usage":{"total_tokens":3,"total_input_tokens":2,"total_output_tokens":1}},"event_type":"interaction.completed"}',
      "",
      "event: done",
      "data: [DONE]",
      "",
    ].join("\n");
    const errSse = [
      "event: error",
      'data: {"error":{"code":"not_found","message":"Failed to get completed interaction: Result not found."},"event_type":"error"}',
      "",
      "event: done",
      "data: [DONE]",
      "",
    ].join("\n");
    let calls = 0;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      calls++;
      try { JSON.parse(req.body); } catch {}
      const sse = calls === 1 ? okSse : errSse;
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new GoogleInteractionsProvider();
    const seed = provider.stream("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-sse-evict" });
    const seedRes = await seed.result();
    expect(seedRes.responseId).toBe("v1_sse_chain");
    const stream = provider.stream("m", HISTORY, { apiKey: "k", sessionId: "s-sse-evict" });
    try { for await (const _e of stream) { /* drain */ } } catch {}
    const err = await stream.result().then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeTruthy();
    expect((err as any)?.retryable).toBe(true);
    // Dead pointer was cleared: the next turn reseeds without it.
    let reseeded: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      reseeded = JSON.parse(req.body);
      return new Response(JSON.stringify(TEXT_INTERACTION), { status: 200 });
    };
    await provider.generate("m", HISTORY, { apiKey: "k", sessionId: "s-sse-evict" });
    expect(reseeded.previous_interaction_id).toBeUndefined();
    expect(Array.isArray(reseeded.input)).toBe(true);
  });

  it("alerts when input tokens shrink turn-over-turn (dropped chain without rehydration)", async () => {
    const seen: unknown[] = [];
    (globalThis as any).__agentAccelAnomaly = (d: unknown) => void seen.push(d);
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      const usage =
        calls === 1
          ? { total_tokens: 150, total_input_tokens: 100, total_output_tokens: 50, total_cached_tokens: 0, total_thought_tokens: 0 }
          : { total_tokens: 12, total_input_tokens: 10, total_output_tokens: 2, total_cached_tokens: 0, total_thought_tokens: 0 };
      return new Response(JSON.stringify({ ...TEXT_INTERACTION, id: `v1_tok${calls}`, usage }), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    await provider.generate("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-tok" });
    await provider.generate("m", HISTORY, { apiKey: "k", sessionId: "s-tok" });
    expect(seen.some((d: any) => d?.type === "interaction_history_shrink")).toBe(true);
  });
});

describe("GoogleInteractionsProvider generation floor & failure handling (mocked)", () => {
  beforeEach(() => {
    clearInteractionChains();
    clearSessionRouting();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    clearInteractionChains();
    clearSessionRouting();
  });

  it("rejects Gemini 1.x/2.x without any network call (minimum: Gemini 3)", async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return new Response(JSON.stringify(TEXT_INTERACTION), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    for (const id of ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro", "google/gemini-2.5-flash-lite"]) {
      await expect(
        provider.generate(id, { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-floor" })
      ).rejects.toThrow(/Gemini 3/);
    }
    expect(calls).toBe(0);
  });

  it("fails streams on legacy generation ids without any network call", async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return new Response("{}", { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    const stream = provider.stream("gemini-2.0-flash", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-floor-sse" });
    try { for await (const _e of stream) { /* drain */ } } catch {}
    const err = await stream.result().then(
      () => null,
      (e: unknown) => e
    );
    expect(String((err as Error)?.message ?? err)).toMatch(/Gemini 3/);
    expect(calls).toBe(0);
  });

  it("throws (never empty success) on failed interactions", async () => {
    (globalThis as any).fetch = async () => {
      return new Response(
        JSON.stringify({
          ...TEXT_INTERACTION,
          id: "v1_failed",
          status: "failed",
          error: { message: "Safety block triggered.", code: "safety" },
        }),
        { status: 200 }
      );
    };
    const provider = new GoogleInteractionsProvider();
    await expect(
      provider.generate("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-failed" })
    ).rejects.toThrow(/Safety block triggered/);
  });

  it("fails streams on failed interaction.completed instead of empty stop", async () => {
    const sse = [
      "event: interaction.created",
      'data: {"interaction":{"id":"v1_f","status":"in_progress","object":"interaction","model":"m"},"event_type":"interaction.created"}',
      "",
      "event: interaction.completed",
      'data: {"interaction":{"id":"v1_f","status":"failed","error":{"message":"Safety block triggered.","code":"safety"}},"event_type":"interaction.completed"}',
      "",
      "event: done",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new GoogleInteractionsProvider();
    const stream = provider.stream("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-failed-sse" });
    try { for await (const _e of stream) { /* drain */ } } catch {}
    const err = await stream.result().then(
      () => null,
      (e: unknown) => e
    );
    expect(String((err as Error)?.message ?? err)).toMatch(/Safety block triggered/);
  });

  it("maps incomplete to length (truncation, not stop)", async () => {
    (globalThis as any).fetch = async () => {
      return new Response(JSON.stringify({ ...TEXT_INTERACTION, id: "v1_inc", status: "incomplete" }), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    const res = await provider.generate("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", sessionId: "s-inc" });
    expect(res.finishReason).toBe("length");
  });

  it("omits empty thought signatures on foreign-provider replay, keeps google ones", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return new Response(JSON.stringify(TEXT_INTERACTION), { status: 200 });
    };
    const provider = new GoogleInteractionsProvider();
    await provider.generate(
      "m",
      {
        messages: [
          { role: "user", content: "Hi" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "foreign reasoning", thoughtSignature: "sig-foreign", thoughtSignatureProvider: "openai" },
              { type: "thinking", thinking: "own reasoning", thoughtSignature: "sig-own", thoughtSignatureProvider: "google" },
            ],
          },
          { role: "user", content: "Again" },
        ],
      },
      { apiKey: "k", sessionId: "s-sig" }
    );
    const thoughts = (bodies[0].input as any[]).filter((s) => s.type === "thought");
    expect(thoughts.length).toBe(2);
    expect(thoughts[0].signature).toBeUndefined();
    expect(thoughts[0].summary).toBeDefined();
    expect(thoughts[1].signature).toBe("sig-own");
  });
});

describe("model switch mid-session", () => {
  it("reseeds from full history, chains again afterwards, and raises no false history-shrink anomaly", async () => {
    const { Agent, telemetryBus, clearInteractionChains } = await import("../src/index.ts");
    clearInteractionChains();
    const bodies: any[] = [];
    const usages = [
      { total_tokens: 1050, total_input_tokens: 1000, total_output_tokens: 50 },
      { total_tokens: 1100, total_input_tokens: 1050, total_output_tokens: 50, total_cached_tokens: 950 },
      { total_tokens: 700, total_input_tokens: 650, total_output_tokens: 50 }, // new model, smaller tokenizer count, cache gone
      { total_tokens: 760, total_input_tokens: 700, total_output_tokens: 60, total_cached_tokens: 600 },
    ];
    let n = 0;
    const fn = (async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `v1_${n + 1}`, status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }], usage: usages[n++] }), { status: 200 });
    }) as any;
    const anomalies: string[] = [];
    const off = telemetryBus.onEvent((e) => { if (e.code === "interaction_history_shrink") anomalies.push(e.code); });
    try {
      const agent = new Agent({ model: "google/gemini-3.5-flash-lite", apiKey: "k", fetch: fn });
      await agent.run("hello");
      await agent.run("again");
      (agent as any).modelStringOrSpec = "google/gemini-3.5-flash";
      const first = await agent.run("after switch");
      await agent.run("more");
      expect(bodies.map((b) => b.previous_interaction_id ?? null)).toEqual([null, "v1_1", null, "v1_3"]);
      expect(Array.isArray(bodies[2].input)).toBe(true); // full history on the switch turn
      expect(first.usage.cachedTokens).toBe(0);
      // priced with the NEW model's rates: 650 in @ $1.50/M + 50 out @ $9/M
      expect(first.usage.cost?.totalCost).toBeCloseTo((650 * 1.5 + 50 * 9) / 1e6, 9);
      expect(anomalies).toEqual([]);
    } finally {
      off();
      clearInteractionChains();
    }
  });
});

describe("Google thought tokens are billed as output", () => {
  it("prices output + thought tokens (usage from a real thinking session)", async () => {
    const { Agent } = await import("../src/index.ts");
    const fn = (async () =>
      new Response(JSON.stringify({ id: "v1_t", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }], usage: { total_tokens: 1593, total_input_tokens: 1240, total_output_tokens: 85, total_thought_tokens: 268 } }), { status: 200 })) as any;
    const res = await new Agent({ model: "google/gemini-3.5-flash-lite", apiKey: "k", fetch: fn }).run("hi");
    expect(res.usage.outputTokens).toBe(353);
    expect(res.usage.thinkingTokens).toBe(268);
    expect(res.usage.totalTokens).toBe(1593);
    // 1240 in @ $0.30/M + (85 + 268) out @ $2.50/M
    expect(res.usage.cost?.totalCost).toBeCloseTo(0.001255, 6); // 1254.5 micro-USD, rounded to whole micro-USD
  });
});
