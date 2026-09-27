import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  OpenAIResponsesProvider,
  resolveModel,
  ModelProvider,
  getProvider,
} from "../src/index.ts";
import {
  mapThinkingLevelToOpenAI,
  mapServiceTierToOpenAI,
  applyCacheForOpenAI,
  mapToolChoiceToOpenAI,
  clearEmittedWarnings,
} from "../src/providers.ts";

describe("Canonical OpenAI mappings", () => {
  test("maps thinking levels verbatim incl xhigh (native support), dynamic omits", () => {
    clearEmittedWarnings();
    expect(mapThinkingLevelToOpenAI("low")).toEqual({ effort: "low" });
    expect(mapThinkingLevelToOpenAI("medium")).toEqual({ effort: "medium" });
    expect(mapThinkingLevelToOpenAI("dynamic")).toEqual({});
    expect(mapThinkingLevelToOpenAI(undefined)).toEqual({});
    expect(mapThinkingLevelToOpenAI("none")).toEqual({ effort: "none" });
    // OpenAI documents xhigh natively — no clamp/warn unlike OpenRouter.
    expect(mapThinkingLevelToOpenAI("xhigh")).toEqual({ effort: "xhigh" });
    expect(mapThinkingLevelToOpenAI("minimal")).toEqual({ effort: "minimal" });
    clearEmittedWarnings();
  });

  test("maps service tier (omit = auto)", () => {
    expect(mapServiceTierToOpenAI("flex")).toBe("flex");
    expect(mapServiceTierToOpenAI("priority")).toBe("priority");
    expect(mapServiceTierToOpenAI(undefined)).toBeUndefined();
  });

  test("warns and drops OpenAI cache retention instead of sending it", () => {
    clearEmittedWarnings();
    const messages: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };
    try {
      applyCacheForOpenAI({ retention: "medium" }, "openai/x");
      applyCacheForOpenAI({ cachedContentId: "cachedContents/abc" }, "openai/x");
      applyCacheForOpenAI({ retention: "implicit" }, "openai/x");
      applyCacheForOpenAI(undefined, "openai/x");
      expect(messages.length).toBe(2);
      expect(messages[0]).toMatch(/openai.*cache retention/i);
    } finally {
      console.warn = orig;
      clearEmittedWarnings();
    }
  });

  test("maps tool choice to Responses values (required is native)", () => {
    expect(mapToolChoiceToOpenAI(undefined)).toBeUndefined();
    expect(mapToolChoiceToOpenAI("auto")).toBeUndefined();
    expect(mapToolChoiceToOpenAI("none")).toBe("none");
    expect(mapToolChoiceToOpenAI("required")).toBe("required");
    expect(mapToolChoiceToOpenAI({ type: "function", function: { name: "a" } })).toEqual({
      type: "function",
      name: "a",
    });
  });
});

