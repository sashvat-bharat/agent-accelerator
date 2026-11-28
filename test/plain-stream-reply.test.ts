import { describe, it, expect, beforeEach } from "bun:test";
import { z } from "zod";
import { Agent, ProviderError, tool } from "../src/index.ts";
import type { StreamEvent } from "../src/index.ts";
import { clearInteractionChains } from "../src/providers/google.ts";
import { clearSessionRouting } from "../src/providers.ts";

// A stream request answered in one piece (a JSON body, not an event stream), on each of the five adapters.
const WIRES = {
  openai: { model: "openai/gpt-5.5" },
  compat: { model: "groq/test-model", baseUrl: "https://x.test/v1" },
  openrouter: { model: "openrouter/openai/gpt-5.5" },
  anthropic: { model: "anthropic/claude-sonnet-5-5" },
  google: { model: "google/gemini-3.5-flash-lite" },
} as const;
type Wire = keyof typeof WIRES;
const ALL = Object.keys(WIRES) as Wire[];

// The smallest honest whole reply of each wire, with the text "hi".
const GOOD: Record<Wire, unknown> = {
  openai: { id: "r1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] },
  compat: { choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] },
  openrouter: {
    id: "c1",
    choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  },
  anthropic: {
    id: "m1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  google: { id: "i1", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "hi" }] }] },
};

// An error object each wire's proxies send with HTTP 200.
const ERROR: Record<Wire, unknown> = {
  openai: { error: { message: "upstream exploded", code: "proxy_error" } },
  compat: { error: { message: "upstream exploded" } },
  openrouter: { error: { message: "upstream exploded", code: 400 } },
  anthropic: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  google: { error: { code: 503, message: "UNAVAILABLE" } },
};

// A fetch that answers call n with `bodies[n]` (the last one repeats) as HTTP 200 with the given content type, and records the request bodies.
const answers = (bodies: unknown[], type: string | null = "application/json") => {
  const sent: Array<Record<string, unknown>> = [];
  const fn = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
    const body = bodies[Math.min(sent.length - 1, bodies.length - 1)];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: type ? { "content-type": type } : {},
    });
  }) as unknown as typeof fetch;
  return { fn, sent };
};

const agentFor = (wire: Wire, fn: typeof fetch, extra: Record<string, unknown> = {}) =>
  new Agent({
    ...WIRES[wire],
    apiKey: "k",
    fetch: fn,
    runRetries: 0,
    maxTurns: 3,
    retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 },
    ...extra,
  } as never);

// The error a promise rejects with (caught by hand: a failed `toThrow` on an Agent promise spins the test runner).
const failure = (p: Promise<unknown>): Promise<ProviderError> =>
  p.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e as ProviderError
  );

// Every event of one streamed run, and its result.
const streamAll = async (agent: Agent, prompt: string) => {
  const stream = agent.stream(prompt);
  const events: StreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return { events, result: await stream.result() };
};

beforeEach(() => {
  clearInteractionChains();
  clearSessionRouting();
});

