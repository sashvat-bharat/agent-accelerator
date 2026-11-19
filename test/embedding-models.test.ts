import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setHome } from "../src/utils/home.ts";
import { setConfigs, SETTING_KEYS } from "../src/config/settings.ts";
import { telemetryBus } from "../src/telemetry.ts";
import { ProviderError } from "../src/types/errors.ts";
import {
  getEmbeddingModel,
  listEmbeddingModels,
  unsupportedEmbeddingModelReason,
} from "../src/models/embedding-models.ts";
import {
  ensureOpenRouterEmbeddingModels,
  openRouterEmbeddingModels,
  refreshOpenRouterEmbeddingModels,
  resetOpenRouterEmbeddingsCache,
} from "../src/models/openrouter-embeddings.ts";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-embed-"));
  setHome(home);
  resetOpenRouterEmbeddingsCache();
});
afterEach(() => {
  setHome();
  resetOpenRouterEmbeddingsCache();
  fs.rmSync(home, { recursive: true, force: true });
});

// A body shaped like OpenRouter's embedding model list, with a few entries the reader must treat differently.
const list = {
  data: [
    {
      id: "cohere/embed-5-fast",
      name: "Cohere: Embed 5 Fast",
      description: "Fast embeddings.",
      context_length: 128000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["embeddings"] },
      pricing: { prompt: "0.00000008", completion: "0" },
      expiration_date: null,
    },
    {
      id: "google/gemini-embedding-2",
      name: "Google: Gemini Embedding 2",
      context_length: 8192,
      architecture: { input_modalities: ["text", "image", "file", "audio", "video"], output_modalities: ["embeddings"] },
      pricing: { prompt: "0.0000002", image: "0.00000045", audio: "0.0000065" },
    },
    {
      id: "nvidia/free-one:free",
      name: "Free",
      context_length: 4096,
      architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
      pricing: { prompt: "0" },
    },
    {
      id: "old/expired",
      architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
      pricing: { prompt: "0.1" },
      expiration_date: "2020-01-01",
    },
    { id: "chat/model", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: {} },
    { architecture: { input_modalities: ["text"] } },
    "not an object",
  ],
};

// A fetch that answers with `body` and counts its calls.
function listFetch(body: unknown = list, init?: ResponseInit) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// Lets the refresh setting be "on" for one test (the global preload turns it off).
const refreshOn = () => setConfigs({ values: { catalog_refresh: "on" }, editable: [...SETTING_KEYS] });

describe("the curated embedding models", () => {
  it("are two Google and three OpenAI models, sorted, with the facts the providers state", () => {
    expect(listEmbeddingModels().map((m) => m.model)).toEqual([
      "google/gemini-embedding-001",
      "google/gemini-embedding-2",
      "openai/text-embedding-3-large",
      "openai/text-embedding-3-small",
      "openai/text-embedding-ada-002",
    ]);
    expect(listEmbeddingModels("gemini")).toHaveLength(2); // the SDK routes gemini/ to google
    expect(listEmbeddingModels("openai")).toHaveLength(3);
    expect(listEmbeddingModels("anthropic")).toEqual([]);

    const two = getEmbeddingModel("google/gemini-embedding-2")!;
    expect(two.inputs).toEqual(["text", "image", "audio", "video", "pdf"]);
    expect(two.combinesInputs).toBe(true);
    expect(two.task).toBe("prefix");
    expect(two.limits).toMatchObject({ inputTokens: 8192, images: 6, audioSeconds: 180, videoSeconds: 120, pdfPages: 6 });
    expect(two.prices).toMatchObject({ textInput: 0.2, imageInput: 0.45, audioInput: 6.5, videoInput: 12 });

    const one = getEmbeddingModel("google/gemini-embedding-001")!;
    expect(one.inputs).toEqual(["text"]);
    expect(one.task).toBe("taskType");
    expect(one.renormalizeShortened).toBe(true);
    expect(one.combinesInputs).toBeUndefined();
    expect(one.limits.inputTokens).toBe(2048);

    expect(getEmbeddingModel("openai/text-embedding-3-small")!.prices).toEqual({ textInput: 0.02 });
    expect(getEmbeddingModel("openai/text-embedding-3-large")!.dimensions).toMatchObject({ default: 3072, shortenable: true });
    expect(getEmbeddingModel("openai/text-embedding-ada-002")!.dimensions).toEqual({ default: 1536, shortenable: false });
  });

  it("every model says who serves it, how big its vectors are and what a task looks like", () => {
    for (const m of listEmbeddingModels()) {
      expect(m.model).toBe(`${m.provider}/${m.id}`);
      expect(m.inputs).toContain("text");
      expect(m.dimensions!.default).toBeGreaterThan(0);
      expect(["taskType", "prefix", "inputType", "none"]).toContain(m.task);
      expect(m.prices!.textInput).toBeGreaterThan(0);
    }
  });

  it("are found by provider/id, by the gemini/ alias and by a bare id when only one provider has it", () => {
    expect(getEmbeddingModel("gemini/gemini-embedding-2")!.model).toBe("google/gemini-embedding-2");
    expect(getEmbeddingModel("text-embedding-3-small")!.provider).toBe("openai");
    expect(getEmbeddingModel("google/text-embedding-3-small")).toBeUndefined();
    expect(getEmbeddingModel("nope/none")).toBeUndefined();
    expect(getEmbeddingModel("")).toBeUndefined();
  });

  it("an unknown model gets a reason that lists the known ones", () => {
    expect(unsupportedEmbeddingModelReason("openai/text-embedding-3-small")).toBeUndefined();
    const why = unsupportedEmbeddingModelReason("openai/gpt-5")!;
    expect(why).toContain('"openai/gpt-5" is not a known embedding model');
    expect(why).toContain("google/gemini-embedding-2");
    expect(unsupportedEmbeddingModelReason("openrouter/x/y")).toContain("may not be loaded yet");
  });
});

