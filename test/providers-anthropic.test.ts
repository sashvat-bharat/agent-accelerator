import { describe, it, expect, beforeEach } from "bun:test";
import { AnthropicMessagesProvider } from "../src/providers/anthropic.ts";
import {
  anthropicSchema,
  clearEmittedWarnings,
  mapOutputToAnthropic,
  mapServiceTierToAnthropic,
  mapThinkingLevelToAnthropic,
  mapToolChoiceToAnthropic,
} from "../src/providers.ts";
import { telemetryBus } from "../src/telemetry.ts";
import { ConfigError, ValidationError } from "../src/types/errors.ts";
import type { ProviderContext } from "../src/types/message.ts";
import type { StandardToolDeclaration } from "../src/types/tool.ts";
import {
  API_KEY,
  BASE,
  MODEL,
  anthropicApi,
  anthropicHeaders,
  blockDelta,
  blockStart,
  blockStop,
  errorReply,
  issuedThinking,
  jsonReply,
  messageDelta,
  messageObject,
  messageStart,
  messageStop,
  ping,
  sseReply,
  sseText,
  textStream,
  thinkingBlock,
  usageObject,
} from "./anthropic-fixtures.ts";

const provider = new AnthropicMessagesProvider();
const hi: ProviderContext = { messages: [{ role: "user", content: "Hello, Claude" }], systemPrompt: "You are terse." };
const fastRetry = { maxRetries: 2, retryBaseDelayMs: 1 };
const weather: StandardToolDeclaration = {
  name: "get_weather",
  description: "Get the weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

// Collects the telemetry warnings emitted while fn runs; in: the tests that check warn-once fallbacks, out: the warning codes with their data.
async function warnings(fn: () => Promise<unknown> | unknown): Promise<Array<Record<string, unknown>>> {
  const seen: Array<Record<string, unknown>> = [];
  const off = telemetryBus.onEvent((e) => {
    if (e.code === "provider_warning") seen.push((e.data ?? {}) as Record<string, unknown>);
  });
  try {
    await fn();
  } finally {
    off();
  }
  return seen;
}

beforeEach(() => clearEmittedWarnings());

describe("Anthropic mappers", () => {
  it("maps thinking levels to adaptive thinking + effort, with the model's own off switch", async () => {
    const w = await warnings(() => {
      expect(mapThinkingLevelToAnthropic(undefined, undefined, "r")).toEqual({});
      expect(mapThinkingLevelToAnthropic("dynamic", undefined, "r")).toEqual({});
      for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
        expect(mapThinkingLevelToAnthropic(level, undefined, "r")).toEqual({
          thinking: { type: "adaptive", display: "summarized" },
          effort: level,
        });
      }
      expect(mapThinkingLevelToAnthropic("minimal", undefined, "r")).toEqual({
        thinking: { type: "adaptive", display: "summarized" },
        effort: "low",
      });
      expect(mapThinkingLevelToAnthropic("none", { type: "between_tools" }, "r")).toEqual({ thinking: { type: "between_tools" } });
      expect(mapThinkingLevelToAnthropic("none", undefined, "r")).toEqual({ effort: "low" });
    });
    expect(w.map((x) => x["requested"])).toEqual(["minimal (r)", "none (r)"]);
  });

  it("maps service tier: priority is auto, flex warns and is dropped", async () => {
    const w = await warnings(() => {
      expect(mapServiceTierToAnthropic(undefined)).toBeUndefined();
      expect(mapServiceTierToAnthropic("priority")).toBe("auto");
      expect(mapServiceTierToAnthropic("flex")).toBeUndefined();
    });
    expect(w.length).toBe(1);
  });

  it("maps tool choice, falling back to auto where forced use is a 400", async () => {
    const pin = { type: "function" as const, function: { name: "get_weather" } };
    const w = await warnings(() => {
      expect(mapToolChoiceToAnthropic("auto", true, "r")).toBeUndefined();
      expect(mapToolChoiceToAnthropic(undefined, true, "r")).toBeUndefined();
      expect(mapToolChoiceToAnthropic("none", false, "r")).toEqual({ type: "none" });
      expect(mapToolChoiceToAnthropic("required", true, "r")).toEqual({ type: "any" });
      expect(mapToolChoiceToAnthropic(pin, true, "r")).toEqual({ type: "tool", name: "get_weather" });
      expect(mapToolChoiceToAnthropic("required", false, "r")).toBeUndefined();
      expect(mapToolChoiceToAnthropic("validated", true, "r")).toBeUndefined();
    });
    expect(w.length).toBe(2);
  });

  it("cleans a schema to Anthropic's subset: closed objects, constraints moved into the description", () => {
    const cleaned = anthropicSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        age: { type: "integer", minimum: 0, maximum: 150 },
        email: { type: "string", format: "email", minLength: 3 },
        site: { type: "string", format: "hostname-ish" },
        tags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
        nested: { type: "object", properties: { x: { type: "number", multipleOf: 2 } }, additionalProperties: { type: "string" } },
        either: { oneOf: [{ type: "string" }, { type: "object", properties: {} }] },
      },
      required: ["age"],
    });
    const p = (cleaned["properties"] as Record<string, Record<string, unknown>>);
    expect(cleaned["$schema"]).toBeUndefined();
    expect(cleaned["additionalProperties"]).toBe(false);
    expect(p["age"]).toEqual({ type: "integer", description: "(minimum: 0; maximum: 150)" });
    expect(p["email"]).toEqual({ type: "string", format: "email", description: "(minLength: 3)" });
    expect(p["site"]).toEqual({ type: "string", description: "(format: hostname-ish)" });
    expect(p["tags"]!["maxItems"]).toBeUndefined();
    expect(p["tags"]!["minItems"]).toBeUndefined();
    expect(p["tags"]!["description"]).toBe("(maxItems: 5; minItems: 2)");
    expect(p["nested"]!["additionalProperties"]).toBe(false);
    expect((p["nested"]!["properties"] as Record<string, unknown>)["x"]).toEqual({ type: "number", description: "(multipleOf: 2)" });
    expect(p["either"]!["oneOf"]).toBeUndefined();
    expect((p["either"]!["anyOf"] as Array<Record<string, unknown>>)[1]!["additionalProperties"]).toBe(false);
  });

  it("maps a structured-output spec to output_config.format with no name or strict flag", () => {
    expect(mapOutputToAnthropic(undefined)).toBeUndefined();
    const m = mapOutputToAnthropic({ name: "answer", strict: true, schema: { type: "object", properties: { a: { type: "string" } } } });
    expect(m).toEqual({
      format: { type: "json_schema", schema: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false } },
    });
  });
});

