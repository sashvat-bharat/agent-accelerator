import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { Agent, tool, ModelProvider, resolveModel, getProvider } from "../src/index.ts";
import { ensureCustomProvider } from "../src/providers/registry.ts";
import { ConfigError } from "../src/types/errors.ts";
import {
  API_KEY,
  MODEL,
  anthropicApi,
  blockDelta,
  blockStart,
  blockStop,
  jsonReply,
  messageDelta,
  messageObject,
  messageStart,
  messageStop,
  sseReply,
  thinkingBlock,
  usageObject,
} from "./anthropic-fixtures.ts";

describe("Anthropic routing", () => {
  it("routes anthropic/<model> and bare Claude ids to the native adapter", () => {
    const a = resolveModel("anthropic/" + MODEL);
    expect(a.provider.id).toBe("anthropic");
    expect(a.modelId).toBe(MODEL);
    expect(a.modelSpec?.provider).toBe("anthropic");
    const bare = resolveModel(MODEL);
    expect(bare.provider.id).toBe("anthropic");
    expect(bare.modelId).toBe(MODEL);
    expect(getProvider("anthropic")).toBe(a.provider);
  });

  it("builds a selection with ModelProvider.Anthropic and keeps the first-class provider unreplaceable", () => {
    expect(ModelProvider.Anthropic("claude-opus-5-5", "k").model).toBe("anthropic/claude-opus-5-5");
    expect(ModelProvider.Anthropic("anthropic/claude-opus-5-5").model).toBe("anthropic/claude-opus-5-5");
    expect(() => ensureCustomProvider("anthropic", { baseUrl: "https://x.example" })).toThrow(ConfigError);
  });
});

