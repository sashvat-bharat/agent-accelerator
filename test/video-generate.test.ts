import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateVideo } from "../src/video/generate.ts";
import { GeneratedVideo, VideoResult } from "../src/video/result.ts";
import { getProvider } from "../src/providers/registry.ts";
import { setHome } from "../src/utils/home.ts";
import { setConfigs, SETTING_KEYS } from "../src/config/settings.ts";
import { resetModels, setModels } from "../src/config/models.ts";
import { resetOpenRouterVideosCache, refreshOpenRouterVideoModels } from "../src/models/openrouter-videos.ts";
import { telemetryBus } from "../src/telemetry.ts";
import { clearEmittedWarnings } from "../src/providers.ts";
import {
  BudgetExceededError,
  ConfigError,
  ModelNotAllowedError,
  ProviderError,
  SecurityPolicyError,
  ValidationError,
} from "../src/types/errors.ts";
import type { ProviderVideoRequest, ProviderVideoResult } from "../src/types/video.ts";
import { PNG, fakeMp4 } from "./video-fixtures.ts";

const real = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", "openrouter-video-models.json"), "utf8"));
const OMNI = "google/gemini-omni-1.2-flash";

type Fake = (modelId: string, req: ProviderVideoRequest, options: Record<string, unknown>) => Promise<ProviderVideoResult>;
const providers = { google: getProvider("google") as { generateVideo?: Fake }, openrouter: getProvider("openrouter") as { generateVideo?: Fake } };
const original = { google: providers.google.generateVideo, openrouter: providers.openrouter.generateVideo };

// A provider result with a small MP4 and the usage of 10 s of 720p, unless overridden.
function result(over: Partial<ProviderVideoResult> = {}): ProviderVideoResult {
  return {
    video: { bytes: fakeMp4(10), mimeType: "video/mp4" },
    usage: { inputTokens: 100, outputTokens: 57_920, totalTokens: 58_020 },
    model: "gemini-omni-1.2-flash",
    provider: "google",
    raw: { request: { url: "u", method: "POST", headers: {}, body: { secret: "prompt text" } }, response: { status: 200, statusText: "OK", headers: {}, body: { big: "x".repeat(50) } } },
    durationMs: 1,
    ...over,
  };
}

