import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateDecision,
  getProvider,
  setModels,
  DecisionResult,
  ConfigError,
  ValidationError,
  BudgetExceededError,
  ProviderError,
  TimeoutError,
  ModelNotAllowedError,
  SecurityPolicyError,
  setHome,
} from "../src/index.ts";
import { resetModels } from "../src/config/models.ts";
import { setConfigs, SETTING_KEYS } from "../src/config/settings.ts";
import { setGovernorLimits } from "../src/agent/governor.ts";
import { resetOpenRouterDecisionsCache } from "../src/models/openrouter-decisions.ts";
import type { ProviderDecisionRequest, ProviderDecisionResult, ProviderDecisionAnswer } from "../src/types/decision.ts";

type Hook = (modelId: string, req: ProviderDecisionRequest, options: any) => Promise<ProviderDecisionResult>;

const questions = {
  upset: { type: "noul" as const, instructions: "Is the customer upset?" },
  dept: { type: "choice" as const, instructions: "Which team?", criteria: { billing: "Payments.", other: "" } },
  urgency: { type: "score" as const, instructions: "How urgent?", criteria: ["Low", "Medium", "High"] },
};
const goodAnswers: Record<string, ProviderDecisionAnswer> = {
  upset: { type: "noul", noul: 0.9 }, // no confidence: the SDK fills it
  dept: { type: "choice", choice: "billing", probabilities: { billing: 0.8, other: 0.2 }, confidence: 0.8 },
  urgency: { type: "score", score: 1.5, probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 } }, // no legend, no confidence
};
const reply = (extra: Partial<ProviderDecisionResult> = {}, answers = goodAnswers): ProviderDecisionResult => ({
  answers,
  usage: { inputTokens: 200, outputTokens: 0, totalTokens: 200 },
  model: "m",
  provider: "google",
  raw: { request: { url: "https://x/decisions", method: "POST", headers: {}, body: { input: "secret text", model: "m" } } },
  durationMs: 1,
  ...extra,
});

