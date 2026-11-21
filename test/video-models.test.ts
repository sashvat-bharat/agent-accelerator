import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setHome } from "../src/utils/home.ts";
import { setConfigs, SETTING_KEYS } from "../src/config/settings.ts";
import { ProviderError } from "../src/types/errors.ts";
import { getVideoModel, listVideoModels, unsupportedVideoModelReason } from "../src/models/video-models.ts";
import {
  ensureOpenRouterVideoModels,
  openRouterVideoModels,
  refreshOpenRouterVideoModels,
  resetOpenRouterVideosCache,
} from "../src/models/openrouter-videos.ts";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-video-"));
  setHome(home);
  resetOpenRouterVideosCache();
});
afterEach(() => {
  setHome();
  resetOpenRouterVideosCache();
  fs.rmSync(home, { recursive: true, force: true });
});

// OpenRouter's REAL public list of 21 Nov 2026 (35 models), saved as it was served.
const real = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", "openrouter-video-models.json"), "utf8"));

function listFetch(body: unknown = real) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const refreshOn = () => setConfigs({ values: { catalog_refresh: "on" }, editable: [...SETTING_KEYS] });

describe("the curated Google video model", () => {
  it("is one model, Gemini Omni 1.2 Flash, with the facts Google states", () => {
    expect(listVideoModels("google").map((m) => m.model)).toEqual(["google/gemini-omni-1.2-flash"]);
    const m = getVideoModel("google/gemini-omni-1.2-flash")!;
    expect(m.durations).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(m.defaultDuration).toBe(10);
    expect(m.resolutions).toEqual(["360p", "720p", "1080p", "4K"]);
    expect(m.defaultResolution).toBe("720p");
    expect(m.aspectRatios).toEqual(["16:9", "9:16"]);
    expect(m.frames).toEqual(["first_frame", "last_frame"]);
    expect(m.references.images).toEqual({ max: 6 });
    expect(m.references.videos).toEqual({ maxClips: 3, clipSeconds: 3, longOutput: { aboveSeconds: 10, maxClips: 1 } });
    expect(m.limits).toEqual({ inputVideoSeconds: 15, framePairMaxSeconds: 10, inlineOutputBytes: 4_000_000 });
  });

  it("prices: 5,792 tokens per second of 720p at $12 per 1M is $0.069504 a second, the number OpenRouter lists too", () => {
    const p = getVideoModel("google/gemini-omni-1.2-flash")!.prices!;
    expect((p.outputTokensPerSecond["720p"]! * p.videoOutputPerMillion) / 1_000_000).toBeCloseTo(0.069504, 9);
    const listed = real.data.find((m: { id: string }) => m.id === "google/gemini-omni-1.2-flash").pricing_skus;
    expect(Number(listed.duration_seconds_with_audio_720p)).toBeCloseTo(0.069504, 9);
    expect((p.outputTokensPerSecond["1080p"]! * p.videoOutputPerMillion) / 1_000_000).toBeCloseTo(0.104256, 9);
    expect((p.outputTokensPerSecond["4K"]! * p.videoOutputPerMillion) / 1_000_000).toBeCloseTo(0.208512, 9);
    expect((p.outputTokensPerSecond["360p"]! * p.videoOutputPerMillion) / 1_000_000).toBeCloseTo(0.023172, 9);
  });

  it("the previous generation is not known at all: no entry, no alias, just an unknown-model error", () => {
    expect(getVideoModel("google/gemini-omni-1.1-flash")).toBeUndefined();
    expect(getVideoModel("gemini-omni-1.1-flash")).toBeUndefined();
    const why = unsupportedVideoModelReason("google/gemini-omni-1.1-flash")!;
    expect(why).toContain('"google/gemini-omni-1.1-flash" is not a known video model');
    expect(why).toContain("google/gemini-omni-1.2-flash");
    expect(why.toLowerCase()).not.toContain("deprecated");
    expect(why.toLowerCase()).not.toContain("rerout");
  });

  it("is found by provider/id, by the gemini/ alias and by a bare id when only one provider has it", () => {
    expect(getVideoModel("gemini/gemini-omni-1.2-flash")!.model).toBe("google/gemini-omni-1.2-flash");
    expect(getVideoModel("gemini-omni-1.2-flash")!.provider).toBe("google");
    expect(getVideoModel("openai/gemini-omni-1.2-flash")).toBeUndefined();
    expect(getVideoModel("")).toBeUndefined();
    expect(unsupportedVideoModelReason("google/gemini-omni-1.2-flash")).toBeUndefined();
    expect(unsupportedVideoModelReason("openrouter/x/y")).toContain("may not be loaded yet");
  });
});

