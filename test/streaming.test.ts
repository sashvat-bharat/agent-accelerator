import { describe, it, expect } from "bun:test";
import { AssistantMessageEventStream, AgentResponse } from "../src/index.ts";
import { SSEParser } from "../src/streaming/sse-parser.ts";

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

  it("buffer: false keeps no events: listeners see every one, nothing overflows, result() still resolves", async () => {
    const { telemetryBus } = await import("../src/telemetry.ts");
    const codes: string[] = [];
    const off = telemetryBus.onEvent((ev) => codes.push(ev.code));
    try {
      const plain = new AssistantMessageEventStream({ buffer: false });
      let seen = 0;
      plain.on("text_delta", () => seen++);
      for (let i = 0; i < 3000; i++) plain.push({ type: "text_delta", delta: "x" }); // far past the 1000-event buffer, no reader
      expect(seen).toBe(3000);
      expect(codes).not.toContain("stream_buffer_overflow");
      const response = new AgentResponse({ text: "x", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: "m", provider: "google", durationMs: 1, raw: { request: {} as any } });
      plain.end(response);
      expect(await plain.result()).toBe(response);

      // The default keeps the bound and says so when it drops events.
      const normal = new AssistantMessageEventStream();
      for (let i = 0; i < 1100; i++) normal.push({ type: "text_delta", delta: "x" });
      expect(codes).toContain("stream_buffer_overflow");

      // A failure still reaches result() without a reader.
      const failing = new AssistantMessageEventStream({ buffer: false });
      failing.fail(new Error("boom"));
      await expect(failing.result()).rejects.toThrow("boom");
    } finally {
      off();
    }
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

  it("stores trimmed thinking and leaves cache payloads untouched", async () => {
    // Gemini thought summaries trail with blank lines (observed `"...\n\n\n"`): the stored thinking is trimmed and request bodies stay byte-identical.
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
        name: "ThinkingHygiene",
        model: "google/gemini-3.5-flash-lite",
        apiKey: "test-key",
      });
      const thinkingOut: string[] = [];
      const textOut: string[] = [];
      const res = await agent.run("Hi", {
        stream: true,
        onThinkingDelta: (d) => void thinkingOut.push(d),
        onDelta: (d) => void textOut.push(d),
      });

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