// The registry's providers are singletons: put a fake `decide` on one and restore it afterwards.
const patched: Array<() => void> = [];
function fake(provider: "google" | "openai" | "openrouter", hook: Hook | undefined) {
  const target = getProvider(provider) as unknown as { decide?: Hook };
  const before = Object.getOwnPropertyDescriptor(target, "decide");
  const calls: ProviderDecisionRequest[] = [];
  const options: any[] = [];
  target.decide = hook
    ? (m, req, o) => {
        calls.push(req);
        options.push(o);
        return hook(m, req, o);
      }
    : undefined;
  patched.push(() => (before ? Object.defineProperty(target, "decide", before) : delete target.decide));
  return { calls, options };
}
const base = { model: "google/gemini-decision-1", input: "I was charged twice.", questions, apiKey: "k" };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "accel-dec-"));
  setHome(dir);
  resetOpenRouterDecisionsCache();
});
afterEach(() => {
  while (patched.length) patched.pop()!();
  resetModels();
  setGovernorLimits(undefined);
  setHome();
  resetOpenRouterDecisionsCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("generateDecision", () => {
  it("returns completed answers, priced from the table, with the wire audit redacted", async () => {
    const { calls, options } = fake("google", async () => reply());
    const r = await generateDecision({ ...base, timeoutMs: 5000 });
    expect(r).toBeInstanceOf(DecisionResult);
    expect(r.model).toBe("gemini-decision-1");
    expect(r.provider).toBe("google");
    // one request holds the whole input and every question
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual([{ kind: "text", text: "I was charged twice." }]);
    expect(Object.keys(calls[0]!.questions)).toEqual(["upset", "dept", "urgency"]);
    expect(options[0].timeoutMs).toBe(5000);
    expect(options[0].apiKey).toBe("k");
    expect(options[0].signal).toBeInstanceOf(AbortSignal);
    // the SDK fills what a provider leaves out
    expect(r.answers["upset"]).toEqual({ type: "noul", noul: 0.9, confidence: 0.9 }); // max(p, 1 - p)
    expect(r.answers["dept"]).toEqual({ type: "choice", choice: "billing", probabilities: { billing: 0.8, other: 0.2 }, confidence: 0.8 });
    expect(r.answers["urgency"]).toEqual({
      type: "score",
      score: 1.5,
      probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 },
      legend: { "0": "Low", "1": "Medium", "2": "High" }, // from the criteria
      confidence: 0.6, // the top probability
    });
    // 200 input tokens at $0.10 per 1M
    expect(r.usage.cost).toEqual({ inputCost: 0.00002, outputCost: 0, totalCost: 0.00002 });
    // the default raw keeps no body content
    expect(JSON.stringify(r.raw)).not.toContain("secret text");
  });

  it("the provider's own cost wins over the table (a free model is a known $0)", async () => {
    fake("google", async () => reply({ usage: { inputTokens: 200, outputTokens: 0, totalTokens: 200, cost: { totalCost: 0 } } }));
    expect((await generateDecision(base)).usage.cost).toEqual({ totalCost: 0 });
  });

  it("a model with no price gives an unknown cost, never $0", async () => {
    fake("openrouter", async () => reply({ provider: "openrouter" }));
    setConfigs({ values: { catalog_refresh: "on" }, editable: [...SETTING_KEYS] });
    const list = {
      data: [{ id: "x/free", architecture: { input_modalities: ["text"], output_modalities: ["decisions"] }, pricing: {}, endpoints: ["/api/alpha/decisions"] }],
    };
    const fetchList = (async () => new Response(JSON.stringify(list))) as unknown as typeof fetch;
    const r = await generateDecision({ ...base, model: "openrouter/x/free", fetch: fetchList });
    expect(r.usage.cost).toBeUndefined();
  });

  it("passes a refusal through while the other questions keep their answers", async () => {
    fake("google", async () => reply({}, { ...goodAnswers, dept: { type: "refusal" } }));
    const r = await generateDecision(base);
    expect(r.answers["dept"]).toEqual({ type: "refusal" });
    expect(r.answers["upset"]!.type).toBe("noul");
  });

  it("reads OpenRouter's list first for an openrouter/ model, using the caller's key and fetch", async () => {
    setConfigs({ values: { catalog_refresh: "on" }, editable: [...SETTING_KEYS] });
    fake("openrouter", async () => reply({ provider: "openrouter" }));
    const seen: Array<{ url: string; auth: string }> = [];
    const list = {
      data: [
        {
          id: "perplexity/pplx-decider-flash-v1.3:free",
          architecture: { input_modalities: ["text", "image"], output_modalities: ["decisions"] },
          pricing: { prompt: "0" },
          endpoints: ["/api/alpha/decisions"],
        },
      ],
    };
    const fetchList = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), auth: String((init?.headers as Record<string, string>)["Authorization"]) });
      return new Response(JSON.stringify(list));
    }) as unknown as typeof fetch;
    const r = await generateDecision({ ...base, model: "openrouter/perplexity/pplx-decider-flash-v1.3:free", apiKey: "sk-or-1", fetch: fetchList });
    expect(r.provider).toBe("openrouter");
    expect(seen).toEqual([{ url: "https://openrouter.ai/api/v1/models?output_modalities=decisions", auth: "Bearer sk-or-1" }]);
    expect(r.usage.cost).toEqual({ inputCost: 0, outputCost: 0, totalCost: 0 }); // the list's free price is a known $0
  });

  it("reads files (inside fileAccess.roots) before the adapter sees them", async () => {
    const png = path.join(dir, "p.png");
    fs.writeFileSync(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    const { calls } = fake("google", async () => reply());
    await generateDecision({ ...base, input: [{ type: "text", text: "see" }, { type: "image", image: png }], fileAccess: { roots: [dir] } });
    const part = calls[0]!.input[1]!;
    expect(part.kind).toBe("image");
    expect((part as { media: { mimeType: string } }).media.mimeType).toBe("image/png");
    await expect(
      generateDecision({ ...base, input: [{ type: "image", image: "/etc/hostname" }], fileAccess: { roots: [dir] } })
    ).rejects.toBeInstanceOf(SecurityPolicyError);
  });

  it("refuses before any network call: unknown model, model outside the list, no adapter, bad request", async () => {
    const { calls } = fake("google", async () => reply());
    await expect(generateDecision({ ...base, model: "google/gemini-3.5-flash" })).rejects.toBeInstanceOf(ConfigError);
    await expect(generateDecision({ ...base, input: { type: "audio", audio: "a.mp3" }, model: "openai/gpt-6-luna" })).rejects.toBeInstanceOf(ValidationError);
    fake("openai", undefined);
    await expect(generateDecision({ ...base, model: "openai/gpt-6-luna" })).rejects.toThrow("cannot make decisions yet");
    setModels({ default: { model: "openai/gpt-5", sub_agent_model: "openai/gpt-5" }, providers: { openai: { models: ["gpt-5"] } } });
    await expect(generateDecision(base)).rejects.toBeInstanceOf(ModelNotAllowedError);
    expect(calls).toHaveLength(0);
  });

  it("an unusable reply is a non-retryable ProviderError naming the question", async () => {
    const wrong: Array<[string, Record<string, ProviderDecisionAnswer>]> = [
      ["no answer came back", { ...goodAnswers, dept: undefined as never }],
      ["the answer is a score, the question was a noul", { ...goodAnswers, upset: { type: "score", score: 1, probabilities: { "0": 1 } } }],
      ["the yes probability is not a number from 0 to 1", { ...goodAnswers, upset: { type: "noul", noul: 1.5 } }],
      ['"nope" is not one of the options', { ...goodAnswers, dept: { type: "choice", choice: "nope", probabilities: { billing: 1 } } }],
      ["the probabilities name an option that was not asked", { ...goodAnswers, dept: { type: "choice", choice: "billing", probabilities: { billing: 0.5, ghost: 0.5 } } }],
      ["the probabilities are missing", { ...goodAnswers, dept: { type: "choice", choice: "billing" } as never }],
      ["the score is not a number from 0 to 2", { ...goodAnswers, urgency: { type: "score", score: 3, probabilities: { "0": 1 } } }],
      ["the probabilities name a level that was not asked", { ...goodAnswers, urgency: { type: "score", score: 1, probabilities: { "5": 1 } } }],
    ];
    for (const [why, answers] of wrong) {
      fake("google", async () => reply({}, answers));
      const err = (await generateDecision(base).catch((e) => e)) as ProviderError;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain(why);
      expect(err.message).toContain("returned an unusable decision reply");
      patched.pop()!();
    }
  });

  it("stops over budget.maxCostUsd and rejects a bad budget before the call", async () => {
    fake("google", async () => reply({ usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100, cost: { totalCost: 0.5 } } }));
    const err = (await generateDecision({ ...base, budget: { maxCostUsd: 0.1 } }).catch((e) => e)) as BudgetExceededError;
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as unknown as { partial: { answers: object } }).partial.answers).toBeDefined();
    await expect(generateDecision({ ...base, budget: { maxCostUsd: 0 } })).rejects.toBeInstanceOf(ValidationError);
  });

  it("aborts before the call, during it, and on a timeout", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { calls } = fake("google", async () => reply());
    await expect(generateDecision({ ...base, signal: ctl.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
    patched.pop()!();

    const live = new AbortController();
    fake("google", () => new Promise(() => {})); // never answers
    const running = generateDecision({ ...base, signal: live.signal });
    setTimeout(() => live.abort(new Error("stop it")), 10);
    await expect(running).rejects.toMatchObject({ name: "AbortError", message: "stop it" });
    patched.pop()!();

    fake("google", () => new Promise(() => {}));
    await expect(generateDecision({ ...base, timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError);
  });

  it("waits for a provider slot when a concurrency limit is set", async () => {
    setGovernorLimits({ maxRequests: 1 });
    let running = 0;
    let peak = 0;
    fake("google", async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 15));
      running--;
      return reply();
    });
    await Promise.all([generateDecision(base), generateDecision(base), generateDecision(base)]);
    expect(peak).toBe(1);
  });

  it("keeps the wire exchange only when asked", async () => {
    fake("google", async () => reply());
    expect(JSON.stringify((await generateDecision({ ...base, captureRaw: true })).raw)).toContain("secret text");
  });
});
