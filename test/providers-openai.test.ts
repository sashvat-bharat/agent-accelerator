import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { OpenAIResponsesProvider } from "../src/providers/openai.ts";
import {
  mapThinkingLevelToOpenAI,
  mapServiceTierToOpenAI,
  mapToolChoiceToOpenAI,
  clearEmittedWarnings,
} from "../src/providers.ts";
import { getProvider, resolveModel } from "../src/providers/registry.ts";
import { parseStreamedToolArguments } from "../src/providers.ts";
import { mockFetchOnce, captureWarnings } from "./helpers.ts";
import { priceUsage } from "../src/session/store.ts";
import { getModelFromCatalog } from "../src/models/catalog.ts";

const ORIGINAL_FETCH = globalThis.fetch;



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

  it("maps cache 12h to prompt_cache_retention 24h and warns+drops other TTLs", async () => {
    clearEmittedWarnings();
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const w = captureWarnings();
    try {
      const provider = new OpenAIResponsesProvider();
      const ctx = { messages: [{ role: "user" as const, content: "Hi" }] };
      await provider.generate("gpt-4o", ctx, { apiKey: "k", cache: "12h" });
      await provider.generate("gpt-4o", ctx, { apiKey: "k", cache: "5m" });
      expect(bodies[0].prompt_cache_retention).toBe("24h");
      expect(bodies[1].prompt_cache_retention).toBeUndefined();
      expect(w.messages.length).toBe(1);
      expect(w.messages[0]).toMatch(/openai.*cache.*"12h"/i);
    } finally {
      w.restore();
      clearEmittedWarnings();
    }
  });

  it("GPT-5.6 and later: 30m / 12h set prompt_cache_options.ttl and never prompt_cache_retention", async () => {
    clearEmittedWarnings();
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const w = captureWarnings();
    try {
      const provider = new OpenAIResponsesProvider();
      const ctx = { messages: [{ role: "user" as const, content: "Hi" }] };
      for (const [model, cache] of [
        ["gpt-6.1-sol", "30m"],
        ["gpt-5.6-terra", "12h"],
        ["gpt-6-luna", "implicit"],
        ["gpt-6.1-sol", "5m"],
        ["gpt-5.5", "30m"],
      ] as const) {
        await provider.generate(model, ctx, { apiKey: "k", cache });
      }
      expect(bodies[0].prompt_cache_options).toEqual({ ttl: "30m" });
      expect(bodies[1].prompt_cache_options).toEqual({ ttl: "12h" });
      expect(bodies[2].prompt_cache_options).toBeUndefined();
      expect(bodies[3].prompt_cache_options).toBeUndefined(); // 5m is unsupported: warned and dropped
      expect(bodies[4].prompt_cache_options).toBeUndefined(); // gpt-5.5 predates the field
      for (const b of bodies) expect(b.prompt_cache_retention).toBeUndefined();
      expect(w.messages.some((m) => /5m \(openai\/gpt-6\.1-sol\)/.test(m))).toBe(true);
      expect(w.messages.some((m) => /30m \(openai\/gpt-5\.5\)/.test(m))).toBe(true); // gpt-5.5 has no 30m
    } finally {
      w.restore();
      clearEmittedWarnings();
    }
  });

  it("reads cache_write_tokens as a subset of input and prices it at the catalog write rate", async () => {
    const reply = {
      ...TEXT_RESPONSE,
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 300, cache_write_tokens: 500 },
        output_tokens: 100,
        total_tokens: 1100,
      },
    };
    (globalThis as any).fetch = async () => new Response(JSON.stringify(reply), { status: 200 });
    const provider = new OpenAIResponsesProvider();
    const res = await provider.generate("gpt-6.1-sol", { messages: [{ role: "user" as const, content: "Hi" }] }, { apiKey: "k" });
    expect(res.usage.cacheReadTokens).toBe(300);
    expect(res.usage.cacheWriteTokens).toBe(500);
    // gpt-6.1-sol: input $2, cache read $0.1, cache write $2.5, output $10 per 1M: 200*2 + 300*0.1 + 500*2.5 + 100*10 micro-USD
    const priced = priceUsage(res.usage, getModelFromCatalog("openai", "gpt-6.1-sol"));
    expect(priced?.breakdown.totalMicroUSD).toBe(400 + 30 + 1250 + 1000);
    // A report that claims more writes than input is clamped, never negative.
    const odd = { ...reply, usage: { ...reply.usage, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 500 } } };
    (globalThis as any).fetch = async () => new Response(JSON.stringify(odd), { status: 200 });
    const res2 = await provider.generate("gpt-6.1-sol", { messages: [{ role: "user" as const, content: "Hi" }] }, { apiKey: "k" });
    expect(res2.usage.cacheWriteTokens).toBe(100);
  });

  it("maps image resolution to input_image.detail (no warning)", async () => {
    clearEmittedWarnings();
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const w = captureWarnings();
    try {
      const provider = new OpenAIResponsesProvider();
      const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      const image = (resolution?: "low" | "medium" | "high" | "ultra_high", image = png) => ({
        type: "image" as const,
        image,
        ...(resolution ? { resolution } : {}),
      });
      const content = [
        { type: "text" as const, text: "look" },
        image("low"),
        image("medium"),
        image("high"),
        image("ultra_high", "https://example.com/a.png"),
        image(),
      ];
      await provider.generate("gpt-5.5", { messages: [{ role: "user" as const, content }] }, { apiKey: "k" });
      const blocks = bodies[0].input[0].content.filter((b: any) => b.type === "input_image");
      expect(blocks.map((b: any) => b.detail)).toEqual(["low", "auto", "high", "original", undefined]);
      expect(blocks[3].image_url).toBe("https://example.com/a.png");
      expect(w.messages.some((m) => /media resolution/i.test(m))).toBe(false);
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

describe("OpenAI reasoning replay (current tool loop)", () => {
  const REASONING = {
    type: "reasoning",
    id: "rs_abc",
    summary: [],
    encrypted_content: "ENC123==",
    status: "completed",
  };
  const CALL = { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' };
  const OUTPUT = [REASONING, CALL];
  const toolReply = {
    ...TEXT_RESPONSE,
    id: "resp-r1",
    output: OUTPUT,
  };
  const user = (content: string) => ({ role: "user" as const, content });
  const assistant = (steps?: unknown[]) => ({
    role: "assistant" as const,
    content: [{ type: "tool_call" as const, id: "fc_1", name: "get_weather", arguments: { city: "Paris" }, callId: "call_1" }],
    ...(steps ? { providerSteps: { provider: "openai", steps } } : {}),
  });
  const toolResult = {
    role: "tool" as const,
    name: "get_weather",
    content: [{ type: "tool_result" as const, id: "fc_1", name: "get_weather", result: "sunny" }],
  };
  const capture = (): any[] => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_u: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    return bodies;
  };

  it("asks for encrypted reasoning only on catalog reasoning models", async () => {
    const bodies = capture();
    const provider = new OpenAIResponsesProvider();
    await provider.generate("gpt-5.5", { messages: [user("Hi")] }, { apiKey: "k" });
    await provider.generate("gpt-4o", { messages: [user("Hi")] }, { apiKey: "k" });
    expect(bodies[0].include).toEqual(["reasoning.encrypted_content"]);
    expect(bodies[1].include).toBeUndefined();
  });

  it("keeps a turn's reasoning, call and message items exactly as received", async () => {
    (globalThis as any).fetch = async () => new Response(JSON.stringify(toolReply), { status: 200 });
    const res = await new OpenAIResponsesProvider().generate("gpt-5.5", { messages: [user("Hi")] }, { apiKey: "k" });
    expect(res.providerSteps).toEqual({ provider: "openai", steps: OUTPUT });
    // A turn without reasoning keeps nothing: it is rebuilt from text and calls as before.
    (globalThis as any).fetch = async () => new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    const plain = await new OpenAIResponsesProvider().generate("gpt-5.5", { messages: [user("Hi")] }, { apiKey: "k" });
    expect(plain.providerSteps).toBeUndefined();
  });

  it("replays the stored items of the current loop and pairs the result with the same call id", async () => {
    const bodies = capture();
    await new OpenAIResponsesProvider().generate(
      "gpt-5.5",
      { messages: [user("Weather?"), assistant([REASONING, CALL]), toolResult] },
      { apiKey: "k" }
    );
    const input = bodies[0].input;
    expect(input.map((i: any) => i.type)).toEqual(["message", "reasoning", "function_call", "function_call_output"]);
    expect(input[1]).toEqual(REASONING); // byte for byte, encrypted content included
    expect(input[2].call_id).toBe("call_1");
    expect(input[3].call_id).toBe("call_1");
    expect(input.filter((i: any) => i.type === "function_call").length).toBe(1); // not rebuilt a second time
  });

  it("does not replay the reasoning of a finished turn", async () => {
    const bodies = capture();
    const finished = { role: "assistant" as const, content: "It is sunny.", providerSteps: { provider: "openai", steps: [REASONING] } };
    await new OpenAIResponsesProvider().generate(
      "gpt-5.5",
      { messages: [user("Weather?"), assistant([REASONING, CALL]), toolResult, finished, user("And tomorrow?")] },
      { apiKey: "k" }
    );
    expect(bodies[0].input.some((i: any) => i.type === "reasoning")).toBe(false);
    expect(bodies[0].input.filter((i: any) => i.type === "function_call").length).toBe(1); // rebuilt from the stored call
  });

  it("ignores steps stored by another provider and rebuilds the call", async () => {
    const bodies = capture();
    const foreign = { ...assistant(), providerSteps: { provider: "google", steps: [{ type: "thought" }] } };
    await new OpenAIResponsesProvider().generate(
      "gpt-5.5",
      { messages: [user("Weather?"), foreign, toolResult] },
      { apiKey: "k" }
    );
    expect(bodies[0].input.map((i: any) => i.type)).toEqual(["message", "function_call", "function_call_output"]);
  });

  it("keeps nothing when a tool call arrived cut off (it is replayed as {} and never verbatim)", async () => {
    const cut = { ...toolReply, output: [REASONING, { ...CALL, arguments: '{"city":"Pa' }] };
    (globalThis as any).fetch = async () => new Response(JSON.stringify(cut), { status: 200 });
    const res = await new OpenAIResponsesProvider().generate("gpt-5.5", { messages: [user("Hi")] }, { apiKey: "k" });
    expect(res.providerSteps).toBeUndefined();
  });

  it("a streamed turn keeps the completed output items too", async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp-s"}}',
      "",
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { ...CALL, arguments: "" } })}`,
      "",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, arguments: CALL.arguments })}`,
      "",
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp-s", status: "completed", output: OUTPUT, usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async () =>
      new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const stream = new OpenAIResponsesProvider().stream("gpt-5.5", { messages: [user("Hi")] }, { apiKey: "k" });
    for await (const _ of stream) {
      // drained
    }
    expect((await stream.result()).providerSteps).toEqual({ provider: "openai", steps: OUTPUT });
  });
});

