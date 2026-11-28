import { describe, it, expect } from "bun:test";
import { reasoningParts } from "../src/providers/shared.ts";
import { OpenRouterChatCompletionsProvider } from "../src/providers/openrouter.ts";
import { OpenAICompatibleChatProvider } from "../src/providers/openai-compat.ts";
import type { Provider } from "../src/types/model.ts";

// The thinking text of Chat Completions replies: `reasoning_details` blocks (text or summary), else `reasoning_content`, else `reasoning`.
const ctx = { messages: [{ role: "user" as const, content: "x" }] };
const sse = (deltas: Array<Record<string, unknown>>) =>
  new Response(
    `${deltas.map((delta) => `data: ${JSON.stringify({ id: "g", choices: [{ index: 0, delta }] })}\n\n`).join("")}data: ${JSON.stringify(
      { id: "g", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }
    )}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
const once = (res: () => Response) => (async () => res()) as unknown as typeof fetch;
const ADAPTERS: Array<[string, () => Provider]> = [
  ["openrouter", () => new OpenRouterChatCompletionsProvider()],
  ["openai-compat", () => new OpenAICompatibleChatProvider("acme", { baseUrl: "https://x.test/v1" })],
];
// One streamed turn over `deltas`: the final thinking and the thinking deltas the app saw.
const streamThinking = async (make: () => Provider, deltas: Array<Record<string, unknown>>) => {
  const stream = make().stream("m", ctx, { apiKey: "k", fetch: once(() => sse(deltas)) } as never);
  const seen: string[] = [];
  for await (const e of stream) if (e.type === "thinking_delta" && e.thinkingDelta) seen.push(e.thinkingDelta);
  const res = await stream.result();
  return { thinking: res.thinking, seen, steps: res.providerSteps };
};

describe("reasoningParts", () => {
  it("reads the text or the summary of each block; encrypted blocks have none", () => {
    expect(reasoningParts({ reasoning_details: [{ type: "reasoning.text", text: "a" }, { type: "reasoning.summary", summary: "b" }] })).toEqual(["a", "b"]);
    expect(reasoningParts({ reasoning_details: [{ type: "reasoning.summary", summary: [{ text: "c" }, { text: "d" }] }] })).toEqual(["cd"]);
    expect(reasoningParts({ reasoning_details: [{ type: "reasoning.encrypted", data: "x" }] })).toEqual([]);
  });

  it("blocks with text win; blocks without text (or none) leave reasoning_content, then reasoning", () => {
    expect(reasoningParts({ reasoning_details: [{ text: "t" }], reasoning: "t" })).toEqual(["t"]);
    expect(reasoningParts({ reasoning_details: [], reasoning: "r" })).toEqual(["r"]);
    expect(reasoningParts({ reasoning_details: [{ type: "reasoning.encrypted", data: "x" }], reasoning: "r" })).toEqual(["r"]);
    expect(reasoningParts({ reasoning_content: "rc", reasoning: "r" })).toEqual(["rc"]);
    expect([reasoningParts({}), reasoningParts(undefined), reasoningParts({ reasoning: "" })]).toEqual([[], [], []]);
  });
});

describe("thinking text that used to be dropped", () => {
  for (const [name, make] of ADAPTERS) {
    it(`${name} stream: summary blocks reach the app as thinking`, async () => {
      const { thinking, seen } = await streamThinking(make, [
        { reasoning_details: [{ type: "reasoning.summary", summary: "Plan", index: 0 }] },
        { reasoning_details: [{ type: "reasoning.summary", summary: " more", index: 0 }] },
      ]);
      expect([thinking, seen]).toEqual(["Plan more", ["Plan", " more"]]);
    });

    it(`${name} stream: an empty or encrypted-only block list does not hide reasoning`, async () => {
      const empty = await streamThinking(make, [{ reasoning_details: [], reasoning: "R1" }]);
      const encrypted = await streamThinking(make, [{ reasoning_details: [{ type: "reasoning.encrypted", data: "x" }], reasoning: "R2" }]);
      expect([empty.thinking, encrypted.thinking]).toEqual(["R1", "R2"]);
    });

    it(`${name} stream: thinking sent both as a block and as reasoning is read once`, async () => {
      const { thinking } = await streamThinking(make, [{ reasoning_details: [{ type: "reasoning.text", text: "T" }], reasoning: "T" }]);
      expect(thinking).toBe("T");
    });
  }

  it("openrouter: the summary blocks are still kept whole for replay", async () => {
    const { steps } = await streamThinking(ADAPTERS[0]![1], [
      { reasoning_details: [{ type: "reasoning.summary", summary: "Plan", index: 0 }] },
      { reasoning_details: [{ type: "reasoning.summary", summary: " more", index: 0 }] },
    ]);
    expect(steps?.steps).toEqual([{ type: "reasoning.summary", summary: "Plan more", index: 0 }]);
  });

  it("openai-compat run(): reads reasoning_content, as its stream does, and blocks still win", async () => {
    const reply = (message: Record<string, unknown>) => () =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi", ...message }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const provider = () => new OpenAICompatibleChatProvider("acme", { baseUrl: "https://x.test/v1" });
    const deep = await provider().generate("m", ctx, { apiKey: "k", fetch: once(reply({ reasoning_content: "deep" })) } as never);
    const both = await provider().generate("m", ctx, {
      apiKey: "k",
      fetch: once(reply({ reasoning_details: [{ type: "reasoning.summary", summary: "S" }], reasoning_content: "S" })),
    } as never);
    expect([deep.thinking, both.thinking]).toEqual(["deep", "S"]);
  });
});
