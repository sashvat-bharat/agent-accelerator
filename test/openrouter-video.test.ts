import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateVideo } from "../src/video/generate.ts";
import { setHome } from "../src/utils/home.ts";
import { setConfigs, SETTING_KEYS } from "../src/config/settings.ts";
import { resetOpenRouterVideosCache, refreshOpenRouterVideoModels } from "../src/models/openrouter-videos.ts";
import { ProviderError, TimeoutError } from "../src/types/errors.ts";
import { PNG, fakeMp4 } from "./video-fixtures.ts";
import { recordingFetch, jsonAnswer } from "./helpers.ts";

const real = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", "openrouter-video-models.json"), "utf8"));
const VEO = "openrouter/google/veo-3.1";
const JOB = "gen-vid-1700000000-abcdefghijABCDEFGH12";
const CLIP = fakeMp4(8);
const BASE = "https://or.test/api/v1";

const accepted = jsonAnswer({ id: JOB, polling_url: `${BASE}/videos/${JOB}`, status: "pending" }, 202);
const job = (status: string, extra: Record<string, unknown> = {}) => jsonAnswer({ id: JOB, status, ...extra });
const done = (extra: Record<string, unknown> = {}) =>
  job("completed", { urls: [`https://cdn.test/signed/${JOB}.mp4?sig=1`], unsigned_urls: [`/api/v1/videos/${JOB}/content?index=0`], usage: { cost: 3.2, is_byok: false }, ...extra });
const file = () => new Response(CLIP, { status: 200, headers: { "content-type": "video/mp4" } });

let home: string;
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-orvideo-"));
  setHome(home);
  resetOpenRouterVideosCache();
  setConfigs({ values: { catalog_refresh: "on" }, editable: [...SETTING_KEYS] });
  await refreshOpenRouterVideoModels({ fetch: (async () => new Response(JSON.stringify(real), { status: 200 })) as unknown as typeof fetch });
});
afterEach(() => {
  setHome();
  resetOpenRouterVideosCache();
  fs.rmSync(home, { recursive: true, force: true });
});
const base = { model: VEO, apiKey: "KEY", baseUrl: BASE, pollIntervalMs: 1 };

