import { describe, it, expect } from "bun:test";
import { generateDecision, ConfigError, ProviderError, ValidationError } from "../src/index.ts";

const MODEL = "google/gemini-decision-1";
const KEY = "AIza-secret-0123456789";
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
// The reply of a real call (20 Nov 2026): answers keyed by question name, probabilities by option and by level number.
const real = {
  answers: {
    urgency: {
      confidence: 0.8165652182292663,
      score: 1.806817502183722,
      probabilities: { "2": 0.8165652182292663, "0": 0.009747716045544235, "1": 0.17368706572518947 },
      legend: { "2": "High", "1": "Medium", "0": "Low" },
      type: "score",
    },
    dept: {
      confidence: 0.9829354600716103,
      choice: "billing",
      probabilities: { billing: 0.9829354600716103, technical: 0.007643647348538603, other: 0.009420892579851082 },
      type: "choice",
    },
    upset: { confidence: 0.9659703808209621, noul: 0.9659703808209621, type: "noul" },
  },
  usage: {
    total_tokens: 201,
    total_input_tokens: 201,
    input_tokens_by_modality: [{ modality: "text", tokens: 201 }],
    total_output_tokens: 0,
  },
};
const ok = (reply: unknown = real) => new Response(JSON.stringify(reply), { status: 200 });
const failure = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const questions = {
  upset: { type: "noul" as const, instructions: "Is the customer upset?" },
  dept: { type: "choice" as const, instructions: "Which department?", criteria: { billing: "Payments.", technical: "", other: "" } },
  urgency: { type: "score" as const, instructions: "How urgent?", criteria: ["Low", "Medium", "High"] },
};
const base = { model: MODEL, input: "I was charged twice.", questions, apiKey: KEY };

