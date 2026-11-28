import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { Agent, tool } from "../src/index.ts";
import { OpenAIResponsesProvider } from "../src/providers/openai.ts";

// OpenAI's `response.completed` carries the whole reply: it fills text and calls that the stream's deltas lost.
const ctx = { messages: [{ role: "user" as const, content: "x" }] };
const message = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });
const fnCall = (id: string, callId: string, args: string) => ({
  type: "function_call",
  id,
  call_id: callId,
  name: "weather",
  arguments: args,
});
const completed = (output: unknown[]) => ({
  type: "response.completed",
  response: { id: "r", status: "completed", output },
});
// An SSE body from frames; a string frame is sent as it is (a frame that cannot be read).
const body = (frames: unknown[]) =>
  new Response(frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
// One provider-level stream turn: the result and the text deltas the app saw.
const turn = async (frames: unknown[]) => {
  const fetch = (async () => body(frames)) as unknown as typeof globalThis.fetch;
  const stream = new OpenAIResponsesProvider().stream("m", ctx, { apiKey: "k", fetch } as never);
  const deltas: string[] = [];
  const calls: string[] = [];
  for await (const e of stream) {
    if (e.type === "text_delta" && e.delta) deltas.push(e.delta);
    if (e.type === "tool_call_complete" && e.toolCall) calls.push(e.toolCall.id);
  }
  return { res: await stream.result(), deltas, calls };
};
const delta = (text: string) => ({ type: "response.output_text.delta", delta: text });

describe("OpenAI's completed reply fills what the stream lost", () => {
  it("a lost end of the text: the result has it, and the app gets the missing end", async () => {
    const { res, deltas } = await turn([delta("Hel"), "{not json", completed([message("Hello")])]);
    expect([res.text, deltas]).toEqual(["Hello", ["Hel", "lo"]]);
  });

  it("a lost middle: the completed text wins in the result", async () => {
    const { res, deltas } = await turn([delta("Hel"), "{lost", delta(" world"), completed([message("Hello world")])]);
    expect([res.text, deltas]).toEqual(["Hello world", ["Hel", " world"]]);
  });

  it("a call whose output_item.added never arrived is added, at its place, and runs", async () => {
    const added = {
      type: "response.output_item.added",
      output_index: 1,
      item: fnCall("fc_b", "call_b", '{"city":"Rome"}'),
    };
    const { res, calls } = await turn([
      added,
      completed([fnCall("fc_a", "call_a", '{"city":"Paris"}'), fnCall("fc_b", "call_b", '{"city":"Rome"}')]),
    ]);
    expect(res.toolCalls.map((c) => [c.id, c.arguments])).toEqual([
      ["fc_a", { city: "Paris" }],
      ["fc_b", { city: "Rome" }],
    ]);
    expect([calls, res.finishReason]).toEqual([["fc_a", "fc_b"], "tool_calls"]);

    const seen: unknown[] = [];
    const weather = tool({
      name: "weather",
      description: "d",
      input: z.object({ city: z.string() }),
      execute: (args) => {
        seen.push(args);
        return "21C";
      },
    });
    let n = 0;
    const fetch = (async () =>
      n++ === 0
        ? body([completed([fnCall("fc_a", "call_a", '{"city":"Paris"}')])])
        : body([delta("21C"), completed([message("21C")])])) as unknown as typeof globalThis.fetch;
    const agent = new Agent({ model: "openai/gpt-5.5", apiKey: "k", fetch, tools: [weather], runRetries: 0, maxTurns: 3 });
    expect((await agent.stream("w?").result()).text).toBe("21C");
    expect(seen).toEqual([{ city: "Paris" }]);
  });

  it("a call taken from the completed reply never replaces a streamed call that holds its place", async () => {
    // The stream put fc_b at output_index 0; the completed output lists only fc_a, at position 0 (an inconsistent
    // server). A streamed call is never lost: both are kept.
    const { res } = await turn([
      { type: "response.output_item.added", output_index: 0, item: fnCall("fc_b", "call_b", '{"city":"Rome"}') },
      completed([fnCall("fc_a", "call_a", '{"city":"Paris"}')]),
    ]);
    expect(res.toolCalls.map((c) => c.id)).toEqual(["fc_b", "fc_a"]);
  });

  it("an empty completed output changes nothing", async () => {
    const { res, deltas } = await turn([delta("hi"), completed([])]);
    expect([res.text, deltas]).toEqual(["hi", ["hi"]]);
  });

  it("text and calls that streamed normally are not doubled", async () => {
    const { res, deltas, calls } = await turn([
      delta("Let me check"),
      { type: "response.output_item.added", output_index: 1, item: fnCall("fc_a", "call_a", "") },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"city":"Paris"}' },
      completed([message("Let me check"), fnCall("fc_a", "call_a", '{"city":"Paris"}')]),
    ]);
    expect([res.text, deltas, calls]).toEqual(["Let me check", ["Let me check"], ["fc_a"]]);
    expect(res.toolCalls.map((c) => c.arguments)).toEqual([{ city: "Paris" }]);
  });
});
