import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { Agent, tool } from "../src/index.ts";
import { argumentsText, parseArguments } from "../src/providers/shared.ts";
import { TRUNCATED_ARGS_KEY, isTruncatedArguments } from "../src/types/tool.ts";

// Tool-call arguments that a server sends as an object instead of JSON text, on the two Chat Completions adapters.
const CALL = { id: "c1", type: "function", function: { name: "weather", arguments: { city: "Paris" } } };
const CALL_REPLY = { choices: [{ message: { role: "assistant", content: null, tool_calls: [CALL] }, finish_reason: "tool_calls" }] };
const TEXT_REPLY = { choices: [{ message: { role: "assistant", content: "21C" }, finish_reason: "stop" }] };

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const sse = (chunks: unknown[]) =>
  new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const CALL_CHUNK = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...CALL }] }, finish_reason: "tool_calls" }] };
const TEXT_CHUNK = { choices: [{ index: 0, delta: { content: "21C" }, finish_reason: "stop" }] };

const COMPAT = { model: "groq/m", baseUrl: "https://x.test/v1" };
const OPENROUTER = { model: "openrouter/openai/gpt-5.5" };

// One run on `wire` whose first reply is `first` and second `second`; the arguments the tool got and the run's calls.
const runOnce = async (
  wire: object,
  mode: "run" | "stream",
  first: () => Response,
  second: () => Response
) => {
  const seen: unknown[] = [];
  // `city` is optional, so a call that lost its arguments would still run (with nothing): the old bug.
  const weather = tool({
    name: "weather",
    description: "d",
    input: z.object({ city: z.string().optional() }),
    execute: (args) => {
      seen.push(args);
      return "21C";
    },
  });
  let n = 0;
  const fetch = (async () => (n++ === 0 ? first() : second())) as unknown as typeof globalThis.fetch;
  const agent = new Agent({ ...wire, apiKey: "k", fetch, tools: [weather], runRetries: 0, maxTurns: 3 } as never);
  const res = mode === "run" ? await agent.run("w?") : await agent.stream("w?").result();
  return { seen, calls: res.toolCalls };
};

describe("tool-call arguments sent as an object", () => {
  for (const [label, wire, mode, first, second] of [
    ["openai-compat run()", COMPAT, "run", () => json(CALL_REPLY), () => json(TEXT_REPLY)],
    ["openai-compat stream()", COMPAT, "stream", () => sse([CALL_CHUNK]), () => sse([TEXT_CHUNK])],
    ["openai-compat stream() answered in one piece", COMPAT, "stream", () => json(CALL_REPLY), () => json(TEXT_REPLY)],
    ["openrouter (streams)", OPENROUTER, "run", () => sse([CALL_CHUNK]), () => sse([TEXT_CHUNK])],
    ["openrouter answered in one piece", OPENROUTER, "run", () => json(CALL_REPLY), () => json(TEXT_REPLY)],
  ] as const) {
    it(`${label}: the tool runs with them, and the raw arguments are their JSON text`, async () => {
      const { seen, calls } = await runOnce(wire, mode, first, second);
      expect(seen).toEqual([{ city: "Paris" }]);
      expect(calls.map((c) => [c.arguments, c.rawArguments])).toEqual([[{ city: "Paris" }, '{"city":"Paris"}']]);
    });
  }

  it("a stream that sends the call first and its arguments object in a later chunk", async () => {
    for (const wire of [COMPAT, OPENROUTER]) {
      const head = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "weather" } }] } }] };
      const tail = {
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: { city: "Paris" } } }] }, finish_reason: "tool_calls" }],
      };
      const { seen } = await runOnce(wire, "stream", () => sse([head, tail]), () => sse([TEXT_CHUNK]));
      expect(seen).toEqual([{ city: "Paris" }]);
    }
  });

  it("a list as the arguments is unusable: the call never runs", async () => {
    const listCall = { ...CALL, function: { name: "weather", arguments: ["Paris"] } };
    const reply = { choices: [{ message: { role: "assistant", content: null, tool_calls: [listCall] }, finish_reason: "tool_calls" }] };
    const chunk = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...listCall }] }, finish_reason: "tool_calls" }] };
    const viaRun = await runOnce(COMPAT, "run", () => json(reply), () => json(TEXT_REPLY));
    const viaStream = await runOnce(COMPAT, "stream", () => sse([chunk]), () => sse([TEXT_CHUNK]));
    for (const { seen, calls } of [viaRun, viaStream]) {
      expect(seen).toEqual([]);
      expect(isTruncatedArguments(calls[0]!.arguments)).toBe(true);
    }
  });

  it("parseArguments: text is parsed, an object is kept, anything else is the marker, which always holds text", () => {
    const object = { city: "Paris" };
    expect(parseArguments(object)).toBe(object);
    expect(parseArguments('{"city":"Paris"}')).toEqual(object);
    expect([parseArguments(undefined), parseArguments(""), parseArguments(null)]).toEqual([{}, {}, {}]);
    for (const [raw, text] of [
      [["Paris"], '["Paris"]'],
      [5, "5"],
      ['{"city":"Par', '{"city":"Par'],
      ['"Paris"', '"Paris"'],
    ] as const) {
      const parsed = parseArguments(raw);
      expect(parsed).toEqual({ [TRUNCATED_ARGS_KEY]: text });
      expect(isTruncatedArguments(parsed)).toBe(true); // a marker the run recognizes, so the call never runs
    }
  });

  it("argumentsText: text as it is, an object or a list as JSON, nothing for other values", () => {
    expect(argumentsText('{"a":1}')).toBe('{"a":1}');
    expect(argumentsText({ a: 1 })).toBe('{"a":1}');
    expect(argumentsText([1])).toBe("[1]");
    expect([argumentsText(undefined), argumentsText(null), argumentsText(5)]).toEqual([undefined, undefined, undefined]);
  });
});
