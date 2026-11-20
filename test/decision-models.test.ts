import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setHome } from "../src/utils/home.ts";
import { setConfigs, SETTING_KEYS } from "../src/config/settings.ts";
import { telemetryBus } from "../src/telemetry.ts";
import { ProviderError } from "../src/types/errors.ts";
import { getDecisionModel, listDecisionModels, unsupportedDecisionModelReason } from "../src/models/decision-models.ts";
import {
  ensureOpenRouterDecisionModels,
  openRouterDecisionModels,
  refreshOpenRouterDecisionModels,
  resetOpenRouterDecisionsCache,
} from "../src/models/openrouter-decisions.ts";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-decide-"));
  setHome(home);
  resetOpenRouterDecisionsCache();
});
afterEach(() => {
  setHome();
  resetOpenRouterDecisionsCache();
  fs.rmSync(home, { recursive: true, force: true });
});

const decisions = (modalities: string[]) => ({ input_modalities: modalities, output_modalities: ["decisions"] });

// A body shaped like OpenRouter's real decision list (taken from a live call), with entries the reader must treat differently.
const list = {
  data: [
    {
      id: "google/gemini-decision-1",
      name: "Google: Gemini Decision 1",
      description: "Google's decision model.",
      context_length: 262144,
      architecture: decisions(["text", "image", "audio", "video", "file"]),
      pricing: { prompt: "0.0000001", completion: "0" },
      endpoints: ["/api/alpha/decisions"],
      expiration_date: null,
    },
    {
      id: "perplexity/pplx-decider-flash-v1.3:free",
      name: "Perplexity: Decider Flash",
      context_length: 262144,
      architecture: decisions(["text", "image"]),
      pricing: { prompt: "0", completion: "0" },
      endpoints: ["/api/alpha/decisions", "/api/alpha/extractions"],
      expiration_date: null,
    },
    {
      id: "vendor/with-cache",
      name: "With cache",
      context_length: 0,
      architecture: decisions(["text"]),
      pricing: { prompt: "0.00000004", input_cache_read: "0.000000004", input_cache_write: "0" },
    },
    {
      id: "cloudflare/extractions-only",
      architecture: decisions(["text", "image"]),
      pricing: { prompt: "0.0000001" },
      endpoints: ["/api/alpha/extractions"],
    },
    {
      id: "liquid/d1",
      architecture: decisions(["text"]),
      pricing: { prompt: "0.00000002" },
      endpoints: ["/api/alpha/decisions"],
      expiration_date: "2020-01-01",
    },
    { id: "chat/model", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: {} },
    { architecture: decisions(["text"]) },
    "not an object",
  ],
};