describe("a stream request answered in one piece", () => {
  for (const wire of ALL) {
    it(`${wire}: an error reply fails the stream with the error run() reports, never an empty answer`, async () => {
      const viaStream = await failure(agentFor(wire, answers([ERROR[wire]]).fn).stream("hi").result());
      const viaRun = await failure(agentFor(wire, answers([ERROR[wire]]).fn).run("hi"));
      expect(viaStream).toBeInstanceOf(ProviderError);
      expect(viaStream.message).toBe(viaRun.message);
      expect(viaStream.message).not.toContain("incomplete");
    });

    it(`${wire}: a real reply gives the same answer as run(), and the app sees its text`, async () => {
      const { events, result } = await streamAll(agentFor(wire, answers([GOOD[wire]]).fn), "hi");
      const viaRun = await agentFor(wire, answers([GOOD[wire]]).fn).run("hi");
      expect([result.text, result.finishReason]).toEqual(["hi", "stop"]);
      expect([result.text, result.finishReason]).toEqual([viaRun.text, viaRun.finishReason]);
      expect(events.filter((e) => e.type === "text_delta").map((e) => e.delta)).toEqual(["hi"]);
      expect(events.some((e) => e.type === "done")).toBe(true);
    });

    it(`${wire}: a reply that cannot be used is retried before the stream starts, and a good one recovers it`, async () => {
      const { fn, sent } = answers([{}, GOOD[wire]]);
      const result = await agentFor(wire, fn, { retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 } })
        .stream("hi")
        .result();
      expect(result.text).toBe("hi");
      expect(sent.length).toBe(2);
    });

    it(`${wire}: a body that is neither JSON nor a stream and holds nothing is a cut stream, not an empty answer`, async () => {
      const err = await failure(agentFor(wire, answers([""], "application/octet-stream").fn).stream("hi").result());
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.code).toBe("incomplete_stream");
      expect(err.retryable).toBe(true);
    });
  }

  for (const [wire, transient] of [
    ["openrouter", { error: { message: "busy", code: 502 } }],
    ["openai", { error: { message: "busy", code: "server_error" } }],
  ] as const) {
    it(`${wire}: an error reply with a temporary code is retried before the stream starts`, async () => {
      const { fn, sent } = answers([transient, GOOD[wire]]);
      const result = await agentFor(wire, fn, { retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 } })
        .stream("hi")
        .result();
      expect([result.text, sent.length]).toEqual(["hi", 2]);
    });
  }

  it("openrouter: run() reports an error reply too (it streams), and a plain-text error keeps its text", async () => {
    const err = await failure(agentFor("openrouter", answers([ERROR.openrouter]).fn).run("hi"));
    expect(err.message).toContain("upstream exploded");
    const text = await failure(agentFor("openrouter", answers([{ error: "Unauthorized" }]).fn).run("hi"));
    expect(text.message).toContain("Unauthorized");
  });

  it("the thinking of a whole reply reaches the app before its text", async () => {
    const reply = {
      id: "r1",
      status: "completed",
      output: [
        { type: "reasoning", id: "rs1", summary: [{ type: "summary_text", text: "thought" }] },
        { type: "message", content: [{ type: "output_text", text: "hi" }] },
      ],
    };
    const { events, result } = await streamAll(agentFor("openai", answers([reply]).fn), "hi");
    expect(result.thinking).toBe("thought");
    const shown = events.filter((e) => e.type === "thinking_delta" || e.type === "text_delta");
    expect(shown.map((e) => [e.type, e.thinkingDelta ?? e.delta])).toEqual([
      ["thinking_delta", "thought"],
      ["text_delta", "hi"],
    ]);
  });

  // Two tool calls in one whole reply, then a text answer: both run with their own arguments.
  const callsReply: Partial<Record<Wire, unknown>> = {
    openrouter: {
      id: "c1",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_a", type: "function", function: { name: "add", arguments: '{"a":1}' } },
              { id: "call_b", type: "function", function: { name: "add", arguments: '{"a":2}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    openai: {
      id: "r1",
      status: "completed",
      output: [
        { type: "function_call", id: "fc_a", call_id: "call_a", name: "add", arguments: '{"a":1}' },
        { type: "function_call", id: "fc_b", call_id: "call_b", name: "add", arguments: '{"a":2}' },
      ],
    },
  };
  for (const wire of ["openrouter", "openai"] as const) {
    it(`${wire}: tool calls in a whole reply run apart, each with its own arguments`, async () => {
      const seen: number[] = [];
      const add = tool({
        name: "add",
        description: "adds",
        input: z.object({ a: z.number() }),
        execute: ({ a }) => {
          seen.push(a);
          return a + 1;
        },
      });
      const { events, result } = await streamAll(
        agentFor(wire, answers([callsReply[wire], GOOD[wire]]).fn, { tools: [add] }),
        "hi"
      );
      expect(seen.sort()).toEqual([1, 2]);
      expect(result.text).toBe("hi");
      const completed = events.filter((e) => e.type === "tool_call_complete").map((e) => e.toolCall?.id);
      expect([completed.length, new Set(completed).size]).toEqual([2, 2]); // two calls, never merged into one
    });
  }

  it("google: a whole reply records the chain, so the next turn continues the interaction", async () => {
    const { fn, sent } = answers([GOOD.google]);
    const agent = agentFor("google", fn);
    await agent.stream("one").result();
    await agent.stream("two").result();
    expect(sent[1]!["previous_interaction_id"]).toBe("i1");
  });

  it("google: a whole reply that is still running cannot be used", async () => {
    const err = await failure(agentFor("google", answers([{ id: "i1", status: "in_progress" }]).fn).stream("hi").result());
    expect([err.retryable, err.status]).toEqual([true, 502]);
    expect(err.message).toContain("has not finished");
  });
});