// Installs a fake adapter and returns what it was called with.
function install(which: "google" | "openrouter", fn: (req: ProviderVideoRequest) => Promise<ProviderVideoResult> | ProviderVideoResult) {
  const seen: Array<{ modelId: string; req: ProviderVideoRequest; options: Record<string, unknown> }> = [];
  providers[which].generateVideo = async (modelId, req, options) => {
    seen.push({ modelId, req, options });
    return fn(req);
  };
  return seen;
}

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-videogen-"));
  setHome(home);
  resetOpenRouterVideosCache();
  clearEmittedWarnings();
});
afterEach(() => {
  providers.google.generateVideo = original.google;
  providers.openrouter.generateVideo = original.openrouter;
  resetModels();
  setHome();
  resetOpenRouterVideosCache();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("generateVideo: the request the adapter gets", () => {
  it("hands over a checked request with the model's default length, the pictures read, and the deadline and poll settings", async () => {
    const seen = install("google", () => result());
    await generateVideo({ model: OMNI, prompt: " A marble ", firstFrame: PNG, referenceImages: [PNG, PNG], aspectRatio: "9:16", resolution: "4k" });
    expect(seen).toHaveLength(1);
    const { modelId, req, options } = seen[0]!;
    expect(modelId).toBe("gemini-omni-1.2-flash"); // the bare id, no provider prefix
    expect(req.prompt).toBe("A marble");
    expect(req.durationSeconds).toBe(10);
    expect(req.resolution).toBe("4K");
    expect(req.aspectRatio).toBe("9:16");
    expect(req.firstFrame!.mimeType).toBe("image/png");
    expect(req.referenceImages).toHaveLength(2);
    expect(req.referenceVideos).toEqual([]);
    expect(req.deadlineMs).toBe(600_000);
    expect(req.pollIntervalMs).toBe(10_000);
    expect(options["timeoutMs"]).toBe(600_000);
    expect(req.lastFrame).toBeUndefined();
    expect("audio" in req).toBe(false); // not asked, not sent
  });

  it("timeoutMs 0 or Infinity means no deadline and no per-request timeout", async () => {
    for (const timeoutMs of [0, Infinity]) {
      const seen = install("google", () => result());
      await generateVideo({ model: OMNI, prompt: "x", timeoutMs });
      expect(seen[0]!.req.deadlineMs).toBe(Infinity);
      expect("timeoutMs" in seen[0]!.options).toBe(false);
    }
  });

  it("passes the progress listener and poll interval through", async () => {
    const seen = install("google", () => result());
    const onProgress = () => {};
    await generateVideo({ model: OMNI, prompt: "x", pollIntervalMs: 250, onProgress });
    expect(seen[0]!.req.pollIntervalMs).toBe(250);
    expect(seen[0]!.req.onProgress).toBe(onProgress);
  });

  it("passes the connection settings (key, endpoint, headers, fetch, retry) to the provider", async () => {
    const seen = install("google", () => result());
    const fetchFn = (async () => new Response("")) as unknown as typeof fetch;
    await generateVideo({ model: OMNI, prompt: "x", apiKey: "k", baseUrl: "http://h", headers: { a: "b" }, fetch: fetchFn, retry: { maxRetries: 1 } });
    expect(seen[0]!.options).toMatchObject({ apiKey: "k", baseUrl: "http://h", headers: { a: "b" }, maxRetries: 1 });
    expect(seen[0]!.options["fetch"]).toBe(fetchFn);
  });
});

describe("generateVideo: the result", () => {
  it("is a VideoResult with the clip, the usage priced from the table, and the provider's ids", async () => {
    install("google", () => result({ text: "Here you go.", responseId: "v1_abc", finishReason: "stop" }));
    const r = await generateVideo({ model: OMNI, prompt: "x" });
    expect(r).toBeInstanceOf(VideoResult);
    expect(r.video).toBeInstanceOf(GeneratedVideo);
    expect(r.video.mimeType).toBe("video/mp4");
    expect(r.video.durationSeconds).toBeCloseTo(10, 6);
    expect(r.video.extension).toBe(".mp4");
    expect(r.text).toBe("Here you go.");
    expect(r.responseId).toBe("v1_abc");
    expect(r.jobId).toBeUndefined();
    expect(r.model).toBe("gemini-omni-1.2-flash");
    expect(r.provider).toBe("google");
    expect(r.usage.cost!.totalCost).toBeCloseTo(0.69519, 6);
  });

  it("the provider's own cost wins over the table", async () => {
    install("google", () => result({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: { totalCost: 0.5 } } }));
    expect((await generateVideo({ model: OMNI, prompt: "x" })).usage.cost!.totalCost).toBe(0.5);
  });

  it("unknown stays unknown: a model with no price and no reported cost has no cost", async () => {
    refreshOn();
    await refreshOpenRouterVideoModels({ fetch: listFetch() });
    install("openrouter", () => result({ provider: "openrouter", jobId: "gen-vid-9-aaaaaaaaaaaaaaaaaaaa" }));
    const r = await generateVideo({ model: "openrouter/google/veo-3.1", prompt: "x", duration: 4 });
    expect(r.usage.cost).toBeUndefined();
    expect(r.jobId).toBe("gen-vid-9-aaaaaaaaaaaaaaaaaaaa");
  });

  it("JSON and toJSON never hold the bytes; save writes the file and fixes a missing extension", async () => {
    install("google", () => result());
    const r = await generateVideo({ model: OMNI, prompt: "x" });
    const json = JSON.stringify(r);
    expect(json).toContain('"bytes":');
    expect(json.length).toBeLessThan(2000);
    expect(r.toJSON().video).toMatchObject({ mimeType: "video/mp4" });
    const file = await r.video.save(path.join(home, "deep", "clip"));
    expect(file).toBe(path.join(home, "deep", "clip.mp4"));
    expect(fs.readFileSync(file).byteLength).toBe(r.video.bytes.byteLength);
    expect(r.video.toPart()).toEqual({ type: "video", video: r.video.bytes, mimeType: "video/mp4" });
  });

  it("captureRaw: bodies are summarized by default-compatible policy when asked for 'redacted'", async () => {
    install("google", () => result());
    const r = await generateVideo({ model: OMNI, prompt: "x", captureRaw: "redacted" });
    expect(JSON.stringify(r.raw)).not.toContain("prompt text");
    const full = await generateVideo({ model: OMNI, prompt: "x", captureRaw: true });
    expect(JSON.stringify(full.raw)).toContain("prompt text");
  });
});

describe("generateVideo: a video really came back", () => {
  it("no bytes is a ProviderError that carries the model's words (a refusal), never a result", async () => {
    install("google", () => result({ video: { bytes: new Uint8Array(0), mimeType: "video/mp4" }, text: "I cannot make that video." }));
    const err = await generateVideo({ model: OMNI, prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("[google/gemini-omni-1.2-flash] returned no video: I cannot make that video.");
    expect(err.retryable).toBe(false);
  });
});

describe("generateVideo: models", () => {
  it("an unknown model is a ConfigError that lists the known ones; Omni 1.1 is simply unknown", async () => {
    install("google", () => result());
    for (const model of ["google/gemini-omni-1.1-flash", "openai/sora-9", "", "google/nope"]) {
      const err = await generateVideo({ model, prompt: "x" }).catch((e) => e);
      expect(err).toBeInstanceOf(ConfigError);
    }
    const err = await generateVideo({ model: "google/gemini-omni-1.1-flash", prompt: "x" }).catch((e) => e);
    expect(err.message).toContain("is not a known video model");
    expect(err.message).toContain(OMNI);
  });

  it("a model outside the setModels list is refused before anything is read or sent", async () => {
    const seen = install("google", () => result());
    setModels({ default: { model: "google/gemini-3.5-flash-lite", sub_agent_model: "google/gemini-3.5-flash-lite" }, providers: { google: { models: ["gemini-3.5-flash-lite"] } } });
    const err = await generateVideo({ model: OMNI, prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelNotAllowedError);
    expect(seen).toHaveLength(0);
  });

  it("a provider without a video adapter says so (ConfigError), after the checks", async () => {
    providers.google.generateVideo = undefined;
    const err = await generateVideo({ model: OMNI, prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("cannot make videos yet");
  });

  it("an invalid request never reaches the provider (one error, everything listed)", async () => {
    const seen = install("google", () => result());
    const err = await generateVideo({ model: OMNI, prompt: "x", duration: 99, resolution: "8K" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("(2 problems)");
    expect(seen).toHaveLength(0);
  });

  it("OpenRouter models are looked up in the list the call loads itself", async () => {
    refreshOn();
    const calls: string[] = [];
    const fetchFn = (async (url: string) => (calls.push(String(url)), new Response(JSON.stringify(real), { status: 200 }))) as unknown as typeof fetch;
    const seen = install("openrouter", () => result({ provider: "openrouter" }));
    await generateVideo({ model: "openrouter/google/veo-3.1", prompt: "x", duration: 6, resolution: "1080p", fetch: fetchFn });
    expect(calls).toEqual(["https://openrouter.ai/api/v1/videos/models"]);
    expect(seen[0]!.modelId).toBe("google/veo-3.1");
    expect(seen[0]!.req.durationSeconds).toBe(6);
    // the list's own rules apply: Veo 3.1 makes 4, 6 or 8 seconds
    const err = await generateVideo({ model: "openrouter/google/veo-3.1", prompt: "x", duration: 5 }).catch((e) => e);
    expect(err.message).toContain("It makes: 4, 6, 8 seconds");
  });
});

describe("generateVideo: reference clips and size limits", () => {
  it("reads each clip's length from the file and refuses one over the model's limit, before any request", async () => {
    const seen = install("google", () => result());
    const err = await generateVideo({ model: OMNI, prompt: "x", referenceVideos: [fakeMp4(2), fakeMp4(5.5)] }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("referenceVideos[1]: 5.5 s; google/gemini-omni-1.2-flash takes clips up to 3 s");
    expect(err.message).not.toContain("referenceVideos[0]");
    expect(seen).toHaveLength(0);
  });

  it("a clip a hair over the limit passes (encoders round up), a clip of unknown length passes (the provider decides)", async () => {
    const seen = install("google", () => result());
    await generateVideo({ model: OMNI, prompt: "x", referenceVideos: [fakeMp4(3.1), Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d])] });
    expect(seen[0]!.req.referenceVideos.map((c) => c.seconds)).toEqual([expect.closeTo(3.1, 3), undefined]);
  });

  it("a video the SDK made can be a reference clip", async () => {
    const seen = install("google", () => result());
    await generateVideo({ model: OMNI, prompt: "x", referenceVideos: [new GeneratedVideo(fakeMp4(3), "video/mp4")] });
    expect(seen[0]!.req.referenceVideos[0]!.media.mimeType).toBe("video/mp4");
    expect(seen[0]!.req.referenceVideos[0]!.seconds).toBeCloseTo(3, 6);
  });

  it("an input that is not a video is refused", async () => {
    install("google", () => result());
    const err = await generateVideo({ model: OMNI, prompt: "x", referenceVideos: [PNG] }).catch((e) => e);
    expect(err.message).toContain('has the type "image/png", which is not a video');
    const bad = await generateVideo({ model: OMNI, prompt: "x", firstFrame: fakeMp4(1) }).catch((e) => e);
    expect(bad.message).toContain("which is not an image");
  });

  it("a model whose list is silent about clips gets them with one warning", async () => {
    refreshOn();
    await refreshOpenRouterVideoModels({ fetch: listFetch() });
    const seen = install("openrouter", () => result({ provider: "openrouter" }));
    const events: string[] = [];
    const off = telemetryBus.onEvent((e) => events.push(`${e.code}:${(e.data as { capability?: string })?.capability ?? ""}`));
    try {
      await generateVideo({ model: "openrouter/bytedance/seedance-2.0", prompt: "x", referenceVideos: [fakeMp4(8)] });
    } finally {
      off();
    }
    expect(events).toContain("provider_warning:reference videos");
    expect(seen[0]!.req.referenceVideos).toHaveLength(1); // sent as asked
  });

  it("fileAccess roots apply to every local picture and clip", async () => {
    const seen = install("google", () => result());
    const file = path.join(home, "frame.png");
    fs.writeFileSync(file, PNG);
    const inside = await generateVideo({ model: OMNI, prompt: "x", firstFrame: file, fileAccess: { roots: [home] } });
    expect(inside).toBeInstanceOf(VideoResult);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "aa-other-"));
    try {
      for (const opts of [{ firstFrame: file }, { lastFrame: file }, { referenceImages: [file] }, { referenceVideos: [file] }]) {
        const err = await generateVideo({ model: OMNI, prompt: "x", ...opts, fileAccess: { roots: [other] } }).catch((e) => e);
        expect(err).toBeInstanceOf(SecurityPolicyError);
      }
      expect((await generateVideo({ model: OMNI, prompt: "x", firstFrame: file, fileAccess: { roots: [] } }).catch((e) => e)) instanceof SecurityPolicyError).toBe(true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
    expect(seen).toHaveLength(1); // only the allowed call reached the provider
  });
});

describe("generateVideo: budget", () => {
  it("refuses BEFORE the request when the table's estimate is already over the cap", async () => {
    const seen = install("google", () => result());
    // 15 s of 720p is about $1.04
    const err = await generateVideo({ model: OMNI, prompt: "x", duration: 15, budget: { maxCostUsd: 0.5 } }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.message).toContain("Estimated cost $1.0426 for 15 s");
    expect(seen).toHaveLength(0);
    await generateVideo({ model: OMNI, prompt: "x", duration: 15, budget: { maxCostUsd: 2 } });
    expect(seen).toHaveLength(1);
  });

  it("an actual cost over the cap throws with the finished video attached (it was paid for)", async () => {
    install("google", () => result({ jobId: "gen-vid-1-bbbbbbbbbbbbbbbbbbbb", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: { totalCost: 3 } } }));
    const err = await generateVideo({ model: OMNI, prompt: "x", budget: { maxCostUsd: 1 } }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.partial.video).toBeInstanceOf(GeneratedVideo);
    expect(err.jobId).toBe("gen-vid-1-bbbbbbbbbbbbbbbbbbbb");
  });

  it("rejects nonsense settings before doing anything", async () => {
    const seen = install("google", () => result());
    for (const bad of [{ budget: { maxCostUsd: 0 } }, { budget: { maxCostUsd: -1 } }, { timeoutMs: -5 }, { pollIntervalMs: 0 }, { pollIntervalMs: Infinity }]) {
      const err = await generateVideo({ model: OMNI, prompt: "x", ...bad }).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("generateVideo: abort", () => {
  it("an already aborted signal never reaches the provider", async () => {
    const seen = install("google", () => result());
    const ctl = new AbortController();
    ctl.abort();
    const err = await generateVideo({ model: OMNI, prompt: "x", signal: ctl.signal }).catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(seen).toHaveLength(0);
  });

  it("an abort during the request rejects at once, even when the adapter never answers", async () => {
    install("google", () => new Promise<ProviderVideoResult>(() => {}));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error("stop")), 10);
    const t = Date.now();
    const err = await generateVideo({ model: OMNI, prompt: "x", signal: ctl.signal }).catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("the adapter's own error (with a job id) passes through untouched", async () => {
    const boom = Object.assign(new Error("job failed: content policy"), { jobId: "gen-vid-2-cccccccccccccccccccc" });
    install("google", () => Promise.reject(boom));
    const err = await generateVideo({ model: OMNI, prompt: "x" }).catch((e) => e);
    expect(err).toBe(boom);
  });
});

// The real list as a fetch, and the setting that lets lists download in a test.
function listFetch(): typeof fetch {
  return (async () => new Response(JSON.stringify(real), { status: 200 })) as unknown as typeof fetch;
}
function refreshOn() {
  setConfigs({ values: { catalog_refresh: "on" }, editable: [...SETTING_KEYS] });
}
