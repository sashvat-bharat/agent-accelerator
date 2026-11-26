// Video generation: one function makes a clip with a supported video model and returns a `VideoResult`.
//
//   1. Make a clip, save it, read its length and its cost.
//   2. A request the model cannot take is ONE error that lists every problem, before any network call (a reference clip that
//      is too long is caught from the MP4 header, a missing first-frame role is an error, never a silent text-to-video).
//   3. `video.edit(prompt)` continues the clip on the model that made it (Google: the stored interaction).
//   4. OpenRouter works in jobs: the SDK submits, polls (with `onProgress`) and downloads, and the key goes only to OpenRouter's host.
//   5. A timeout leaves the job running at the provider: the error carries `jobId`, and `resumeVideo` finishes it without paying twice.
//   6. The cost is the provider's report or the table's price, never a made-up $0.
//
// It also works as a smoke check: it asserts these contracts and exits with code 1 if one stops holding.
//
// Run: bun run examples/20-video.ts                  (offline: scripted providers, no key, no cost)
//      bun run examples/20-video.ts --live <model>   (a REAL clip with the shortest length and lowest tier the model lists,
//                                                     e.g. google/gemini-omni-1.2-flash; COSTS MONEY and takes minutes)
// The offline run keeps its own home in .agent-accel/demo-video/ (gitignored, wiped at the start), so it never touches
// your real model catalog.
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
import { check, fail, liveModel } from "./_helpers";
import { JOB, fakeMp4, offline, requests, script } from "./offline/video";

const live = liveModel("google/gemini-omni-1.2-flash");
const conn = live ? {} : { apiKey: "demo-key", fetch: offline };
const GOOGLE = "google/gemini-omni-1.2-flash";
const ROUTER = "openrouter/google/veo-3.1";

// A live run: the cheapest real call the model allows (its shortest length and lowest tier).
async function runLive(model: string): Promise<void> {
  if (model.toLowerCase().startsWith("openrouter/")) await refreshOpenRouterVideoModels();
  const info = getVideoModel(model);
  if (!info)
    throw new Error(
      `${model} is not a known video model. Known: ${listVideoModels()
        .map((m) => m.model)
        .join(", ")}`
    );
  console.log("LIVE: this makes a real clip and costs money.");
  const r = await generateVideo({
    model,
    prompt: "A marble rolling along a wooden track, one continuous smooth shot.",
    ...(info.durations[0] !== undefined ? { duration: info.durations[0] } : {}),
    ...(info.resolutions[0] ? { resolution: info.resolutions[0] } : {}),
    onProgress: (p) => console.log(`  ${p.status}${p.progress !== undefined ? ` ${p.progress}%` : ""}`),
  });
  const file = await r.video.save(path.resolve(".agent-accel", "demo-video-live"));
  console.log(
    `saved ${file} (${r.video.durationSeconds ?? "?"} s), cost $`,
    r.usage.cost?.totalCost ?? "unknown",
    "| id:",
    r.jobId ?? r.responseId
  );
}

async function main(): Promise<void> {
  if (live) return runLive(live);
  const demo = path.resolve(".agent-accel", "demo-video");
  fs.rmSync(demo, { recursive: true, force: true }); // the demo owns this folder
  setHome(demo);

  console.log("1. Make a clip, save it, read its length and cost");
  const r = await generateVideo({ ...conn, model: GOOGLE, prompt: "A marble on a chain reaction track.", duration: 6 });
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

  console.log("\n2. A request the model cannot take is one clear error");
  const before = requests.length;
  try {
    await generateVideo({
      ...conn,
      model: GOOGLE,
      prompt: "x",
      duration: 99,
      resolution: "8K",
      referenceVideos: [fakeMp4(5)],
    });
    fail(new Error("contract broken: a bad request was accepted"));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    console.log(err.message);
    check(/duration/.test(err.message) && /resolution/.test(err.message), "one error lists every problem");
  }
  try {
    await generateVideo({ ...conn, model: GOOGLE, prompt: "x", referenceVideos: [fakeMp4(5)] });
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

  console.log("\n3. Edit the clip: it continues the stored interaction");
  const edited = await r.video.edit("Make the marble glow.");
  const last = requests[requests.length - 1]!;
  console.log("edit body:", JSON.stringify(last.body));
  check(
    last.body.previous_interaction_id === "v1_demo1" && last.body.input === "Make the marble glow.",
    "Google got the previous interaction and the prompt only"
  );
  check(last.body.response_format.duration === undefined, "an edit keeps the clip's own length");
  check(edited.responseId === "v1_demo2", "the edited clip can be edited again");

  console.log("\n4. OpenRouter works in jobs: submit, poll, download");
  const seen: string[] = [];
  const job = await generateVideo({
    ...conn,
    model: ROUTER,
    prompt: "A paper boat in the rain.",
    duration: 6,
    pollIntervalMs: 5,
    onProgress: (p) => seen.push(`${p.status} ${p.progress ?? ""}`.trim()),
  });
  console.log("progress:", seen.join(" -> "), "| job:", job.jobId);
  check(seen.length >= 2 && job.jobId === JOB, "progress is reported and the result carries the job id");
  check(
    requests.find((q) => q.url.includes("/content?index=0"))!.auth,
    "the file is downloaded with the key (OpenRouter's own host)"
  );
  check(job.usage.cost?.totalCost === 0.8, "the cost is OpenRouter's report");
  check(listVideoModels("openrouter").length === 1, "OpenRouter's list was read once and is now known");

  console.log("\n5. A timeout leaves the job running: resume it, don't pay twice");
  script.slow = true;
  let jobId = "";
  try {
    await generateVideo({ ...conn, model: ROUTER, prompt: "again", duration: 6, pollIntervalMs: 5, timeoutMs: 60 });
    fail(new Error("contract broken: a slow job did not time out"));
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;
    jobId = (err as TimeoutError & { jobId?: string }).jobId ?? "";
    console.log(err.message);
    check(jobId === JOB, "the error carries the job id");
  }
  script.slow = false;
  const submitted = () => requests.filter((q) => q.method === "POST" && q.url.includes("openrouter")).length;
  const before2 = submitted();
  const resumed = await resumeVideo({ ...conn, model: ROUTER, jobId, pollIntervalMs: 5 });
  check(resumed.video.bytes.byteLength > 0 && resumed.jobId === JOB, "resumeVideo finishes the job");
  check(submitted() === before2, "no new job was submitted");

  console.log("\n6. Models and costs");
  check(listVideoModels("google").length === 1, "Google lists exactly one video model");
  check(
    getVideoModel(GOOGLE)?.audioAlways === true,
    "each entry says what the model can do (here: audio is always on)"
  );
  console.log("\nAll contracts hold.");
}

main().catch(fail);
