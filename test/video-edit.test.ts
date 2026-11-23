import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateVideo } from "../src/video/generate.ts";
import { resumeVideo } from "../src/video/resume.ts";
import { GeneratedVideo } from "../src/video/result.ts";
import { setHome } from "../src/utils/home.ts";
import { setConfigs, SETTING_KEYS } from "../src/config/settings.ts";
import { resetOpenRouterVideosCache, refreshOpenRouterVideoModels } from "../src/models/openrouter-videos.ts";
import { ConfigError, TimeoutError, ValidationError } from "../src/types/errors.ts";
import { PNG, fakeMp4 } from "./video-fixtures.ts";
import { recordingFetch, jsonAnswer } from "./helpers.ts";

const real = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", "openrouter-video-models.json"), "utf8"));
const OMNI = "google/gemini-omni-1.2-flash";
const VEO = "openrouter/google/veo-3.1";
const JOB = "gen-vid-1700000000-abcdefghijABCDEFGH12";
const BASE = "https://or.test/api/v1";
const CLIP = fakeMp4(8);
const B64 = Buffer.from(CLIP).toString("base64");

const google = (id: string) =>
  jsonAnswer({ id, status: "completed", steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: B64 }] }], usage: { total_input_tokens: 5, total_output_tokens: 1000, total_tokens: 1005, output_tokens_by_modality: [{ modality: "video", tokens: 1000 }] } });
const accepted = (id = JOB) => jsonAnswer({ id, polling_url: `${BASE}/videos/${id}`, status: "pending" }, 202);
const job = (status: string, extra: Record<string, unknown> = {}) => jsonAnswer({ id: JOB, status, ...extra });
const done = job("completed", { unsigned_urls: [`/api/v1/videos/${JOB}/content?index=0`], usage: { cost: 2 } });
const file = () => new Response(CLIP, { status: 200, headers: { "content-type": "video/mp4" } });

let home: string;
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-videdit-"));
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
const g = { model: OMNI, apiKey: "KEY", baseUrl: "https://g.test/v1beta" };
const o = { model: VEO, apiKey: "KEY", baseUrl: BASE, pollIntervalMs: 1 };

describe("video.edit on Google", () => {
  it("continues the stored interaction with the prompt only, on the same connection, and chains again", async () => {
    const m = recordingFetch(google("v1_first"), google("v1_second"), google("v1_third"));
    const first = await generateVideo({ ...g, prompt: "A violinist", duration: 6, fetch: m.fn });
    const second = await first.video.edit("Make the violin invisible.");
    expect(m.calls[1]!.url).toBe("https://g.test/v1beta/interactions");
    expect(m.calls[1]!.headers["x-goog-api-key"]).toBe("KEY"); // the connection is inherited
    expect(m.calls[1]!.body).toEqual({
      model: "gemini-omni-1.2-flash",
      previous_interaction_id: "v1_first",
      input: "Make the violin invisible.",
      response_format: { type: "video" }, // no default length: an edit keeps the clip's own
      background: false,
    });
    expect(second.responseId).toBe("v1_second");
    const third = await second.video.edit("Now at night.", { duration: 6 });
    expect(m.calls[2]!.body.previous_interaction_id).toBe("v1_second");
    expect(m.calls[2]!.body.response_format.duration).toBe("6s"); // asked again, so sent
    expect(third.responseId).toBe("v1_third");
  });

  it("pictures and clips cannot be added to an edit (one error lists it)", async () => {
    const m = recordingFetch(google("v1_first"));
    const first = await generateVideo({ ...g, prompt: "x", fetch: m.fn });
    const err = await first.video.edit("y", { firstFrame: PNG, referenceVideos: [fakeMp4(2)] }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("continueFrom: an edit changes the clip with the prompt only");
    expect(m.calls).toHaveLength(1);
  });

  it("only the model that made the clip can edit it", async () => {
    const m = recordingFetch(google("v1_first"));
    const first = await generateVideo({ ...g, prompt: "x", fetch: m.fn });
    const err = await first.video.edit("y", { model: VEO }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("only be edited by the model that made it (google/gemini-omni-1.2-flash)");
    expect(m.calls).toHaveLength(1);
  });

  it("a clip that was not made by generateVideo has nothing to continue from, and edit() then needs a model", async () => {
    const stranger = new GeneratedVideo(CLIP, "video/mp4");
    const e1 = await stranger.edit("y").catch((e) => e);
    expect(e1).toBeInstanceOf(ConfigError);
    const e2 = await generateVideo({ ...g, prompt: "y", continueFrom: stranger, fetch: recordingFetch(google("x")).fn }).catch((e) => e);
    expect(e2).toBeInstanceOf(ValidationError);
    expect(e2.message).toContain("not made by generateVideo");
    const e3 = await generateVideo({ ...g, prompt: "y", continueFrom: "nope" as never }).catch((e) => e);
    expect(e3.message).toContain("must be a clip from generateVideo");
  });

  it("a clip whose call returned no id cannot be continued", async () => {
    const noId = jsonAnswer({ status: "completed", steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: B64 }] }] });
    const m = recordingFetch(noId);
    const first = await generateVideo({ ...g, prompt: "x", fetch: m.fn });
    const err = await first.video.edit("y").catch((e) => e);
    expect(err.message).toContain("did not return an id");
  });
});

