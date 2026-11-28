import { describe, it, expect } from "bun:test";
import { streamedCallIndex } from "../src/providers/shared.ts";
import { OpenRouterChatCompletionsProvider } from "../src/providers/openrouter.ts";
import { OpenAICompatibleChatProvider } from "../src/providers/openai-compat.ts";
import type { Provider } from "../src/types/model.ts";

// Streamed Chat Completions tool calls whose pieces carry no `index` (some OpenAI-compatible servers): a new id starts a new call.
const ctx = { messages: [{ role: "user" as const, content: "x" }] };
const ADAPTERS: Array<[string, () => Provider]> = [
  ["openrouter", () => new OpenRouterChatCompletionsProvider()],
  ["openai-compat", () => new OpenAICompatibleChatProvider("acme", { baseUrl: "https://x.test/v1" })],
];
const call = (id: string | undefined, args: string, name?: string) => ({
  ...(id ? { id, type: "function" } : {}),
  function: { ...(name ? { name } : {}), arguments: args },
});
// The calls of one streamed turn whose chunks carry these tool-call pieces, then a tool_calls finish.
const callsOf = async (make: () => Provider, chunks: Array<Array<Record<string, unknown>>>) => {
  const body = [
    ...chunks.map((pieces) => ({ id: "g", choices: [{ index: 0, delta: { tool_calls: pieces } }] })),
    { id: "g", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  const text = `${body.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  const fetch = (async () => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof globalThis.fetch;
  const res = await make().stream("m", ctx, { apiKey: "k", fetch } as never).result();
  return res.toolCalls.map((c) => [c.id, c.arguments]);
};

describe("streamedCallIndex", () => {
  const calls = new Map([[0, { id: "call_a" }]]);
  it("an index wins; without one, a new id starts the next call and anything else continues the current one", () => {
    expect(streamedCallIndex({ index: 3, id: "call_b" }, calls, 0)).toBe(3);
    expect(streamedCallIndex({ id: "call_b" }, calls, 0)).toBe(1);
    expect(streamedCallIndex({ id: "call_a" }, calls, 0)).toBe(0);
    expect(streamedCallIndex({}, calls, 0)).toBe(0);
    expect(streamedCallIndex({ id: "call_a" }, new Map(), 0)).toBe(0); // the first call
    expect(streamedCallIndex({ id: "call_b" }, new Map([[0, { id: "" }]]), 0)).toBe(0); // the current call has no id yet
    expect(streamedCallIndex({ id: "call_c" }, new Map([[0, { id: "a" }], [5, { id: "b" }]]), 5)).toBe(6);
  });
});

describe("parallel streamed tool calls without an index", () => {
  for (const [name, make] of ADAPTERS) {
    it(`${name}: calls in separate chunks stay apart, and argument pieces continue their call`, async () => {
      expect(
        await callsOf(make, [
          [call("call_a", "", "weather")],
          [call(undefined, '{"city":')],
          [call(undefined, '"Paris"}')],
          [call("call_b", "", "weather")],
          [call(undefined, '{"city":"Rome"}')], // after a new call, pieces continue the NEW one
        ])
      ).toEqual([
        ["call_a", { city: "Paris" }],
        ["call_b", { city: "Rome" }],
      ]);
    });

    it(`${name}: two calls in one chunk stay apart`, async () => {
      expect(await callsOf(make, [[call("call_a", '{"city":"Paris"}', "weather"), call("call_b", '{"city":"Rome"}', "weather")]])).toEqual([
        ["call_a", { city: "Paris" }],
        ["call_b", { city: "Rome" }],
      ]);
    });

    it(`${name}: the same id sent again without an index stays one call`, async () => {
      expect(await callsOf(make, [[call("call_a", '{"ci', "weather")], [call("call_a", 'ty":"Paris"}')]])).toEqual([
        ["call_a", { city: "Paris" }],
      ]);
    });

    it(`${name}: pieces with an index are placed by it, as before`, async () => {
      expect(
        await callsOf(make, [
          [{ index: 0, ...call("call_a", '{"city":', "weather") }],
          [{ index: 1, ...call("call_b", '{"city":"Rome"}', "weather") }],
          [{ index: 0, ...call(undefined, '"Paris"}') }],
        ])
      ).toEqual([
        ["call_a", { city: "Paris" }],
        ["call_b", { city: "Rome" }],
      ]);
    });
  }
});