describe("Google decision adapter: the request", () => {
  it("sends one request to /decisions with a plain string input, the questions as given, and the key in a header", async () => {
    const s = stub(() => ok());
    const r = await generateDecision({ ...base, fetch: s.fn });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
    expect(s.calls[0]!.headers["x-goog-api-key"]).toBe(KEY);
    expect(JSON.stringify(s.calls[0]!.body)).not.toContain(KEY);
    expect(s.calls[0]!.body).toEqual({
      model: "gemini-decision-1",
      input: "I was charged twice.",
      questions: {
        upset: { type: "noul", instructions: "Is the customer upset?" },
        dept: { type: "choice", instructions: "Which department?", criteria: { billing: "Payments.", technical: "", other: "" } },
        urgency: { type: "score", instructions: "How urgent?", criteria: ["Low", "Medium", "High"] },
      },
    });
    expect(r.raw.request.headers["x-goog-api-key"]).toBe("[REDACTED]"); // the audit never holds the key
    expect(r.answers["dept"]).toMatchObject({ type: "choice", choice: "billing" });
  });

  it("sends a list as content blocks: JSON as text, media inline with its type, an alias renamed, a resolution kept", async () => {
    const s = stub(() => ok());
    await generateDecision({
      ...base,
      input: [
        "Order: ",
        { type: "json", json: { id: 8821 } },
        { type: "image", image: PNG, resolution: "low" },
        { type: "video", image: undefined, video: "data:video/quicktime;base64,AAAA", resolution: "high" } as never,
        { type: "file", file: "data:application/pdf;base64,JVBERg==" },
        { type: "audio", audio: "data:audio/x-wav;base64,UklGRg==" },
      ],
      fetch: s.fn,
    });
    expect(s.calls[0]!.body.input).toEqual([
      { type: "text", text: "Order: " },
      { type: "text", text: '{"id":8821}' },
      { type: "image", data: "iVBORw0KGgo=", mime_type: "image/png", resolution: "low" },
      { type: "video", data: "AAAA", mime_type: "video/mov", resolution: "high" }, // Google's name for QuickTime
      { type: "document", data: "JVBERg==", mime_type: "application/pdf" }, // a PDF is a `document` block
      { type: "audio", data: "UklGRg==", mime_type: "audio/wav" },
    ]);
  });

  it("refuses a media type Google does not read before the network", async () => {
    const s = stub(() => ok());
    const err = (await generateDecision({
      ...base,
      input: { type: "image", image: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
      fetch: s.fn,
    }).catch((e) => e)) as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain('does not read image of type "image/svg+xml"');
    expect(s.calls).toHaveLength(0);
  });

  it("needs a key", async () => {
    const saved = process.env["GEMINI_API_KEY"];
    const saved2 = process.env["GOOGLE_API_KEY"];
    const saved3 = process.env["GOOGLE_GENAI_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    delete process.env["GOOGLE_API_KEY"];
    delete process.env["GOOGLE_GENAI_API_KEY"];
    try {
      await expect(generateDecision({ ...base, apiKey: undefined, fetch: stub(() => ok()).fn })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
      if (saved2 !== undefined) process.env["GOOGLE_API_KEY"] = saved2;
      if (saved3 !== undefined) process.env["GOOGLE_GENAI_API_KEY"] = saved3;
    }
  });
});

describe("Google decision adapter: the reply", () => {
  it("keeps Google's answers and reads the usage with its per-modality split", async () => {
    const reply = {
      ...real,
      usage: {
        total_input_tokens: 553,
        total_tokens: 553,
        total_output_tokens: 0,
        input_tokens_by_modality: [
          { modality: "text", tokens: 297 },
          { modality: "image", tokens: 256 },
        ],
      },
    };
    const r = await generateDecision({ ...base, fetch: stub(() => ok(reply)).fn });
    expect(r.answers["upset"]).toEqual({ type: "noul", noul: 0.9659703808209621, confidence: 0.9659703808209621 });
    expect(r.answers["urgency"]).toMatchObject({ type: "score", score: 1.806817502183722, legend: { "0": "Low", "1": "Medium", "2": "High" } });
    expect(r.usage).toMatchObject({ inputTokens: 553, outputTokens: 0, totalTokens: 553, inputDetails: { textTokens: 297, imageTokens: 256 } });
    // 553 tokens at $0.10 per 1M, in whole micro-dollars
    expect(r.usage.cost).toEqual({ inputCost: 0.000055, outputCost: 0, totalCost: 0.000055 });
  });

  it("retries a transient failure, and does not retry a bad request", async () => {
    const flaky = stub((n) => (n === 1 ? failure(503, { error: { message: "overloaded", status: "UNAVAILABLE" } }) : ok()));
    const r = await generateDecision({ ...base, fetch: flaky.fn, retry: { baseDelayMs: 1 } });
    expect(flaky.calls).toHaveLength(2);
    expect(r.answers["dept"]).toBeDefined();

    const bad = stub(() => failure(400, { error: { code: 400, message: "questions: key 'a b' is not valid", status: "INVALID_ARGUMENT" } }));
    const err = (await generateDecision({ ...base, fetch: bad.fn, retry: { baseDelayMs: 1 } }).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("questions: key 'a b' is not valid");
    expect(bad.calls).toHaveLength(1);
  });

  it("adds a key hint on a 401", async () => {
    const s = stub(() => failure(401, { error: { message: "API key not valid", status: "UNAUTHENTICATED" } }));
    const err = (await generateDecision({ ...base, fetch: s.fn }).catch((e) => e)) as ProviderError;
    expect(err.message).toContain("Check GEMINI_API_KEY");
  });

  it("a reply that is not JSON is a ProviderError, and one with no usage leaves the cost unknown", async () => {
    const html = stub(() => new Response("<html>bad gateway</html>", { status: 200 }));
    await expect(generateDecision({ ...base, fetch: html.fn })).rejects.toThrow("request failed (200)");
    const noUsage = stub(() => ok({ answers: real.answers }));
    const r = await generateDecision({ ...base, fetch: noUsage.fn });
    expect(r.usage.cost).toBeUndefined();
  });

  it("an answers-less reply fails the answer check, naming the question", async () => {
    const empty = stub(() => ok({ usage: real.usage }));
    const err = (await generateDecision({ ...base, fetch: empty.fn }).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('unusable decision reply for "upset": no answer came back');
  });
});