describe("Anthropic generate: request", () => {
  it("sends the documented headers and a minimal body (no sampling params, top-level cache_control, required max_tokens)", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn });
    const c = api.calls[0]!;
    expect(c.url).toBe(BASE + "/messages");
    expect(c.init.method).toBe("POST");
    expect(c.headers.get("x-api-key")).toBe(API_KEY);
    expect(c.headers.get("anthropic-version")).toBe("2026-10-21");
    expect(c.headers.get("content-type")).toBe("application/json");
    expect(c.headers.get("user-agent")).toMatch(/^Agent-Accelerator\//);
    expect(c.headers.get("anthropic-beta")).toBeNull(); // no beta feature is used
    expect(c.headers.get("authorization")).toBeNull();
    expect(c.headers.get("x-session-id")).toBeNull(); // Anthropic caches by prefix: no affinity headers
    expect(c.body).toEqual({
      model: MODEL,
      max_tokens: expect.any(Number),
      messages: [{ role: "user", content: [{ type: "text", text: "Hello, Claude" }] }],
      system: "You are terse.",
      cache_control: { type: "ephemeral" },
    });
    expect(c.body.max_tokens).toBeGreaterThan(0);
    expect(c.body.max_tokens).toBeLessThanOrEqual(64_000);
    for (const k of ["temperature", "top_p", "top_k", "stream", "thinking", "tools", "tool_choice", "output_config"]) expect(k in c.body).toBe(false);
  });

  it("strips the anthropic/ prefix, honours maxOutputTokens and a caller-set anthropic-version", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate("anthropic/" + MODEL, hi, {
      apiKey: API_KEY,
      fetch: api.fn,
      maxOutputTokens: 777.9,
      headers: { "Anthropic-Version": "2023-06-01", "X-Team": "ops" },
    });
    const c = api.calls[0]!;
    expect(c.body.model).toBe(MODEL);
    expect(c.body.max_tokens).toBe(777);
    expect(c.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(c.headers.get("x-team")).toBe("ops");
  });

  it("records the audit request with the key redacted and the response with every header", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    const res = await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn });
    expect(res.raw.request.url).toBe(BASE + "/messages");
    expect(res.raw.request.headers["x-api-key"]).toBe("[REDACTED]");
    expect(JSON.stringify(res.raw.request)).not.toContain(API_KEY);
    expect(res.raw.response!.status).toBe(200);
    expect(res.raw.response!.headers["request-id"]).toBe("req_011CVr7pJqKmWx4nBd2LsYhE");
    expect(res.raw.response!.headers["anthropic-ratelimit-tokens-remaining"]).toBe("2398000");
    expect(res.raw.response!.headers["anthropic-organization-id"]).toBeDefined();
    expect((res.raw.response!.body as { id: string }).id).toMatch(/^msg_/);
  });

  it("uses a custom endpoint, the base_urls-style baseUrl option, and an Authorization header in place of the key", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    // A proxy that authenticates by itself: the validator accepts any Authorization header.
    const fn = (async (url: string, init: RequestInit) => api.fn(url.replace("https://gateway.example/anthropic", "https://api.anthropic.com/v1"), init)) as unknown as typeof fetch;
    await provider.generate(MODEL, hi, {
      baseUrl: "https://gateway.example/anthropic/",
      headers: { Authorization: "Bearer proxy-token" },
      fetch: fn,
    });
    expect(api.calls[0]!.headers.get("authorization")).toBe("Bearer proxy-token");
    expect(api.calls[0]!.headers.get("x-api-key")).toBeNull();
  });

  it("fails before the network without a key", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    const keep = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      await expect(provider.generate(MODEL, hi, { fetch: api.fn })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      if (keep !== undefined) process.env["ANTHROPIC_API_KEY"] = keep;
    }
    expect(api.calls.length).toBe(0);
  });

  it("sends service_tier auto for priority", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn, serviceTier: "priority" });
    expect(api.calls[0]!.body.service_tier).toBe("auto");
  });
});

