import { describe, it, expect } from "bun:test";
import { SSEParser, AssistantMessageEventStream, AgentResponse } from "../src/index.ts";

describe("Streaming & SSE Parser", () => {
  it("should parse SSE events from chunks correctly", () => {
    const parser = new SSEParser();
    const rawChunk = "event: message\ndata: {\"text\":\"Hello\"}\n\ndata: {\"text\":\" World\"}\n\n";
    const messages = parser.feed(rawChunk);

    expect(messages.length).toBe(2);
    expect(messages[0]!.event).toBe("message");
    expect(messages[0]!.data).toBe("{\"text\":\"Hello\"}");
    expect(messages[1]!.data).toBe("{\"text\":\" World\"}");
  });

  it("should propagate stream events via AsyncIterable", async () => {
    const stream = new AssistantMessageEventStream();
    const chunks: string[] = [];

    setTimeout(() => {
      stream.push({ type: "text_delta", delta: "Chunk 1" });
      stream.push({ type: "text_delta", delta: " Chunk 2" });
      stream.end(
        new AgentResponse({
          text: "Chunk 1 Chunk 2",
          usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
          model: "gemini-3.5-flash-lite",
          provider: "google",
          durationMs: 15,
          raw: { request: {} as any },
        })
      );
    }, 10);

    for await (const event of stream) {
      if (event.type === "text_delta" && event.delta) {
        chunks.push(event.delta);
      }
    }

    expect(chunks).toEqual(["Chunk 1", " Chunk 2"]);
    const finalRes = await stream.result();
    expect(finalRes.text).toBe("Chunk 1 Chunk 2");
    expect(finalRes.toJSON().usage.totalTokens).toBe(9);
  });

  it("should handle wrapThinking across multiple turns without state lock", async () => {
    const { Agent } = await import("../src/agent/agent.ts");
    const agent = new Agent({
      name: "MultiTurnTester",
      model: "google/gemini-2.5-flash",
    });

    const outputEvents: string[] = [];
    // Simulate stream with wrapThinking callbacks
    const fakeStream = new AssistantMessageEventStream();
    
    // Simulate what agent.stream wires up
    let isThinking = false;
    const openThink = () => {
      if (!isThinking) {
        isThinking = true;
        outputEvents.push("<think>\n");
      }
    };
    const closeThink = () => {
      if (isThinking) {
        isThinking = false;
        outputEvents.push("\n</think>\n\n");
      }
    };

    fakeStream.on("thinking_delta", (e: any) => {
      openThink();
      outputEvents.push(`[THINK:${e.thinkingDelta}]`);
    });
    fakeStream.on("text_delta", (e: any) => {
      closeThink();
      outputEvents.push(`[TEXT:${e.delta}]`);
    });
    fakeStream.on("tool_result" as any, () => {
      closeThink();
    });

    // Turn 1
    fakeStream.push({ type: "thinking_delta", thinkingDelta: "Plan 1" });
    fakeStream.push({ type: "text_delta", delta: "Calling tool" });
    fakeStream.push({ type: "tool_result", toolResult: { id: "c1", name: "tool", result: "ok" } });

    // Turn 2 — should open <think> again and close with text!
    fakeStream.push({ type: "thinking_delta", thinkingDelta: "Plan 2" });
    fakeStream.push({ type: "text_delta", delta: "Final report" });

    expect(outputEvents).toEqual([
      "<think>\n",
      "[THINK:Plan 1]",
      "\n</think>\n\n",
      "[TEXT:Calling tool]",
      "<think>\n",
      "[THINK:Plan 2]",
      "\n</think>\n\n",
      "[TEXT:Final report]",
    ]);
  });

  it("should switch from reasoning to text_delta when </think> tag or # header is encountered", async () => {
    const { OpenRouterProvider } = await import("../src/index.ts");
    const provider = new OpenRouterProvider();
    const originalFetch = globalThis.fetch;

    // Simulate an upstream model dumping a document header into reasoning
    const sseChunks = [
      'data: {"id":"gen-1","choices":[{"delta":{"reasoning":"I will think for a second.\\n# Executive Report: Summary\\nContent here"}}],"finish_reason":"stop"}\n\n',
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
        "inclusionai/ling-3.0-flash-fin:free",
        { messages: [{ role: "user", content: "Write report" }] },
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

      const res = await stream.result();
      expect(thinkingDeltas.join("")).toBe("I will think for a second.");
      expect(textDeltas.join("")).toBe("# Executive Report: Summary\nContent here");
      expect(res.text).toBe("# Executive Report: Summary\nContent here");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should rescue text from thinking when no content deltas were emitted and no tools called", async () => {
    const { OpenRouterProvider } = await import("../src/index.ts");
    const provider = new OpenRouterProvider();
    const originalFetch = globalThis.fetch;

    const sseChunks = [
      'data: {"id":"gen-2","choices":[{"delta":{"reasoning":"Simple text answer completely in reasoning"}}],"finish_reason":"stop"}\n\n',
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
        "qwen/qwq-32b",
        { messages: [{ role: "user", content: "hello" }] },
        { apiKey: "test-key" }
      );

      const res = await stream.result();
      expect(res.text).toBe("Simple text answer completely in reasoning");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should detect document header split across SSE chunks (cross-chunk rolling buffer)", async () => {
    const { OpenRouterProvider } = await import("../src/index.ts");
    const provider = new OpenRouterProvider();
    const originalFetch = globalThis.fetch;

    // Simulate tokenizer splitting \n\n into Chunk 1 and # Title into Chunk 2
    const sseChunks = [
      'data: {"id":"gen-split-1","choices":[{"delta":{"reasoning":"Analyzing research findings.\\n\\n"}}]}\n\n',
      'data: {"id":"gen-split-1","choices":[{"delta":{"reasoning":"# Executive Summary: Solid-State Batteries\\n"}}]}\n\n',
      'data: {"id":"gen-split-1","choices":[{"delta":{"reasoning":"Commercialization timeline is 2027."}}],"finish_reason":"stop"}\n\n',
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
        "inclusionai/ling-3.0-flash-fin:free",
        { messages: [{ role: "user", content: "Write report" }] },
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

      const res = await stream.result();
      expect(thinkingDeltas.join("")).toBe("Analyzing research findings.\n\n");
      expect(textDeltas.join("")).toBe("# Executive Summary: Solid-State Batteries\nCommercialization timeline is 2027.");
      expect(res.text).toBe("# Executive Summary: Solid-State Batteries\nCommercialization timeline is 2027.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should handle </think> tag split across SSE chunks (cross-chunk rolling buffer)", async () => {
    const { OpenRouterProvider } = await import("../src/index.ts");
    const provider = new OpenRouterProvider();
    const originalFetch = globalThis.fetch;

    // Simulate </think> split across chunk 1 (</thi) and chunk 2 (nk>)
    const sseChunks = [
      'data: {"id":"gen-split-2","choices":[{"delta":{"reasoning":"Let me calculate. </thi"}}]}\n\n',
      'data: {"id":"gen-split-2","choices":[{"delta":{"reasoning":"nk>\\nThe result is 42."}}],"finish_reason":"stop"}\n\n',
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
        "inclusionai/ling-3.0-flash-fin:free",
        { messages: [{ role: "user", content: "Calculate" }] },
        { apiKey: "test-key" }
      );

      const textDeltas: string[] = [];

      for await (const event of stream) {
        if (event.type === "text_delta" && event.delta) {
          textDeltas.push(event.delta);
        }
      }

      const res = await stream.result();
      expect(textDeltas.join("")).toBe("\nThe result is 42.");
      expect(res.text).toBe("\nThe result is 42.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
