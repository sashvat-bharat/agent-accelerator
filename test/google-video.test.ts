import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateVideo } from "../src/video/generate.ts";
import { setHome } from "../src/utils/home.ts";
import { ProviderError, TimeoutError } from "../src/types/errors.ts";
import { PNG, fakeMp4 } from "./video-fixtures.ts";
import { recordingFetch, jsonAnswer } from "./helpers.ts";

const OMNI = "google/gemini-omni-1.2-flash";
const B64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const CLIP = fakeMp4(10);


// The documented REST reply: steps with a model_output block holding the video.
function reply(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "v1_abc",
    status: "completed",
    model: "gemini-omni-1.2-flash",
    object: "interaction",
    steps: [
      { type: "user_input", content: [{ type: "text", text: "..." }] },
      { type: "thought", content: [{ text: "...", type: "thought" }] },
      { type: "model_output", content },
    ],
    usage: { total_input_tokens: 12, total_output_tokens: 57_920, total_thought_tokens: 0, total_tokens: 57_932, output_tokens_by_modality: [{ modality: "video", tokens: 57_920 }] },
    ...extra,
  };
}
const inline = (bytes = CLIP) => reply([{ type: "video", mime_type: "video/mp4", data: B64(bytes) }]);

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-gvideo-"));
  setHome(home);
});
afterEach(() => {
  setHome();
  fs.rmSync(home, { recursive: true, force: true });
});
const base = { model: OMNI, apiKey: "KEY", baseUrl: "https://g.test/v1beta" };

describe("Google video: the request on the wire", () => {
  it("text to video: a plain string input, the format block, a key header, synchronous", async () => {
    const m = recordingFetch(jsonAnswer(inline()));
    const r = await generateVideo({ ...base, prompt: "A marble rolling", fetch: m.fn, aspectRatio: "9:16", resolution: "720p", duration: 6 });
    expect(m.calls).toHaveLength(1);
    const c = m.calls[0]!;
    expect(c.url).toBe("https://g.test/v1beta/interactions");
    expect(c.method).toBe("POST");
    expect(c.headers["x-goog-api-key"]).toBe("KEY");
    expect(c.body).toEqual({
      model: "gemini-omni-1.2-flash",
      input: "A marble rolling",
      response_format: { type: "video", aspect_ratio: "9:16", resolution: "720p", duration: "6s" },
      background: false,
    });
    expect(r.video.bytes.byteLength).toBe(CLIP.byteLength);
    expect(r.responseId).toBe("v1_abc");
    expect(r.finishReason).toBe("stop");
    expect(JSON.stringify(r.raw)).not.toContain(B64(CLIP).slice(0, 40)); // the clip is not copied into the audit record
    expect(JSON.stringify(r.raw)).not.toContain("KEY");
  });

  it("the default length (10 s) is sent as '10s'", async () => {
    const m = recordingFetch(jsonAnswer(inline()));
    await generateVideo({ ...base, prompt: "x", fetch: m.fn });
    expect(m.calls[0]!.body.response_format.duration).toBe("10s");
  });

  it("a first frame alone is image_to_video; the picture block comes before the text", async () => {
    const m = recordingFetch(jsonAnswer(inline()));
    await generateVideo({ ...base, prompt: "make it move", firstFrame: PNG, fetch: m.fn });
    const b = m.calls[0]!.body;
    expect(b.input).toEqual([{ type: "image", data: B64(PNG), mime_type: "image/png" }, { type: "text", text: "make it move" }]);
    expect(b.generation_config).toEqual({ video_config: { task: "image_to_video" } });
  });

  it("first and last frame: two image blocks in that order and no task (Google advises prompting)", async () => {
    const m = recordingFetch(jsonAnswer(inline()));
    await generateVideo({ ...base, prompt: "a transition", firstFrame: PNG, lastFrame: PNG, duration: 8, fetch: m.fn });
    const b = m.calls[0]!.body;
    expect(b.input.map((x: any) => x.type)).toEqual(["image", "image", "text"]);
    expect(b.generation_config).toBeUndefined();
  });

  it("reference pictures and clips are image/video blocks; references only means reference_to_video", async () => {
    const m = recordingFetch(jsonAnswer(inline()));
    await generateVideo({ ...base, prompt: "a cat with yarn", referenceImages: [PNG, PNG], referenceVideos: [fakeMp4(3)], fetch: m.fn });
    const b = m.calls[0]!.body;
    expect(b.input.map((x: any) => x.type)).toEqual(["image", "image", "video", "text"]);
    expect(b.input[2].mime_type).toBe("video/mp4");
    expect(b.generation_config).toEqual({ video_config: { task: "reference_to_video" } });
  });

  it("seed goes to generation_config", async () => {
    const m = recordingFetch(jsonAnswer(inline()));
    await generateVideo({ ...base, prompt: "x", seed: 7, fetch: m.fn });
    expect(m.calls[0]!.body.generation_config).toEqual({ seed: 7 });
  });

  it("a picture type Google does not read fails before any request", async () => {
    const m = recordingFetch(jsonAnswer(inline()));
    const gif = `data:image/svg+xml;base64,${Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>").toString("base64")}`;
    const err = await generateVideo({ ...base, prompt: "x", firstFrame: gif, fetch: m.fn }).catch((e) => e);
    expect(err.message).toContain("does not accept the picture type");
    expect(m.calls).toHaveLength(0);
  });
});

