import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { OpenAIResponsesProvider } from "../src/providers/openai.ts";
import {
  mapThinkingLevelToOpenAI,
  mapServiceTierToOpenAI,
  applyCacheForOpenAI,
  mapToolChoiceToOpenAI,
  clearEmittedWarnings,
} from "../src/providers.ts";
import { getProvider, resolveModel } from "../src/providers/registry.ts";
import { parseStreamedToolArguments } from "../src/providers.ts";

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
  id: "resp-test123",
  object: "response",
  created_at: 1741290958,
  model: "gpt-4o",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_test1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello there", annotations: [] }],
    },
  ],
  error: null,
  usage: {
    input_tokens: 20,
    input_tokens_details: { cached_tokens: 5 },
    output_tokens: 10,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 30,
  },
};

const TOOL_RESPONSE = {
  ...TEXT_RESPONSE,
  id: "resp-tool1",
  status: "completed",
  output: [
    {
      type: "reasoning",
      id: "rs_test1",
      content: [{ type: "reasoning_text", text: "need weather" }],
      summary: [],
    },
    {
      type: "function_call",
      id: "fc_test1",
      call_id: "call_test1",
      name: "get_weather",
      arguments: '{"location":"Paris"}',
    },
  ],
};

describe("Canonical OpenAI mappings", () => {
  it("maps thinking levels verbatim incl xhigh, dynamic omits", () => {
    clearEmittedWarnings();
    const w = captureWarnings();
    try {
      expect(mapThinkingLevelToOpenAI("low")).toEqual({ effort: "low" });
      expect(mapThinkingLevelToOpenAI("medium")).toEqual({ effort: "medium" });
      expect(mapThinkingLevelToOpenAI("dynamic")).toEqual({});
      expect(mapThinkingLevelToOpenAI(undefined)).toEqual({});
      expect(mapThinkingLevelToOpenAI("none")).toEqual({ effort: "none" });
      expect(mapThinkingLevelToOpenAI("xhigh")).toEqual({ effort: "xhigh" });
      // No warnings — xhigh is native on OpenAI.
      expect(w.messages.length).toBe(0);
    } finally {
      w.restore();
      clearEmittedWarnings();
    }
  });

  it("maps service tier (omit = auto)", () => {
    expect(mapServiceTierToOpenAI("flex")).toBe("flex");
    expect(mapServiceTierToOpenAI("priority")).toBe("priority");
    expect(mapServiceTierToOpenAI(undefined)).toBeUndefined();
  });

  it("warns and drops OpenAI cache retention instead of sending it", () => {
    clearEmittedWarnings();
    const w = captureWarnings();
    try {
      applyCacheForOpenAI({ retention: "medium" }, "openai/x");
      applyCacheForOpenAI({ cachedContentId: "cachedContents/abc" }, "openai/x");
      applyCacheForOpenAI({ retention: "implicit" }, "openai/x");
      applyCacheForOpenAI(undefined, "openai/x");
      expect(w.messages.length).toBe(2);
      expect(w.messages[0]).toMatch(/openai.*cache retention/i);
    } finally {
      w.restore();
      clearEmittedWarnings();
    }
  });

  it("maps tool choice (required native, function pin verbatim)", () => {
    expect(mapToolChoiceToOpenAI(undefined)).toBeUndefined();
    expect(mapToolChoiceToOpenAI("auto")).toBeUndefined();
    expect(mapToolChoiceToOpenAI("none")).toBe("none");
    expect(mapToolChoiceToOpenAI("required")).toBe("required");
    expect(mapToolChoiceToOpenAI({ type: "function", function: { name: "a" } })).toEqual({
      type: "function",
      name: "a",
    });
  });

  it("reconstructs streamed tool arguments", () => {
    expect(parseStreamedToolArguments("{}", '{"location":"Paris"}')).toEqual({ location: "Paris" });
    expect(parseStreamedToolArguments('{"loc', 'ation":"Paris"}')).toEqual({ location: "Paris" });
  });
});