describe("video.edit on OpenRouter", () => {
  it("continues the job with previous_job_id", async () => {
    const m = recordingFetch(accepted(), done, file, accepted("gen-vid-2-ZYXWVUTSRQponmlkjihg"), done, file);
    const first = await generateVideo({ ...o, prompt: "x", duration: 8, fetch: m.fn });
    await first.video.edit("Make it night", { duration: 8 });
    const second = m.calls.filter((c) => c.method === "POST")[1]!;
    expect(second.body.previous_job_id).toBe(JOB);
    expect(second.body.prompt).toBe("Make it night");
    expect(second.headers["authorization"]).toBe("Bearer KEY");
  });
});

describe("resumeVideo", () => {
  it("never submits: it asks for the existing job, waits for it and downloads it", async () => {
    const seen: string[] = [];
    const m = recordingFetch(job("in_progress", { progress: 50 }), done, file);
    const r = await resumeVideo({ ...o, jobId: JOB, fetch: m.fn, onProgress: (p) => seen.push(p.status) });
    expect(m.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/videos/${JOB}`,
      `GET ${BASE}/videos/${JOB}`,
      `GET https://or.test/api/v1/videos/${JOB}/content?index=0`,
    ]);
    expect(m.calls.every((c) => c.headers["authorization"] === "Bearer KEY")).toBe(true);
    expect(seen).toEqual(["in_progress"]);
    expect(r.jobId).toBe(JOB);
    expect(r.usage.cost!.totalCost).toBe(2);
    expect(r.video.bytes.byteLength).toBe(CLIP.byteLength);
    expect(JSON.stringify(r.raw)).not.toContain("KEY");
  });

  it("the whole story: a timeout hands you the job id, resumeVideo finishes it, and the clip can be edited", async () => {
    const slow = recordingFetch(accepted(), job("in_progress"));
    const err = await generateVideo({ ...o, prompt: "x", duration: 8, fetch: slow.fn, pollIntervalMs: 5, timeoutMs: 40 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    const later = recordingFetch(done, file, accepted("gen-vid-2-ZYXWVUTSRQponmlkjihg"), done, file);
    const r = await resumeVideo({ ...o, jobId: err.jobId, fetch: later.fn });
    expect(r.jobId).toBe(JOB);
    await r.video.edit("Make it night", { duration: 8 });
    expect(later.calls.find((c) => c.method === "POST")!.body.previous_job_id).toBe(JOB);
  });

  it("a failed job, a timeout and an abort each carry the job id; a budget over the cap keeps the clip", async () => {
    const failed = recordingFetch(job("failed", { error: "content policy" }));
    const e1 = await resumeVideo({ ...o, jobId: JOB, fetch: failed.fn }).catch((e) => e);
    expect(e1.message).toContain("content policy");
    expect(e1.jobId).toBe(JOB);
    const running = recordingFetch(job("in_progress"));
    const e2 = await resumeVideo({ ...o, jobId: JOB, fetch: running.fn, pollIntervalMs: 5, timeoutMs: 40 }).catch((e) => e);
    expect(e2).toBeInstanceOf(TimeoutError);
    expect(e2.jobId).toBe(JOB);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    const e3 = await resumeVideo({ ...o, jobId: JOB, fetch: running.fn, pollIntervalMs: 10_000, signal: ctl.signal }).catch((e) => e);
    expect(e3.name).toBe("AbortError");
    expect(e3.jobId).toBe(JOB);
    const dear = recordingFetch(done, file);
    const e4 = await resumeVideo({ ...o, jobId: JOB, fetch: dear.fn, budget: { maxCostUsd: 1 } }).catch((e) => e);
    expect(e4.name).toBe("BudgetExceededError");
    expect(e4.partial.video).toBeInstanceOf(GeneratedVideo);
  });

  it("refuses what cannot be resumed, before any request", async () => {
    const m = recordingFetch(done);
    const bad = [
      [{ model: OMNI, jobId: "v1_x" }, "makes a video in one request"],
      [{ model: "openrouter/nope/none", jobId: JOB }, "not a known video model"],
      [{ model: VEO, jobId: "  " }, "jobId must be"],
      [{ model: VEO, jobId: JOB, pollIntervalMs: 0 }, "pollIntervalMs"],
      [{ model: VEO, jobId: JOB, budget: { maxCostUsd: -1 } }, "budget.maxCostUsd"],
    ] as const;
    for (const [opts, text] of bad) {
      const err = await resumeVideo({ apiKey: "KEY", baseUrl: BASE, fetch: m.fn, ...opts } as never).catch((e) => e);
      expect(err.message).toContain(text);
    }
    expect(m.calls).toHaveLength(0);
  });
});
