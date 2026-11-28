import { describe, it, expect } from "bun:test";
import { Agent, telemetryBus } from "../src/index.ts";
import { AssistantMessageEventStream } from "../src/streaming/event-stream.ts";
import { AgentResponse } from "../src/types/response.ts";

// The 1 MB stream guard measures each new piece, never the answer so far: a long answer keeps streaming.
const PIECE = 10_000;
const PIECES = 130; // 1.3 million characters, past the 1,048,576 limit
const piece = (i: number) => String.fromCharCode(97 + (i % 26)).repeat(PIECE);
// The smallest final response a stream can end with.
const done = (text: string) =>
  new AgentResponse({
    text,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    model: "m",
    provider: "openai",
    durationMs: 0,
    raw: { request: { url: "", method: "POST", headers: {}, body: {} } },
  });

describe("the stream's size guard", () => {
  it("delivers every text and thinking delta of an answer longer than the limit", async () => {
    const stream = new AssistantMessageEventStream();
    let text = "";
    let thinking = "";
    for (let i = 0; i < PIECES; i++) {
      text += piece(i);
      thinking += piece(i);
      stream.push({ type: "thinking_delta", thinkingDelta: piece(i), partialThinking: thinking });
      stream.push({ type: "text_delta", delta: piece(i), partialText: text });
    }
    stream.end(done(text));
    const seen = { text: "", thinking: "" };
    for await (const e of stream) {
      if (e.type === "text_delta") seen.text += e.delta ?? "";
      if (e.type === "thinking_delta") seen.thinking += e.thinkingDelta ?? "";
    }
    expect([seen.text.length, seen.thinking.length]).toEqual([PIECE * PIECES, PIECE * PIECES]);
    expect([seen.text === text, seen.thinking === thinking]).toEqual([true, true]);
  });

  it("still drops one piece that is itself over the limit, and reports it", async () => {
    const codes: string[] = [];
    const off = telemetryBus.onEvent((e) => codes.push(e.code));
    try {
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "text_delta", delta: "x".repeat(1_048_577) });
      stream.push({ type: "thinking_delta", thinkingDelta: "y".repeat(1_048_577) });
      stream.push({ type: "text_delta", delta: "ok" });
      stream.end(done("ok"));
      const deltas: string[] = [];
      for await (const e of stream) if (e.type === "text_delta" || e.type === "thinking_delta") deltas.push(e.delta ?? e.thinkingDelta ?? "");
      expect(deltas).toEqual(["ok"]);
      expect(codes).toContain("stream_event_oversize");
    } finally {
      off();
    }
  });

  it("agent.stream(): a long answer streams to the end, through the provider and the agent", async () => {
    const chunks = Array.from({ length: PIECES }, (_, i) => ({
      choices: [{ index: 0, delta: { content: piece(i), reasoning_content: piece(i) } }],
    }));
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" } as never] });
    const sse = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
    const fetch = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof globalThis.fetch;
    const agent = new Agent({ model: "groq/m", apiKey: "k", baseUrl: "https://x.test/v1", fetch, runRetries: 0 });
    const stream = agent.stream("long");
    let text = "";
    let thinking = "";
    for await (const e of stream) {
      if (e.type === "text_delta") text += e.delta ?? "";
      if (e.type === "thinking_delta") thinking += e.thinkingDelta ?? "";
    }
    const res = await stream.result();
    expect(res.text.length).toBe(PIECE * PIECES);
    expect([text === res.text, thinking.length]).toEqual([true, PIECE * PIECES]);
  });
});