describe("Google video: the reply", () => {
  it("usage: video tokens priced at the video rate, input at the input rate", async () => {
    const m = recordingFetch(jsonAnswer(inline()));
    const r = await generateVideo({ ...base, prompt: "x", resolution: "720p", fetch: m.fn });
    expect(r.usage.outputDetails?.videoTokens).toBe(57_920);
    expect(r.usage.cost!.totalCost).toBeCloseTo((12 * 1.5 + 57_920 * 12) / 1_000_000, 9);
  });

  it("thinking tokens count as text output", async () => {
    const m = recordingFetch(jsonAnswer(reply([{ type: "video", mime_type: "video/mp4", data: B64(CLIP) }], { usage: { total_input_tokens: 10, total_output_tokens: 1000, total_thought_tokens: 500, total_tokens: 1510, output_tokens_by_modality: [{ modality: "video", tokens: 1000 }] } })));
    const r = await generateVideo({ ...base, prompt: "x", fetch: m.fn });
    expect(r.usage.thinkingTokens).toBe(500);
    expect(r.usage.outputTokens).toBe(1500);
    expect(r.usage.cost!.totalCost).toBeCloseTo((10 * 1.5 + 500 * 9 + 1000 * 12) / 1_000_000, 9);
  });

  it("words next to the video are kept in text", async () => {
    const m = recordingFetch(jsonAnswer(reply([{ type: "text", text: "Here is your video." }, { type: "video", mime_type: "video/mp4", data: B64(CLIP) }])));
    expect((await generateVideo({ ...base, prompt: "x", fetch: m.fn })).text).toBe("Here is your video.");
  });

  it("an answer in words only (a refusal) becomes an error that carries the words", async () => {
    const m = recordingFetch(jsonAnswer(reply([{ type: "text", text: "I can't make that video." }])));
    const err = await generateVideo({ ...base, prompt: "x", fetch: m.fn }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("returned no video: I can't make that video");
  });

  it("a failed interaction is an error that carries the interaction id", async () => {
    const m = recordingFetch(jsonAnswer(reply([], { status: "failed", error: { code: "INTERNAL", message: "generation failed" } })));
    const err = await generateVideo({ ...base, prompt: "x", fetch: m.fn }).catch((e) => e);
    expect(err.message).toContain("generation failed");
    expect(err.jobId).toBe("v1_abc");
  });

  it("HTTP errors: 400 names Google's message, 401 hints at the key, 429 is retried", async () => {
    const bad = recordingFetch(jsonAnswer({ error: { code: 400, message: "duration is not supported", status: "INVALID_ARGUMENT" } }, 400));
    const e1 = await generateVideo({ ...base, prompt: "x", fetch: bad.fn }).catch((e) => e);
    expect(e1.message).toContain("duration is not supported");
    expect(bad.calls).toHaveLength(1); // a 400 is not retried
    const denied = recordingFetch(jsonAnswer({ error: { code: 401, message: "API key not valid" } }, 401));
    const e2 = await generateVideo({ ...base, prompt: "x", fetch: denied.fn }).catch((e) => e);
    expect(e2.message).toContain("API key not valid");
    const flaky = recordingFetch(jsonAnswer({ error: { code: 429, message: "slow down" } }, 429), jsonAnswer(inline()));
    const ok = await generateVideo({ ...base, prompt: "x", fetch: flaky.fn, retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 } });
    expect(ok.video.bytes.byteLength).toBeGreaterThan(0);
    expect(flaky.calls).toHaveLength(2);
  });

  it("a missing key is a ConfigError before any request", async () => {
    const m = recordingFetch(jsonAnswer(inline()));
    const saved = [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY];
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const err = await generateVideo({ model: OMNI, prompt: "x", fetch: m.fn, env: {} }).catch((e) => e);
      expect(err.name).toBe("ConfigError");
      expect(m.calls).toHaveLength(0);
    } finally {
      if (saved[0] !== undefined) process.env.GEMINI_API_KEY = saved[0];
      if (saved[1] !== undefined) process.env.GOOGLE_API_KEY = saved[1];
    }
  });
});

