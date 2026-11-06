import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { OpenRouterChatCompletionsProvider } from "../src/providers/openrouter.ts";
import {
  mapThinkingLevelToOpenRouterChat,
  mapServiceTierToOpenRouter,
  mapToolChoiceToOpenRouterChat,
  clearEmittedWarnings,
  parseStreamedToolArguments,
  selectRawArguments,
} from "../src/providers.ts";
import { getProvider, resolveModel } from "../src/providers/registry.ts";
import { isRetryableRun } from "../src/utils/retry.ts";

const ORIGINAL_FETCH = globalThis.fetch;

// Every OpenRouter request streams, so a reply is SSE. This turns a non-streaming chat completion fixture into the
// frames a streamed request gets: one chunk with the whole message as a delta, one with the finish reason and usage.
function sseReply(json: any): Response {
  const choice = json.choices?.[0] ?? {};
  const m = choice.message ?? {};
  const delta: Record<string, unknown> = { role: "assistant" };
  if (m.content) delta["content"] = m.content;
  if (m.reasoning_details) delta["reasoning_details"] = m.reasoning_details;
  else if (m.reasoning) delta["reasoning"] = m.reasoning;
  if (m.tool_calls) delta["tool_calls"] = m.tool_calls.map((t: any, index: number) => ({ index, id: t.id, type: "function", function: t.function }));
  const first: Record<string, unknown> = { id: json.id, model: json.model, choices: [{ index: 0, delta, finish_reason: null }] };
  if (json.error) first["error"] = json.error; // a provider failure arrives as an error frame inside the stream
  const last = { id: json.id, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: json.usage };
  const frames = [first, last].map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(frames, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function mockFetchOnce(body: unknown, init?: { status?: number }) {
  (globalThis as any).fetch = async (_url: unknown, _req: unknown) => {
    if ((init?.status ?? 200) >= 400 || typeof body === "string") {
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: init?.status ?? 200,
        statusText: init?.status === 400 ? "Bad Request" : "OK",
        headers: { "Content-Type": "application/json" },
      });
    }
    return sseReply(body);
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

  it("sends cache_control TTL for anthropic models and warns+drops it elsewhere", async () => {
    clearEmittedWarnings();
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return sseReply(TEXT_RESPONSE);
    };
    const w = captureWarnings();
    try {
      const provider = new OpenRouterChatCompletionsProvider();
      const ctx = { messages: [{ role: "user" as const, content: "Hi" }] };
      await provider.generate("anthropic/claude-x", ctx, { apiKey: "k", cache: "1h" });
      await provider.generate("anthropic/claude-x", ctx, { apiKey: "k", cache: "implicit" });
      await provider.generate("z-ai/glm-5.3-flash", ctx, { apiKey: "k", cache: "5m" });
      expect(bodies[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      expect(bodies[1].cache_control).toBeUndefined();
      expect(bodies[2].cache_control).toBeUndefined();
      expect(w.messages.length).toBe(1);
      expect(w.messages[0]).toMatch(/openrouter.*cache.*"implicit"/i);
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
      return sseReply(TEXT_RESPONSE);
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
    expect(sentBody.stream).toBe(true); // OpenRouter only cancels streaming requests, so even generate() streams
    expect(sentBody.messages[0]).toEqual({ role: "system", content: "Be concise." });
    expect(sentBody.reasoning).toEqual({ effort: "low" });
    expect(sentBody.store).toBeUndefined();
    expect(sentBody.prompt_cache_key).toBeUndefined();
    expect(sentBody.session_id).toBe("s-or");
    expect(sentHeaders["Authorization"]).toBe("Bearer k");
    // Attribution is opt-in: nothing is credited to a third-party app by default.
    expect(sentHeaders["HTTP-Referer"]).toBeUndefined();
    expect(sentHeaders["X-Title"]).toBeUndefined();
  });

  it("sends messages-array history with assistant tool calls + tool results", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      const b = JSON.parse(req.body);
      bodies.push(b);
      const hasToolResult = Array.isArray(b.messages) && b.messages.some((m: any) => m.role === "tool");
      return sseReply(hasToolResult ? TEXT_RESPONSE : TOOL_RESPONSE);
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

  it("sends files in the documented shape: file_data for URLs and data URLs, never a plugin or file_url", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return sseReply(TEXT_RESPONSE);
    };
    const provider = new OpenRouterChatCompletionsProvider();
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    await provider.generate(
      "m",
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize." },
              { type: "file", file: "https://example.com/d.pdf", filename: "d.pdf", mimeType: "application/pdf" } as any,
              { type: "file", file: bytes, mimeType: "text/csv" } as any,
            ],
          },
        ],
      },
      { apiKey: "k" }
    );
    expect(bodies[0].plugins).toBeUndefined();
    const content = bodies[0].messages.find((m: any) => m.role === "user").content;
    expect(content).toHaveLength(3); // text + two files: the URL is not repeated as a text part
    expect(content[1]).toEqual({ type: "file", file: { filename: "d.pdf", file_data: "https://example.com/d.pdf" } });
    expect(content[2].file.file_data).toBe(`data:text/csv;base64,${Buffer.from(bytes).toString("base64")}`);
    expect(content[2].file.filename).toBeUndefined();
    expect(JSON.stringify(bodies[0])).not.toContain("file_url");
  });

  it("sends video_url parts natively (no video fail-fast on this transport)", async () => {
    let sentBody: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentBody = JSON.parse(req.body);
      return sseReply(TEXT_RESPONSE);
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

describe("per-media resolution on OpenRouter", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    clearEmittedWarnings();
  });

  const run = async (content: any[]) => {
    const { telemetryBus } = await import("../src/telemetry.ts");
    clearEmittedWarnings();
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_u: unknown, req: any) => (bodies.push(JSON.parse(req.body)), sseReply(TEXT_RESPONSE));
    const warnings: any[] = [];
    const off = telemetryBus.onEvent((e) => {
      if (e.code === "provider_warning" && (e.data as any)?.capability === "media resolution") warnings.push(e.data);
    });
    const w = captureWarnings();
    try {
      const provider = new OpenRouterChatCompletionsProvider();
      await provider.generate("x/model", { messages: [{ role: "user", content }] }, { apiKey: "k" });
      await provider.generate("x/model", { messages: [{ role: "user", content }] }, { apiKey: "k" });
    } finally {
      off();
      w.restore();
    }
    return { bodies, warnings };
  };

  it("sends an image's resolution as image_url.detail (URL and inline) and does not warn", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    const { bodies, warnings } = await run([
      { type: "image", image: "https://example.com/a.png", resolution: "low" },
      { type: "image", image: "https://example.com/b.png", resolution: "medium" },
      { type: "image", image: png, resolution: "high" },
      { type: "image", image: "https://example.com/c.png", resolution: "ultra_high" },
      { type: "image", image: "https://example.com/d.png" },
    ] as any);
    const images = bodies[0].messages[0].content.map((c: any) => c.image_url);
    expect(images.map((i: any) => i.detail)).toEqual(["low", "auto", "high", "original", undefined]);
    expect(images[2].url.startsWith("data:image/png;base64,")).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("warns once on the bus for a video's resolution and never sends the field", async () => {
    const { bodies, warnings } = await run([{ type: "video", video: "https://example.com/v.mp4", resolution: "high" }] as any);
    expect(warnings.length).toBe(1);
    expect(JSON.stringify(bodies)).not.toContain("resolution");
    expect(JSON.stringify(bodies)).not.toContain("detail");
  });
});

