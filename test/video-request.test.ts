import { describe, it, expect } from "bun:test";
import { ValidationError } from "../src/types/errors.ts";
import { getVideoModel, type VideoModelInfo } from "../src/models/video-models.ts";
import { resolveVideoRequest } from "../src/video/request.ts";
import { estimateVideoCostUsd, priceVideoUsage } from "../src/video/pricing.ts";
import { mp4DurationSeconds } from "../src/utils/mp4.ts";
import { fakeMp4 } from "./video-fixtures.ts";

const omni = getVideoModel("google/gemini-omni-1.2-flash")!;

// A made-up OpenRouter-style entry, so the rules can be checked with exact lists.
const generic: VideoModelInfo = {
  model: "openrouter/acme/clip-1",
  provider: "openrouter",
  id: "acme/clip-1",
  name: "Clip 1",
  description: "x",
  durations: [4, 6, 8],
  durationAuto: true,
  resolutions: ["480p", "720p", "4K"],
  aspectRatios: ["16:9", "9:16"],
  sizes: ["1280x720", "720x1280"],
  frames: ["first_frame"],
  audio: false,
  seed: false,
  references: { images: "unknown", videos: "unknown" },
};

// The message of the ValidationError a request throws, or "" when it is accepted.
function problems(opts: Parameters<typeof resolveVideoRequest>[0], def: VideoModelInfo): string {
  try {
    resolveVideoRequest(opts, def);
    return "";
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as Error).message;
  }
}

