import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { OpenRouterChatCompletionsProvider } from "../src/providers/openrouter.ts";
import {
  mapThinkingLevelToOpenRouterChat,
  mapServiceTierToOpenRouter,
  applyCacheForOpenRouter,
  mapToolChoiceToOpenRouterChat,
  clearEmittedWarnings,
} from "../src/providers.ts";
import { getProvider, resolveModel } from "../src/providers/registry.ts";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetchOnce(body: unknown, init?: { status?: number }) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  (globalThis as any).fetch = async (_url: unknown, _req: unknown) => {
    return new Response(text, {
      status: init?.status ?? 200,
      statusText: init?.status === 400 ? "Bad Request" : "OK",
      headers: { "Content-Type": "application/json" },
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

const TEXT_RESPONSE = {
  id: "gen-test123",
  object: "chat.completion",
  created: 1790243814,
  model: "stealth/space-bunny-alpha",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      native_finish_reason: "stop",
      message: {
        role: "assistant",
        content: "Hello there",
        reasoning: "need to greet",
        reasoning_details: [{ type: "reasoning.text", text: "need to greet", format: "unknown", index: 0 }],
      },
    },
  ],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 10,
    total_tokens: 30,
    prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 1 },
    completion_tokens_details: { reasoning_tokens: 2 },
    cost: 0.00001,
  },
};

const TOOL_RESPONSE = {
  ...TEXT_RESPONSE,
  id: "gen-tool1",
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      native_finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        reasoning: "need weather",
        tool_calls: [
          {
            id: "call_test1",
            type: "function",
            function: { name: "get_weather", arguments: '{"location":"Paris"}' },
          },
        ],
      },
    },
  ],
};

describe("Canonical OpenRouter Chat Completions mappings", () => {
  it("maps thinking levels verbatim incl xhigh (documented + live-verified)", () => {
    clearEmittedWarnings();
    const w = captureWarnings();
    try {
      expect(mapThinkingLevelToOpenRouterChat("low")).toEqual({ effort: "low" });
      expect(mapThinkingLevelToOpenRouterChat("medium")).toEqual({ effort: "medium" });
      expect(mapThinkingLevelToOpenRouterChat("dynamic")).toEqual({});
      expect(mapThinkingLevelToOpenRouterChat(undefined)).toEqual({});
      expect(mapThinkingLevelToOpenRouterChat("none")).toEqual({ effort: "none" });
      // Stable transport documents xhigh (reasoning_effort enum) — no clamp.
      expect(mapThinkingLevelToOpenRouterChat("xhigh")).toEqual({ effort: "xhigh" });
      expect(w.messages.length).toBe(0);
    } finally {
      w.restore();
      clearEmittedWarnings();
    }
  });

  it("maps service tier (omit = auto)", () => {
    expect(mapServiceTierToOpenRouter("flex")).toBe("flex");
    expect(mapServiceTierToOpenRouter("priority")).toBe("priority");
    expect(mapServiceTierToOpenRouter(undefined)).toBeUndefined();
  });

  it("warns and drops cache retention instead of sending it", () => {
    clearEmittedWarnings();
    const w = captureWarnings();
    try {
      applyCacheForOpenRouter({ retention: "medium" }, "openrouter/x");
      applyCacheForOpenRouter({ cachedContentId: "cachedContents/abc" }, "openrouter/x");
      applyCacheForOpenRouter({ retention: "implicit" }, "openrouter/x");
      applyCacheForOpenRouter(undefined, "openrouter/x");
      expect(w.messages.length).toBe(2);
      expect(w.messages[0]).toMatch(/openrouter.*cache retention/i);
    } finally {
      w.restore();
      clearEmittedWarnings();
    }
  });

  it("maps tool choice to Completions shape (function name nested)", () => {
    expect(mapToolChoiceToOpenRouterChat(undefined)).toBeUndefined();
    expect(mapToolChoiceToOpenRouterChat("auto")).toBeUndefined();
    expect(mapToolChoiceToOpenRouterChat("none")).toBe("none");
    expect(mapToolChoiceToOpenRouterChat("required")).toBe("required");
    expect(mapToolChoiceToOpenRouterChat({ type: "function", function: { name: "a" } })).toEqual({
      type: "function",
      function: { name: "a" },
    });
  });
});