describe("OpenAI Provider & Responses API Compatibility", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("should register openai as a first-class native provider", () => {
    const p = getProvider("openai");
    expect(p).toBeDefined();
    expect(p.id).toBe("openai");
    expect(p).toBeInstanceOf(OpenAIResponsesProvider);
  });

  test("should resolve openai model with prefix (strips only openai/)", () => {
    const resolved = resolveModel("openai/gpt-4o");
    expect(resolved.provider.id).toBe("openai");
    expect(resolved.modelId).toBe("gpt-4o");
  });

  test("should support ModelProvider.OpenAI helper", () => {
    const inst = ModelProvider.OpenAI("gpt-4o", "test-key", {
      baseUrl: "https://my-proxy.com/v1",
      thinkingLevel: "medium",
    });
    expect(inst.model).toBe("openai/gpt-4o");
    expect(inst.apiKey).toBe("test-key");
    expect(inst.baseUrl).toBe("https://my-proxy.com/v1");
    expect(inst.thinkingLevel).toBe("medium");
  });

  test("should route by changing OPENAI_BASE_URL and OPENAI_BASE_API_KEY (native /responses)", async () => {
    process.env.OPENAI_BASE_URL = "https://custom-proxy.internal/v1";
    process.env.OPENAI_BASE_API_KEY = "sk-custom-secret-key";

    const provider = new OpenAIResponsesProvider();
    let requestedUrl = "";
    let requestedHeaders: Record<string, string> = {};
    let requestedBody: any = null;

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
      requestedUrl = url;
      requestedHeaders = (init.headers as any) || {};
      requestedBody = JSON.parse(init.body as string);

      return new Response(
        JSON.stringify({
          id: "resp-mock-123",
          object: "response",
          created_at: Date.now(),
          model: "gpt-4o",
          status: "completed",
          output: [
            {
              type: "reasoning",
              id: "rs_mock",
              content: [{ type: "reasoning_text", text: "Deep thinking trace here..." }],
              summary: [],
            },
            {
              type: "message",
              id: "msg_mock",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello from custom OpenAI proxy!", annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 25,
            input_tokens_details: { cached_tokens: 10 },
            output_tokens: 15,
            output_tokens_details: { reasoning_tokens: 8 },
            total_tokens: 40,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    try {
      const result = await provider.generate(
        "gpt-4o",
        {
          systemPrompt: "Be concise.",
          messages: [{ role: "user", content: "Test message" }],
        },
        {
          thinking: { enabled: true, level: "medium" },
          sessionId: "test-session-42",
        }
      );

      expect(requestedUrl).toBe("https://custom-proxy.internal/v1/responses");
      expect(requestedHeaders["Authorization"]).toBe("Bearer sk-custom-secret-key");
      expect(requestedBody.model).toBe("gpt-4o");
      expect(requestedBody.instructions).toBe("Be concise.");
      expect(requestedBody.reasoning).toEqual({ effort: "medium" });
      expect(requestedBody.prompt_cache_key).toBe("test-session-42");
      expect(requestedBody.store).toBe(false);
      expect(requestedBody.previous_response_id).toBeUndefined();
      // Stateless array-form history (never bare string).
      expect(Array.isArray(requestedBody.input)).toBe(true);

      expect(result.text).toBe("Hello from custom OpenAI proxy!");
      expect(result.thinking).toBe("Deep thinking trace here...");
      expect(result.usage.inputTokens).toBe(25);
      expect(result.usage.outputTokens).toBe(15);
      expect(result.usage.cachedTokens).toBe(10);
      expect(result.usage.thinkingTokens).toBe(8);
      expect(result.finishReason).toBe("stop");
      expect(result.responseId).toBe("resp-mock-123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("should stream responses via Responses SSE and extract thinking + text deltas", async () => {
    const provider = new OpenAIResponsesProvider();
    const originalFetch = globalThis.fetch;

    const sseChunks = [
      'data: {"type":"response.created","response":{"id":"resp-1"}}\n\n',
      'data: {"type":"response.reasoning_text.delta","output_index":0,"delta":"Thinking step 1..."}\n\n',
      'data: {"type":"response.output_text.delta","output_index":1,"delta":"Hello "}\n\n',
      'data: {"type":"response.output_text.delta","output_index":1,"delta":"world!"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp-1","status":"completed","usage":{"input_tokens":12,"output_tokens":6,"total_tokens":18}}}\n\n',
      "data: [DONE]\n\n",
    ];

    (globalThis as any).fetch = async () => {
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of sseChunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    try {
      const stream = provider.stream(
        "gpt-4o",
        {
          messages: [{ role: "user", content: "Write hello world" }],
        },
        { apiKey: "test-key" }
      );

      const textDeltas: string[] = [];
      const thinkingDeltas: string[] = [];

      for await (const event of stream) {
        if (event.type === "text_delta" && event.delta) {
          textDeltas.push(event.delta);
        } else if (event.type === "thinking_delta" && event.thinkingDelta) {
          thinkingDeltas.push(event.thinkingDelta);
        }
      }

      const finalResponse = await stream.result();
      expect(thinkingDeltas.join("")).toBe("Thinking step 1...");
      expect(textDeltas.join("")).toBe("Hello world!");
      expect(finalResponse.text).toBe("Hello world!");
      expect(finalResponse.thinking).toBe("Thinking step 1...");
      expect(finalResponse.usage.totalTokens).toBe(18);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("should handle tool calls in Responses format correctly", async () => {
    const provider = new OpenAIResponsesProvider();
    const originalFetch = globalThis.fetch;

    (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.tools).toBeDefined();
      expect(body.tools[0].name).toBe("calculator");
      expect(body.tools[0].type).toBe("function");

      return new Response(
        JSON.stringify({
          id: "resp-tool-test",
          status: "completed",
          output: [
            {
              type: "function_call",
              id: "fc_abc123",
              call_id: "call_abc123",
              name: "calculator",
              arguments: '{"expr":"2+2"}',
            },
          ],
          usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const result = await provider.generate(
        "openai/gpt-4o",
        {
          messages: [{ role: "user", content: "Calculate 2+2" }],
        },
        {
          apiKey: "test-key",
          tools: [
            {
              name: "calculator",
              description: "Calculate mathematical expressions",
              parameters: {
                type: "object",
                properties: { expr: { type: "string" } },
                required: ["expr"],
              },
            },
          ],
        }
      );

      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBe(1);
      expect(result.toolCalls![0].name).toBe("calculator");
      expect(result.toolCalls![0].arguments).toEqual({ expr: "2+2" });
      expect(result.finishReason).toBe("tool_calls");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("should accept multimodal inputs (text, image, file) as input_image/input_file", async () => {
    const provider = new OpenAIResponsesProvider();
    const originalFetch = globalThis.fetch;
    let interceptedBody: any = null;

    (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
      interceptedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          id: "resp-multimodal-1",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_mm",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "I analyzed the image and pdf.", annotations: [] }],
            },
          ],
          usage: { input_tokens: 150, output_tokens: 15, total_tokens: 165 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const result = await provider.generate(
        "openai/gpt-4o",
        {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Please analyze all attached media:" },
                {
                  type: "image",
                  image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                },
                {
                  type: "file",
                  file: "data:application/pdf;base64,JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmo=",
                  mimeType: "application/pdf",
                  filename: "doc.pdf",
                },
              ],
            },
          ],
        },
        { apiKey: "test-key" }
      );

      expect(interceptedBody).toBeDefined();
      expect(Array.isArray(interceptedBody.input)).toBe(true);
      const userMsg = interceptedBody.input.find((i: any) => i.type === "message" && i.role === "user");
      expect(userMsg).toBeDefined();
      const types = userMsg.content.map((c: any) => c.type);
      expect(types).toContain("input_text");
      expect(types).toContain("input_image");
      expect(types).toContain("input_file");
      const img = userMsg.content.find((c: any) => c.type === "input_image");
      expect(img.image_url).toContain("data:image/png;base64,");

      expect(result.text).toBe("I analyzed the image and pdf.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("requires an API key instead of failing opaquely", async () => {
    const provider = new OpenAIResponsesProvider();
    const err = await provider
      .generate("gpt-4o", { messages: [{ role: "user", content: "x" }] }, { env: {} })
      .then(() => null)
      .catch((e) => e);
    expect(String(err?.message ?? err)).toMatch(/OPENAI_API_KEY|API key/);
  });
});