describe("resolveVideoRequest", () => {
  it("accepts a plain prompt and fills the model's own defaults (Google: 10 s)", () => {
    const { request, warnings } = resolveVideoRequest({ model: omni.model, prompt: "  A fox  " }, omni);
    expect(request.prompt).toBe("A fox");
    expect(request.durationSeconds).toBe(10);
    expect(request.resolution).toBeUndefined(); // sent only when asked: the provider's own default is 720p
    expect(warnings).toEqual([]);
  });

  it("a model with no stated default sends no duration", () => {
    expect(resolveVideoRequest({ model: generic.model, prompt: "x" }, generic).request.durationSeconds).toBeUndefined();
  });

  it("spells a tier as the model lists it", () => {
    expect(resolveVideoRequest({ model: omni.model, prompt: "x", resolution: "4k" }, omni).request.resolution).toBe("4K");
  });

  it("lists EVERY problem in one error", () => {
    const msg = problems(
      {
        model: omni.model,
        prompt: "x",
        duration: 2,
        resolution: "8K",
        aspectRatio: "1:1",
        referenceImages: new Array(7).fill("a.png"),
      },
      omni
    );
    expect(msg).toContain("(4 problems)");
    expect(msg).toContain("duration: 2 s is not available");
    expect(msg).toContain('resolution: "8K" is not available');
    expect(msg).toContain('aspectRatio: "1:1" is not available');
    expect(msg).toContain("referenceImages: 7 pictures; google/gemini-omni-1.2-flash takes at most 6");
  });

  it("needs a prompt unless a first frame is given", () => {
    expect(problems({ model: omni.model }, omni)).toContain("prompt: required");
    expect(problems({ model: omni.model, prompt: "   " }, omni)).toContain("prompt: required");
    expect(problems({ model: omni.model, firstFrame: "a.png" }, omni)).toBe("");
    expect(problems({ model: omni.model, prompt: 5 as unknown as string }, omni)).toContain("prompt: must be a string");
  });

  it("duration: whole seconds from the list, or 'auto' only where the model allows it", () => {
    expect(problems({ model: omni.model, prompt: "x", duration: 1.5 }, omni)).toContain("duration: must be a whole number of seconds");
    expect(problems({ model: omni.model, prompt: "x", duration: 16 }, omni)).toContain("It makes: 3, 4");
    expect(problems({ model: omni.model, prompt: "x", duration: "auto" }, omni)).toContain("cannot choose the length itself");
    const auto = resolveVideoRequest({ model: generic.model, prompt: "x", duration: "auto" }, generic).request;
    expect(auto.durationAuto).toBe(true);
    expect(auto.durationSeconds).toBeUndefined();
  });

  it("first and last frame: refused where the model has no such role, never silently dropped", () => {
    const first = { ...generic, frames: ["first_frame" as const] };
    expect(problems({ model: generic.model, prompt: "x", lastFrame: "b.png" }, first)).toContain("takes no last frame (a first frame only)");
    expect(problems({ model: generic.model, prompt: "x", firstFrame: "a.png" }, { ...generic, frames: [] })).toContain("takes no first frame");
    expect(problems({ model: omni.model, prompt: "x", firstFrame: "a.png", lastFrame: "b.png", duration: 8 }, omni)).toBe("");
  });

  it("two frames allow at most 10 s on Google, and the default length (10) is fine", () => {
    expect(problems({ model: omni.model, prompt: "x", firstFrame: "a.png", lastFrame: "b.png", duration: 12 }, omni)).toContain("at most 10 s then");
    expect(problems({ model: omni.model, prompt: "x", firstFrame: "a.png", lastFrame: "b.png" }, omni)).toBe("");
  });

  it("OpenRouter: frames or reference pictures, not both (the provider would ignore the references)", () => {
    const both = { ...generic, frames: ["first_frame" as const] };
    expect(problems({ model: generic.model, prompt: "x", firstFrame: "a.png", referenceImages: ["r.png"] }, both)).toContain("frames OR reference pictures");
    expect(problems({ model: generic.model, prompt: "x", referenceImages: ["r.png"] }, both)).toBe("");
  });

  it("reference clips on Google: 3 of 3 s for a clip up to 10 s, 1 for a longer one", () => {
    const clips = (n: number) => new Array(n).fill("c.mp4");
    expect(problems({ model: omni.model, prompt: "x", duration: 10, referenceVideos: clips(3) }, omni)).toBe("");
    expect(problems({ model: omni.model, prompt: "x", duration: 10, referenceVideos: clips(4) }, omni)).toContain("at most 3, each up to 3 s");
    expect(problems({ model: omni.model, prompt: "x", duration: 12, referenceVideos: clips(2) }, omni)).toContain("at most 1 for a clip longer than 10 s");
    expect(problems({ model: omni.model, prompt: "x", duration: 12, referenceVideos: clips(1) }, omni)).toBe("");
  });

  it("reference clips: refused where a model states it reads none, a warning where the list is silent", () => {
    expect(problems({ model: generic.model, prompt: "x", referenceVideos: ["c.mp4"] }, { ...generic, references: { images: "unknown", videos: "no" } })).toContain("reads no reference clips");
    const { warnings } = resolveVideoRequest({ model: generic.model, prompt: "x", referenceVideos: ["c.mp4"] }, generic);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ capability: "reference videos", fallback: "sending them anyway (the model may ignore them)" });
  });

  it("controls the model does not have are dropped with a warning (audio, seed, size)", () => {
    const g = resolveVideoRequest({ model: omni.model, prompt: "x", audio: false, size: "1280x720" }, omni);
    expect(g.request.audio).toBeUndefined();
    expect(g.request.size).toBeUndefined();
    expect(g.warnings.map((w) => w.capability).sort()).toEqual(["audio", "size"]);
    const o = resolveVideoRequest({ model: generic.model, prompt: "x", audio: true, seed: 7 }, generic);
    expect(o.request.audio).toBeUndefined(); // the model makes silent videos
    expect(o.request.seed).toBeUndefined();
    expect(o.warnings.map((w) => w.capability).sort()).toEqual(["audio", "seed"]);
    // a control it has passes through
    const on = resolveVideoRequest({ model: omni.model, prompt: "x", seed: 7, audio: true }, omni).request;
    expect(on).toMatchObject({ seed: 7, audio: true });
    expect(problems({ model: omni.model, prompt: "x", seed: 1.5 }, omni)).toContain("seed: must be a whole number");
  });

  it("size: from the model's list, and never together with a ratio or tier", () => {
    expect(resolveVideoRequest({ model: generic.model, prompt: "x", size: "720x1280" }, generic).request.size).toBe("720x1280");
    expect(problems({ model: generic.model, prompt: "x", size: "1x1" }, generic)).toContain('size: "1x1" is not available');
    expect(problems({ model: generic.model, prompt: "x", size: "1280x720", aspectRatio: "16:9" }, generic)).toContain("cannot be combined");
    expect(problems({ model: generic.model, prompt: "x", size: "1280x720", resolution: "720p" }, generic)).toContain("cannot be combined");
  });

  it("a list the model does not state turns the control into a warning, not an error", () => {
    const bare = { ...generic, resolutions: [], aspectRatios: [], sizes: undefined };
    const r = resolveVideoRequest({ model: generic.model, prompt: "x", resolution: "720p", aspectRatio: "16:9", size: "1x1" }, bare);
    expect(r.warnings.map((w) => w.capability).sort()).toEqual(["aspect ratio", "resolution", "size"]);
    expect(r.request.resolution).toBeUndefined();
  });
});

