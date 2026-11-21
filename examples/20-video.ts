/**
 * Agent Accelerator - Video generation
 *
 * One function makes a clip with a supported video model and returns a `VideoResult`:
 *
 *   1. Make a clip, save it, read its length and its cost.
 *   2. A request the model cannot take is ONE error that lists every problem, before any network call (a reference clip that is
 *      too long is caught from the MP4 header, a missing first-frame role is an error, never a silent text-to-video).
 *   3. `video.edit(prompt)` continues the clip on the model that made it (Google: the stored interaction).
 *   4. OpenRouter works in jobs: the SDK submits, polls (with `onProgress`) and downloads, and the key goes only to OpenRouter's host.
 *   5. A timeout leaves the job running at the provider: the error carries `jobId`, and `resumeVideo` finishes it without paying twice.
 *   6. The cost is the provider's report or the table's price, never a made-up $0.
 *
 * It also works as a smoke check: it asserts these contracts and exits with code 1 (one line on stderr) if one stops holding.
 *
 * Run:  bun run examples/20-video.ts                   (offline: a scripted stand-in for the providers, no key, no cost)
 *       bun run examples/20-video.ts --live <model>    (a REAL clip with the shortest length and lowest tier the model lists,
 *                                                       e.g. google/gemini-omni-1.2-flash; COSTS MONEY and takes minutes)
 * The offline run keeps its own home in ./.agent-accel/demo-video/ (gitignored; wiped at the start), so it never touches your
 * real model catalog.
 *
 * Note: this example does not import `_shared.ts`, because that file sets the model list for the live examples.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  TimeoutError,
  ValidationError,
  generateVideo,
  getVideoModel,
  listVideoModels,
  refreshOpenRouterVideoModels,
  resumeVideo,
  setHome,
} from "agent-accelerator";

const C = "\x1b[36m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const R = "\x1b[0m";
const head = (t: string) => console.log(`\n${C}━━━ ${t} ━━━${R}`);

// One-line failure report, like `fail` in _shared.ts (which this example does not import).
const fail = (err: unknown): never => {
  console.error(`\n✖ ${(err as { message?: string } | undefined)?.message ?? err}\n`);
  process.exit(1);
};
const check = (ok: boolean, what: string): void => {
  if (!ok) fail(new Error(`contract broken: ${what}`));
  console.log(`${G}✓${R} ${what}`);
};

const live = process.argv.includes("--live") ? process.argv[process.argv.indexOf("--live") + 1] : undefined;
if (process.argv.includes("--live") && !live)
  fail(new Error("--live needs a model, e.g. --live google/gemini-omni-1.2-flash"));

// A tiny MP4 header of a given length (ftyp + moov/mvhd + a few bytes): enough for the SDK to read the length. No real frames.
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, body: number[]): number[] => [...u32(8 + body.length), ...ascii(type), ...body];
function fakeMp4(seconds: number): Uint8Array {
  const mvhd = [
    0,
    0,
    0,
    0,
    ...u32(0),
    ...u32(0),
    ...u32(1000),
    ...u32(Math.round(seconds * 1000)),
    ...new Array(80).fill(0),
  ];
  return Uint8Array.from([
    ...box("ftyp", [...ascii("isom"), ...u32(512), ...ascii("isom")]),
    ...box("moov", box("mvhd", mvhd)),
    ...box("mdat", new Array(32).fill(7)),
  ]);
}
const CLIP = fakeMp4(6);

// The scripted providers. Google answers in one request (the video inline as base64); OpenRouter makes a job.
// biome-ignore lint/suspicious/noExplicitAny: request bodies are read loosely in this demo
const requests: Array<{ method: string; url: string; auth: boolean; body: any }> = [];
const JOB = "gen-vid-1700000000-abcdefghijABCDEFGH12";
let interactions = 0;
let polls = 0;
let slowJob = false; // when true the job stays "in_progress" (to show a timeout)
const offline = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
  const method = init?.method ?? "GET";
  const auth = Object.keys(init?.headers ?? {}).some((k) => k.toLowerCase() === "authorization");
  const body = init?.body ? JSON.parse(init.body) : undefined;
  if (url.endsWith("/videos/models"))
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "google/veo-3.1",
            name: "Veo 3.1",
            supported_durations: [4, 6, 8],
            supported_resolutions: ["720p", "1080p"],
            supported_aspect_ratios: ["16:9", "9:16"],
            supported_frame_images: ["first_frame", "last_frame"],
            generate_audio: true,
          },
        ],
      }),
      { status: 200 }
    );
  requests.push({ method, url, auth, body });
  if (url.includes("generativelanguage")) {
    interactions += 1;
    return new Response(
      JSON.stringify({
        id: `v1_demo${interactions}`,
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "video", mime_type: "video/mp4", data: Buffer.from(CLIP).toString("base64") }],
          },
        ],
        usage: {
          total_input_tokens: 12,
          total_output_tokens: 34_752,
          total_tokens: 34_764,
          output_tokens_by_modality: [{ modality: "video", tokens: 34_752 }],
        },
      }),
      { status: 200 }
    );
  }
  if (method === "POST")
    return new Response(
      JSON.stringify({ id: JOB, polling_url: `https://openrouter.ai/api/v1/videos/${JOB}`, status: "pending" }),
      {
        status: 202,
      }
    );
  if (url.endsWith(`/videos/${JOB}`)) {
    polls += 1;
    if (slowJob || polls < 3)
      return new Response(JSON.stringify({ id: JOB, status: "in_progress", progress: polls * 30 }), { status: 200 });
    return new Response(
      JSON.stringify({
        id: JOB,
        status: "completed",
        unsigned_urls: [`/api/v1/videos/${JOB}/content?index=0`],
        usage: { cost: 0.8 },
      }),
      { status: 200 }
    );
  }
  return new Response(CLIP, { status: 200, headers: { "content-type": "video/mp4" } }); // the file download
}) as unknown as typeof fetch;
const conn = live ? {} : { apiKey: "demo-key", fetch: offline };

async function main(): Promise<void> {
  const demo = path.resolve(".agent-accel", "demo-video");
  if (!live) {
    fs.rmSync(demo, { recursive: true, force: true });
    setHome(demo);
  }

  if (live) {
    // The cheapest real call the model allows: its shortest length and lowest tier.
    const def = getVideoModel(live);
    if (live.toLowerCase().startsWith("openrouter/")) await refreshOpenRouterVideoModels();
    const model = getVideoModel(live) ?? def;
    if (!model)
      fail(
        new Error(
          `${live} is not a known video model. Known: ${listVideoModels()
            .map((m) => m.model)
            .join(", ")}`
        )
      );
    console.log(`${Y}LIVE: this makes a real clip and costs money.${R}`);
    const r = await generateVideo({
      model: live,
      prompt: "A marble rolling along a wooden track, one continuous smooth shot.",
      ...(model!.durations[0] !== undefined ? { duration: model!.durations[0] } : {}),
      ...(model!.resolutions[0] ? { resolution: model!.resolutions[0] } : {}),
      onProgress: (p) => console.log(`  ${p.status}${p.progress !== undefined ? ` ${p.progress}%` : ""}`),
    });
    const file = await r.video.save(path.resolve(".agent-accel", "demo-video-live"));
    console.log(
      `saved ${file} (${r.video.durationSeconds ?? "?"} s), cost $`,
      r.usage.cost?.totalCost ?? "unknown",
      "| id:",
      r.jobId ?? r.responseId
    );
    console.log(`\n${Y}Live run done: the offline contracts below are skipped.${R}`);
    return;
  }

  head("1. Make a clip, save it, read its length and cost");
  const r = await generateVideo({
    ...conn,
    model: "google/gemini-omni-1.2-flash",
    prompt: "A marble on a chain reaction track.",
    duration: 6,
  });
  const file = await r.video.save(path.join(demo, "marble"));
  console.log(
    "saved",
    path.relative(process.cwd(), file),
    "|",
    r.video.durationSeconds,
    "s | cost $",
    r.usage.cost?.totalCost
  );
  check(path.extname(file) === ".mp4" && fs.existsSync(file), "saved with the right extension");
  check(r.video.durationSeconds === 6, "the length is read from the file");
  check(requests[0]?.body.response_format.duration === "6s", "Google got the length as '6s'");
  check(
    r.usage.cost?.totalCost === 0.417042,
    "priced from the table: 12 in at $1.50 + 34,752 video tokens at $12 per 1M"
  );

  head("2. A request the model cannot take is one clear error");
  const before = requests.length;
  try {
    await generateVideo({
      ...conn,
      model: "google/gemini-omni-1.2-flash",
      prompt: "x",
      duration: 99,
      resolution: "8K",
      referenceVideos: [fakeMp4(5)],
    });
    fail(new Error("contract broken: a bad request was accepted"));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    console.log(`${Y}${err.message}${R}`);
    check(/duration/.test(err.message) && /resolution/.test(err.message), "one error lists every problem");
  }
  try {
    await generateVideo({ ...conn, model: "google/gemini-omni-1.2-flash", prompt: "x", referenceVideos: [fakeMp4(5)] });
    fail(new Error("contract broken: a too-long reference clip was accepted"));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    check(/takes clips up to 3 s/.test(err.message), "a reference clip that is too long is caught from its MP4 header");
  }
  check(requests.length === before, "nothing was sent");
  try {
    await generateVideo({ ...conn, model: "google/gemini-omni-1.1-flash", prompt: "x" });
    fail(new Error("contract broken: an unlisted model was accepted"));
  } catch (err) {
    check(/not a known video model/.test((err as Error).message), "an unlisted model is simply unknown");
  }

  head("3. Edit the clip: it continues the stored interaction");
  const edited = await r.video.edit("Make the marble glow.");
  const last = requests[requests.length - 1]!;
  console.log("edit body:", JSON.stringify(last.body));
  check(
    last.body.previous_interaction_id === "v1_demo1" && last.body.input === "Make the marble glow.",
    "Google got the previous interaction and the prompt only"
  );
  check(last.body.response_format.duration === undefined, "an edit keeps the clip's own length");
  check(edited.responseId === "v1_demo2", "the edited clip can be edited again");

  head("4. OpenRouter works in jobs: submit, poll, download");
  const seen: string[] = [];
  const job = await generateVideo({
    ...conn,
    model: "openrouter/google/veo-3.1",
    prompt: "A paper boat in the rain.",
    duration: 6,
    pollIntervalMs: 5,
    onProgress: (p) => seen.push(`${p.status} ${p.progress ?? ""}`.trim()),
  });
  console.log("progress:", seen.join(" -> "), "| job:", job.jobId);
  check(seen.length >= 2 && job.jobId === JOB, "progress is reported and the result carries the job id");
  const download = requests.find((q) => q.url.includes("/content?index=0"))!;
  check(download.auth, "the file is downloaded with the key (OpenRouter's own host)");
  check(job.usage.cost?.totalCost === 0.8, "the cost is OpenRouter's report");
  check(listVideoModels("openrouter").length === 1, "OpenRouter's list was read once and is now known");

  head("5. A timeout leaves the job running: resume it, don't pay twice");
  slowJob = true;
  let jobId = "";
  try {
    await generateVideo({
      ...conn,
      model: "openrouter/google/veo-3.1",
      prompt: "again",
      duration: 6,
      pollIntervalMs: 5,
      timeoutMs: 60,
    });
    fail(new Error("contract broken: a slow job did not time out"));
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;
    jobId = (err as TimeoutError & { jobId?: string }).jobId ?? "";
    console.log(`${Y}${err.message}${R}`);
    check(jobId === JOB, "the error carries the job id");
  }
  slowJob = false;
  const posts = requests.filter((q) => q.method === "POST" && q.url.includes("openrouter")).length;
  const resumed = await resumeVideo({ ...conn, model: "openrouter/google/veo-3.1", jobId, pollIntervalMs: 5 });
  check(resumed.video.bytes.byteLength > 0 && resumed.jobId === JOB, "resumeVideo finishes the job");
  check(
    requests.filter((q) => q.method === "POST" && q.url.includes("openrouter")).length === posts,
    "no new job was submitted"
  );

  head("6. Models and costs");
  check(listVideoModels("google").length === 1, "Google lists exactly one video model");
  check(
    getVideoModel("google/gemini-omni-1.2-flash")?.audioAlways === true,
    "each entry says what the model can do (here: audio is always on)"
  );
  console.log(`\n${G}All contracts hold.${R}`);
}

main().catch(fail);
