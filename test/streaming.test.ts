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
});