describe("Anthropic generate: response", () => {
  it("maps text, ids, finish reason and the full usage object (cache buckets added to input)", async () => {
    const usage = usageObject({
      input_tokens: 2095,
      cache_creation_input_tokens: 2051,
      cache_read_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 2051, ephemeral_1h_input_tokens: 0 },
      output_tokens: 503,
      output_tokens_details: { thinking_tokens: 120 },
    });
    const api = anthropicApi([jsonReply(messageObject({ usage, content: [{ type: "text", text: "Hi! My name is Claude.", citations: null }] }))]);
    const res = await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn });
    expect(res.text).toBe("Hi! My name is Claude.");
    expect(res.finishReason).toBe("stop");
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe(MODEL);
    expect(res.responseId).toMatch(/^msg_/);
    expect(res.usage).toEqual({
      inputTokens: 2095 + 2051 + 1000,
      outputTokens: 503,
      totalTokens: 2095 + 2051 + 1000 + 503,
      cachedTokens: 1000,
      cacheReadTokens: 1000,
      cacheWriteTokens: 2051,
      thinkingTokens: 120,
    });
    expect(res.usage.cacheReadTokens! + res.usage.cacheWriteTokens!).toBeLessThanOrEqual(res.usage.inputTokens);
  });

  it("maps every stop_reason", async () => {
    const cases: Array<[string, string]> = [
      ["end_turn", "stop"],
      ["stop_sequence", "stop"],
      ["max_tokens", "length"],
      ["model_context_window_exceeded", "length"],
      ["refusal", "refusal"],
      ["pause_turn", "stop"],
    ];
    for (const [wire, canonical] of cases) {
      const api = anthropicApi([jsonReply(messageObject({ stop_reason: wire }))]);
      expect((await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn })).finishReason).toBe(canonical);
    }
  });

  it("maps parallel tool_use blocks with their provider ids and finish reason tool_calls", async () => {
    const content = [
      { type: "text", text: "Checking both.", citations: null },
      { type: "tool_use", id: "toolu_01D7FLrfh4GYq7yT1ULFeyMV", name: "get_weather", input: { city: "Paris" }, caller: { type: "direct" } },
      { type: "tool_use", id: "toolu_01T1x1fJ34qAmk2tNTrN7Up6", name: "get_weather", input: { city: "Rome" }, caller: { type: "direct" } },
    ];
    const api = anthropicApi([jsonReply(messageObject({ content, stop_reason: "tool_use" }))]);
    const res = await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn, tools: [weather] });
    expect(res.finishReason).toBe("tool_calls");
    expect(res.text).toBe("Checking both.");
    expect(res.toolCalls!.map((c) => [c.id, c.name, c.arguments])).toEqual([
      ["toolu_01D7FLrfh4GYq7yT1ULFeyMV", "get_weather", { city: "Paris" }],
      ["toolu_01T1x1fJ34qAmk2tNTrN7Up6", "get_weather", { city: "Rome" }],
    ]);
    expect(res.toolCalls![0]!.rawArguments).toBe('{"city":"Paris"}');
    expect(api.calls[0]!.body.tools).toEqual([
      { name: "get_weather", description: "Get the weather for a city.", input_schema: weather.parameters },
    ]);
  });

  it("keeps a length finish reason when max_tokens cut a tool call", async () => {
    const content = [{ type: "tool_use", id: "toolu_01cut", name: "get_weather", input: {} }];
    const api = anthropicApi([jsonReply(messageObject({ content, stop_reason: "max_tokens" }))]);
    const res = await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn, tools: [weather] });
    expect(res.finishReason).toBe("length");
    expect(res.toolCalls![0]!.arguments).toEqual({ __truncated_raw: "{}" }); // never executed
  });

  it("maps thinking text and stores the raw blocks (signature, redacted_thinking) as providerSteps", async () => {
    const t1 = thinkingBlock("The user greets me; answer briefly.");
    const content = [t1, { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpP" }, { type: "text", text: "Hello!", citations: null }];
    const api = anthropicApi([jsonReply(messageObject({ content }))]);
    const res = await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn, thinking: { level: "high" } });
    expect(res.thinking).toBe("The user greets me; answer briefly.");
    expect(res.providerSteps).toEqual({
      provider: "anthropic",
      steps: [t1, { type: "redacted_thinking", data: expect.any(String) }, { type: "text", text: "Hello!" }],
    });
    expect(api.calls[0]!.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(api.calls[0]!.body.output_config).toEqual({ effort: "high" });
  });

  it("stores no providerSteps when there is no thinking (the canonical parts rebuild the turn)", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    const res = await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn });
    expect(res.providerSteps).toBeUndefined();
  });

  it("rejects an invalid JSON 200 body with a concise provider error", async () => {
    const fn = (async () => new Response("<html>gateway</html>", { status: 200, headers: anthropicHeaders() })) as unknown as typeof fetch;
    await expect(provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: fn })).rejects.toThrow(/request failed \(200\).*gateway/);
  });
});

describe("Anthropic thinking, caching and output options on the wire", () => {
  it("turns thinking off the way each model allows, else warns and uses the lowest effort", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate("claude-sonnet-5-5", hi, { apiKey: API_KEY, fetch: api.fn, thinking: { level: "none" } });
    expect(api.calls[0]!.body.thinking).toEqual({ type: "between_tools" });
    await provider.generate("claude-haiku-5-5", hi, { apiKey: API_KEY, fetch: api.fn, thinking: { level: "none" } });
    expect(api.calls[1]!.body.thinking).toEqual({ type: "disabled" });
    const w = await warnings(() => provider.generate("claude-opus-5-5", hi, { apiKey: API_KEY, fetch: api.fn, thinking: { level: "none" } }));
    expect(api.calls[2]!.body.thinking).toBeUndefined();
    expect(api.calls[2]!.body.output_config).toEqual({ effort: "low" });
    expect(w[0]!["capability"]).toBe("thinking level");
  });

  it("maps the cache option: implicit/unset = automatic 5m breakpoint, 5m and 1h explicit, others warn once", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    const run = (cache?: "implicit" | "5m" | "30m" | "1h" | "12h") => provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn, cache });
    await run();
    await run("implicit");
    await run("5m");
    await run("1h");
    const w = await warnings(async () => {
      await run("12h");
      await run("12h");
    });
    expect(api.calls.map((c) => c.body.cache_control)).toEqual([
      { type: "ephemeral" },
      { type: "ephemeral" },
      { type: "ephemeral", ttl: "5m" },
      { type: "ephemeral", ttl: "1h" },
      { type: "ephemeral" },
      { type: "ephemeral" },
    ]);
    expect(w.length).toBe(1);
  });

  it("sends structured output as output_config.format next to effort, with the schema cleaned", async () => {
    const api = anthropicApi([jsonReply(messageObject({ content: [{ type: "text", text: '{"name":"John","age":3}', citations: null }] }))]);
    await provider.generate(MODEL, hi, {
      apiKey: API_KEY,
      fetch: api.fn,
      thinking: { level: "medium" },
      output: {
        name: "person",
        strict: true,
        schema: { type: "object", properties: { name: { type: "string" }, age: { type: "integer", minimum: 0 } }, required: ["name", "age"] },
      },
    });
    expect(api.calls[0]!.body.output_config).toEqual({
      effort: "medium",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { name: { type: "string" }, age: { type: "integer", description: "(minimum: 0)" } },
          required: ["name", "age"],
          additionalProperties: false,
        },
      },
    });
  });

  it("makes a strict tool's schema valid for the grammar and leaves a normal tool's schema alone", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    const strictTool: StandardToolDeclaration = { name: "lookup", description: "d", strict: true, parameters: { type: "object", properties: { id: { type: "integer", minimum: 1 } } } };
    await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn, tools: [strictTool, weather] });
    const [s, w] = api.calls[0]!.body.tools;
    expect(s.strict).toBe(true);
    expect(s.input_schema.additionalProperties).toBe(false);
    expect(s.input_schema.properties.id).toEqual({ type: "integer", description: "(minimum: 1)" });
    expect(w.input_schema).toEqual(weather.parameters);
    expect("strict" in w).toBe(false);
  });

  it("sends tool_choice where the model allows it and warns + falls back where it would be a 400", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate("claude-haiku-5-5", hi, { apiKey: API_KEY, fetch: api.fn, tools: [weather], toolChoice: "required" });
    expect(api.calls[0]!.body.tool_choice).toEqual({ type: "any" });
    await provider.generate("claude-haiku-5-5", hi, {
      apiKey: API_KEY,
      fetch: api.fn,
      tools: [weather],
      toolChoice: { type: "function", function: { name: "get_weather" } },
    });
    expect(api.calls[1]!.body.tool_choice).toEqual({ type: "tool", name: "get_weather" });
    await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn, tools: [weather], toolChoice: "none" });
    expect(api.calls[2]!.body.tool_choice).toEqual({ type: "none" });
    const w = await warnings(() => provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn, tools: [weather], toolChoice: "required" }));
    expect(api.calls[3]!.body.tool_choice).toBeUndefined(); // the real API would answer 400 here
    expect(w.length).toBe(1);
  });
});

