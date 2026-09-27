import { describe, it, expect, afterEach } from "bun:test";
import {
  OpenAICompatibleChatProvider,
  OpenAICompatibleProvider,
  CustomProvider,
  createOpenAICompatibleProvider,
  createCustomProvider,
  ensureCustomProvider,
  resolveModel,
  getProvider,
} from "../src/index.ts";

const ORIGINAL_FETCH = globalThis.fetch;

const TEXT_RESPONSE = {
  id: "chatcmpl-test123",
  object: "chat.completion",
  created: 1750000000,
  model: "llama-3.3-70b-versatile",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello there" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
};

function mockJson(body: unknown, status = 200) {
  (globalThis as any).fetch = async () => {
    return new Response(JSON.stringify(body), { status });
  };
}

describe("OpenAICompatibleChatProvider (native REST, mocked)", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("is registered for custom prefixes with scoped model ids preserved", () => {
    const r = resolveModel("groq/llama-3.3-70b-versatile");
    expect(r.provider.id).toBe("groq");
    expect(r.modelId).toBe("llama-3.3-70b-versatile");
    expect(r.provider).toBeInstanceOf(OpenAICompatibleChatProvider);
    expect(r.provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(getProvider("groq")).toBe(r.provider);
  });

  it("generates text with a strict-subset body (no reasoning/tier/session extras)", async () => {
    let sentBody: any = null;
    let sentHeaders: any = null;
    let sentUrl = "";
    (globalThis as any).fetch = async (url: unknown, req: any) => {
      sentUrl = String(url);
      sentBody = JSON.parse(req.body);
      sentHeaders = req.headers;
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const provider = new OpenAICompatibleChatProvider("groq", {
      baseUrl: "https://api.groq.com/openai/v1",
    });
    const res = await provider.generate(
      "llama-3.3-70b-versatile",
      { systemPrompt: "Be concise.", messages: [{ role: "user", content: "Hi" }] },
      { apiKey: "k", sessionId: "s-groq", thinking: { enabled: true, level: "low" }, serviceTier: "priority", cache: { retention: "long" } }
    );
    expect(res.text).toBe("Hello there");
    expect(res.responseId).toBe("chatcmpl-test123");
    expect(res.provider).toBe("groq");
    expect(res.model).toBe("llama-3.3-70b-versatile");
    expect(res.usage.inputTokens).toBe(20);
    expect(res.finishReason).toBe("stop");
    expect(sentUrl).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(sentBody.model).toBe("llama-3.3-70b-versatile");
    expect(sentBody.messages[0]).toEqual({ role: "system", content: "Be concise." });
    expect(sentBody.reasoning).toBeUndefined();
    expect(sentBody.service_tier).toBeUndefined();
    expect(sentBody.session_id).toBeUndefined();
    expect(sentBody.prompt_cache_key).toBeUndefined();
    expect(sentHeaders["Authorization"]).toBe("Bearer k");
    expect(sentHeaders["x-session-id"]).toBe("s-groq");
  });

  it("parses tool calls and tolerates reasoning fields into thinking", async () => {
    mockJson({
      id: "c-tools",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            reasoning: "let me check",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
    });
    const provider = new OpenAICompatibleChatProvider("groq", {
      baseUrl: "https://api.groq.com/openai/v1",
    });
    const res = await provider.generate(
      "m",
      { messages: [{ role: "user", content: "Weather?" }] },
      { apiKey: "k" }
    );
    expect(res.finishReason).toBe("tool_calls");
    expect(res.toolCalls?.length).toBe(1);
    expect(res.toolCalls?.[0]?.name).toBe("get_weather");
    expect(res.toolCalls?.[0]?.arguments).toEqual({ city: "Paris" });
    expect(res.thinking).toBe("let me check");
  });

  it("captures Gemini thought signatures and echoes them on the next turn", async () => {
    const SIG = "c2lnbmF0dXJl";
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      const second = bodies.length > 1;
      return new Response(
        JSON.stringify(
          second
            ? TEXT_RESPONSE
            : {
                id: "c-sig",
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call_1",
                          type: "function",
                          function: { name: "t", arguments: "{}" },
                          extra_content: { google: { thought_signature: SIG } },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
              }
        ),
        { status: 200 }
      );
    };
    const provider = new OpenAICompatibleChatProvider("compat", {
      baseUrl: "https://compat.example/v1",
    });
    const turn1 = await provider.generate(
      "m",
      { messages: [{ role: "user", content: "hi" }] },
      { apiKey: "k" }
    );
    expect(turn1.toolCalls?.[0]?.thoughtSignature).toBe(SIG);

    await provider.generate(
      "m",
      {
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [{ type: "tool_call", id: "call_1", name: "t", arguments: {}, thoughtSignature: SIG } as any],
          },
          { role: "tool", content: [{ type: "tool_result", id: "call_1", name: "t", result: "ok" }] } as any,
        ],
      },
      { apiKey: "k" }
    );
    const asst = bodies[1].messages.find((m: any) => m.role === "assistant");
    expect(asst.tool_calls[0].extra_content?.google?.thought_signature).toBe(SIG);
  });

  it("fails fast without a key on cloud endpoints, allows local ones keyless", async () => {
    const provider = new OpenAICompatibleChatProvider("groq", {
      baseUrl: "https://api.groq.com/openai/v1",
    });
    const err = await provider
      .generate("m", { messages: [{ role: "user", content: "hi" }] }, {})
      .then(() => null)
      .catch((e) => e);
    expect(String(err?.message ?? err)).toMatch(/Missing API key for "groq".*GROQ_API_KEY/);

    let sentHeaders: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentHeaders = req.headers;
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const local = new OpenAICompatibleChatProvider("ollama", { baseUrl: "http://localhost:11434/v1" });
    const res = await local.generate("qwen2.5-coder", { messages: [{ role: "user", content: "hi" }] }, {});
    expect(res.text).toBe("Hello there");
    expect(sentHeaders["Authorization"]).toBeUndefined();
  });

  it("warns and drops thinking levels instead of sending them", async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    let sentBody: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentBody = JSON.parse(req.body);
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    try {
      const provider = new OpenAICompatibleChatProvider("groq");
      await provider.generate(
        "m",
        { messages: [{ role: "user", content: "hi" }] },
        { apiKey: "k", thinking: { enabled: true, level: "high" } }
      );
      expect(sentBody.reasoning).toBeUndefined();
      expect(sentBody.reasoning_effort).toBeUndefined();
      expect(warnings.some((w) => w.includes("thinking level"))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  it("streams text + tool calls with usage and done", async () => {
    const chunks = [
      'data: {"id":"s1","choices":[{"delta":{"role":"assistant","content":"Hi"}}]}\n\n',
      'data: {"id":"s1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"t","arguments":"{\\"a\\":1}"}}]}}]}\n\n',
      'data: {"id":"s1","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4,"total_tokens":11}}\n\n',
      "data: [DONE]\n\n",
    ];
    (globalThis as any).fetch = async () => {
      const stream = new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new OpenAICompatibleChatProvider("groq", {
      baseUrl: "https://api.groq.com/openai/v1",
    });
    const s = provider.stream("m", { messages: [{ role: "user", content: "hi" }] }, { apiKey: "k" });
    const texts: string[] = [];
    for await (const e of s) {
      if (e.type === "text_delta" && e.delta) texts.push(e.delta);
    }
    const final = await s.result();
    expect(texts.join("")).toBe("Hi");
    expect(final.toolCalls?.length).toBe(1);
    expect(final.toolCalls?.[0]?.arguments).toEqual({ a: 1 });
    expect(final.finishReason).toBe("tool_calls");
    expect(final.usage.inputTokens).toBe(7);
  });

  it("surfaces HTTP errors concisely", async () => {
    mockJson({ error: { message: "model not found", code: "model_not_found" } }, 404);
    const provider = new OpenAICompatibleChatProvider("groq", {
      baseUrl: "https://api.groq.com/openai/v1",
    });
    const err = await provider
      .generate("nope", { messages: [{ role: "user", content: "hi" }] }, { apiKey: "k" })
      .then(() => null)
      .catch((e) => e);
    expect(err.name).toBe("AgentAccelProviderError");
    expect(String(err.message)).toContain("[groq/nope] request failed (404): model not found");
  });

  it("aliases and factory helpers resolve to the native class", () => {
    expect(createOpenAICompatibleProvider("groq")).toBeInstanceOf(OpenAICompatibleChatProvider);
    expect(createCustomProvider("groq")).toBeInstanceOf(OpenAICompatibleChatProvider);
    expect(CustomProvider).toBe(OpenAICompatibleChatProvider);
    expect(ensureCustomProvider("groq")).toBe(getProvider("groq"));
  });
});
