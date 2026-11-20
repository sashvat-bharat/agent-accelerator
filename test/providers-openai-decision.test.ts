import { describe, it, expect } from "bun:test";
import { generateDecision, getProvider, ConfigError, ProviderError, ValidationError } from "../src/index.ts";

const MODEL = "openai/gpt-6-luna";
const KEY = "sk-secret-0123456789abcdef";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}
function stub(handler: (n: number, body: any) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    return handler(calls.length, body);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
// A reply built from OpenAI's API reference: answers in question order, probabilities as lists.
const usage = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 400, cache_write_tokens: 0 },
  output_tokens: 3,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 1003,
};
const real = {
  model: "gpt-6-luna-2026-11-01",
  answers: [
    { type: "predicate", name: "upset", probability: 0.97 },
    {
      type: "choice",
      name: "dept",
      choice: "billing",
      confidence: 0.9,
      probabilities: [
        { value: "billing", probability: 0.9 },
        { value: "technical", probability: 0.06 },
        { value: "other", probability: 0.04 },
      ],
    },
    {
      type: "score",
      name: "urgency",
      score: 1.7,
      confidence: 0.7,
      probabilities: [
        { label: "0", value: 0, probability: 0.05 },
        { label: "1", value: 1, probability: 0.25 },
        { label: "2", value: 2, probability: 0.7 },
      ],
    },
  ],
  usage,
};
const ok = (reply: unknown = real, headers: Record<string, string> = {}) => new Response(JSON.stringify(reply), { status: 200, headers });
const failure = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const questions = {
  upset: { type: "noul" as const, instructions: "Is the customer upset?" },
  dept: { type: "choice" as const, instructions: "Which department?", criteria: { billing: "Payments.", technical: "", other: "" } },
  urgency: { type: "score" as const, instructions: "How urgent?", criteria: ["Low", "Medium", "High"] },
};
const base = { model: MODEL, input: "I was charged twice.", questions, apiKey: KEY };

describe("OpenAI decision adapter: the request", () => {
  it("translates the shared questions to OpenAI's: an ordered array of predicate, choice and score", async () => {
    const s = stub(() => ok());
    const r = await generateDecision({ ...base, fetch: s.fn });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe("https://api.openai.com/v1/decisions");
    expect(s.calls[0]!.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(s.calls[0]!.body)).not.toContain(KEY);
    expect(s.calls[0]!.body).toEqual({
      model: "gpt-6-luna",
      input: "I was charged twice.",
      questions: [
        { type: "predicate", name: "upset", instructions: "Is the customer upset?" },
        {
          type: "choice",
          name: "dept",
          instructions: "Which department?",
          choices: [{ value: "billing", description: "Payments." }, { value: "technical" }, { value: "other" }], // "" is no description
        },
        {
          type: "score",
          name: "urgency",
          instructions: "How urgent?",
          levels: [
            { label: "0", description: "Low" },
            { label: "1", description: "Medium" },
            { label: "2", description: "High" },
          ],
        },
      ],
    });
    expect(r.raw.request.headers["Authorization"]).toBe("[REDACTED]");
  });

  it("writes what yes and no mean under a predicate's instructions (it has no criteria field)", async () => {
    const s = stub(() => ok({ ...real, answers: [real.answers[0]] }));
    await generateDecision({
      ...base,
      questions: { upset: { type: "noul", instructions: "Defect?", criteria: { true: "Broken.", false: "Preference." } } },
      fetch: s.fn,
    });
    expect(s.calls[0]!.body.questions[0].instructions).toBe("Defect?\nYes means: Broken.\nNo means: Preference.");
    expect(s.calls[0]!.body.questions[0].criteria).toBeUndefined();
  });

  it("sends a list as one user message of text and image parts, with the resolution as detail", async () => {
    const s = stub(() => ok());
    await generateDecision({
      ...base,
      input: [
        "Order: ",
        { type: "json", json: { id: 8821 } },
        { type: "image", image: PNG, resolution: "ultra_high" },
        { type: "image", image: PNG, resolution: "medium" },
        { type: "image", image: PNG },
      ],
      fetch: s.fn,
    });
    expect(s.calls[0]!.body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Order: " },
          { type: "input_text", text: '{"id":8821}' },
          { type: "input_image", image_url: PNG, detail: "original" },
          { type: "input_image", image_url: PNG, detail: "auto" },
          { type: "input_image", image_url: PNG },
        ],
      },
    ]);
  });

  it("refuses audio, video and PDF: the model reads text and images only", async () => {
    const s = stub(() => ok());
    const err = (await generateDecision({ ...base, input: { type: "audio", audio: "a.mp3" }, fetch: s.fn }).catch((e) => e)) as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("openai/gpt-6-luna cannot read audio");
    // the adapter guards on its own too
    await expect(
      getProvider("openai").decide!(
        "gpt-6-luna",
        { input: [{ kind: "audio", media: { mimeType: "audio/mp3", base64Data: "AA", dataUrl: "data:audio/mp3;base64,AA" } }], questions: {} },
        { apiKey: KEY, fetch: s.fn }
      )
    ).rejects.toThrow("does not read audio");
    expect(s.calls).toHaveLength(0);
  });

  it("needs a key", async () => {
    const saved = [process.env["OPENAI_API_KEY"], process.env["OPENAI_BASE_API_KEY"]];
    delete process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_BASE_API_KEY"];
    try {
      await expect(generateDecision({ ...base, apiKey: undefined, fetch: stub(() => ok()).fn })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      if (saved[0] !== undefined) process.env["OPENAI_API_KEY"] = saved[0];
      if (saved[1] !== undefined) process.env["OPENAI_BASE_API_KEY"] = saved[1];
    }
  });
});