describe("video pricing", () => {
  it("Google: video tokens at $12, text at $9, input at $1.50 per 1M, in whole micro-USD", () => {
    // 10 s of 720p = 57,920 video tokens: $0.69504
    const cost = priceVideoUsage(omni, { inputTokens: 100, outputTokens: 57_920, totalTokens: 58_020 })!;
    expect(cost.outputCost).toBeCloseTo(0.69504, 6);
    expect(cost.inputCost).toBeCloseTo(0.00015, 6);
    expect(cost.totalCost).toBeCloseTo(0.69519, 6);
    // text the model wrote is split off the output at its own rate
    const split = priceVideoUsage(omni, { inputTokens: 0, outputTokens: 1000, totalTokens: 1000, outputDetails: { textTokens: 100 } })!;
    expect(split.totalCost).toBeCloseTo((100 * 9 + 900 * 12) / 1_000_000, 9);
    const stated = priceVideoUsage(omni, { inputTokens: 0, outputTokens: 1000, totalTokens: 1000, outputDetails: { videoTokens: 400, textTokens: 100 } })!;
    expect(stated.totalCost).toBeCloseTo((100 * 9 + 400 * 12) / 1_000_000, 9);
  });

  it("unknown stays unknown: no tokens reported, or a model with no token prices", () => {
    expect(priceVideoUsage(omni, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBeUndefined();
    expect(priceVideoUsage(generic, { inputTokens: 10, outputTokens: 10, totalTokens: 20 })).toBeUndefined();
  });

  it("estimates a clip from the table's tokens per second (Google only)", () => {
    expect(estimateVideoCostUsd(omni, 10, undefined)).toBeCloseTo(0.69504, 6); // the default tier is 720p
    expect(estimateVideoCostUsd(omni, 15, "1080p")).toBeCloseTo(1.56384, 6);
    expect(estimateVideoCostUsd(omni, 6, "4K")).toBeCloseTo(1.251072, 6);
    expect(estimateVideoCostUsd(omni, undefined, "720p")).toBeUndefined();
    expect(estimateVideoCostUsd(generic, 5, "720p")).toBeUndefined();
  });
});

describe("mp4DurationSeconds", () => {
  it("reads the length from the moov/mvhd header, version 0 and 1, any timescale, moov before or after the data", () => {
    expect(mp4DurationSeconds(fakeMp4(3))).toBeCloseTo(3, 6);
    expect(mp4DurationSeconds(fakeMp4(12.5, { timescale: 90000 }))).toBeCloseTo(12.5, 6);
    expect(mp4DurationSeconds(fakeMp4(7, { version: 1 }))).toBeCloseTo(7, 6);
    expect(mp4DurationSeconds(fakeMp4(4, { moovLast: true, extra: 5000 }))).toBeCloseTo(4, 6);
  });

  it("anything else is unknown, never a guess", () => {
    expect(mp4DurationSeconds(new Uint8Array(0))).toBeUndefined();
    expect(mp4DurationSeconds(new TextEncoder().encode("not a video at all, just text bytes"))).toBeUndefined();
    const cut = fakeMp4(3).slice(0, 40); // header cut inside the moov box
    expect(mp4DurationSeconds(cut)).toBeUndefined();
    const noMoov = fakeMp4(3).slice(0, 28); // only the ftyp box
    expect(mp4DurationSeconds(noMoov)).toBeUndefined();
  });
});
