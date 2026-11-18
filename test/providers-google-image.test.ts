import { describe, it, expect } from "bun:test";
import { generateImage, ConfigError, ProviderError, ValidationError } from "../src/index.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const THOUGHT = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9]);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const NB = "google/gemini-nano-banana-2.1";
const LITE = "google/gemini-3.1-flash-lite-image";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}
function stub(handler: (n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return handler(calls.length);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
// A realistic reply: a thought step holding an interim image, then the model's output with a text and the final picture.
const interaction = (over: Record<string, unknown> = {}) => ({
  id: "v1_abc",
  status: "completed",
  steps: [
    // steps that are not the model's output but carry an image under `content` must never become results
    { type: "user_input", content: [{ type: "image", data: b64(THOUGHT), mime_type: "image/png" }] },
    { type: "thought", content: [{ type: "image", data: b64(THOUGHT), mime_type: "image/png" }], summary: [{ type: "text", text: "Plan the composition" }, { type: "image", data: b64(THOUGHT), mime_type: "image/png" }] },
    { type: "model_output", content: [{ type: "text", text: "Here is your fox." }, { type: "image", data: b64(PNG), mime_type: "image/png" }] },
  ],
  usage: {
    total_input_tokens: 20,
    total_output_tokens: 1200,
    total_thought_tokens: 300,
    total_tokens: 1520,
    input_tokens_by_modality: [{ modality: "text", tokens: 20 }],
    output_tokens_by_modality: [{ modality: "text", tokens: 80 }, { modality: "image", tokens: 1120 }],
  },
  ...over,
});
const ok = (over: Record<string, unknown> = {}) => new Response(JSON.stringify(interaction(over)), { status: 200 });
const err = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe("Google image adapter", () => {
  it("sends the prompt and only the options that were set, with the key in a header", async () => {
    const s = stub(() => ok());
    await generateImage({ model: NB, prompt: "A fox", apiKey: "AIza-secret-0123456789", fetch: s.fn });
    expect(s.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(s.calls[0]!.headers["x-goog-api-key"]).toBe("AIza-secret-0123456789");
    expect(s.calls[0]!.body).toEqual({ model: "gemini-nano-banana-2.1", input: [{ type: "text", text: "A fox" }] }); // no response_format, no thinking, no grounding
  });

  it("maps ratio, tier, file type and thinking level to response_format and generation_config", async () => {
    const s = stub(() => ok());
    await generateImage({ model: NB, prompt: "A fox", aspectRatio: "16:9", resolution: "2K", format: "jpeg", thinking: "high", apiKey: "k", fetch: s.fn });
    expect(s.calls[0]!.body.response_format).toEqual({ type: "image", aspect_ratio: "16:9", image_size: "2K", mime_type: "image/jpeg" });
    expect(s.calls[0]!.body.generation_config).toEqual({ thinking_level: "high" });
    expect(JSON.stringify(s.calls[0]!.body)).not.toMatch(/search|grounding|google_search/i);
  });

  it("returns the final picture and the words, never the interim thought image", async () => {
    const s = stub(() => ok());
    const r = await generateImage({ model: NB, prompt: "x", apiKey: "k", fetch: s.fn });
    expect(r.images).toHaveLength(1);
    expect(new Uint8Array(r.image.bytes)).toEqual(PNG);
    expect(r.text).toBe("Here is your fox.");
    expect(r.finishReason).toBe("stop");
    expect(r.model).toBe("gemini-nano-banana-2.1");
    expect(r.provider).toBe("google");
  });

  it("keeps the modality split, folds thinking into output, and prices the call from the table", async () => {
    const s = stub(() => ok());
    const r = await generateImage({ model: NB, prompt: "x", apiKey: "k", fetch: s.fn });
    expect(r.usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 1500, // 1200 + 300 thinking
      totalTokens: 1520,
      thinkingTokens: 300,
      inputDetails: { textTokens: 20, imageTokens: 0 },
      outputDetails: { imageTokens: 1120, textTokens: 80 },
    });
    // 20 input x $1.50 + 1120 image x $30 + (1500 - 1120) text and thinking x $7.50 = $0.03648
    expect(r.usage.cost?.totalCost).toBeCloseTo(0.03648, 8);
  });

  it("edits: reference images go in as input blocks (aliases fixed, unsupported types refused before sending)", async () => {
    const s = stub(() => ok());
    const jpg = `data:image/jpg;base64,${b64(PNG)}`; // declared with the common wrong spelling
    await generateImage({ model: NB, prompt: "Put these together", images: [PNG, jpg], apiKey: "k", fetch: s.fn });
    const input = s.calls[0]!.body.input;
    expect(input[0]).toEqual({ type: "text", text: "Put these together" });
    expect(input.slice(1).map((b: any) => b.type)).toEqual(["image", "image"]);
    expect(input[1].data).toBe(b64(PNG));
    expect(input[1].mime_type).toBe("image/png");
    expect(input[2].mime_type).toBe("image/jpeg"); // image/jpg is fixed to the name Google knows
    const svg = stub(() => ok());
    await expect(
      generateImage({ model: NB, prompt: "x", images: [`data:image/svg+xml;base64,${b64(new Uint8Array([60, 115, 118, 103]))}`], apiKey: "k", fetch: svg.fn })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(svg.calls).toHaveLength(0);
  });

  it("n runs one request per picture (Google has no n), and the usage and cost add up", async () => {
    const s = stub(() => ok());
    const r = await generateImage({ model: NB, prompt: "x", n: 3, apiKey: "k", fetch: s.fn });
    expect(s.calls).toHaveLength(3);
    expect(r.images).toHaveLength(3);
    expect(r.requests).toBe(3);
    expect(r.usage.inputTokens).toBe(60);
    expect(r.usage.cost?.totalCost).toBeCloseTo(3 * 0.03648, 6);
  });

  it("Flash Lite is called the same way (model id, thinking levels, 1K)", async () => {
    const s = stub(() => ok());
    await generateImage({ model: LITE, prompt: "x", resolution: "1K", thinking: "minimal", apiKey: "k", fetch: s.fn });
    expect(s.calls[0]!.body).toMatchObject({ model: "gemini-3.1-flash-lite-image", response_format: { type: "image", image_size: "1K" }, generation_config: { thinking_level: "minimal" } });
  });

  it("a reply with words and no picture (a safety refusal) is a ProviderError that carries the words", async () => {
    const s = stub(() => ok({ steps: [{ type: "model_output", content: [{ type: "text", text: "I can't create that image." }] }] }));
    const e = await generateImage({ model: NB, prompt: "x", apiKey: "k", fetch: s.fn }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toMatch(/returned no image: I can't create that image\./);
  });

  it("a failed interaction throws Google's own message", async () => {
    const s = stub(() => ok({ status: "failed", steps: [], error: { message: "Image generation failed", code: "internal" } }));
    const e = await generateImage({ model: NB, prompt: "x", apiKey: "k", fetch: s.fn }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toMatch(/Image generation failed/);
  });

  it("retries 429 (Retry-After) and 503, then succeeds; a 400 is not retried", async () => {
    const s = stub((n) => (n === 1 ? err(429, { error: { message: "quota" } }, { "retry-after-ms": "5" }) : n === 2 ? err(503, { error: { message: "busy" } }) : ok()));
    const r = await generateImage({ model: NB, prompt: "x", apiKey: "k", fetch: s.fn, retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 20 } });
    expect(s.calls).toHaveLength(3);
    expect(r.images).toHaveLength(1);
    const bad = stub(() => err(400, { error: { message: "Unsupported aspect ratio", code: 400, status: "INVALID_ARGUMENT" } }));
    const e = await generateImage({ model: NB, prompt: "x", apiKey: "k", fetch: bad.fn, retry: { maxRetries: 3, baseDelayMs: 1 } }).catch((x) => x);
    expect(bad.calls).toHaveLength(1);
    expect(e.message).toMatch(/Unsupported aspect ratio/);
    expect(e.retryable).toBe(false);
  });

  it("a 401 says which key to check, and the key never shows in the errors or the audit", async () => {
    const s = stub(() => err(401, { error: { message: "API key not valid" } }));
    const e = await generateImage({ model: NB, prompt: "x", apiKey: "AIza-secret-0123456789", fetch: s.fn }).catch((x) => x);
    expect(e.message).toMatch(/API key not valid.*GEMINI_API_KEY/);
    expect(JSON.stringify(e)).not.toContain("AIza-secret");
    const good = stub(() => ok());
    const r = await generateImage({ model: NB, prompt: "x", apiKey: "AIza-secret-0123456789", fetch: good.fn, captureRaw: true });
    expect(JSON.stringify(r.raw)).not.toContain("AIza-secret");
    expect(r.raw.request.headers["x-goog-api-key"]).toBe("[REDACTED]");
  });

  it("without a key it is a ConfigError before any request", async () => {
    const s = stub(() => ok());
    const keys = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"] as const;
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    try {
      await expect(generateImage({ model: NB, prompt: "x", fetch: s.fn })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      keys.forEach((k, i) => saved[i] !== undefined && (process.env[k] = saved[i]));
    }
    expect(s.calls).toHaveLength(0);
  });

  it("the interaction id stays in the audit record", async () => {
    const s = stub(() => ok());
    const r = await generateImage({ model: NB, prompt: "x", apiKey: "k", fetch: s.fn });
    expect(r.raw.response?.body).toMatchObject({ id: "v1_abc" });
  });
});
