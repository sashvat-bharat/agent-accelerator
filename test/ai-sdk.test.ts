import { describe, it, expect } from "bun:test";
import {
  getProvider,
  resolveModel,
  GoogleAIStudioProvider,
  OpenAIProvider,
  OpenAICompatibleProvider,
  OpenCodeProvider,
  OpenRouterProvider,
  tool,
  z,
} from "../src/index.ts";
import {
  getAiSdkProvider,
  getAiSdkModel,
  toAiSdkTools,
  toAiSdkPrompt,
  executeAiSdkGenerate,
  executeAiSdkStream,
} from "../src/ai-sdk/index.ts";

describe("Vercel AI SDK Layer beneath Agent Accelerator", () => {
  it("should create Vercel AI SDK models for Google, OpenAI, OpenCode, OpenRouter, and Custom providers", () => {
    const googleModel = getAiSdkModel("google", "gemini-3.5-flash-lite", { apiKey: "test-google-key" });
    expect(googleModel).toBeDefined();
    expect(googleModel.modelId).toBe("gemini-3.5-flash-lite");

    const openaiModel = getAiSdkModel("openai", "gpt-4o", { apiKey: "test-openai-key" });
    expect(openaiModel).toBeDefined();
    expect(openaiModel.modelId).toBe("gpt-4o");

    const opencodeModel = getAiSdkModel("opencode", "gpt-5.4", { apiKey: "test-opencode-key" });
    expect(opencodeModel).toBeDefined();
    expect(opencodeModel.modelId).toBe("gpt-5.4");

    const openrouterModel = getAiSdkModel("openrouter", "anthropic/claude-3.7-sonnet", { apiKey: "test-or-key" });
    expect(openrouterModel).toBeDefined();
    expect(openrouterModel.modelId).toBe("anthropic/claude-3.7-sonnet");

    const groqModel = getAiSdkModel("groq", "llama-3.3-70b-versatile", { apiKey: "gsk_test" });
    expect(groqModel).toBeDefined();
    expect(groqModel.modelId).toBe("llama-3.3-70b-versatile");
  });

  it("should expose toAiSdkModel() on all Agent Accelerator providers", () => {
    const google = getProvider("google") as GoogleAIStudioProvider;
    const openai = getProvider("openai") as OpenAIProvider;
    const opencode = getProvider("opencode") as OpenCodeProvider;
    const openrouter = getProvider("openrouter") as OpenRouterProvider;
    const custom = getProvider("groq") as OpenAICompatibleProvider;

    expect(typeof google.toAiSdkModel).toBe("function");
    expect(typeof openai.toAiSdkModel).toBe("function");
    expect(typeof opencode.toAiSdkModel).toBe("function");
    expect(typeof openrouter.toAiSdkModel).toBe("function");
    expect(typeof custom.toAiSdkModel).toBe("function");

    const gModel = google.toAiSdkModel("gemini-3.7-flash", { apiKey: "test-key" });
    expect(gModel.modelId).toBe("gemini-3.7-flash");

    const oModel = openai.toAiSdkModel("gpt-4o-mini", { apiKey: "test-key" });
    expect(oModel.modelId).toBe("gpt-4o-mini");

    const cModel = custom.toAiSdkModel("llama-3.3-70b", { apiKey: "test-key" });
    expect(cModel.modelId).toBe("llama-3.3-70b");
  });

  it("should convert Agent Accelerator tools to Vercel AI SDK function tools with inputSchema", () => {
    const testTool = tool({
      description: "Calculates expressions",
      input: z.object({ expr: z.string() }),
      execute: async ({ expr }) => expr,
    });

    const aiTools = toAiSdkTools([
      {
        name: "calc",
        description: testTool.description,
        parameters: testTool.parameters,
      },
    ]);

    expect(aiTools).toBeDefined();
    expect(aiTools!.length).toBe(1);
    expect(aiTools![0].type).toBe("function");
    expect(aiTools![0].name).toBe("calc");
    expect(aiTools![0].description).toBe("Calculates expressions");
    expect(aiTools![0].inputSchema).toBeDefined();
    expect((aiTools![0].inputSchema as any).type).toBe("object");
  });

  it("should convert ProviderContext to LanguageModelV4Prompt", async () => {
    const prompt = await toAiSdkPrompt({
      systemPrompt: "You are a helpful assistant",
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check" },
            { type: "thinking", thinking: "Internal thought trace" },
            {
              type: "tool_call",
              id: "c1",
              name: "check_db",
              arguments: { table: "users" },
              thoughtSignature: "SIG_TEST==",
            },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", id: "c1", name: "check_db", result: { count: 42 } }],
        },
      ],
    });

    expect(prompt.length).toBe(4);
    expect(prompt[0].role).toBe("system");
    expect(prompt[0].content).toBe("You are a helpful assistant");

    expect(prompt[1].role).toBe("user");
    expect((prompt[1].content as any)[0].text).toBe("Hello");

    expect(prompt[2].role).toBe("assistant");
    const assistantParts = prompt[2].content as any[];
    expect(assistantParts.some((p) => p.type === "text")).toBe(true);
    expect(assistantParts.some((p) => p.type === "reasoning")).toBe(true);
    const toolCallPart = assistantParts.find((p) => p.type === "tool-call");
    expect(toolCallPart).toBeDefined();
    expect(toolCallPart.toolName).toBe("check_db");
    expect(toolCallPart.providerMetadata?.google?.thoughtSignature).toBe("SIG_TEST==");

    expect(prompt[3].role).toBe("tool");
    const toolParts = prompt[3].content as any[];
    expect(toolParts[0].type).toBe("tool-result");
    expect(toolParts[0].toolCallId).toBe("c1");
  });

  it("should execute generate via Vercel AI SDK LanguageModelV4 and return Agent Accelerator result", async () => {
    const mockModel: any = {
      specificationVersion: "v4",
      modelId: "mock-model",
      async doGenerate() {
        return {
          content: [
            { type: "reasoning", text: "Thinking about the user request..." },
            { type: "text", text: "Here is the response from AI SDK layer." },
          ],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 20, noCache: 20, cacheRead: 5 },
            outputTokens: { total: 10, text: 6, reasoning: 4 },
          },
          response: {
            id: "resp_123",
            body: { choices: [{ message: { content: "Here is the response from AI SDK layer." } }] },
          },
          request: {
            url: "https://mock.api/v1/chat/completions",
            method: "POST",
          },
        };
      },
    };

    const res = await executeAiSdkGenerate(
      mockModel,
      "custom",
      "mock-model",
      { messages: [{ role: "user", content: "hi" }] }
    );

    expect(res.text).toBe("Here is the response from AI SDK layer.");
    expect(res.thinking).toBe("Thinking about the user request...");
    expect(res.usage.inputTokens).toBe(20);
    expect(res.usage.outputTokens).toBe(10);
    expect(res.usage.cachedTokens).toBe(5);
    expect(res.usage.thinkingTokens).toBe(4);
    expect(res.responseId).toBe("resp_123");
  });

  it("should stream events via Vercel AI SDK LanguageModelV4 through AssistantMessageEventStream", async () => {
    const mockModel: any = {
      specificationVersion: "v4",
      modelId: "mock-model",
      async doStream() {
        const chunks = [
          { type: "response-metadata", id: "stream_resp_456" },
          { type: "reasoning-delta", delta: "Step 1 reasoning" },
          { type: "text-delta", delta: "Hello " },
          { type: "text-delta", delta: "world!" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 15, noCache: 15, cacheRead: 0 },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
          },
        ];

        return {
          stream: new ReadableStream({
            start(c) {
              for (const ch of chunks) c.enqueue(ch);
              c.close();
            },
          }),
          request: { url: "https://mock.api/v1/chat/completions" },
          response: { id: "stream_resp_456" },
        };
      },
    };

    const stream = executeAiSdkStream(
      mockModel,
      "custom",
      "mock-model",
      { messages: [{ role: "user", content: "hi" }] }
    );

    const texts: string[] = [];
    const thinkings: string[] = [];

    for await (const event of stream) {
      if (event.type === "text_delta" && event.delta) texts.push(event.delta);
      if (event.type === "thinking_delta" && event.thinkingDelta) thinkings.push(event.thinkingDelta);
    }

    const finalRes = await stream.result();
    expect(thinkings.join("")).toBe("Step 1 reasoning");
    expect(texts.join("")).toBe("Hello world!");
    expect(finalRes.text).toBe("Hello world!");
    expect(finalRes.thinking).toBe("Step 1 reasoning");
    expect(finalRes.usage.totalTokens).toBe(20);
    expect(finalRes.responseId).toBe("stream_resp_456");
  });

  it("should never leak Vercel AI SDK exports to the public index.ts API", () => {
    const publicExports = require("../src/index.ts");
    expect(publicExports.createGoogleGenerativeAI).toBeUndefined();
    expect(publicExports.createOpenAI).toBeUndefined();
    expect(publicExports.createOpenAICompatible).toBeUndefined();
    expect(publicExports.generateText).toBeUndefined();
    expect(publicExports.streamText).toBeUndefined();
    expect(publicExports.LanguageModelV4).toBeUndefined();
    expect(publicExports.LanguageModelV1).toBeUndefined();
  });
});