// ---------------------------------------------------------------------------
// OpenRouter only cancels a request that streams, so generate() streams too (docs: "Stream cancellation").
// ---------------------------------------------------------------------------
describe("every OpenRouter request can be cancelled: generate() is served over a stream", () => {
  const enc = new TextEncoder();
  const frame = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // A reply that keeps producing tokens until the client closes the connection (cancel of the response body).
  function endless(): { response: Response; state: { sent: number; cancelled: boolean } } {
    const state = { sent: 0, cancelled: false };
    let timer: ReturnType<typeof setInterval>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => {
          state.sent++;
          controller.enqueue(enc.encode(frame({ id: "g", choices: [{ index: 0, delta: { content: "tok " } }] })));
        }, 5);
      },
      cancel() {
        state.cancelled = true;
        clearInterval(timer);
      },
    });
    return { response: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }), state };
  }
  const ctx = { messages: [{ role: "user" as const, content: "write a novel" }] };
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("an abort closes the connection: the body is cancelled, the tokens stop, and the caller's reason is kept", async () => {
    const e = endless();
    let sent: AbortSignal | undefined;
    (globalThis as any).fetch = async (_u: unknown, req: any) => ((sent = req.signal), e.response);
    const ctl = new AbortController();
    const pending = new OpenRouterChatCompletionsProvider().generate("m", ctx, { apiKey: "k", signal: ctl.signal }).catch((err) => err);
    for (let i = 0; i < 400 && e.state.sent < 3; i++) await sleep(5);
    ctl.abort(new Error("user pressed stop"));
    const err = await pending;
    expect(err).toMatchObject({ name: "AbortError", message: "user pressed stop" });
    const at = e.state.sent;
    await sleep(60);
    expect(e.state.cancelled).toBe(true); // the connection is closed, so OpenRouter can stop the model
    expect(e.state.sent).toBe(at);
    expect(sent?.aborted).toBe(true);
  });

  it("timeoutMs still bounds the whole call, not just the wait for the first byte", async () => {
    const e = endless(); // headers at once, tokens forever
    (globalThis as any).fetch = async () => e.response;
    const started = Date.now();
    const err = await new OpenRouterChatCompletionsProvider().generate("m", ctx, { apiKey: "k", timeoutMs: 60 } as any).catch((x) => x);
    expect(err).toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1500);
    await sleep(30);
    expect(e.state.cancelled).toBe(true);
  });

  it("a long answer is drained: no buffer-overflow warning, nothing lost", async () => {
    const frames = Array.from({ length: 1500 }, () => frame({ id: "g", choices: [{ index: 0, delta: { content: "a" } }] })).join("");
    const done = frame({ id: "g", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1500, total_tokens: 1501 } });
    (globalThis as any).fetch = async () => new Response(frames + done + "data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const { telemetryBus } = await import("../src/telemetry.ts");
    const codes: string[] = [];
    const off = telemetryBus.onEvent((ev) => codes.push(ev.code));
    try {
      const res = await new OpenRouterChatCompletionsProvider().generate("m", ctx, { apiKey: "k" });
      expect(res.text).toBe("a".repeat(1500));
      expect(res.usage.outputTokens).toBe(1500);
    } finally {
      off();
    }
    expect(codes).not.toContain("stream_buffer_overflow");
  });

  it("a transient failure before the first byte is still retried", async () => {
    let n = 0;
    (globalThis as any).fetch = async () => (++n === 1 ? new Response(JSON.stringify({ error: { message: "busy", code: 503 } }), { status: 503 }) : sseReply(TEXT_RESPONSE));
    const res = await new OpenRouterChatCompletionsProvider().generate("m", ctx, { apiKey: "k", maxRetries: 1, retryBaseDelayMs: 1 });
    expect(res.text).toBe("Hello there");
    expect(n).toBe(2);
  });

  it("an HTTP error is reported as before (concise, with its status)", async () => {
    mockFetchOnce({ error: { message: "bad key", code: 401 } }, { status: 401 });
    const err = await new OpenRouterChatCompletionsProvider().generate("m", ctx, { apiKey: "k" }).catch((x) => x);
    expect(String(err.message)).toContain("[openrouter/m]");
    expect(String(err.message)).toContain("(401)");
  });
});