describe("OpenAI reasoning replay through the Agent loop", () => {
  it("the second request of a tool loop carries the first turn's reasoning item, and the saved session keeps it", async () => {
    const { Agent } = await import("../src/agent/agent.ts");
    const { tool } = await import("../src/tools/tool.ts");
    const bodies: any[] = [];
    const reasoning = { type: "reasoning", id: "rs_9", summary: [], encrypted_content: "ENC==" };
    const call = { type: "function_call", id: "fc_9", call_id: "call_9", name: "ping", arguments: "{}" };
    const replies = [
      { ...TEXT_RESPONSE, id: "r1", output: [reasoning, call] },
      TEXT_RESPONSE,
    ];
    const agent = new Agent({
      model: "openai/gpt-5.5",
      apiKey: "k",
      runRetries: 0,
      tools: { ping: tool({ description: "ping", input: {}, execute: async () => "pong" }) },
      fetch: (async (_u: unknown, req: any) => {
        bodies.push(JSON.parse(req.body));
        return new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await agent.run("Ping it");
    expect(bodies.length).toBe(2);
    expect(bodies[1].input.map((i: any) => i.type)).toEqual(["message", "reasoning", "function_call", "function_call_output"]);
    expect(bodies[1].input[1]).toEqual(reasoning);
    const saved = JSON.parse(JSON.stringify(agent.exportSession()));
    const withSteps = saved.messages.find((m: any) => m.providerSteps);
    expect(withSteps.providerSteps.steps[0]).toEqual(reasoning);
  });
});

describe("OpenAI streaming vocabulary (audit)", () => {
  const sse = (...events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  const serve = (body: string): void => {
    (globalThis as any).fetch = async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const run = async (body: string) => {
    serve(body);
    const stream = new OpenAIResponsesProvider().stream("gpt-5.5", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k" });
    const events: any[] = [];
    for await (const e of stream) events.push(e);
    return { events, result: await stream.result() };
  };
  const usage = { input_tokens: 12, output_tokens: 34, total_tokens: 46 };
  const text = { type: "response.output_text.delta", delta: "Partial answer" };

  it("response.incomplete ends the stream: usage kept, finish reason length", async () => {
    const { result } = await run(
      sse(
        { type: "response.created", response: { id: "r1" } },
        text,
        { type: "response.incomplete", response: { id: "r1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage } }
      )
    );
    expect(result.text).toBe("Partial answer");
    expect(result.finishReason).toBe("length");
    expect(result.usage.outputTokens).toBe(34);
  });

  it("response.incomplete with content_filter is a refusal", async () => {
    const { result } = await run(
      sse(text, { type: "response.incomplete", response: { id: "r2", status: "incomplete", incomplete_details: { reason: "content_filter" }, usage } })
    );
    expect(result.finishReason).toBe("refusal");
  });

  it("streams reasoning summary deltas, with a paragraph break between summary parts", async () => {
    const { events, result } = await run(
      sse(
        { type: "response.reasoning_summary_part.added", summary_index: 0 },
        { type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "First idea." },
        { type: "response.reasoning_summary_part.added", summary_index: 1 },
        { type: "response.reasoning_summary_text.delta", summary_index: 1, delta: "Second idea." },
        text,
        {
          type: "response.completed",
          response: {
            id: "r3",
            status: "completed",
            output: [{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "First idea." }, { type: "summary_text", text: "Second idea." }] }],
            usage,
          },
        }
      )
    );
    expect(events.filter((e) => e.type === "thinking_delta").map((e) => e.thinkingDelta).join("")).toBe("First idea.\n\nSecond idea.");
    expect(result.thinking).toBe("First idea.\n\nSecond idea."); // the completed item adds nothing twice
  });

  it("reads summary_text objects of a non-streaming reasoning item", async () => {
    const reply = {
      ...TEXT_RESPONSE,
      output: [
        { type: "reasoning", id: "rs_2", summary: [{ type: "summary_text", text: "Checked the units." }] },
        ...TEXT_RESPONSE.output,
      ],
    };
    (globalThis as any).fetch = async () => new Response(JSON.stringify(reply), { status: 200 });
    const res = await new OpenAIResponsesProvider().generate("gpt-5.5", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k" });
    expect(res.thinking).toBe("Checked the units.");
  });

  it("marks server_error and rate_limit_exceeded as retryable, other error codes not", async () => {
    const failure = async (code: string, shape: "failed" | "error") => {
      serve(
        sse(
          shape === "failed"
            ? { type: "response.failed", response: { id: "r", status: "failed", error: { code, message: "boom" } } }
            : { type: "error", code, message: "boom" }
        )
      );
      const stream = new OpenAIResponsesProvider().stream("gpt-5.5", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k" });
      try {
        for await (const _ of stream) {
          // drained
        }
        await stream.result();
      } catch (e: any) {
        return e;
      }
      throw new Error("expected a failure");
    };
    expect((await failure("server_error", "failed")).retryable).toBe(true);
    expect((await failure("rate_limit_exceeded", "error")).retryable).toBe(true);
    expect((await failure("invalid_prompt", "failed")).retryable).toBe(false);
    // The non-streaming path classifies the same way.
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ ...TEXT_RESPONSE, status: "failed", error: { code: "server_error", message: "boom" } }), { status: 200 });
    const err: any = await new OpenAIResponsesProvider()
      .generate("gpt-5.5", { messages: [{ role: "user", content: "Hi" }] }, { apiKey: "k", maxRetries: 0 })
      .catch((e) => e);
    expect(err.retryable).toBe(true);
  });
});

describe("OpenAI tool-call ids from any provider (audit)", () => {
  it("pairs every result with its call, keeps ids within 64 characters and distinct", async () => {
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_u: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const long1 = `call_${"a".repeat(80)}1`;
    const long2 = `call_${"a".repeat(80)}2`; // same first 64 characters as long1
    const ids = [
      { id: "call_abc123" }, // Google-style, no callId
      { id: "fc_x|call_y" }, // pipe id from another adapter
      { id: "toolu_01Ab-Cd" }, // Anthropic
      { id: long1 },
      { id: long2 },
      { id: "weird id!.with*chars" },
    ];
    const assistant = {
      role: "assistant" as const,
      content: ids.map((c) => ({ type: "tool_call" as const, id: c.id, name: "t", arguments: {} })),
    };
    const results = {
      role: "tool" as const,
      name: "t",
      content: ids.map((c) => ({ type: "tool_result" as const, id: c.id, name: "t", result: "ok" })),
    };
    await new OpenAIResponsesProvider().generate(
      "gpt-5.5",
      { messages: [{ role: "user", content: "Go" }, assistant, results] },
      { apiKey: "k" }
    );
    const input = bodies[0].input;
    const calls = input.filter((i: any) => i.type === "function_call");
    const outs = input.filter((i: any) => i.type === "function_call_output");
    expect(calls.length).toBe(6);
    expect(outs.map((o: any) => o.call_id)).toEqual(calls.map((c: any) => c.call_id));
    expect(new Set(calls.map((c: any) => c.call_id)).size).toBe(6);
    expect(new Set(calls.map((c: any) => c.id)).size).toBe(6);
    for (const i of [...calls.map((c: any) => c.call_id), ...calls.map((c: any) => c.id)]) {
      expect(i.length).toBeLessThanOrEqual(64);
      expect(i).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    for (const c of calls) expect(c.id.startsWith("fc_")).toBe(true);
  });
});