describe("Google video: a big clip is delivered as a link", () => {
  const link = reply([{ type: "video", mime_type: "video/mp4", uri: "https://g.test/v1beta/files/abc-123:download?alt=media" }]);
  const state = (s: string) => jsonAnswer({ name: "files/abc-123", state: s });
  const download = () => new Response(CLIP, { status: 200, headers: { "content-type": "video/mp4" } });

  it("4K asks for delivery uri and the lowercase tier; the file is checked until ACTIVE, then downloaded with the key", async () => {
    const seen: string[] = [];
    const m = recordingFetch(jsonAnswer(link), state("PROCESSING"), state("ACTIVE"), download);
    const r = await generateVideo({ ...base, prompt: "x", resolution: "4K", duration: 3, fetch: m.fn, pollIntervalMs: 1, onProgress: (p) => seen.push(p.status) });
    expect(m.calls[0]!.body.response_format).toMatchObject({ resolution: "4k", delivery: "uri" });
    expect(m.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://g.test/v1beta/interactions",
      "GET https://g.test/v1beta/files/abc-123",
      "GET https://g.test/v1beta/files/abc-123",
      "GET https://g.test/v1beta/files/abc-123:download?alt=media",
    ]);
    expect(m.calls[1]!.headers["x-goog-api-key"]).toBe("KEY");
    expect(m.calls[3]!.headers["x-goog-api-key"]).toBe("KEY");
    expect(seen).toEqual(["processing"]);
    expect(r.video.bytes.byteLength).toBe(CLIP.byteLength);
    expect(r.jobId).toBeUndefined();
    expect(r.responseId).toBe("v1_abc");
  });

  it("1080p also uses a link; 720p and below stay inline", async () => {
    const a = recordingFetch(jsonAnswer(inline()));
    await generateVideo({ ...base, prompt: "x", resolution: "1080p", duration: 3, fetch: a.fn });
    expect(a.calls[0]!.body.response_format.delivery).toBe("uri");
    const b = recordingFetch(jsonAnswer(inline()));
    await generateVideo({ ...base, prompt: "x", resolution: "360p", duration: 3, fetch: b.fn });
    expect(b.calls[0]!.body.response_format.delivery).toBeUndefined();
  });

  it("a file that FAILED is an error with the interaction id", async () => {
    const m = recordingFetch(jsonAnswer(link), state("FAILED"));
    const err = await generateVideo({ ...base, prompt: "x", resolution: "4K", duration: 3, fetch: m.fn, pollIntervalMs: 1 }).catch((e) => e);
    expect(err.message).toContain("FAILED");
    expect(err.jobId).toBe("v1_abc");
  });

  it("a create request that outlives timeoutMs is a TimeoutError that says the video may still be made", async () => {
    const hang = (async (_u: string, init: RequestInit) =>
      await new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      )) as unknown as typeof fetch;
    const err = await generateVideo({ ...base, prompt: "x", fetch: hang, timeoutMs: 40 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toContain("may still be made at Google");
  });

  it("a file still processing at the deadline is a TimeoutError that carries the id", async () => {
    const m = recordingFetch(jsonAnswer(link), state("PROCESSING"));
    const err = await generateVideo({ ...base, prompt: "x", resolution: "4K", duration: 3, fetch: m.fn, pollIntervalMs: 5, timeoutMs: 60 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.jobId).toBe("v1_abc");
  });

  it("an abort while the file is processing rejects at once", async () => {
    const m = recordingFetch(jsonAnswer(link), state("PROCESSING"));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    const err = await generateVideo({ ...base, prompt: "x", resolution: "4K", duration: 3, fetch: m.fn, pollIntervalMs: 10_000, signal: ctl.signal }).catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(err.jobId).toBe("v1_abc");
  });

  it("a link this SDK cannot read is a clear error", async () => {
    const m = recordingFetch(jsonAnswer(reply([{ type: "video", mime_type: "video/mp4", uri: "https://elsewhere.test/clip.mp4" }])));
    const err = await generateVideo({ ...base, prompt: "x", resolution: "4K", duration: 3, fetch: m.fn }).catch((e) => e);
    expect(err.message).toContain("cannot read");
  });
});