describe("Anthropic history", () => {
  const callPart = (id: string, city: string) => ({ type: "tool_call" as const, id, name: "get_weather", arguments: { city } });
  const resultPart = (id: string, result: unknown, isError = false) => ({ type: "tool_result" as const, id, name: "get_weather", result, isError });

  it("pairs parallel tool calls with their results in ONE user message, results first, then a steer text", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate(MODEL, {
      messages: [
        { role: "user", content: "Weather in Paris and Rome?" },
        { role: "assistant", content: [{ type: "text", text: "Checking." }, callPart("toolu_01A", "Paris"), callPart("toolu_01B", "Rome")] },
        { role: "tool", content: [resultPart("toolu_01A", { temp: 21 }), resultPart("toolu_01B", "sunny", false)] },
        { role: "user", content: "Also keep it short." },
      ],
    }, { apiKey: API_KEY, fetch: api.fn, tools: [weather] });
    const m = api.calls[0]!.body.messages;
    expect(m.map((x: { role: string }) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(m[1].content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_01A", name: "get_weather", input: { city: "Paris" } },
      { type: "tool_use", id: "toolu_01B", name: "get_weather", input: { city: "Rome" } },
    ]);
    expect(m[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_01A", content: '{"temp":21}' },
      { type: "tool_result", tool_use_id: "toolu_01B", content: "sunny" },
      { type: "text", text: "Also keep it short." },
    ]);
  });

  it("moves tool_result blocks ahead of text that arrived before them (the API requires them first)", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate(MODEL, {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [callPart("toolu_01A", "A")] },
        { role: "user", content: "a steer typed while the tool ran" },
        { role: "tool", content: [resultPart("toolu_01A", "done")] },
      ],
    }, { apiKey: API_KEY, fetch: api.fn, tools: [weather] });
    expect(api.calls[0]!.body.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_01A", content: "done" },
      { type: "text", text: "a steer typed while the tool ran" },
    ]);
  });

  it("marks failed tool results with is_error and drops an empty result's content", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate(MODEL, {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [callPart("toolu_01A", "x"), callPart("toolu_01B", "y")] },
        { role: "tool", content: [resultPart("toolu_01A", "Error executing get_weather: boom", true), resultPart("toolu_01B", "")] },
      ],
    }, { apiKey: API_KEY, fetch: api.fn, tools: [weather] });
    expect(api.calls[0]!.body.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_01A", content: "Error executing get_weather: boom", is_error: true },
      { type: "tool_result", tool_use_id: "toolu_01B" },
    ]);
  });

  it("makes ids from other providers valid, the same on the call and on its result", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate(MODEL, {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_call", id: "fc_abc|call_9", callId: "call_9", name: "get_weather", arguments: { city: "A" } }, { type: "tool_call", id: "call:weird id#2", name: "get_weather", arguments: { city: "B" } }] },
        { role: "tool", content: [{ type: "tool_result", id: "fc_abc|call_9", name: "get_weather", result: "ok" }, { type: "tool_result", id: "call:weird id#2", name: "get_weather", result: "ok2" }] },
      ],
    }, { apiKey: API_KEY, fetch: api.fn, tools: [weather] });
    const m = api.calls[0]!.body.messages;
    expect(m[1].content.map((b: { id: string }) => b.id)).toEqual(["call_9", "call_weird_id_2"]);
    expect(m[2].content.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual(["call_9", "call_weird_id_2"]);
  });

  it("pairs plain-text tool messages with their calls by name, in order", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate(MODEL, {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [callPart("toolu_01A", "A"), callPart("toolu_01B", "B")] },
        { role: "tool", content: "first result", name: "get_weather" },
        { role: "tool", content: "second result", name: "get_weather" },
      ],
    }, { apiKey: API_KEY, fetch: api.fn, tools: [weather] });
    expect(api.calls[0]!.body.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_01A", content: "first result" },
      { type: "tool_result", tool_use_id: "toolu_01B", content: "second result" },
    ]);
  });

  it("never resends a cut-off tool call's arguments marker", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate(MODEL, {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_call", id: "toolu_01A", name: "get_weather", arguments: { __truncated_raw: '{"city": "Par' } }] },
        { role: "tool", content: [resultPart("toolu_01A", "Error: arguments were cut off")] },
      ],
    }, { apiKey: API_KEY, fetch: api.fn, tools: [weather] });
    expect(api.calls[0]!.body.messages[1].content[0].input).toEqual({});
  });

  it("replays the current tool loop's thinking blocks unmodified and drops older turns' thinking", async () => {
    const old = thinkingBlock("old turn thinking");
    const cur = thinkingBlock("I should call the weather tool.");
    const redacted = { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpP" };
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate(MODEL, {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "Hello!" }], providerSteps: { provider: "anthropic", steps: [old, { type: "text", text: "Hello!" }] } },
        { role: "user", content: "Weather in Paris?" },
        {
          role: "assistant",
          content: [{ type: "text", text: "On it." }, callPart("toolu_01A", "Paris")],
          providerSteps: { provider: "anthropic", steps: [cur, redacted, { type: "text", text: "On it." }, { type: "tool_use", id: "toolu_01A", name: "get_weather", input: { city: "Paris" } }] },
        },
        { role: "tool", content: [resultPart("toolu_01A", "21C")] },
      ],
    }, { apiKey: API_KEY, fetch: api.fn, tools: [weather], thinking: { level: "high" } });
    const m = api.calls[0]!.body.messages;
    expect(m[1].content).toEqual([{ type: "text", text: "Hello!" }]); // finished turn: no thinking resent
    expect(m[3].content).toEqual([cur, redacted, { type: "text", text: "On it." }, { type: "tool_use", id: "toolu_01A", name: "get_weather", input: { city: "Paris" } }]);
  });

  it("the fake API rejects a modified thinking block (so the replay above is what makes the request valid)", async () => {
    const cur = thinkingBlock("original thinking");
    const api = anthropicApi([jsonReply(messageObject())]);
    const tampered = { ...cur, thinking: "edited" };
    await expect(
      provider.generate(MODEL, {
        messages: [
          { role: "user", content: "Weather?" },
          { role: "assistant", content: [callPart("toolu_01A", "P")], providerSteps: { provider: "anthropic", steps: [tampered, { type: "tool_use", id: "toolu_01A", name: "get_weather", input: { city: "P" } }] } },
          { role: "tool", content: [resultPart("toolu_01A", "ok")] },
        ],
      }, { apiKey: API_KEY, fetch: api.fn, tools: [weather] })
    ).rejects.toThrow(/cannot be modified/);
    expect(issuedThinking.size).toBeGreaterThan(0);
  });

  it("ignores another provider's providerSteps and never rebuilds a signature-less thinking block", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate(MODEL, {
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "from elsewhere" }, callPart("toolu_01A", "P")],
          providerSteps: { provider: "google", steps: [{ type: "thought", signature: "x" }] },
        },
        { role: "tool", content: [resultPart("toolu_01A", "ok")] },
      ],
    }, { apiKey: API_KEY, fetch: api.fn, tools: [weather] });
    expect(api.calls[0]!.body.messages[1].content).toEqual([{ type: "tool_use", id: "toolu_01A", name: "get_weather", input: { city: "P" } }]);
  });

  it("skips empty turns and merges neighbours of one role so roles always alternate", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate(MODEL, {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "" },
        { role: "user", content: "second" },
        { role: "assistant", content: [] },
        { role: "user", content: [{ type: "text", text: "third" }] },
      ],
    }, { apiKey: API_KEY, fetch: api.fn });
    expect(api.calls[0]!.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }, { type: "text", text: "third" }] },
    ]);
  });
});

