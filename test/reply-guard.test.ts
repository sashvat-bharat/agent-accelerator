import { describe, it, expect } from "bun:test";
import { Agent, ProviderError } from "../src/index.ts";
import {
  chatReplyProblem,
  responsesReplyProblem,
  messageReplyProblem,
  interactionReplyProblem,
} from "../src/providers/reply-guard.ts";

// A fetch that answers every call with one HTTP 200 body, and counts the calls.
const answer = (body: unknown) => {
  const calls = { n: 0 };
  const fn = (async () => {
    calls.n++;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
};

// One agent per wire: the four non-streaming adapters the guard protects.
const WIRES = {
  chat: { model: "groq/test-model", baseUrl: "https://x.test/v1" },
  responses: { model: "openai/gpt-5.5" },
  messages: { model: "anthropic/claude-sonnet-5-5" },
  interactions: { model: "google/gemini-3.5-flash-lite" },
} as const;
type Wire = keyof typeof WIRES;

const agentFor = (wire: Wire, fn: typeof fetch, retries = 0) =>
  new Agent({
    ...WIRES[wire],
    apiKey: "k",
    fetch: fn,
    runRetries: 0,
    maxTurns: 2,
    retry: { maxRetries: retries, baseDelayMs: 1, maxDelayMs: 2 },
  } as never);

// The smallest honest reply of each wire, with the text "hi".
const GOOD: Record<Wire, unknown> = {
  chat: { choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] },
  responses: {
    id: "r1",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
  },
  messages: {
    id: "m1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  interactions: {
    id: "i1",
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text: "hi" }] }],
  },
};

// Replies that are valid JSON but are not a reply of any wire.
const GARBAGE: Array<[string, unknown]> = [
  ["an empty object", {}],
  ["a list", []],
  ["null", "null"],
  ["a number", "7"],
  ["a string", '"hello"'],
];

describe("the reply checks", () => {
  it("chat: needs an object with a first choice that is an object, or an error", () => {
    expect(chatReplyProblem(GOOD.chat)).toBeUndefined();
    expect(chatReplyProblem({ error: { message: "boom" } })).toBeUndefined(); // the parser reports it
    expect(chatReplyProblem({ choices: [{ message: null }] })).toBeUndefined(); // an empty choice is still a choice
    expect(chatReplyProblem({})).toContain("no `choices`");
    expect(chatReplyProblem({ choices: [] })).toContain("no `choices`");
    expect(chatReplyProblem({ choices: [null] })).toContain("first choice");
    expect(chatReplyProblem({ choices: "x" })).toContain("no `choices`");
    expect(chatReplyProblem(null)).toContain("null");
    expect(chatReplyProblem([])).toContain("list");
    expect(chatReplyProblem(7)).toContain("number");
  });

  it("responses: needs an `output` list, or a failure the parser reports", () => {
    expect(responsesReplyProblem(GOOD.responses)).toBeUndefined();
    expect(responsesReplyProblem({ status: "completed", output: [] })).toBeUndefined(); // legitimately empty
    expect(responsesReplyProblem({ status: "failed" })).toBeUndefined();
    expect(responsesReplyProblem({ error: { message: "x" } })).toBeUndefined();
    expect(responsesReplyProblem({ status: "completed" })).toContain("no `output`");
    expect(responsesReplyProblem({ output: "text" })).toContain("no `output`");
    expect(responsesReplyProblem(null)).toContain("null");
  });

  it("messages: needs a `content` list, and an error object is a problem", () => {
    expect(messageReplyProblem(GOOD.messages)).toBeUndefined();
    expect(messageReplyProblem({ content: [] })).toBeUndefined(); // legitimately empty
    expect(messageReplyProblem({ type: "error", error: { message: "x" } })).toContain("error object");
    expect(messageReplyProblem({ content: null })).toContain("no `content`");
    expect(messageReplyProblem([])).toContain("list");
  });

  it("interactions: needs an `id` or a `steps` list", () => {
    expect(interactionReplyProblem(GOOD.interactions)).toBeUndefined();
    expect(interactionReplyProblem({ id: "i1" })).toBeUndefined(); // a background run that has no steps yet
    expect(interactionReplyProblem({ steps: [] })).toBeUndefined();
    expect(interactionReplyProblem({ status: "completed" })).toContain("neither");
    expect(interactionReplyProblem({ id: 5 })).toContain("neither");
    expect(interactionReplyProblem(null)).toContain("null");
  });
});

describe("a reply that is not a reply, on every adapter", () => {
  for (const wire of Object.keys(WIRES) as Wire[]) {
    for (const [label, body] of GARBAGE) {
      it(`${wire}: ${label} is a retryable ProviderError, not a silent empty answer`, async () => {
        const { fn } = answer(body);
        const err = await agentFor(wire, fn)
          .run("hi")
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ProviderError); // never a raw TypeError
        expect((err as ProviderError).retryable).toBe(true);
        expect((err as ProviderError).status).toBe(502);
        expect((err as Error).message).toContain("cannot be used");
      });
    }
  }

  it("the message names the cause and shows the start of the reply", async () => {
    const { fn } = answer({ unexpected: "x".repeat(400) });
    const err = (await agentFor("chat", fn)
      .run("hi")
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("no `choices`");
    expect(err.message).toContain('{"unexpected":"xxxx');
    expect(err.message.length).toBeLessThan(500); // the reply is cut, not dumped
  });

  it("an error object sent with HTTP 200 is not an answer (Anthropic)", async () => {
    const { fn } = answer({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    const err = (await agentFor("messages", fn)
      .run("hi")
      .catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("error object");
  });
});

describe("a real reply still works", () => {
  for (const wire of Object.keys(WIRES) as Wire[]) {
    it(`${wire}: the smallest honest reply gives its text`, async () => {
      const { fn } = answer(GOOD[wire]);
      expect((await agentFor(wire, fn).run("hi")).text).toBe("hi");
    });
  }

  it("a legitimately empty answer is still an answer", async () => {
    for (const [wire, body] of [
      ["chat", { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] }],
      ["responses", { id: "r1", status: "completed", output: [] }],
      ["messages", { id: "m1", type: "message", content: [], stop_reason: "end_turn" }],
    ] as Array<[Wire, unknown]>) {
      const res = await agentFor(wire, answer(body).fn).run("hi");
      expect([wire, res.text, res.finishReason]).toEqual([wire, "", "stop"]);
    }
  });

  it("a provider error body is still reported as the provider's own error", async () => {
    const { fn } = answer({ error: { message: "model overloaded", code: "overloaded" } });
    const err = (await agentFor("chat", fn)
      .run("hi")
      .catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("model overloaded");
    expect(err.message).not.toContain("cannot be used");
  });
});

describe("a bad reply is retried like a 502", () => {
  for (const wire of Object.keys(WIRES) as Wire[]) {
    it(`${wire}: a second, good reply recovers the run`, async () => {
      let n = 0;
      const fn = (async () => {
        n++;
        return new Response(JSON.stringify(n === 1 ? {} : GOOD[wire]), { status: 200 });
      }) as unknown as typeof fetch;
      const res = await agentFor(wire, fn, 1).run("hi");
      expect(res.text).toBe("hi");
      expect(n).toBe(2);
    });
  }

  it("gives up with the guard's error after the retries are spent", async () => {
    const { fn, calls } = answer({});
    const err = (await agentFor("chat", fn, 2)
      .run("hi")
      .catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(calls.n).toBe(3); // the first try and two retries
  });
});
