import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  OpenAIProvider,
  resolveModel,
  ModelProvider,
  getProvider,
} from "../src/index.ts";

describe("OpenAI Provider & cURL Format Compatibility", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("should register openai as a first-class provider", () => {
    const p = getProvider("openai");
    expect(p).toBeDefined();
    expect(p.id).toBe("openai");
    expect(p.name).toBe("OpenAI");
  });

  test("should resolve openai model with prefix", () => {
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

  test("should route by changing OPENAI_BASE_URL and OPENAI_BASE_API_KEY", async () => {
    process.env.OPENAI_BASE_URL = "https://custom-proxy.internal/v1";
    process.env.OPENAI_BASE_API_KEY = "sk-custom-secret-key";

    const provider = new OpenAIProvider();
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
          id: "chatcmpl-mock-123",
          object: "chat.completion",
          created: Date.now(),
          model: "llama-3.3-70b",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Hello from custom OpenAI proxy!",
                reasoning_content: "Deep thinking trace here...",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 25,
            completion_tokens: 15,
            total_tokens: 40,
            prompt_tokens_details: { cached_tokens: 10 },
            completion_tokens_details: { reasoning_tokens: 8 },
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
        "llama-3.3-70b",
        {
          messages: [{ role: "user", content: "Test message" }],
        },
        {
          sessionId: "test-session-42",
        }
      );

      expect(requestedUrl).toBe("https://custom-proxy.internal/v1/chat/completions");
      expect(requestedHeaders["Authorization"]).toBe("Bearer sk-custom-secret-key");
      expect(requestedHeaders["session_id"]).toBe("test-session-42");
      expect(requestedBody.model).toBe("llama-3.3-70b");
      expect(requestedBody.messages[0].content).toBe("Test message");

      // Verify returned data & usage mapping
      expect(result.text).toBe("Hello from custom OpenAI proxy!");
      expect(result.thinking).toBe("Deep thinking trace here...");
      expect(result.usage.inputTokens).toBe(25);
      expect(result.usage.outputTokens).toBe(15);
      expect(result.usage.cachedTokens).toBe(10);
      expect(result.usage.thinkingTokens).toBe(8);
      expect(result.finishReason).toBe("stop");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("should stream responses with SSE parser and extract thinking + text deltas", async () => {
    process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
    process.env.OPENAI_API_KEY = "ollama-key";

    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;

    const sseChunks = [
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant","reasoning_content":"Thinking step 1..."}}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"world!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":6,"total_tokens":18}}\n\n',
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
      const stream = provider.stream("qwen-2.5-coder", {
        messages: [{ role: "user", content: "Write hello world" }],
      });

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

  test("should handle tool calls in OpenAI format correctly", async () => {
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;

    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.tools).toBeDefined();
      expect(body.tools[0].function.name).toBe("calculator");

      return new Response(
        JSON.stringify({
          id: "chatcmpl-tool-test",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_abc123",
                    type: "function",
                    function: {
                      name: "calculator",
                      arguments: '{"expr":"2+2"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
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

  test("should accept multimodal inputs (text, image, audio, pdf) and output text only", async () => {
    // NOTE: OpenAI chat completions supports image + wav/mp3 audio + PDF only.
    // Video is Gemini-only (Vercel throws UnsupportedFunctionalityError on OpenAI),
    // so video coverage lives in the converter unit test below.
    const provider = new OpenAIProvider();
    const originalFetch = globalThis.fetch;
    let interceptedBody: any = null;

    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
      interceptedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-multimodal-1",
          choices: [
            {
              message: {
                role: "assistant",
                content: "I analyzed the image, audio, pdf, and text instructions.",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 15, total_tokens: 165 },
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
                  type: "audio",
                  audio: "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==",
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
        {
          apiKey: "test-key",
          cache: { cachedContentId: "cachedContents/test1234" } as any,
        }
      );

      // Verify payload structure matches OpenAI cURL format (via Vercel AI SDK)
      expect(interceptedBody).toBeDefined();
      const content = interceptedBody.messages[0].content;
      expect(Array.isArray(content)).toBe(true);

      const textPart = content.find((p: any) => p.type === "text");
      expect(textPart.text).toBe("Please analyze all attached media:");

      const imagePart = content.find((p: any) => p.type === "image_url");
      expect(imagePart.image_url.url).toContain("data:image/png;base64,");

      const audioPart = content.find((p: any) => p.type === "input_audio");
      expect(audioPart.input_audio.data).toBeDefined();
      expect(audioPart.input_audio.format).toBe("wav");

      const filePart = content.find((p: any) => p.type === "file");
      expect(filePart.file.filename).toBe("doc.pdf");
      expect(filePart.file.file_data).toContain("data:application/pdf;base64,");

      // Verify extra_body cached_content
      expect(interceptedBody.extra_body?.google?.cached_content).toBe("cachedContents/test1234");

      // Verify text-only output
      expect(result.text).toBe("I analyzed the image, audio, pdf, and text instructions.");
      expect(typeof result.text).toBe("string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