describe("OpenRouter video: submit, poll, download", () => {
  it("submits the job, polls it until completed and downloads the file with the key", async () => {
    const seen: Array<[string, number | undefined]> = [];
    const m = recordingFetch(accepted, job("pending"), job("in_progress", { progress: 40 }), done(), file);
    const r = await generateVideo({ ...base, prompt: "A marble", duration: 8, resolution: "1080p", aspectRatio: "16:9", fetch: m.fn, onProgress: (p) => seen.push([p.status, p.progress]) });
    expect(m.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${BASE}/videos`,
      `GET ${BASE}/videos/${JOB}`,
      `GET ${BASE}/videos/${JOB}`,
      `GET ${BASE}/videos/${JOB}`,
      `GET https://or.test/api/v1/videos/${JOB}/content?index=0`,
    ]);
    expect(m.calls[0]!.headers["authorization"]).toBe("Bearer KEY");
    expect(m.calls[0]!.body).toEqual({ model: "google/veo-3.1", prompt: "A marble", duration: 8, resolution: "1080p", aspect_ratio: "16:9" });
    expect(m.calls[4]!.headers["authorization"]).toBe("Bearer KEY");
    expect(seen).toEqual([["pending", undefined], ["in_progress", 40]]);
    expect(r.jobId).toBe(JOB);
    expect(r.video.bytes.byteLength).toBe(CLIP.byteLength);
    expect(r.video.mimeType).toBe("video/mp4");
    expect(r.usage.cost!.totalCost).toBe(3.2); // OpenRouter's own report
    expect(JSON.stringify(r.raw)).not.toContain("KEY");
  });

  it("frames go in frame_images with their role; the audio switch and seed are sent", async () => {
    const m = recordingFetch(accepted, done(), file);
    await generateVideo({ ...base, prompt: "p", firstFrame: PNG, lastFrame: PNG, duration: 4, audio: false, seed: 5, fetch: m.fn });
    const b = m.calls[0]!.body;
    expect(b.frame_images.map((f: any) => f.frame_type)).toEqual(["first_frame", "last_frame"]);
    expect(b.frame_images[0]).toMatchObject({ type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } });
    expect(b.generate_audio).toBe(false);
    expect(b.seed).toBe(5);
    expect(b.input_references).toBeUndefined();
  });

  it("reference pictures and clips go in input_references; the provider routing and user come from the openrouter setting", async () => {
    setConfigs({ values: { catalog_refresh: "on", openrouter: { user: "u-1", order: ["google-vertex"], allow_fallbacks: false } }, editable: [...SETTING_KEYS] });
    const m = recordingFetch(accepted, done(), file);
    await generateVideo({ ...base, prompt: "p", duration: 4, referenceImages: [PNG], referenceVideos: [fakeMp4(2)], fetch: m.fn });
    const b = m.calls[0]!.body;
    expect(b.input_references.map((x: any) => x.type)).toEqual(["image_url", "video_url"]);
    expect(b.input_references[1].video_url.url).toMatch(/^data:video\/mp4;base64,/);
    expect(b.frame_images).toBeUndefined();
    expect(b.provider).toMatchObject({ order: ["google-vertex"] });
    expect(b.user).toBe("u-1");
  });

  it("a signed link needs no key and never gets one", async () => {
    const m = recordingFetch(accepted, job("completed", { urls: ["https://cdn.test/signed/x.mp4?sig=1"], usage: { cost: 1 } }), file);
    await generateVideo({ ...base, prompt: "p", duration: 4, fetch: m.fn });
    expect(m.calls[2]!.url).toBe("https://cdn.test/signed/x.mp4?sig=1");
    expect(m.calls[2]!.headers["authorization"]).toBeUndefined();
  });

  it("a key-protected link on another host never gets the key", async () => {
    const m = recordingFetch(accepted, job("completed", { unsigned_urls: ["https://evil.test/steal.mp4"], usage: { cost: 1 } }), file);
    await generateVideo({ ...base, prompt: "p", duration: 4, fetch: m.fn });
    expect(m.calls[2]!.url).toBe("https://evil.test/steal.mp4");
    expect(m.calls[2]!.headers["authorization"]).toBeUndefined();
  });

  it("duration 'auto' is sent as -1 on a model that can choose", async () => {
    const auto = real.data.find((x: any) => x.supported_durations?.includes(-1));
    if (!auto) return;
    const m = recordingFetch(accepted, done(), file);
    await generateVideo({ ...base, model: `openrouter/${auto.id}`, prompt: "p", duration: "auto", fetch: m.fn });
    expect(m.calls[0]!.body.duration).toBe(-1);
  });
});

