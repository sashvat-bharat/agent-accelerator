import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateDecision, ProviderError, ConfigError, setHome } from "../src/index.ts";
import { setConfigs, SETTING_KEYS, resetConfigs } from "../src/config/settings.ts";
import { resetOpenRouterDecisionsCache } from "../src/models/openrouter-decisions.ts";

const KEY = "sk-or-v1-secret-0123456789abcdef";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

// OpenRouter's list, as a live call returned it (20 Nov 2026), cut to what the tests need.
const decision = (modalities: string[]) => ({ input_modalities: modalities, output_modalities: ["decisions"] });
const list = {
  data: [
    {
      id: "perplexity/pplx-decider-flash-v1.3:free",
      architecture: decision(["text", "image"]),
      pricing: { prompt: "0", completion: "0" },
      endpoints: ["/api/alpha/decisions", "/api/alpha/extractions"],
    },
    {
      id: "google/gemini-decision-1",
      architecture: decision(["text", "image", "audio", "video", "file"]),
      pricing: { prompt: "0.0000001", completion: "0" },
      endpoints: ["/api/alpha/decisions"],
    },
  ],
};
// The reply of a real call to the free Perplexity model: no confidence on the yes/no, usage with cost 0.
const real = {
  model: "perplexity/pplx-decider-flash-v1.3-20261112",
  answers: {
    upset: { type: "noul", noul: 0.9953793833636874 },
    dept: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.9661529630708194, technical: 0.005442369318430438, other: 0.028404667610750153 },
      confidence: 0.9492294446062292,
    },
    urgency: {
      type: "score",
      score: 1.9461635778906088,
      legend: { "0": "Low", "1": "Medium", "2": "High" },
      probabilities: { "0": 0.003902737740229941, "1": 0.04603094662893147, "2": 0.9500663156308387 },
      confidence: 0.9461635778906087,
    },
  },
  usage: {
    input_tokens: 136,
    output_tokens: 3,
    cost: 0,
    is_byok: false,
    cost_details: { upstream_inference_cost: 0, upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: 0 },
  },
  id: "gen-dec-1795168770-tN4TgVTwwujCcKvljoEg",
  provider: "Perplexity",
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}
// Answers the model list at its URL and every decisions request with `handler`.
function stub(handler: (n: number, body: any) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: any) => {
    if (String(url).includes("/models?")) return new Response(JSON.stringify(list));
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    return handler(calls.length, body);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const ok = (reply: unknown = real) => new Response(JSON.stringify(reply), { status: 200 });
const failure = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const questions = {
  upset: { type: "noul" as const, instructions: "Is the customer upset?", criteria: { true: "Says they will cancel.", false: "Asks for help." } },
  dept: { type: "choice" as const, instructions: "Which department?", criteria: { billing: "Payments.", technical: "", other: "" } },
  urgency: { type: "score" as const, instructions: "How urgent?", criteria: ["Low", "Medium", "High"] },
};
const FREE = "openrouter/perplexity/pplx-decider-flash-v1.3:free";
const base = { model: FREE, input: "I was charged twice.", questions, apiKey: KEY };

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-or-dec-"));
  setHome(home);
  resetOpenRouterDecisionsCache();
  setConfigs({ values: { catalog_refresh: "on" }, editable: [...SETTING_KEYS] }); // the list is read on the first call
});
afterEach(() => {
  resetConfigs();
  setHome();
  resetOpenRouterDecisionsCache();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("OpenRouter decision adapter: the request", () => {
  it("posts to the alpha decisions endpoint with the questions as given and a plain-string state", async () => {
    const s = stub(() => ok());
    const r = await generateDecision({ ...base, fetch: s.fn });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(s.calls[0]!.headers["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(s.calls[0]!.body)).not.toContain(KEY);
    expect(s.calls[0]!.body).toEqual({
      model: "perplexity/pplx-decider-flash-v1.3:free",
      state: "I was charged twice.",
      questions: {
        upset: { type: "noul", instructions: "Is the customer upset?", criteria: { true: "Says they will cancel.", false: "Asks for help." } },
        dept: { type: "choice", instructions: "Which department?", criteria: { billing: "Payments.", technical: "", other: "" } },
        urgency: { type: "score", instructions: "How urgent?", criteria: ["Low", "Medium", "High"] },
      },
    });
    expect(r.raw.request.headers["Authorization"]).toBe("[REDACTED]");
  });

  it("follows a proxy base URL: .../api/v1 becomes .../api/alpha/decisions", async () => {
    const s = stub(() => ok());
    await generateDecision({ ...base, baseUrl: "https://proxy.example/api/v1/", fetch: s.fn });
    expect(s.calls[0]!.url).toBe("https://proxy.example/api/alpha/decisions");
  });

  it("sends a list as strings and media parts: image_url with detail, raw-base64 audio, video_url, file", async () => {
    const s = stub(() => ok());
    await generateDecision({
      ...base,
      model: "openrouter/google/gemini-decision-1",
      input: [
        "Order: ",
        { type: "json", json: { id: 8821 } },
        { type: "image", image: PNG, resolution: "ultra_high" },
        { type: "image", image: PNG, resolution: "medium" },
        { type: "image", image: PNG },
        { type: "audio", audio: "data:audio/mpeg;base64,SUQz" },
        { type: "audio", audio: "data:audio/x-wav;base64,UklGRg==" },
        { type: "video", video: "data:video/mp4;base64,AAAA" },
        { type: "file", file: "data:application/pdf;base64,JVBERg==" },
      ],
      fetch: s.fn,
    });
    expect(s.calls[0]!.body.state).toEqual([
      "Order: ",
      '{"id":8821}',
      { type: "image_url", image_url: { url: PNG, detail: "high" } },
      { type: "image_url", image_url: { url: PNG, detail: "auto" } },
      { type: "image_url", image_url: { url: PNG } },
      { type: "input_audio", input_audio: { data: "SUQz", format: "mp3" } }, // raw base64, not a data URL
      { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
      { type: "file", file: { file_data: "data:application/pdf;base64,JVBERg==" } },
    ]);
  });

  it("adds the developer's provider routing and user from the openrouter setting", async () => {
    setConfigs({
      values: { catalog_refresh: "on", openrouter: { order: ["perplexity"], allow_fallbacks: false, user: "end-user-1" } },
      editable: [...SETTING_KEYS],
    });
    const s = stub(() => ok());
    await generateDecision({ ...base, fetch: s.fn });
    expect(s.calls[0]!.body.provider).toEqual({ order: ["perplexity"], allow_fallbacks: false });
    expect(s.calls[0]!.body.user).toBe("end-user-1");
  });

  it("needs a key", async () => {
    const saved = process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENROUTER_API_KEY"];
    try {
      // the model list needs the key too, so a saved list is used here
      await generateDecision({ ...base, fetch: stub(() => ok()).fn });
      resetOpenRouterDecisionsCache();
      await expect(generateDecision({ ...base, apiKey: undefined, fetch: stub(() => ok()).fn })).rejects.toBeInstanceOf(ConfigError);
    } finally {
      if (saved !== undefined) process.env["OPENROUTER_API_KEY"] = saved;
    }
  });
});

describe("OpenRouter decision adapter: the reply", () => {
  it("keeps OpenRouter's answers, fills the missing yes/no confidence and takes usage.cost as the price (a free 0 counts)", async () => {
    const r = await generateDecision({ ...base, fetch: stub(() => ok()).fn });
    expect(r.provider).toBe("openrouter");
    expect(r.model).toBe("perplexity/pplx-decider-flash-v1.3:free");
    expect(r.answers["upset"]).toEqual({ type: "noul", noul: 0.9953793833636874, confidence: 0.9953793833636874 });
    expect(r.answers["dept"]).toMatchObject({ type: "choice", choice: "billing", confidence: 0.9492294446062292 });
    expect(r.answers["urgency"]).toMatchObject({ type: "score", legend: { "0": "Low", "1": "Medium", "2": "High" } });
    expect(r.usage).toMatchObject({ inputTokens: 136, outputTokens: 3, totalTokens: 139, cost: { totalCost: 0 } });
  });

  it("OpenRouter's reported cost wins over the list's price", async () => {
    const paid = { ...real, usage: { ...real.usage, cost: 0.00003 } };
    const r = await generateDecision({ ...base, model: "openrouter/google/gemini-decision-1", fetch: stub(() => ok(paid)).fn });
    expect(r.usage.cost).toEqual({ totalCost: 0.00003 });
  });

  it("a reported cost of 0 (BYOK or a promotion) is kept even when the list has a price", async () => {
    const zero = { ...real, usage: { ...real.usage, input_tokens: 500, cost: 0 } };
    const r = await generateDecision({ ...base, model: "openrouter/google/gemini-decision-1", fetch: stub(() => ok(zero)).fn });
    expect(r.usage.cost).toEqual({ totalCost: 0 });
  });

  it("without a reported cost the list's price is used", async () => {
    const noCost = { ...real, usage: { input_tokens: 200, output_tokens: 0 } };
    const r = await generateDecision({ ...base, model: "openrouter/google/gemini-decision-1", fetch: stub(() => ok(noCost)).fn });
    expect(r.usage.cost).toEqual({ inputCost: 0.00002, outputCost: 0, totalCost: 0.00002 }); // 200 x $0.10 per 1M
  });

  it("passes a refusal through", async () => {
    const refused = { ...real, answers: { ...real.answers, dept: { type: "refusal" } } };
    const r = await generateDecision({ ...base, fetch: stub(() => ok(refused)).fn });
    expect(r.answers["dept"]).toEqual({ type: "refusal" });
  });

  it("retries a transient failure; a 402 gets a credits hint; a 400 is not retried and keeps the provider's message", async () => {
    const flaky = stub((n) => (n === 1 ? failure(503, { error: { code: 503, message: "Service temporarily unavailable" } }) : ok()));
    await generateDecision({ ...base, fetch: flaky.fn, retry: { baseDelayMs: 1 } });
    expect(flaky.calls).toHaveLength(2);

    const credits = stub(() => failure(402, { error: { code: 402, message: "Insufficient credits" } }));
    const err402 = (await generateDecision({ ...base, fetch: credits.fn }).catch((e) => e)) as ProviderError;
    expect(err402).toBeInstanceOf(ProviderError);
    expect(err402.message).toContain("too little credit for this decision");

    const bad = stub(() => failure(400, { error: { code: 400, message: "image decode failed: Format error decoding Png" } }));
    const err = (await generateDecision({ ...base, fetch: bad.fn, retry: { baseDelayMs: 1 } }).catch((e) => e)) as ProviderError;
    expect(err.message).toContain("image decode failed");
    expect(bad.calls).toHaveLength(1);
  });

  it("a reply that is not JSON is a ProviderError", async () => {
    const html = stub(() => new Response("<html>bad gateway</html>", { status: 200 }));
    await expect(generateDecision({ ...base, fetch: html.fn })).rejects.toBeInstanceOf(ProviderError);
  });
});