describe("OpenAI decision adapter: the reply", () => {
  it("maps the answers array back to the shared shape under each question's name", async () => {
    const r = await generateDecision({ ...base, fetch: stub(() => ok(real, { "x-request-id": "req_1" })).fn });
    expect(r.answers["upset"]).toEqual({ type: "noul", noul: 0.97, confidence: 0.97 }); // no confidence on the wire: max(p, 1 - p)
    expect(r.answers["dept"]).toEqual({
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.9, technical: 0.06, other: 0.04 },
      confidence: 0.9,
    });
    expect(r.answers["urgency"]).toEqual({
      type: "score",
      score: 1.7,
      probabilities: { "0": 0.05, "1": 0.25, "2": 0.7 },
      legend: { "0": "Low", "1": "Medium", "2": "High" }, // from the criteria: OpenAI sends none
      confidence: 0.7,
    });
    expect(r.model).toBe("gpt-6-luna");
  });

  it("passes a refusal through while the other answers stay", async () => {
    const reply = { ...real, answers: [real.answers[0], { type: "refusal", name: "dept" }, real.answers[2]] };
    const r = await generateDecision({ ...base, fetch: stub(() => ok(reply)).fn });
    expect(r.answers["dept"]).toEqual({ type: "refusal" });
    expect(r.answers["upset"]!.type).toBe("noul");
  });

  it("an answer that carries another question's name, or a missing one, fails the check naming the question", async () => {
    const swapped = { ...real, answers: [real.answers[1], real.answers[0], real.answers[2]] };
    const err = (await generateDecision({ ...base, fetch: stub(() => ok(swapped)).fn }).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('unusable decision reply for "upset": no answer came back');
    const short = { ...real, answers: real.answers.slice(0, 2) };
    const err2 = (await generateDecision({ ...base, fetch: stub(() => ok(short)).fn }).catch((e) => e)) as ProviderError;
    expect(err2.message).toContain('for "urgency": no answer came back');
  });

  it("an answer with no name is matched by its position", async () => {
    const unnamed = { ...real, answers: real.answers.map((a) => ({ ...a, name: null })) };
    const r = await generateDecision({ ...base, fetch: stub(() => ok(unnamed)).fn });
    expect(r.answers["dept"]).toMatchObject({ choice: "billing" });
  });

  it("reads the usage: cache reads and writes are subsets of the input, the cost is the table's (output is free)", async () => {
    const r = await generateDecision({ ...base, fetch: stub(() => ok()).fn });
    expect(r.usage).toMatchObject({ inputTokens: 1000, outputTokens: 3, cachedTokens: 400, cacheWriteTokens: 0, totalTokens: 1003 });
    // 600 x $0.10 + 400 x $0.01 per 1M = 64 micro-USD
    expect(r.usage.cost).toEqual({ inputCost: 0.000064, outputCost: 0, totalCost: 0.000064 });
    // tokens written to the cache have no stated rate: the cost stays unknown
    const wrote = { ...real, usage: { ...usage, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 300 } } };
    expect((await generateDecision({ ...base, fetch: stub(() => ok(wrote)).fn })).usage.cost).toBeUndefined();
  });

  it("retries a transient failure and not a bad request; a 401 gets a key hint; a moderation-free 400 keeps OpenAI's message", async () => {
    const flaky = stub((n) => (n === 1 ? failure(429, { error: { message: "slow down", type: "rate_limit_error" } }, { "retry-after-ms": "1" }) : ok()));
    await generateDecision({ ...base, fetch: flaky.fn, retry: { baseDelayMs: 1 } });
    expect(flaky.calls).toHaveLength(2);

    const bad = stub(() => failure(400, { error: { message: "questions: at most 400", type: "invalid_request_error", code: "invalid_value" } }));
    const err = (await generateDecision({ ...base, fetch: bad.fn, retry: { baseDelayMs: 1 } }).catch((e) => e)) as ProviderError;
    expect(err.message).toContain("questions: at most 400");
    expect(bad.calls).toHaveLength(1);

    const unauthorized = stub(() => failure(401, { error: { message: "Incorrect API key", type: "invalid_request_error" } }));
    expect(((await generateDecision({ ...base, fetch: unauthorized.fn }).catch((e) => e)) as Error).message).toContain("Check OPENAI_API_KEY");
  });

  it("a reply that is not JSON is a ProviderError", async () => {
    const html = stub(() => new Response("<html>bad gateway</html>", { status: 200 }));
    await expect(generateDecision({ ...base, fetch: html.fn })).rejects.toBeInstanceOf(ProviderError);
  });
});