describe("the OpenRouter embedding list", () => {
  it("is empty until it was downloaded, and nothing is created by asking", () => {
    expect(openRouterEmbeddingModels()).toEqual([]);
    expect(listEmbeddingModels("openrouter")).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("is read from OpenRouter's list, saved in the catalog folder, and joins the lookups", async () => {
    const { fn, calls } = listFetch();
    const models = await refreshOpenRouterEmbeddingModels({ fetch: fn });
    expect(calls).toEqual(["https://openrouter.ai/api/v1/embeddings/models"]);
    // expired, non-embedding and malformed entries are skipped
    expect(models.map((m) => m.model)).toEqual([
      "openrouter/cohere/embed-5-fast",
      "openrouter/google/gemini-embedding-2",
      "openrouter/nvidia/free-one:free",
    ]);
    expect(fs.existsSync(path.join(home, "catalog", "openrouter-embeddings.json"))).toBe(true);

    const cohere = getEmbeddingModel("openrouter/cohere/embed-5-fast")!;
    expect(cohere).toMatchObject({ provider: "openrouter", id: "cohere/embed-5-fast", name: "Cohere: Embed 5 Fast", task: "inputType" });
    expect(cohere.inputs).toEqual(["text", "image"]);
    expect(cohere.limits).toEqual({ inputTokens: 128000 });
    expect(cohere.prices).toEqual({ textInput: 0.08 }); // per token in the list, per 1M tokens here
    expect(cohere.dimensions).toBeUndefined(); // the list does not state it: never guessed

    const g = getEmbeddingModel("openrouter/google/gemini-embedding-2")!;
    expect(g.inputs).toEqual(["text", "image", "pdf", "audio", "video"]); // OpenRouter's "file" is a document
    expect(g.prices).toEqual({ textInput: 0.2, imageInput: 0.45, audioInput: 6.5 });

    expect(getEmbeddingModel("openrouter/nvidia/free-one:free")!.prices).toEqual({ textInput: 0 }); // free is a known price
    // the same id under another provider is a different model
    expect(getEmbeddingModel("google/gemini-embedding-2")!.provider).toBe("google");
    expect(listEmbeddingModels("openrouter")).toHaveLength(3);
    expect(listEmbeddingModels()).toHaveLength(8);
  });

  it("is not downloaded again while fresh, unless forced", async () => {
    const { fn, calls } = listFetch();
    await refreshOpenRouterEmbeddingModels({ fetch: fn });
    await refreshOpenRouterEmbeddingModels({ fetch: fn });
    expect(calls).toHaveLength(1);
    await refreshOpenRouterEmbeddingModels({ fetch: fn, force: true });
    expect(calls).toHaveLength(2);
  });

  it("a failed or wrong download throws a ProviderError and keeps the saved copy", async () => {
    await refreshOpenRouterEmbeddingModels({ fetch: listFetch().fn });
    const before = fs.readFileSync(path.join(home, "catalog", "openrouter-embeddings.json"), "utf8");
    for (const bad of [
      listFetch("<html>maintenance</html>").fn,
      listFetch({ data: [] }).fn,
      listFetch({ nope: 1 }).fn,
      (async () => new Response("down", { status: 503, statusText: "Service Unavailable" })) as unknown as typeof fetch,
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    ]) {
      const err = await refreshOpenRouterEmbeddingModels({ fetch: bad, force: true }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toContain("could not read the embedding model list");
      expect(err.retryable).toBe(true);
    }
    expect(fs.readFileSync(path.join(home, "catalog", "openrouter-embeddings.json"), "utf8")).toBe(before);
    expect(openRouterEmbeddingModels()).toHaveLength(3);
  });

  it("a damaged saved file counts as no list", async () => {
    await refreshOpenRouterEmbeddingModels({ fetch: listFetch().fn });
    fs.writeFileSync(path.join(home, "catalog", "openrouter-embeddings.json"), "{ not json");
    resetOpenRouterEmbeddingsCache();
    expect(openRouterEmbeddingModels()).toEqual([]);
  });

  it("sees a list another process saved (the file's change is noticed)", async () => {
    await refreshOpenRouterEmbeddingModels({ fetch: listFetch().fn });
    expect(openRouterEmbeddingModels()).toHaveLength(3);
    const file = path.join(home, "catalog", "openrouter-embeddings.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.models = saved.models.slice(0, 1);
    fs.writeFileSync(file, JSON.stringify(saved));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // a later modification time, as another write would leave
    expect(openRouterEmbeddingModels()).toHaveLength(1);
  });

  it("follows setHome: another home has its own list", async () => {
    await refreshOpenRouterEmbeddingModels({ fetch: listFetch().fn });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "aa-embed-other-"));
    try {
      setHome(other);
      expect(openRouterEmbeddingModels()).toEqual([]);
    } finally {
      setHome(home);
      fs.rmSync(other, { recursive: true, force: true });
    }
    expect(openRouterEmbeddingModels()).toHaveLength(3);
  });
});

describe("ensuring the OpenRouter embedding list", () => {
  it("downloads only when there is no fresh copy, and shares one download between callers", async () => {
    refreshOn();
    const { fn, calls } = listFetch();
    const [a, b] = await Promise.all([ensureOpenRouterEmbeddingModels({ fetch: fn }), ensureOpenRouterEmbeddingModels({ fetch: fn })]);
    expect(calls).toHaveLength(1);
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    await ensureOpenRouterEmbeddingModels({ fetch: fn });
    expect(calls).toHaveLength(1); // fresh now
  });

  it("never touches the network when catalog_refresh is off (the saved copy, or nothing, is returned)", async () => {
    const { fn, calls } = listFetch();
    expect(await ensureOpenRouterEmbeddingModels({ fetch: fn })).toEqual([]); // the global preload set it off
    expect(calls).toHaveLength(0);
    await refreshOpenRouterEmbeddingModels({ fetch: fn, ttlMs: 1 }); // an explicit refresh still works
    await new Promise((r) => setTimeout(r, 5));
    expect(await ensureOpenRouterEmbeddingModels({ fetch: fn })).toHaveLength(3); // stale, but off: used as is
    expect(calls).toHaveLength(1);
  });

  it("a failed refresh falls back to the stale copy with a warning, and is not retried for a while", async () => {
    refreshOn();
    await refreshOpenRouterEmbeddingModels({ fetch: listFetch().fn, ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const events: string[] = [];
    const off = telemetryBus.onEvent((e) => events.push(e.code));
    try {
      let attempts = 0;
      const failing = (async () => {
        attempts++;
        throw new Error("offline");
      }) as unknown as typeof fetch;
      expect(await ensureOpenRouterEmbeddingModels({ fetch: failing })).toHaveLength(3);
      expect(events).toContain("embedding_models_refresh_failed");
      expect(await ensureOpenRouterEmbeddingModels({ fetch: failing })).toHaveLength(3);
      expect(attempts).toBe(1); // inside the 10 minute backoff
    } finally {
      off();
    }
  });

  it("with no copy at all a failed download is thrown", async () => {
    refreshOn();
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(ensureOpenRouterEmbeddingModels({ fetch: failing })).rejects.toBeInstanceOf(ProviderError);
  });

  it("keeps the list in memory when the folder cannot be written", async () => {
    refreshOn();
    const blocker = path.join(home, "blocked");
    fs.writeFileSync(blocker, "a file where the folder should be");
    setConfigs({
      values: { catalog_refresh: "on", catalog_cache_dir: path.join(blocker, "inside") },
      editable: [...SETTING_KEYS],
    });
    const events: string[] = [];
    const off = telemetryBus.onEvent((e) => events.push(e.code));
    try {
      const models = await refreshOpenRouterEmbeddingModels({ fetch: listFetch().fn });
      expect(models).toHaveLength(3);
      expect(events).toContain("embedding_models_cache_write_failed");
      expect(openRouterEmbeddingModels()).toHaveLength(3); // still served from memory
    } finally {
      off();
    }
  });
});