describe("OpenRouterChatCompletionsProvider (REST, mocked)", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    clearEmittedWarnings();
  });

  it("is registered for the openrouter prefix and preserves scoped model ids", () => {
    expect(getProvider("openrouter")).toBeInstanceOf(OpenRouterChatCompletionsProvider);
    const r = resolveModel("openai/gpt-4o");
    expect(r.provider.id).toBe("openai");
    const scoped = resolveModel("openrouter/z-ai/glm-5.3-flash");
    expect(scoped.provider.id).toBe("openrouter");
    expect(scoped.modelId).toBe("z-ai/glm-5.3-flash");
  });

  it("generates text with system message + effort + headers, mapping usage", async () => {
    let sentBody: any = null;
    let sentHeaders: any = null;
    let sentUrl = "";
    (globalThis as any).fetch = async (url: unknown, req: any) => {
      sentUrl = String(url);
      sentBody = JSON.parse(req.body);
      sentHeaders = req.headers;
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const provider = new OpenRouterChatCompletionsProvider();
    const res = await provider.generate(
      "z-ai/glm-5.3-flash",
      { systemPrompt: "Be concise.", messages: [{ role: "user", content: "Hi" }] },
      { apiKey: "k", sessionId: "s-or", thinking: { enabled: true, level: "low" } }
    );
    expect(res.text).toBe("Hello there");
    expect(res.thinking).toBe("need to greet");
    expect(res.responseId).toBe("gen-test123");
    expect(res.provider).toBe("openrouter");
    expect(res.model).toBe("z-ai/glm-5.3-flash");
    expect(res.usage.inputTokens).toBe(20);
    expect(res.usage.cachedTokens).toBe(5);
    expect(res.usage.cacheWriteTokens).toBe(1);
    expect(res.usage.thinkingTokens).toBe(2);
    expect(res.finishReason).toBe("stop");
    expect(sentUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sentBody.model).toBe("z-ai/glm-5.3-flash");
    expect(sentBody.messages[0]).toEqual({ role: "system", content: "Be concise." });
    expect(sentBody.reasoning).toEqual({ effort: "low" });
    expect(sentBody.store).toBeUndefined();
    expect(sentBody.prompt_cache_key).toBeUndefined();
    expect(sentBody.session_id).toBe("s-or");
    expect(sentHeaders["Authorization"]).toBe("Bearer k");
    expect(sentHeaders["HTTP-Referer"]).toBe("https://sashvat.com");
    expect(sentHeaders["X-Title"]).toBe("Agent Accelerator");
  });

  it("sends messages-array history with assistant tool calls + tool results", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      const b = JSON.parse(req.body);
      bodies.push(b);
      const hasToolResult = Array.isArray(b.messages) && b.messages.some((m: any) => m.role === "tool");
      return new Response(JSON.stringify(hasToolResult ? TEXT_RESPONSE : TOOL_RESPONSE), { status: 200 });
    };
    const provider = new OpenRouterChatCompletionsProvider();
    const tools = [{ name: "get_weather", description: "d", parameters: { type: "object", properties: {} } }];
    const turn1 = await provider.generate(
      "m",
      { messages: [{ role: "user", content: "Weather in Paris?" }] },
      { apiKey: "k", sessionId: "s-chain", tools }
    );
    expect(turn1.finishReason).toBe("tool_calls");
    expect(turn1.toolCalls?.[0]?.name).toBe("get_weather");
    expect(turn1.toolCalls?.[0]?.id).toBe("call_test1");
    expect(turn1.toolCalls?.[0]?.arguments).toEqual({ location: "Paris" });
    expect(turn1.thinking).toContain("need weather");

    const turn2 = await provider.generate(
      "m",
      {
        messages: [
          { role: "user", content: "Weather in Paris?" },
          {
            role: "assistant",
            content: [
              { type: "tool_call", id: "call_test1", name: "get_weather", arguments: { location: "Paris" } },
            ],
          },
          {
            role: "tool",
            name: "get_weather",
            content: [{ type: "tool_result", id: "call_test1", name: "get_weather", result: "21C" }],
          },
        ],
      },
      { apiKey: "k", sessionId: "s-chain", tools }
    );
    expect(turn2.text).toBe("Hello there");
    const roles = (bodies[1].messages as any[]).map((m: any) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool"]);
    const asst = bodies[1].messages[1];
    expect(asst.tool_calls[0].id).toBe("call_test1");
    expect(asst.tool_calls[0].function.name).toBe("get_weather");
    const toolMsg = bodies[1].messages[2];
    expect(toolMsg.tool_call_id).toBe("call_test1");
    expect(toolMsg.content).toBe("21C");
  });

  it("enables file-parser plugin only when file parts are present", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const provider = new OpenRouterChatCompletionsProvider();
    await provider.generate("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k" });
    expect(bodies[0].plugins).toBeUndefined();
    await provider.generate(
      "m",
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize." },
              { type: "file", file: "https://example.com/d.pdf", mimeType: "application/pdf" } as any,
            ],
          },
        ],
      },
      { apiKey: "k" }
    );
    expect(bodies[1].plugins).toEqual([{ id: "file-parser" }]);
    const userMsg = bodies[1].messages.find((m: any) => m.role === "user");
    expect(JSON.stringify(userMsg.content)).toContain("https://example.com/d.pdf");
  });

  it("sends video_url parts natively (no video fail-fast on this transport)", async () => {
    let sentBody: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentBody = JSON.parse(req.body);
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const provider = new OpenRouterChatCompletionsProvider();
    await provider.generate(
      "m",
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What happens?" },
              { type: "video", video: "https://example.com/c.mp4" } as any,
            ],
          },
        ],
      },
      { apiKey: "k" }
    );
    const userMsg = sentBody.messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toContainEqual({
      type: "video_url",
      video_url: { url: "https://example.com/c.mp4" },
    });
  });

  it("clamps cached tokens to input", async () => {
    mockFetchOnce({
      ...TEXT_RESPONSE,
      usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 500 }, completion_tokens: 10, total_tokens: 110 },
    });
    const provider = new OpenRouterChatCompletionsProvider();
    const res = await provider.generate("m", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k" });
    expect(res.usage.cachedTokens).toBeLessThanOrEqual(res.usage.inputTokens);
  });

  it("throws 200-with-error bodies carrying metadata.error_type", async () => {
    mockFetchOnce({
      id: "gen-err",
      choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "error" }],
      error: { code: 502, message: "Provider disconnected", metadata: { error_type: "provider_unavailable" } },
    });
    const provider = new OpenRouterChatCompletionsProvider();
    const err = await provider
      .generate("m", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k" })
      .then(() => null)
      .catch((e) => e);
    expect(String(err.message)).toContain("[openrouter/m]");
    expect(String(err.message)).toContain("Provider disconnected");
    expect((err as any).errorType).toBe("provider_unavailable");
  });

  it("normalizes request-error envelopes (numeric code, no error_type)", async () => {
    mockFetchOnce({ error: { message: "openrouter/x is not a valid model ID", code: 400 } }, { status: 400 });
    const provider = new OpenRouterChatCompletionsProvider();
    const err = await provider
      .generate("m", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k" })
      .then(() => null)
      .catch((e) => e);
    expect(String(err.message)).toContain("[openrouter/m]");
    expect(String(err.message)).toContain("not a valid model ID");
  });

  it("requires an API key instead of failing opaquely", async () => {
    const provider = new OpenRouterChatCompletionsProvider();
    const err = await provider
      .generate("m", { messages: [{ role: "user", content: "x" }] }, { env: {} })
      .then(() => null)
      .catch((e) => e);
    expect(String(err?.message ?? err)).toMatch(/OPENROUTER_API_KEY|API key/);
  });

  it("streams text + thinking + usage via Chat Completions SSE", async () => {
    const sse = [
      'data: {"id":"gen-s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      "",
      'data: {"id":"gen-s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"reasoning":"thinking","reasoning_details":[{"type":"reasoning.text","text":"thinking"}]},"finish_reason":null}]}',
      "",
      'data: {"id":"gen-s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      "",
      'data: {"id":"gen-s","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new OpenRouterChatCompletionsProvider();
    const stream = provider.stream("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k" });
    const seen: string[] = [];
    for await (const e of stream) seen.push(e.type);
    const final = await stream.result();
    expect(final.text).toBe("Hi");
    // reasoning + details carry identical text — deduped, not doubled.
    expect(final.thinking).toBe("thinking");
    expect(final.responseId).toBe("gen-s");
    expect(final.finishReason).toBe("stop");
    expect(final.usage.inputTokens).toBe(5);
    expect(seen).toContain("text_delta");
    expect(seen).toContain("thinking_delta");
    expect(seen).toContain("done");
    expect(final.raw.response?.status).toBe(200);
  });

  it("streams tool calls across split argument deltas", async () => {
    const sse = [
      'data: {"id":"gen-t","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      "",
      'data: {"id":"gen-t","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_s","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
      "",
      'data: {"id":"gen-t","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"loc"}}]},"finish_reason":null}]}',
      "",
      'data: {"id":"gen-t","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\\":\\"Paris\\"}"}}]},"finish_reason":null}]}',
      "",
      'data: {"id":"gen-t","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new OpenRouterChatCompletionsProvider();
    const stream = provider.stream("m", { messages: [{ role: "user", content: "W?" }] }, { apiKey: "k" });
    const calls: any[] = [];
    for await (const e of stream) {
      if (e.type === "tool_call_complete") calls.push(e.toolCall);
    }
    const final = await stream.result();
    expect(final.finishReason).toBe("tool_calls");
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("get_weather");
    expect(calls[0].arguments).toEqual({ location: "Paris" });
    expect(calls[0].id).toBe("call_s");
  });

  it("surfaces mid-stream error events instead of resolving empty success", async () => {
    const sse = [
      'data: {"id":"gen-e","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"part"},"finish_reason":null}]}',
      "",
      'data: {"id":"gen-e","object":"chat.completion.chunk","created":1,"model":"m","provider":"X","error":{"code":429,"message":"Upstream 429s","metadata":{"error_type":"rate_limit_exceeded"}},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new OpenRouterChatCompletionsProvider();
    const stream = provider.stream("m", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k" });
    let iteratedError: unknown = null;
    try {
      for await (const e of stream) void e;
    } catch (e) {
      iteratedError = e;
    }
    const resultError: unknown = await stream.result().then(
      () => null,
      (e: unknown) => e
    );
    expect(String((resultError as Error)?.message ?? resultError)).toContain("Upstream 429s");
    expect((resultError as any)?.errorType).toBe("rate_limit_exceeded");
    expect(iteratedError ?? resultError).toBeTruthy();
  });

  it("skips SSE comment keep-alives without failing", async () => {
    const sse = [
      ": OPENROUTER PROCESSING",
      "",
      'data: {"id":"gen-c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
      "",
      'data: {"id":"gen-c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new OpenRouterChatCompletionsProvider();
    const stream = provider.stream("m", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k" });
    for await (const _ of stream) void _;
    const final = await stream.result();
    expect(final.text).toBe("Hi");
  });
});