describe("Anthropic media input", () => {
  // 1x1 PNG, a tiny PDF header and plain text, as raw bytes.
  const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF");

  it("sends images as base64 or url sources and documents as pdf/text sources", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    await provider.generate(MODEL, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Compare these." },
            { type: "image", image: PNG, mimeType: "image/png" },
            { type: "image", image: "https://example.com/cat.webp" },
            { type: "file", file: PDF, mimeType: "application/pdf", filename: "report.pdf" },
            { type: "file", file: "https://example.com/paper.pdf" },
            { type: "file", file: new TextEncoder().encode("plain notes ünï"), mimeType: "text/plain", filename: "notes.txt" },
          ],
        },
      ],
    }, { apiKey: API_KEY, fetch: api.fn });
    const blocks = api.calls[0]!.body.messages[0].content;
    expect(blocks[0]).toEqual({ type: "text", text: "Compare these." });
    expect(blocks[1].type).toBe("image");
    expect(blocks[1].source).toEqual({ type: "base64", media_type: "image/png", data: expect.stringMatching(/^iVBOR/) });
    expect(blocks[2]).toEqual({ type: "image", source: { type: "url", url: "https://example.com/cat.webp" } });
    expect(blocks[3]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: expect.any(String) }, title: "report.pdf" });
    expect(blocks[4]).toEqual({ type: "document", source: { type: "url", url: "https://example.com/paper.pdf" } });
    expect(blocks[5]).toEqual({ type: "document", source: { type: "text", media_type: "text/plain", data: "plain notes ünï" }, title: "notes.txt" });
  });

  it("rejects audio, video and unsupported file or image types before the network, naming the remedy", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    const run = (part: Record<string, unknown>) => provider.generate(MODEL, { messages: [{ role: "user", content: [part as never] }] }, { apiKey: API_KEY, fetch: api.fn });
    await expect(run({ type: "audio", audio: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" })).rejects.toThrow(/unsupported audio input/);
    await expect(run({ type: "video", video: new Uint8Array([1, 2, 3]), mimeType: "video/mp4" })).rejects.toThrow(/unsupported video input/);
    await expect(run({ type: "file", file: new Uint8Array([1, 2, 3]), mimeType: "application/zip" })).rejects.toThrow(/unsupported file type application\/zip/);
    await expect(run({ type: "image", image: new Uint8Array([1, 2, 3]), mimeType: "image/bmp" })).rejects.toBeInstanceOf(ValidationError);
    expect(api.calls.length).toBe(0);
  });
});

