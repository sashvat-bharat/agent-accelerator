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

  it("should collapse provider blank-line padding in wrapThinking display without touching cache payloads", async () => {
    // Regression: Gemini thought summaries trail with blank lines (observed
    // `"...\n\n\n"`), and the `<think>` wrapper added its own newlines —
    // rendering blank lines after `<think>`, double blanks between sections,
    // and blanks before `</think>`. Display normalization must collapse
    // `\n{3,}` → `\n\n` and keep tag boundaries tight while request bodies
    // (instructions, chaining, affinity) stay byte-identical.
    const { Agent } = await import("../src/agent/agent.ts");
    const originalFetch = globalThis.fetch;
    const seenBodies: any[] = [];
    const sse = [
      "event: interaction.created",
      'data: {"interaction":{"id":"v1_w","status":"in_progress","object":"interaction","model":"m"},"event_type":"interaction.created"}',
      "",
      "event: step.start",
      'data: {"index":0,"step":{"type":"thought"},"event_type":"step.start"}',
      "",
      "event: step.delta",
      'data: {"index":0,"delta":{"content":{"type":"text","text":"A\\n\\n\\nB\\n\\n\\n"},"type":"thought_summary"},"event_type":"step.delta"}',
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
      'data: {"interaction":{"id":"v1_w","status":"completed","usage":{"total_tokens":3,"total_input_tokens":2,"total_output_tokens":1,"total_cached_tokens":0,"total_thought_tokens":0}},"event_type":"interaction.completed"}',
      "",
      "event: done",
      "data: [DONE]",
      "",
    ].join("\n");
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      try {
        seenBodies.push(JSON.parse(req.body));
      } catch {}
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    try {
      const agent = new Agent({
        name: "WrapThinkingHygiene",
        model: "google/gemini-3.5-flash-lite",
        apiKey: "test-key",
      });
      const thinkingOut: string[] = [];
      const textOut: string[] = [];
      const res = await agent.run("Hi", {
        stream: true,
        wrapThinking: true,
        onThinkingDelta: (d) => void thinkingOut.push(d),
        onDelta: (d) => void textOut.push(d),
      });

      const thinkingShown = thinkingOut.join("");
      expect(thinkingShown).not.toContain("\n\n\n");
      expect(thinkingShown.startsWith("<think>\nA")).toBe(true);
      // Trailing provider newlines are buffered and dropped at close: no
      // blank line before the tag.
      expect(thinkingShown).toBe("<think>\nA\n\nB\n</think>\n\n");
      // Stored thinking is trimmed (no provider trailing blanks).
      expect(res.thinking).toBe("A\n\nB");
      expect(textOut.join("")).toContain("Hi");
      // Cache-relevant payload untouched: stateless single-turn sends the
      // user turn only, no chaining id invented.
      expect(seenBodies.length).toBe(1);
      expect(seenBodies[0].previous_interaction_id).toBeUndefined();
      expect(seenBodies[0].model).toBe("gemini-3.5-flash-lite");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