describe("OpenRouter video: how a job ends", () => {
  for (const status of ["failed", "cancelled", "expired"]) {
    it(`${status} is an error with OpenRouter's reason and the job id`, async () => {
      const m = recordingFetch(accepted, job(status, { error: "content policy", status_detail: "blocked" }));
      const err = await generateVideo({ ...base, prompt: "p", duration: 4, fetch: m.fn }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toContain(`job ${status}: content policy`);
      expect(err.jobId).toBe(JOB);
    });
  }

  it("a submit that outlives timeoutMs is a TimeoutError that names the request", async () => {
    const hang = (async (_u: string, init: RequestInit) =>
      await new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      )) as unknown as typeof fetch;
    const err = await generateVideo({ ...base, prompt: "p", duration: 4, fetch: hang, timeoutMs: 40 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toContain("The OpenRouter video request timed out after 40 ms");
  });

  it("a job still running at the deadline is a TimeoutError that says it was left running and carries the id", async () => {
    const m = recordingFetch(accepted, job("in_progress", { progress: 10 }));
    const err = await generateVideo({ ...base, prompt: "p", duration: 4, fetch: m.fn, pollIntervalMs: 5, timeoutMs: 60 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.jobId).toBe(JOB);
    expect(err.message).toContain("left running");
  });

  it("an abort rejects at once with the job id", async () => {
    const m = recordingFetch(accepted, job("in_progress"));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    const t = Date.now();
    const err = await generateVideo({ ...base, prompt: "p", duration: 4, fetch: m.fn, pollIntervalMs: 10_000, signal: ctl.signal }).catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(err.jobId).toBe(JOB);
    expect(Date.now() - t).toBeLessThan(1500);
  });

  it("a transient failure of one poll (503) is retried, not fatal", async () => {
    const m = recordingFetch(accepted, jsonAnswer({ error: { code: 503, message: "busy" } }, 503), done(), file);
    const r = await generateVideo({ ...base, prompt: "p", duration: 4, fetch: m.fn, retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 } });
    expect(r.jobId).toBe(JOB);
    expect(m.calls).toHaveLength(4);
  });

  it("a completed job with no file is an error with the id; a failed download carries it too", async () => {
    const none = recordingFetch(accepted, job("completed", { usage: { cost: 1 } }));
    const e1 = await generateVideo({ ...base, prompt: "p", duration: 4, fetch: none.fn }).catch((e) => e);
    expect(e1.message).toContain("listed no file");
    expect(e1.jobId).toBe(JOB);
    const gone = recordingFetch(accepted, done(), jsonAnswer({ error: { message: "not found" } }, 404));
    const e2 = await generateVideo({ ...base, prompt: "p", duration: 4, fetch: gone.fn }).catch((e) => e);
    expect(e2.message).toContain("not found");
    expect(e2.jobId).toBe(JOB);
  });

  it("an empty file is reported as no video (never a result)", async () => {
    const m = recordingFetch(accepted, done(), () => new Response(new Uint8Array(0), { headers: { "content-type": "video/mp4" } }));
    const err = await generateVideo({ ...base, prompt: "p", duration: 4, fetch: m.fn }).catch((e) => e);
    expect(err.message).toContain("returned no video");
  });
});

describe("OpenRouter video: submit errors", () => {
  it("402 hints at credits, 401 at the key, 400 is not retried", async () => {
    const credit = recordingFetch(jsonAnswer({ error: { code: 402, message: "Insufficient credits" } }, 402));
    expect((await generateVideo({ ...base, prompt: "p", duration: 4, fetch: credit.fn }).catch((e) => e)).message).toContain("too little credit for this video");
    const key = recordingFetch(jsonAnswer({ error: { code: 401, message: "No auth" } }, 401));
    expect((await generateVideo({ ...base, prompt: "p", duration: 4, fetch: key.fn }).catch((e) => e)).message).toContain("OPENROUTER_API_KEY");
    const bad = recordingFetch(jsonAnswer({ error: { code: 400, message: "bad duration" } }, 400));
    const e = await generateVideo({ ...base, prompt: "p", duration: 4, fetch: bad.fn }).catch((e) => e);
    expect(e.message).toContain("bad duration");
    expect(bad.calls).toHaveLength(1);
  });

  it("an answer without a job id is an error", async () => {
    const m = recordingFetch(jsonAnswer({ status: "pending" }, 202));
    expect((await generateVideo({ ...base, prompt: "p", duration: 4, fetch: m.fn }).catch((e) => e)).message).toContain("no job id");
  });

  it("a missing key is a ConfigError before any request", async () => {
    const m = recordingFetch(accepted);
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const err = await generateVideo({ model: VEO, prompt: "p", duration: 4, fetch: m.fn, env: {} }).catch((e) => e);
      expect(err.name).toBe("ConfigError");
      expect(m.calls).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });
});