describe("Anthropic through an Agent", () => {
  const lookup = tool({
    name: "get_weather",
    description: "Get the weather for a city.",
    input: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, temp_c: 21 }),
  });

  it("runs a tool loop: thinking is replayed unmodified, usage and cost add up, headers are captured", async () => {
    const think = thinkingBlock("The user wants the weather in Paris; call the tool.");
    const api = anthropicApi([
      jsonReply(
        messageObject({
          content: [think, { type: "text", text: "On it.", citations: null }, { type: "tool_use", id: "toolu_01D7FLrfh4GYq7yT1ULFeyMV", name: "get_weather", input: { city: "Paris" }, caller: { type: "direct" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 40, cache_creation_input_tokens: 1000, output_tokens: 60, output_tokens_details: { thinking_tokens: 30 } },
        })
      ),
      jsonReply(
        messageObject({
          content: [{ type: "text", text: "It is 21 C in Paris.", citations: null }],
          usage: { input_tokens: 10, cache_read_input_tokens: 1040, output_tokens: 12 },
        })
      ),
    ]);
    const agent = new Agent({
      model: "anthropic/" + MODEL,
      apiKey: API_KEY,
      fetch: api.fn,
      tools: [lookup],
      thinking: "high",
      stateless: true,
      runRetries: 0,
      instructions: "You answer with the weather tool.",
    });
    const res = await agent.run("What is the weather in Paris?");
    expect(res.text).toBe("It is 21 C in Paris.");
    expect(res.finishReason).toBe("stop");
    expect(api.calls.length).toBe(2); // the fake API accepted both requests, including the replayed signed thinking block

    const first = api.calls[0]!.body;
    expect(first.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(first.output_config).toEqual({ effort: "high" });
    expect(first.system.startsWith("You answer with the weather tool.")).toBe(true); // the SDK appends its reasoning directive when thinking is on
    expect(first.tools.map((t: { name: string }) => t.name)).toEqual(["get_weather"]);

    const second = api.calls[1]!.body;
    expect(second.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[1].content[0]).toEqual(think);
    expect(second.messages[1].content[2]).toEqual({ type: "tool_use", id: "toolu_01D7FLrfh4GYq7yT1ULFeyMV", name: "get_weather", input: { city: "Paris" } });
    expect(second.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_01D7FLrfh4GYq7yT1ULFeyMV", content: expect.stringContaining('"temp_c":21') },
    ]);

    // Usage: cache buckets are added to input (turn 1: 40+1000, turn 2: 10+1040); catalog prices write at 2.5/M and read at 0.1/M.
    expect(res.usage.inputTokens).toBe(40 + 1000 + 10 + 1040);
    expect(res.usage.cacheWriteTokens).toBe(1000);
    expect(res.usage.cacheReadTokens).toBe(1040);
    expect(res.usage.outputTokens).toBe(72);
    const report = agent.usageReport();
    expect(report.agent.turns).toBe(2);
    expect(report.agent.tokens).toMatchObject({ input: 2090, freshInput: 50, cacheRead: 1040, cacheWrite: 1000, output: 72, thinking: 30 });
    // Catalog prices for claude-sonnet-5-5: input $2, cache write $2.5, cache read $0.1, output $10 per million tokens.
    const usd = (40 * 2 + 1000 * 2.5 + 60 * 10 + 10 * 2 + 1040 * 0.1 + 12 * 10) / 1_000_000;
    expect(report.agent.cost.totalUsd).toBeCloseTo(usd, 9);
    expect(res.raw?.response?.headers["request-id"]).toBe("req_011CVr7pJqKmWx4nBd2LsYhE");
  });

  it("streams a tool loop and replays the streamed thinking block exactly", async () => {
    const api = anthropicApi([
      sseReply([
        messageStart({ input_tokens: 50 }),
        blockStart(0, { type: "thinking", thinking: "", signature: "" }),
        blockDelta(0, { type: "thinking_delta", thinking: "Need the tool." }),
        blockDelta(0, { type: "signature_delta", signature: "EqQBstreamedSignatureABC" }),
        blockStop(0),
        blockStart(1, { type: "tool_use", id: "toolu_01StreamA", name: "get_weather", input: {} }),
        blockDelta(1, { type: "input_json_delta", partial_json: '{"city":"Rome"}' }),
        blockStop(1),
        messageDelta("tool_use", { output_tokens: 33 }),
        messageStop,
      ]),
      sseReply([
        messageStart({ input_tokens: 90 }),
        blockStart(0, { type: "text", text: "" }),
        blockDelta(0, { type: "text_delta", text: "Rome is " }),
        blockDelta(0, { type: "text_delta", text: "21 C." }),
        blockStop(0),
        messageDelta("end_turn", { output_tokens: 8 }),
        messageStop,
      ]),
    ]);
    // The signature of a streamed block is not one the fake API issued by itself: register it as issued.
    thinkingBlock("Need the tool.", "EqQBstreamedSignatureABC");
    const agent = new Agent({ model: "anthropic/" + MODEL, apiKey: API_KEY, fetch: api.fn, tools: [lookup], thinking: "medium", stateless: true });
    const stream = agent.stream("Weather in Rome?");
    const deltas: string[] = [];
    for await (const e of stream) if ((e as { type: string }).type === "text_delta") deltas.push((e as unknown as { delta: string }).delta);
    const res = await stream.result();
    expect(deltas.join("")).toBe("Rome is 21 C.");
    expect(res.text).toBe("Rome is 21 C.");
    expect(api.calls.length).toBe(2);
    expect(api.calls.every((c) => c.body.stream === true)).toBe(true);
    expect(api.calls[1]!.body.messages[1].content[0]).toEqual({ type: "thinking", thinking: "Need the tool.", signature: "EqQBstreamedSignatureABC" });
  });

  it("does not execute a tool call that max_tokens cut, and reports it to the model", async () => {
    let executed = 0;
    const counting = tool({ name: "get_weather", description: "w", input: z.object({ city: z.string() }), execute: async () => ((executed += 1), "x") });
    const api = anthropicApi([
      sseReply([
        messageStart(),
        blockStart(0, { type: "tool_use", id: "toolu_01Cut", name: "get_weather", input: {} }),
        blockDelta(0, { type: "input_json_delta", partial_json: '{"city": "Par' }),
        blockStop(0),
        messageDelta("max_tokens", { output_tokens: 64000 }),
        messageStop,
      ]),
      sseReply([messageStart(), blockStart(0, { type: "text", text: "" }), blockDelta(0, { type: "text_delta", text: "Sorry, retrying." }), blockStop(0), messageDelta("end_turn"), messageStop]),
    ]);
    const agent = new Agent({ model: "anthropic/" + MODEL, apiKey: API_KEY, fetch: api.fn, tools: [counting], stateless: true });
    const stream = agent.stream("Weather?");
    for await (const _ of stream) void _;
    await stream.result();
    expect(executed).toBe(0);
    // The cut call goes back as {} (never the marker) with an error result, so the fake API's pairing rules hold.
    expect(api.calls[1]!.body.messages[1].content[0].input).toEqual({});
    expect(api.calls[1]!.body.messages[2].content[0].tool_use_id).toBe("toolu_01Cut");
  });

  it("surfaces the usage object fields the SDK does not model without breaking (service tier, geo, server tool counters)", async () => {
    const api = anthropicApi([jsonReply(messageObject({ usage: usageObject({ service_tier: "priority", speed: "fast", inference_geo: "us" }) }))]);
    const agent = new Agent({ model: "anthropic/" + MODEL, apiKey: API_KEY, fetch: api.fn, stateless: true, captureRaw: true });
    const res = await agent.run("hi");
    expect(res.text).toBe("Hello! How can I help?");
    expect((res.raw?.response?.body as { usage: { service_tier: string } }).usage.service_tier).toBe("priority");
  });
});