describe("Anthropic HTTP errors", () => {
  const ask = (api: ReturnType<typeof anthropicApi>) => provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn, ...fastRetry });

  it("maps each documented error to a one-line provider error with status, type, request id and retryability", async () => {
    const table: Array<[number, string, string, boolean]> = [
      [400, "invalid_request_error", "messages: Field required", false],
      [401, "authentication_error", "invalid x-api-key", false],
      [402, "billing_error", "Your credit balance is too low.", false],
      [403, "permission_error", "Your API key does not have permission to use the specified resource.", false],
      [404, "not_found_error", "model: claude-nope", false],
      [413, "request_too_large", "Request exceeds the maximum allowed number of bytes.", false],
    ];
    for (const [status, type, message, retryable] of table) {
      const api = anthropicApi([errorReply(status, type, message)]);
      const err = (await ask(api).catch((e: unknown) => e)) as Error & Record<string, unknown>;
      expect(err.message).toContain(message);
      expect(err.message).toContain("(request_id req_011CVr7pJqKmWx4nBd2LsYhE)");
      expect(err.message).not.toContain("\n");
      expect(err["statusCode"]).toBe(status);
      expect(err["errorType"]).toBe(type);
      expect(err["retryable"]).toBe(retryable);
      expect(api.calls.length).toBe(1); // not retried
    }
  });

  it("adds a key hint to a 401", async () => {
    const api = anthropicApi([errorReply(401, "authentication_error", "invalid x-api-key")]);
    await expect(ask(api)).rejects.toThrow(/Check ANTHROPIC_API_KEY/);
  });

  it("retries 429 (honouring retry-after), 500, 504 and 529 overloaded, then succeeds", async () => {
    for (const [status, type] of [[429, "rate_limit_error"], [500, "api_error"], [504, "timeout_error"], [529, "overloaded_error"]] as const) {
      const api = anthropicApi([errorReply(status, type, "try again", { headers: { "retry-after": "0" } }), jsonReply(messageObject())]);
      const res = await ask(api);
      expect(res.text).toBe("Hello! How can I help?");
      expect(api.calls.length).toBe(2);
    }
  });

  it("gives up after the retries and surfaces the last error as retryable", async () => {
    const api = anthropicApi([errorReply(529, "overloaded_error", "Overloaded")]);
    const err = (await ask(api).catch((e: unknown) => e)) as Error & Record<string, unknown>;
    expect(api.calls.length).toBe(3);
    expect(err["statusCode"]).toBe(529);
    expect(err["retryable"]).toBe(true);
  });

  it("never retries the monthly spend-cap 429 (no retry-after, error_code enforced_spend_limit_reached)", async () => {
    const api = anthropicApi([
      errorReply(429, "rate_limit_error", "You have reached your API usage limits: your organization has crossed its monthly API usage threshold. You will regain access on 2026-12-01 at 00:00 UTC.", {
        details: { error_code: "enforced_spend_limit_reached" },
      }),
    ]);
    const err = (await ask(api).catch((e: unknown) => e)) as Error & Record<string, unknown>;
    expect(api.calls.length).toBe(1);
    expect(err["retryable"]).toBe(false);
    expect(err["providerCode"]).toBe("enforced_spend_limit_reached");
  });

  it("reads Retry-After from an ordinary 429", async () => {
    const api = anthropicApi([errorReply(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit", { headers: { "retry-after": "30" } })]);
    const err = (await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: api.fn, maxRetries: 0 }).catch((e: unknown) => e)) as Record<string, unknown>;
    expect(err["retryAfterMs"]).toBe(30_000);
    expect(err["retryable"]).toBe(true);
  });

  it("degrades a non-JSON gateway error page to a short one-line message", async () => {
    const fn = (async () => new Response("<html>\n<h1>502 Bad Gateway</h1>\n</html>", { status: 502, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const err = (await provider.generate(MODEL, hi, { apiKey: API_KEY, fetch: fn, maxRetries: 0 }).catch((e: unknown) => e)) as Error & Record<string, unknown>;
    expect(err["statusCode"]).toBe(502);
    expect(err.message).not.toContain("\n");
  });

  it("the fake API's own 400s reach the caller (an invalid request is never silently accepted)", async () => {
    const api = anthropicApi([jsonReply(messageObject())]);
    // A trailing assistant message would be prefill, which every 4.6+ model rejects.
    await expect(
      provider.generate(MODEL, { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }, { apiKey: API_KEY, fetch: api.fn })
    ).rejects.toThrow(/does not support assistant message prefill/);
  });
});

describe("Anthropic stream", () => {
  // Reads a whole stream: its events and its final response.
  async function drain(stream: ReturnType<AnthropicMessagesProvider["stream"]>) {
    const events: Array<Record<string, any>> = [];
    for await (const e of stream) events.push(e as Record<string, any>);
    return { events, res: await stream.result() };
  }
  const run = (api: ReturnType<typeof anthropicApi>, extra: Record<string, unknown> = {}, ctx: ProviderContext = hi) =>
    provider.stream(MODEL, ctx, { apiKey: API_KEY, fetch: api.fn, ...fastRetry, ...extra });

  it("streams the documented text example: deltas, ping ignored, usage, headers and the stream request flag", async () => {
    const api = anthropicApi([sseReply(textStream(["Hello", "!", " How can I help?"], { output_tokens: 15 }))]);
    const { events, res } = await drain(run(api));
    expect(api.calls[0]!.body.stream).toBe(true);
    expect(api.calls[0]!.headers.get("accept")).toBeNull(); // the API streams on stream:true alone
    expect(events.filter((e) => e["type"] === "text_delta").map((e) => e["delta"])).toEqual(["Hello", "!", " How can I help?"]);
    expect(res.text).toBe("Hello! How can I help?");
    expect(res.finishReason).toBe("stop");
    expect(res.usage).toMatchObject({ inputTokens: 25, outputTokens: 15, totalTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(res.responseId).toMatch(/^msg_/);
    const raw = res.raw.response!;
    expect(raw.headers["request-id"]).toBe("req_011CVr7pJqKmWx4nBd2LsYhE");
    expect(raw.headers["content-type"]).toContain("text/event-stream");
    expect((raw.body as { content: unknown[]; stop_reason: string }).stop_reason).toBe("end_turn");
    expect(res.raw.request.headers["x-api-key"]).toBe("[REDACTED]");
  });

  it("merges cumulative usage: input and cache from message_start, output (and later fields) from message_delta, nulls keep earlier values", async () => {
    const api = anthropicApi([
      sseReply([
        messageStart({ input_tokens: 10, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 2 }),
        blockStart(0, { type: "text", text: "" }),
        blockDelta(0, { type: "text_delta", text: "ok" }),
        blockStop(0),
        messageDelta("end_turn", { input_tokens: null, cache_read_input_tokens: null, output_tokens: 89, output_tokens_details: { thinking_tokens: 40 } }),
        messageStop,
      ]),
    ]);
    const { res } = await drain(run(api));
    expect(res.usage).toEqual({
      inputTokens: 10 + 300 + 4000,
      outputTokens: 89,
      totalTokens: 10 + 300 + 4000 + 89,
      cachedTokens: 4000,
      cacheReadTokens: 4000,
      cacheWriteTokens: 300,
      thinkingTokens: 40,
    });
  });

  it("streams the documented tool-use example (text then tool_use, partial JSON, empty first delta) and keeps provider ids", async () => {
    const api = anthropicApi([
      sseReply([
        messageStart({ input_tokens: 472, output_tokens: 2 }),
        blockStart(0, { type: "text", text: "" }),
        ping,
        blockDelta(0, { type: "text_delta", text: "Okay" }),
        blockStop(0),
        blockStart(1, { type: "tool_use", id: "toolu_01T1x1fJ34qAmk2tNTrN7Up6", name: "get_weather", input: {} }),
        blockDelta(1, { type: "input_json_delta", partial_json: "" }),
        blockDelta(1, { type: "input_json_delta", partial_json: '{"city":' }),
        blockDelta(1, { type: "input_json_delta", partial_json: ' "San' }),
        blockDelta(1, { type: "input_json_delta", partial_json: ' Francisc' }),
        blockDelta(1, { type: "input_json_delta", partial_json: 'o"}' }),
        blockStop(1),
        messageDelta("tool_use", { output_tokens: 89 }),
        messageStop,
      ]),
    ]);
    const { events, res } = await drain(run(api, { tools: [weather] }));
    expect(res.finishReason).toBe("tool_calls");
    expect(res.text).toBe("Okay");
    expect(res.toolCalls).toEqual([
      { id: "toolu_01T1x1fJ34qAmk2tNTrN7Up6", name: "get_weather", arguments: { city: "San Francisco" }, rawArguments: '{"city": "San Francisco"}' },
    ]);
    expect(events.filter((e) => e["type"] === "tool_call_complete").length).toBe(1);
  });

  it("treats a tool with no arguments as {} and runs two parallel calls by index", async () => {
    const api = anthropicApi([
      sseReply([
        messageStart(),
        blockStart(0, { type: "tool_use", id: "toolu_01A", name: "get_weather", input: {} }),
        blockStart(1, { type: "tool_use", id: "toolu_01B", name: "get_weather", input: {} }),
        blockDelta(1, { type: "input_json_delta", partial_json: '{"city":"Rome"}' }),
        blockDelta(0, { type: "input_json_delta", partial_json: "" }),
        blockStop(0),
        blockStop(1),
        messageDelta("tool_use"),
        messageStop,
      ]),
    ]);
    const { res } = await drain(run(api, { tools: [weather] }));
    expect(res.toolCalls!.map((c) => [c.id, c.arguments])).toEqual([["toolu_01A", {}], ["toolu_01B", { city: "Rome" }]]);
  });

  it("assembles a thinking stream (summarized deltas + signature) into providerSteps that replay exactly", async () => {
    const api = anthropicApi([
      sseReply([
        messageStart(),
        blockStart(0, { type: "thinking", thinking: "", signature: "" }),
        blockDelta(0, { type: "thinking_delta", thinking: "I need to find the GCD of 1071 and 462" }),
        blockDelta(0, { type: "thinking_delta", thinking: " using the Euclidean algorithm." }),
        blockDelta(0, { type: "signature_delta", signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds" }),
        blockStop(0),
        blockStart(1, { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpP" }),
        blockStop(1),
        blockStart(2, { type: "text", text: "" }),
        blockDelta(2, { type: "text_delta", text: "The GCD is **21**." }),
        blockStop(2),
        messageDelta("end_turn", { output_tokens: 150, output_tokens_details: { thinking_tokens: 100 } }),
        messageStop,
      ]),
    ]);
    const { events, res } = await drain(run(api, { thinking: { level: "high" } }));
    expect(events.filter((e) => e["type"] === "thinking_delta").length).toBe(2);
    expect(res.thinking).toBe("I need to find the GCD of 1071 and 462 using the Euclidean algorithm.");
    expect(res.usage.thinkingTokens).toBe(100);
    expect(res.providerSteps).toEqual({
      provider: "anthropic",
      steps: [
        { type: "thinking", thinking: "I need to find the GCD of 1071 and 462 using the Euclidean algorithm.", signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds" },
        { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpP" },
        { type: "text", text: "The GCD is **21**." },
      ],
    });
  });

  it("handles display omitted (empty thinking text, one signature) and a message_delta without usage", async () => {
    const api = anthropicApi([
      sseReply([
        messageStart(),
        blockStart(0, { type: "thinking", thinking: "", signature: "" }),
        blockDelta(0, { type: "thinking_delta", thinking: "" }),
        blockDelta(0, { type: "signature_delta", signature: "sigOmitted" }),
        blockStop(0),
        blockStart(1, { type: "text", text: "" }),
        blockDelta(1, { type: "text_delta", text: "Done." }),
        blockStop(1),
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
        messageStop,
      ]),
    ]);
    const { events, res } = await drain(run(api));
    expect(events.some((e) => e["type"] === "thinking_delta")).toBe(false);
    expect(res.thinking).toBeUndefined();
    expect(res.providerSteps!.steps[0]).toEqual({ type: "thinking", thinking: "", signature: "sigOmitted" });
    expect(res.usage.inputTokens).toBe(25); // message_start's usage stands
  });

  it("ignores unknown events, unknown deltas and server-tool blocks (forward compatible)", async () => {
    const api = anthropicApi([
      sseReply(
        sseText([messageStart(), { type: "future_event", x: 1 }, blockStart(0, { type: "text", text: "" }), blockDelta(0, { type: "citations_delta", citation: { type: "char_location" } }), blockDelta(0, { type: "text_delta", text: "ok" }), blockStop(0), blockStart(1, { type: "server_tool_use", id: "srvtoolu_01", name: "web_search", input: {} }), blockStop(1), messageDelta("end_turn"), messageStop]) + ": comment line\n\n"
      ),
    ]);
    const { res } = await drain(run(api));
    expect(res.text).toBe("ok");
  });

  it("fails a mid-stream overloaded_error as a retryable provider error (the HTTP status was 200)", async () => {
    const api = anthropicApi([
      sseReply(sseText([messageStart(), blockStart(0, { type: "text", text: "" }), blockDelta(0, { type: "text_delta", text: "par" })]) + sseText([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }])),
    ]);
    const err = (await drain(run(api)).catch((e: unknown) => e)) as Error & Record<string, unknown>;
    expect(err.message).toContain("Overloaded");
    expect(err["statusCode"]).toBe(529);
    expect(err["retryable"]).toBe(true);
    expect(api.calls.length).toBe(1); // a live stream is never retried
  });

  it("fails an invalid_request_error mid-stream as not retryable", async () => {
    const api = anthropicApi([sseReply(sseText([messageStart(), { type: "error", error: { type: "invalid_request_error", message: "bad" } }]))]);
    const err = (await drain(run(api)).catch((e: unknown) => e)) as Record<string, unknown>;
    expect(err["retryable"]).toBe(false);
  });

  it("fails a stream cut before message_stop as incomplete_stream, even after some text", async () => {
    const cut = sseText([messageStart(), blockStart(0, { type: "text", text: "" }), blockDelta(0, { type: "text_delta", text: "Hel" })]);
    const api = anthropicApi([sseReply(cut)]);
    const err = (await drain(run(api)).catch((e: unknown) => e)) as Record<string, unknown>;
    expect(err["code"]).toBe("incomplete_stream");
    expect(err["retryable"]).toBe(true);
  });

  it("accepts a stream whose stop_reason arrived but message_stop did not (every block is complete)", async () => {
    const api = anthropicApi([sseReply(sseText([messageStart(), blockStart(0, { type: "text", text: "" }), blockDelta(0, { type: "text_delta", text: "Hi" }), blockStop(0), messageDelta("end_turn")]))]);
    const { res } = await drain(run(api));
    expect(res.text).toBe("Hi");
  });

  it("never executes a tool call cut mid-JSON: the arguments are the truncated marker and the finish reason stays length", async () => {
    const api = anthropicApi([
      sseReply([
        messageStart(),
        blockStart(0, { type: "tool_use", id: "toolu_01A", name: "get_weather", input: {} }),
        blockDelta(0, { type: "input_json_delta", partial_json: '{"city": "Par' }),
        blockStop(0),
        messageDelta("max_tokens", { output_tokens: 64000 }),
        messageStop,
      ]),
    ]);
    const { res } = await drain(run(api, { tools: [weather] }));
    expect(res.finishReason).toBe("length");
    expect(res.toolCalls![0]!.arguments).toEqual({ __truncated_raw: '{"city": "Par' });
    // The turn is resent as {} (never the marker): history building is covered above.
  });

  it("retries a 529 before the first byte, then streams", async () => {
    const api = anthropicApi([errorReply(529, "overloaded_error", "Overloaded", { headers: { "retry-after": "0" } }), sseReply(textStream(["ok"]))]);
    const { res } = await drain(run(api));
    expect(res.text).toBe("ok");
    expect(api.calls.length).toBe(2);
  });

  it("fails an HTTP error before the stream with the same concise error as generate", async () => {
    const api = anthropicApi([errorReply(401, "authentication_error", "invalid x-api-key")]);
    await expect(drain(run(api))).rejects.toThrow(/Check ANTHROPIC_API_KEY/);
  });

  it("aborts cleanly: the result rejects with AbortError and nothing is left unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const ctrl = new AbortController();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sseText([messageStart(), blockStart(0, { type: "text", text: "" }), blockDelta(0, { type: "text_delta", text: "slow" })])));
          // never closes: the server is still generating
        },
      });
      const fn = (async () => new Response(body, { status: 200, headers: anthropicHeaders({}, "text/event-stream") })) as unknown as typeof fetch;
      const stream = provider.stream(MODEL, hi, { apiKey: API_KEY, fetch: fn, signal: ctrl.signal });
      setTimeout(() => ctrl.abort(), 20);
      await expect(stream.result()).rejects.toMatchObject({ name: "AbortError" });
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