describe("OpenAIResponsesProvider (REST, mocked)", () => {
  beforeEach(() => {
    clearEmittedWarnings();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    clearEmittedWarnings();
  });

  it("is registered for the openai prefix and strips only openai/", () => {
    expect(getProvider("openai")).toBeInstanceOf(OpenAIResponsesProvider);
    const r = resolveModel("openai/gpt-4o");
    expect(r.provider.id).toBe("openai");
    expect(r.modelId).toBe("gpt-4o");
  });

  it("generates text with instructions + effort + cache key, store:false", async () => {
    let sentBody: any = null;
    let sentHeaders: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentBody = JSON.parse(req.body);
      sentHeaders = req.headers;
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const provider = new OpenAIResponsesProvider();
    const res = await provider.generate(
      "gpt-4o",
      { systemPrompt: "Be concise.", messages: [{ role: "user", content: "Hi" }] },
      { apiKey: "k", sessionId: "s-oi", thinking: { enabled: true, level: "low" } }
    );
    expect(res.text).toBe("Hello there");
    expect(res.responseId).toBe("resp-test123");
    expect(res.provider).toBe("openai");
    expect(res.model).toBe("gpt-4o");
    expect(res.usage.inputTokens).toBe(20);
    expect(res.usage.cachedTokens).toBe(5);
    expect(res.usage.thinkingTokens).toBe(2);
    expect(res.finishReason).toBe("stop");
    expect(sentBody.model).toBe("gpt-4o");
    expect(sentBody.instructions).toBe("Be concise.");
    expect(sentBody.reasoning).toEqual({ effort: "low" });
    expect(sentBody.prompt_cache_key).toBe("s-oi");
    expect(sentBody.store).toBe(false);
    expect(sentBody.previous_response_id).toBeUndefined();
    expect(sentBody.background).toBeUndefined();
    expect(sentBody.conversation).toBeUndefined();
    expect(sentHeaders["Authorization"]).toBe("Bearer k");
  });

  it("always sends array-form input, even for single text turns", async () => {
    let sentBody: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentBody = JSON.parse(req.body);
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const provider = new OpenAIResponsesProvider();
    await provider.generate("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k" });
    expect(Array.isArray(sentBody.input)).toBe(true);
    expect(sentBody.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] },
    ]);
  });

  it("returns function calls with both ids and chains via full history", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      const b = JSON.parse(req.body);
      bodies.push(b);
      const hasOutput = Array.isArray(b.input) && b.input.some((i: any) => i.type === "function_call_output");
      return new Response(JSON.stringify(hasOutput ? TEXT_RESPONSE : TOOL_RESPONSE), { status: 200 });
    };
    const provider = new OpenAIResponsesProvider();
    const tools = [{ name: "get_weather", description: "d", parameters: { type: "object", properties: {} } }];
    const turn1 = await provider.generate(
      "m",
      { messages: [{ role: "user", content: "Weather in Paris?" }] },
      { apiKey: "k", sessionId: "s-chain", tools }
    );
    expect(turn1.finishReason).toBe("tool_calls");
    expect(turn1.toolCalls?.[0]?.name).toBe("get_weather");
    expect(turn1.toolCalls?.[0]?.id).toBe("fc_test1");
    expect(turn1.toolCalls?.[0]?.callId).toBe("call_test1");
    expect(turn1.thinking).toContain("need weather");

    const turn2 = await provider.generate(
      "m",
      {
        messages: [
          { role: "user", content: "Weather in Paris?" },
          {
            role: "assistant",
            content: [
              { type: "tool_call", id: "fc_test1", callId: "call_test1", name: "get_weather", arguments: { location: "Paris" } },
            ],
          },
          {
            role: "tool",
            name: "get_weather",
            content: [{ type: "tool_result", id: "fc_test1", name: "get_weather", result: "21C" }],
          },
        ],
      },
      { apiKey: "k", sessionId: "s-chain", tools }
    );
    expect(turn2.text).toBe("Hello there");
    expect(bodies[1].store).toBe(false);
    expect(bodies[1].previous_response_id).toBeUndefined();
    const types = (bodies[1].input as any[]).map((i: any) => i.type);
    expect(types).toEqual(["message", "function_call", "function_call_output"]);
    expect((bodies[1].input as any[])[2].call_id).toBe("call_test1");
  });

  it("clamps cached tokens to input", async () => {
    mockFetchOnce({
      ...TEXT_RESPONSE,
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 500 }, output_tokens: 10, total_tokens: 110 },
    });
    const provider = new OpenAIResponsesProvider();
    const res = await provider.generate("m", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k" });
    expect(res.usage.cachedTokens).toBeLessThanOrEqual(res.usage.inputTokens);
  });

  it("normalizes error envelopes and preserves type", async () => {
    mockFetchOnce({ error: { message: "bad request", type: "invalid_request_error", code: "invalid_prompt" } }, { status: 400 });
    const provider = new OpenAIResponsesProvider();
    const err = await provider
      .generate("m", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k" })
      .then(() => null)
      .catch((e) => e);
    expect(String(err.message)).toContain("[openai/m]");
    expect(String(err.message)).toContain("bad request");
    expect((err as any).errorType).toBe("invalid_request_error");
  });

  it("throws failed-status responses as errors", async () => {
    mockFetchOnce({ id: "resp-f", status: "failed", error: { message: "boom", code: "server_error" }, output: [] });
    const provider = new OpenAIResponsesProvider();
    const err = await provider
      .generate("m", { messages: [{ role: "user", content: "x" }] }, { apiKey: "k" })
      .then(() => null)
      .catch((e) => e);
    expect(String(err.message)).toContain("boom");
  });

  it("requires an API key instead of failing opaquely", async () => {
    const provider = new OpenAIResponsesProvider();
    const err = await provider
      .generate("m", { messages: [{ role: "user", content: "x" }] }, { env: {} })
      .then(() => null)
      .catch((e) => e);
    expect(String(err?.message ?? err)).toMatch(/OPENAI_API_KEY|API key/);
  });

  it("rejects video pre-network with a clear one-liner (no wire video shape)", async () => {
    let fetched = false;
    (globalThis as any).fetch = async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    };
    const provider = new OpenAIResponsesProvider();
    const err = await provider
      .generate(
        "gpt-4o",
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "video", video: "https://x/y.mp4" } as any] }] },
        { apiKey: "k" }
      )
      .then(() => null)
      .catch((e) => e);
    expect(fetched).toBe(false);
    expect(String(err.message)).toMatch(/unsupported video input/);
  });

  it("clamps long prompt_cache_key to 64 chars (sub-agent child sessions)", async () => {
    // Regression: fixed/dynamic child ids (`parent-sub-tag-rand`, 65-72 chars)
    // 400d on OpenAI with `Invalid 'prompt_cache_key': string too long`.
    // The adapter must clamp defensively so sub-agents never 0-usage fail.
    let sentBody: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentBody = JSON.parse(req.body);
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const provider = new OpenAIResponsesProvider();
    const longSession = "accel-80040b02-6884-4f5a-b552-97e7bf8f550a-sub-adversarial_critic";
    expect(longSession.length).toBeGreaterThan(64);
    const res = await provider.generate(
      "m",
      { messages: [{ role: "user", content: "Hi" }] },
      { apiKey: "k", sessionId: longSession }
    );
    expect(res.text).toBe("Hello there");
    expect(typeof sentBody.prompt_cache_key).toBe("string");
    expect(sentBody.prompt_cache_key.length).toBeLessThanOrEqual(64);
  });

  it("passes remote http URLs through directly (no base64 blowup)", async () => {
    // Regression: fetching remote mp3/pdf and inlining as data URL blew past
    // the 1,048,576 `file_url` limit (11,926,995 chars for the audio fixture).
    // Docs example sends `file_url: "https://...pdf"` directly.
    let sentBody: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentBody = JSON.parse(req.body);
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const provider = new OpenAIResponsesProvider();
    await provider.generate(
      "gpt-4o",
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image", image: "https://picsum.photos/seed/accel/512" } as any,
              { type: "file", file: "https://www.berkshirehathaway.com/letters/2024ltr.pdf", mimeType: "application/pdf" } as any,
            ],
          },
        ],
      },
      { apiKey: "k" }
    );
    const userMsg = sentBody.input.find((i: any) => i.type === "message" && i.role === "user");
    const img = userMsg.content.find((c: any) => c.type === "input_image");
    const file = userMsg.content.find((c: any) => c.type === "input_file");
    expect(img.image_url).toBe("https://picsum.photos/seed/accel/512");
    expect(file.file_url).toBe("https://www.berkshirehathaway.com/letters/2024ltr.pdf");
  });

  it("fails fast on unsupported modalities with a one-liner (no confusing file_url errors)", async () => {
    // gpt-5-nano is text+image only: audio/pdf/video must not reach the wire.
    const provider = new OpenAIResponsesProvider();
    const err = await provider
      .generate(
        "gpt-5-nano",
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "audio", audio: "https://x/y.mp3" } as any] }] },
        { apiKey: "k" }
      )
      .then(() => null)
      .catch((e) => e);
    expect(String(err.message)).toMatch(/unsupported audio input.*supports: text, image/);
  });

  it("trims reasoning assembly trailing blank lines (no edge-tripling)", async () => {
    mockFetchOnce({
      ...TEXT_RESPONSE,
      id: "resp-trim",
      output: [
        {
          type: "reasoning",
          id: "rs_trim",
          content: [{ type: "reasoning_text", text: "Need this\n\n\n" }],
          summary: ["Tail\n"],
        },
        {
          type: "message",
          id: "msg_trim",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Hi", annotations: [] }],
        },
      ],
    });
    const provider = new OpenAIResponsesProvider();
    const res = await provider.generate(
      "m",
      { messages: [{ role: "user", content: "Hi" }] },
      { apiKey: "k" }
    );
    expect(res.text).toBe("Hi");
    expect(res.thinking).toBe("Need this\nTail");
  });

  it("forwards input_file filename and records session affinity in raw audit", async () => {
    let sentBody: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentBody = JSON.parse(req.body);
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const provider = new OpenAIResponsesProvider();
    const res = await provider.generate(
      "gpt-4o",
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "file", file: "data:application/pdf;base64,JVBERg==", mimeType: "application/pdf", filename: "doc.pdf" } as any,
            ],
          },
        ],
      },
      { apiKey: "k", sessionId: "sess-audit-1" }
    );
    const userMsg = sentBody.input.find((i: any) => i.type === "message" && i.role === "user");
    const file = userMsg.content.find((c: any) => c.type === "input_file");
    expect(file.filename).toBe("doc.pdf");
    // Raw audit must show the affinity actually sent (was Content-Type-only).
    expect(res.raw.request.headers["x-session-id"] ?? res.raw.request.headers["session_id"]).toBe("sess-audit-1");
    expect(res.raw.request.headers["Authorization"]).toBe("[REDACTED]");
  });

  it("maps streaming incomplete status to length (not stop)", async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp-i"}}',
      "",
      'data: {"type":"response.output_text.delta","output_index":0,"delta":"partial"}',
      "",
      'data: {"type":"response.completed","response":{"id":"resp-i","status":"incomplete","usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new OpenAIResponsesProvider();
    const stream = provider.stream("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k" });
    for await (const _ of stream) void _;
    const final = await stream.result();
    expect(final.finishReason).toBe("length");
    expect(final.text).toBe("partial");
  });

  it("streams text + reasoning + usage via Responses SSE vocabulary", async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp-s"}}',
      "",
      'data: {"type":"response.reasoning_text.delta","output_index":0,"delta":"thinking"}',
      "",
      'data: {"type":"response.output_text.delta","output_index":1,"delta":"Hi"}',
      "",
      'data: {"type":"response.completed","response":{"id":"resp-s","status":"completed","usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new OpenAIResponsesProvider();
    const stream = provider.stream("m", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k" });
    const seen: string[] = [];
    for await (const e of stream) seen.push(e.type);
    const final = await stream.result();
    expect(final.text).toBe("Hi");
    expect(final.thinking).toBe("thinking");
    expect(final.responseId).toBe("resp-s");
    expect(seen).toContain("text_delta");
    expect(seen).toContain("thinking_delta");
    expect(seen).toContain("done");
  });

  it("streams tool calls via arguments.done", async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp-t"}}',
      "",
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_s","type":"function_call","call_id":"call_s","name":"get_weather","arguments":""}}',
      "",
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"loc"}',
      "",
      'data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"location\\":\\"Paris\\"}"}',
      "",
      'data: {"type":"response.completed","response":{"id":"resp-t","status":"completed","usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new OpenAIResponsesProvider();
    const stream = provider.stream("m", { messages: [{ role: "user", content: "W?" }] }, { apiKey: "k" });
    const calls: any[] = [];
    for await (const e of stream) {
      if (e.type === "tool_call_complete") calls.push(e.toolCall);
    }
    const final = await stream.result();
    expect(final.finishReason).toBe("tool_calls");
    expect(calls.length).toBe(1);
    expect(calls[0].arguments).toEqual({ location: "Paris" });
    expect(calls[0].id).toBe("fc_s");
    expect(calls[0].callId).toBe("call_s");
  });

  it("surfaces SSE error events instead of resolving empty success", async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp-e"}}',
      "",
      'data: {"type":"error","error":{"message":"Upstream 429s","code":429}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new OpenAIResponsesProvider();
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
    expect(iteratedError ?? resultError).toBeTruthy();
  });
});