// A fetch that answers with `body`, records each call's URL and headers.
function listFetch(body: unknown = list, init?: ResponseInit) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = (async (url: string, req?: RequestInit) => {
    calls.push({ url: String(url), headers: (req?.headers ?? {}) as Record<string, string> });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// Lets the refresh setting be "on" for one test (the global preload turns it off).
const refreshOn = () => setConfigs({ values: { catalog_refresh: "on" }, editable: [...SETTING_KEYS] });

describe("the curated decision models", () => {
  it("are one Google and one OpenAI model with the facts the providers state", () => {
    expect(listDecisionModels().map((m) => m.model)).toEqual(["google/gemini-decision-1", "openai/gpt-6-luna"]);
    expect(listDecisionModels("gemini")).toHaveLength(1); // the SDK routes gemini/ to google

    const g = getDecisionModel("google/gemini-decision-1")!;
    expect(g.inputs).toEqual(["text", "image", "audio", "video", "pdf"]);
    expect(g.limits).toEqual({ inputTokens: 262_144, questions: 1000, options: 255, levels: 255 });
    expect(g.prices).toEqual({ input: 0.1 });

    const o = getDecisionModel("openai/gpt-6-luna")!;
    expect(o.inputs).toEqual(["text", "image"]);
    expect(o.limits).toEqual({ questions: 400, options: 255, levels: 10 });
    expect(o.prices).toEqual({ input: 0.1, cacheRead: 0.01, longContext: { aboveTokens: 272_000, multiplier: 2 } }); // output is not charged; the cache-write rate is not stated: left out
  });

  it("are found by provider/id, by the gemini/ alias and by a bare id when only one provider has it", () => {
    expect(getDecisionModel("gemini/gemini-decision-1")!.model).toBe("google/gemini-decision-1");
    expect(getDecisionModel("gpt-6-luna")!.provider).toBe("openai");
    expect(getDecisionModel("openai/gemini-decision-1")).toBeUndefined();
    expect(getDecisionModel("")).toBeUndefined();
  });

  it("an unknown model gets a reason that lists the known ones", () => {
    expect(unsupportedDecisionModelReason("google/gemini-decision-1")).toBeUndefined();
    const why = unsupportedDecisionModelReason("openai/gpt-5")!;
    expect(why).toContain('"openai/gpt-5" is not a known decision model');
    expect(why).toContain("google/gemini-decision-1");
    expect(unsupportedDecisionModelReason("openrouter/x/y")).toContain("may not be loaded yet");
  });
});

describe("the OpenRouter decision list", () => {
  it("is empty until it was downloaded, and nothing is created by asking", () => {
    expect(openRouterDecisionModels()).toEqual([]);
    expect(listDecisionModels("openrouter")).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("is read with the OpenRouter key, saved in the catalog folder, and joins the lookups", async () => {
    const { fn, calls } = listFetch();
    const models = await refreshOpenRouterDecisionModels({ fetch: fn, apiKey: "sk-or-test" });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/models?output_modalities=decisions");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer sk-or-test"); // the list needs a key
    // expired, extractions-only, non-decision and malformed entries are skipped
    expect(models.map((m) => m.model)).toEqual([
      "openrouter/google/gemini-decision-1",
      "openrouter/perplexity/pplx-decider-flash-v1.3:free",
      "openrouter/vendor/with-cache",
    ]);
    expect(fs.existsSync(path.join(home, "catalog", "openrouter-decisions.json"))).toBe(true);

    const g = getDecisionModel("openrouter/google/gemini-decision-1")!;
    expect(g).toMatchObject({ provider: "openrouter", id: "google/gemini-decision-1", name: "Google: Gemini Decision 1" });
    expect(g.inputs).toEqual(["text", "image", "audio", "video", "pdf"]); // OpenRouter's "file" is a document
    expect(g.limits).toEqual({ inputTokens: 262144 });
    expect(g.prices).toEqual({ input: 0.1 }); // per token in the list, per 1M tokens here

    const free = getDecisionModel("openrouter/perplexity/pplx-decider-flash-v1.3:free")!;
    expect(free.inputs).toEqual(["text", "image"]);
    expect(free.prices).toEqual({ input: 0 }); // free is a known price

    const cached = getDecisionModel("openrouter/vendor/with-cache")!;
    expect(cached.prices).toEqual({ input: 0.04, cacheRead: 0.004 }); // a 0 cache-write price is not a price
    expect(cached.limits).toEqual({}); // a context length of 0 is not stated

    // the same id under another provider is a different model
    expect(getDecisionModel("google/gemini-decision-1")!.provider).toBe("google");
    expect(listDecisionModels("openrouter")).toHaveLength(3);
    expect(listDecisionModels()).toHaveLength(5);
  });

  it("is not downloaded again while fresh, unless forced", async () => {
    const { fn, calls } = listFetch();
    await refreshOpenRouterDecisionModels({ fetch: fn });
    await refreshOpenRouterDecisionModels({ fetch: fn });
    expect(calls).toHaveLength(1);
    await refreshOpenRouterDecisionModels({ fetch: fn, force: true });
    expect(calls).toHaveLength(2);
  });

  it("a failed or wrong download throws a ProviderError and keeps the saved copy", async () => {
    await refreshOpenRouterDecisionModels({ fetch: listFetch().fn });
    const file = path.join(home, "catalog", "openrouter-decisions.json");
    const before = fs.readFileSync(file, "utf8");
    for (const bad of [
      listFetch("<html>maintenance</html>").fn,
      listFetch({ data: [] }).fn,
      listFetch({ nope: 1 }).fn,
      (async () => new Response("down", { status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch,
    ]) {
      const err = (await refreshOpenRouterDecisionModels({ fetch: bad, force: true }).catch((e) => e)) as ProviderError;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toContain("could not read the decision model list");
    }
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(openRouterDecisionModels()).toHaveLength(3);
  });

  it("ensure downloads a missing list once at a time and uses a fresh one as is", async () => {
    refreshOn();
    const { fn, calls } = listFetch();
    const [a, b] = await Promise.all([ensureOpenRouterDecisionModels({ fetch: fn }), ensureOpenRouterDecisionModels({ fetch: fn })]);
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    expect(calls).toHaveLength(1);
    await ensureOpenRouterDecisionModels({ fetch: fn });
    expect(calls).toHaveLength(1);
  });

  it("never touches the network when catalog_refresh is off", async () => {
    const { fn, calls } = listFetch(); // the global preload turned refreshing off
    expect(await ensureOpenRouterDecisionModels({ fetch: fn })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("a failed refresh falls back to a stale copy with a warning, and throws without any copy", async () => {
    refreshOn();
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(ensureOpenRouterDecisionModels({ fetch: failing })).rejects.toBeInstanceOf(ProviderError);
    resetOpenRouterDecisionsCache();
    await refreshOpenRouterDecisionModels({ fetch: listFetch().fn, ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 5)); // now stale
    const events: string[] = [];
    const off = telemetryBus.onEvent((e) => events.push(e.code));
    try {
      expect(await ensureOpenRouterDecisionModels({ fetch: failing })).toHaveLength(3);
      expect(events).toContain("decision_models_refresh_failed");
    } finally {
      off();
    }
  });
});