describe("tool calls without arguments", () => {
  afterEach(() => {
    (globalThis as any).fetch = ORIGINAL_FETCH;
  });

  const frame = (f: unknown) => `data: ${JSON.stringify(f)}\n\n`;
  const sse = (body: string) => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const call = { index: 0, id: "call_1", type: "function", function: { name: "ping", arguments: "" } };

  it("treats empty streamed arguments as {} while broken JSON stays truncated", () => {
    expect(parseStreamedToolArguments("", "")).toEqual({});
    expect(parseStreamedToolArguments("  ", "\n")).toEqual({});
    expect(selectRawArguments("", "")).toBe("{}");
    expect(parseStreamedToolArguments("", '{"a":"abc')).toEqual({ __truncated_raw: '{"a":"abc' });
  });

  it("returns a no-argument call that finished normally with {} arguments", async () => {
    (globalThis as any).fetch = async () =>
      sse(
        frame({ id: "g1", choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] }) +
          frame({ id: "g1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }) +
          "data: [DONE]\n\n"
      );
    const res = await new OpenRouterChatCompletionsProvider().generate("m", { messages: [{ role: "user", content: "go" }] }, { apiKey: "k" });
    expect(res.toolCalls?.[0]?.arguments).toEqual({});
    expect(res.toolCalls?.[0]?.rawArguments).toBe("{}");
  });

  it("still fails a cut-off stream whose call never received its arguments", async () => {
    (globalThis as any).fetch = async () => sse(frame({ id: "g1", choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] }));
    const err = await new OpenRouterChatCompletionsProvider()
      .generate("m", { messages: [{ role: "user", content: "go" }] }, { apiKey: "k", maxRetries: 0 })
      .then(() => null)
      .catch((e) => e);
    expect((err as any)?.code).toBe("incomplete_stream");
  });
});