describe("the OpenRouter video list (the real one)", () => {
  it("is empty until it was downloaded, and nothing is created by asking", () => {
    expect(openRouterVideoModels()).toEqual([]);
    expect(listVideoModels("openrouter")).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("keeps the 28 prompt-to-video models and drops the 6 source-video tools and the old Omni", async () => {
    const { fn, calls } = listFetch();
    const models = await refreshOpenRouterVideoModels({ fetch: fn });
    expect(calls).toEqual(["https://openrouter.ai/api/v1/videos/models"]);
    expect(real.data).toHaveLength(35);
    expect(models).toHaveLength(28);
    const ids = models.map((m) => m.id);
    for (const gone of [
      "heygen/heygen-avatar-6",
      "heygen/heygen-avatar-6-turbo",
      "heygen/avatar-iv",
      "black-forest-labs/flux-video-edit",
      "black-forest-labs/flux-video-upscale",
      "runway/aleph-2",
      "google/gemini-omni-1.1-flash",
    ])
      expect(ids).not.toContain(gone);
    expect(ids).toContain("google/gemini-omni-1.2-flash");
    expect(fs.existsSync(path.join(home, "catalog", "openrouter-videos.json"))).toBe(true);
    // both tables are visible together, the same id under two providers stays two models
    expect(listVideoModels()).toHaveLength(29);
    expect(getVideoModel("google/gemini-omni-1.2-flash")!.provider).toBe("google");
    expect(getVideoModel("openrouter/google/gemini-omni-1.2-flash")!.provider).toBe("openrouter");
    expect(getVideoModel("openrouter/google/gemini-omni-1.1-flash")).toBeUndefined();
  });

  it("maps the facts the list states and leaves out the ones it does not", async () => {
    await refreshOpenRouterVideoModels({ fetch: listFetch().fn });
    const veo = getVideoModel("openrouter/google/veo-3.1")!;
    expect(veo).toMatchObject({ provider: "openrouter", id: "google/veo-3.1", name: "Google: Veo 3.1" });
    expect(veo.durations).toEqual([4, 6, 8]);
    expect(veo.resolutions).toEqual(["720p", "1080p", "4K"]);
    expect(veo.aspectRatios).toEqual(["16:9", "9:16"]);
    expect(veo.frames).toEqual(["first_frame", "last_frame"]);
    expect(veo.audio).toBe(true);
    expect(veo.sizes).toContain("3840x2160");
    expect(veo.passthrough).toContain("negativePrompt");
    expect(veo.pricingSkus!["duration_seconds_with_audio"]).toBe("0.40"); // as listed, not interpreted
    expect(veo.prices).toBeUndefined(); // OpenRouter reports the real cost of each job
    expect(veo.defaultDuration).toBeUndefined(); // the list states no default: never guessed
    expect(veo.defaultResolution).toBeUndefined();
    expect(veo.references).toEqual({ images: "unknown", videos: "unknown" });
  });

  it("-1 means the model may pick the length (and is not a duration), unsorted lists are sorted, null flags stay unknown", async () => {
    await refreshOpenRouterVideoModels({ fetch: listFetch().fn });
    const seed = getVideoModel("openrouter/bytedance/seedance-2.5")!;
    expect(seed.durationAuto).toBe(true);
    expect(seed.durations[0]).toBe(4);
    expect(seed.durations).not.toContain(-1);
    expect(getVideoModel("openrouter/bytedance/seedance-2.0")!.durationAuto).toBeUndefined();
    expect(getVideoModel("openrouter/google/veo-3.1-lite")!.durations).toEqual([4, 6, 8]); // listed as [8, 4, 6]
    const grok = getVideoModel("openrouter/x-ai/grok-imagine-video")!; // generate_audio: null, seed: null
    expect(grok.audio).toBeUndefined();
    expect(grok.seed).toBeUndefined();
    expect(getVideoModel("openrouter/runway/gen-4.5")!.frames).toEqual(["first_frame"]);
    expect(getVideoModel("openrouter/minimax/hailuo-2.3")!.audio).toBe(false); // a stated false is a fact
  });

  it("every kept model is well formed", async () => {
    const models = await refreshOpenRouterVideoModels({ fetch: listFetch().fn });
    for (const m of models) {
      expect(m.model).toBe(`openrouter/${m.id}`);
      expect(m.durations.length).toBeGreaterThan(0);
      expect(m.durations.every((d) => Number.isInteger(d) && d > 0)).toBe(true);
      expect(m.resolutions.length).toBeGreaterThan(0);
      expect(m.aspectRatios.length).toBeGreaterThan(0);
    }
  });

  it("skips expired and malformed entries; a body that is not the list is an error", async () => {
    const body = {
      data: [
        { id: "a/ok", name: "Ok", supported_durations: [5], supported_resolutions: ["720p"], supported_aspect_ratios: ["16:9"] },
        { id: "a/expired", supported_durations: [5], expiration_date: "2020-01-01" },
        { id: "a/no-durations", supported_resolutions: ["720p"] },
        { id: "a/text-durations", supported_durations: ["5"] },
        { id: "a/only-auto", supported_durations: [-1] },
        { name: "no id", supported_durations: [5] },
        "junk",
        null,
      ],
    };
    const models = await refreshOpenRouterVideoModels({ fetch: listFetch(body).fn });
    expect(models.map((m) => m.id)).toEqual(["a/ok"]);
    for (const bad of [listFetch("<html>down</html>").fn, listFetch({ data: [] }).fn, listFetch({ nope: 1 }).fn]) {
      const err = await refreshOpenRouterVideoModels({ fetch: bad, force: true }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toContain("could not read the video model list");
    }
    expect(openRouterVideoModels().map((m) => m.id)).toEqual(["a/ok"]); // the saved copy survives
  });

  it("is not downloaded again while fresh, unless forced", async () => {
    const { fn, calls } = listFetch();
    await refreshOpenRouterVideoModels({ fetch: fn });
    await refreshOpenRouterVideoModels({ fetch: fn });
    expect(calls).toHaveLength(1);
    await refreshOpenRouterVideoModels({ fetch: fn, force: true });
    expect(calls).toHaveLength(2);
  });

  it("is sent without a key (the list is public)", async () => {
    let headers: Record<string, string> = {};
    const fn = (async (_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify(real), { status: 200 });
    }) as unknown as typeof fetch;
    await refreshOpenRouterVideoModels({ fetch: fn, apiKey: "sk-or-secret" });
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });
});

describe("ensuring the OpenRouter video list", () => {
  it("downloads only when there is no fresh copy, and shares one download between callers", async () => {
    refreshOn();
    const { fn, calls } = listFetch();
    const [a, b] = await Promise.all([ensureOpenRouterVideoModels({ fetch: fn }), ensureOpenRouterVideoModels({ fetch: fn })]);
    expect(calls).toHaveLength(1);
    expect(a).toHaveLength(28);
    expect(b).toHaveLength(28);
    await ensureOpenRouterVideoModels({ fetch: fn });
    expect(calls).toHaveLength(1);
  });

  it("never touches the network when catalog_refresh is off", async () => {
    const { fn, calls } = listFetch();
    expect(await ensureOpenRouterVideoModels({ fetch: fn })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