describe("errors in the middle of a stream", () => {
  afterEach(() => {
    (globalThis as any).fetch = ORIGINAL_FETCH;
  });

  const run = async (error: Record<string, unknown>) => {
    const frames =
      `data: ${JSON.stringify({ id: "g1", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: "g1", error, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] })}\n\n`;
    (globalThis as any).fetch = async () => new Response(frames, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    return new OpenRouterChatCompletionsProvider()
      .generate("m", { messages: [{ role: "user", content: "hi" }] }, { apiKey: "k", maxRetries: 0 })
      .then(() => null)
      .catch((e) => e as any);
  };

  it("carries the HTTP status of a numeric code, so the run retry treats it like an HTTP error", async () => {
    const err = await run({ code: 429, message: "Rate limit exceeded", metadata: { error_type: "rate_limit_exceeded" } });
    expect(err.statusCode).toBe(429);
    expect(err.message).toContain("(429)");
    expect(err.errorType).toBe("rate_limit_exceeded");
    expect(isRetryableRun(err)).toBe(true);
  });

  it("maps a string code through its error_type, and leaves non-retryable errors alone", async () => {
    const overloaded = await run({ code: "server_error", message: "Provider disconnected", metadata: { error_type: "provider_unavailable" } });
    expect(overloaded.statusCode).toBe(502);
    expect(isRetryableRun(overloaded)).toBe(true);
    const bad = await run({ code: 400, message: "Bad input", metadata: { error_type: "invalid_request" } });
    expect(bad.statusCode).toBe(400);
    expect(isRetryableRun(bad)).toBe(false);
    const unknown = await run({ code: "weird", message: "?" });
    expect(unknown.statusCode).toBeUndefined();
    expect(isRetryableRun(unknown)).toBe(false);
  });
});

describe("small request and usage values", () => {
  afterEach(() => {
    (globalThis as any).fetch = ORIGINAL_FETCH;
    clearEmittedWarnings();
  });

  const frames = (usage: unknown) =>
    new Response(
      `data: ${JSON.stringify({ id: "g", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );

  it("keeps a reported cost of 0 as a known cost", async () => {
    (globalThis as any).fetch = async () => frames({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0 });
    const res = await new OpenRouterChatCompletionsProvider().generate("m", { messages: [{ role: "user", content: "hi" }] }, { apiKey: "k" });
    expect(res.usage.cost).toEqual({ totalCost: 0 });
    (globalThis as any).fetch = async () => frames({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    const none = await new OpenRouterChatCompletionsProvider().generate("m", { messages: [{ role: "user", content: "hi" }] }, { apiKey: "k" });
    expect(none.usage.cost).toBeUndefined();
  });

  it("offers the 5m/1h cache TTL to ~anthropic/ aliases too", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_u: unknown, req: any) => (bodies.push(JSON.parse(req.body)), frames({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
    const w = captureWarnings();
    try {
      await new OpenRouterChatCompletionsProvider().generate("~anthropic/claude-sonnet-latest", { messages: [{ role: "user", content: "hi" }] }, { apiKey: "k", cache: "1h" });
    } finally {
      w.restore();
    }
    expect(bodies[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(w.messages).toEqual([]);
  });

  it("sends at most 4 stop sequences and says so once", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_u: unknown, req: any) => (bodies.push(JSON.parse(req.body)), frames({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
    const w = captureWarnings();
    try {
      const provider = new OpenRouterChatCompletionsProvider();
      const ctx = { messages: [{ role: "user" as const, content: "hi" }] };
      await provider.generate("m", ctx, { apiKey: "k", stop: ["a", "b", "c", "d", "e", "f"] });
      await provider.generate("m", ctx, { apiKey: "k", stop: ["a", "b"] });
    } finally {
      w.restore();
    }
    expect(bodies[0].stop).toEqual(["a", "b", "c", "d"]);
    expect(bodies[1].stop).toEqual(["a", "b"]);
    expect(w.messages.length).toBe(1);
    expect(w.messages[0]).toMatch(/at most 4 stop sequences/);
  });
});

describe("402 from the in-flight spending budget", () => {
  afterEach(() => {
    (globalThis as any).fetch = ORIGINAL_FETCH;
  });

  const payment = (metadata: Record<string, unknown>) =>
    new Response(JSON.stringify({ error: { code: 402, message: "This request would exceed your available credits", metadata } }), {
      status: 402,
      headers: { "Content-Type": "application/json", "retry-after-ms": "5" },
    });
  const generate = () => new OpenRouterChatCompletionsProvider().generate("m", { messages: [{ role: "user", content: "hi" }] }, { apiKey: "k" });

  it("is retried after the Retry-After wait, and then succeeds", async () => {
    let calls = 0;
    (globalThis as any).fetch = async () =>
      ++calls === 1 ? payment({ reason: "in_flight_budget_exhausted", limit_source: "openrouter_in_flight_budget" }) : sseReply(TEXT_RESPONSE);
    const res = await generate();
    expect(res.text).toBe("Hello there");
    expect(calls).toBe(2);
  });

  it("is not retried when the account is simply out of credits", async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => (calls++, payment({ reason: "weight_exceeds_budget", limit_source: "openrouter_credits" }));
    const err = await generate().then(() => null, (e) => e);
    expect(calls).toBe(1);
    expect(err.statusCode).toBe(402);
    expect(err.retryable).toBeUndefined();
  });
});
