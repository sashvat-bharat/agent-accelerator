// The scripted providers of examples/20-video.ts. Google answers in one request (the video inline as base64); OpenRouter makes a
// job that is polled, then downloaded. No network, no key, no cost.

// A tiny MP4 header of a given length (ftyp + moov/mvhd + a few bytes): enough for the SDK to read the length. No real frames.
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, body: number[]): number[] => [...u32(8 + body.length), ...ascii(type), ...body];

/** A tiny MP4 of the given length in seconds. */
export function fakeMp4(seconds: number): Uint8Array {
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

/** The id of the one OpenRouter job. */
export const JOB = "gen-vid-1700000000-abcdefghijABCDEFGH12";

/** Every request the scripted providers received. */
// biome-ignore lint/suspicious/noExplicitAny: request bodies are read loosely in the demos
export const requests: Array<{ method: string; url: string; auth: boolean; body: any }> = [];

/** Set `slow` to keep the job "in_progress" for ever (to show a timeout). */
export const script: { slow: boolean } = { slow: false };

let interactions = 0;
let polls = 0;

/** A `fetch` that answers like Google and OpenRouter do (OpenRouter's model list included). */
export const offline: typeof fetch = (async (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> }
) => {
  const method = init?.method ?? "GET";
  const auth = Object.keys(init?.headers ?? {}).some((k) => k.toLowerCase() === "authorization");
  const body = init?.body ? JSON.parse(init.body) : undefined;
  if (url.endsWith("/videos/models")) {
    const model = {
      id: "google/veo-3.1",
      name: "Veo 3.1",
      supported_durations: [4, 6, 8],
      supported_resolutions: ["720p", "1080p"],
      supported_aspect_ratios: ["16:9", "9:16"],
      supported_frame_images: ["first_frame", "last_frame"],
      generate_audio: true,
    };
    return new Response(JSON.stringify({ data: [model] }), { status: 200 });
  }
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
  if (method === "POST") {
    const job = { id: JOB, polling_url: `https://openrouter.ai/api/v1/videos/${JOB}`, status: "pending" };
    return new Response(JSON.stringify(job), { status: 202 });
  }
  if (url.endsWith(`/videos/${JOB}`)) {
    polls += 1;
    if (script.slow || polls < 3) {
      return new Response(JSON.stringify({ id: JOB, status: "in_progress", progress: polls * 30 }), { status: 200 });
    }
    const done = {
      id: JOB,
      status: "completed",
      unsigned_urls: [`/api/v1/videos/${JOB}/content?index=0`],
      usage: { cost: 0.8 },
    };
    return new Response(JSON.stringify(done), { status: 200 });
  }
  return new Response(CLIP, { status: 200, headers: { "content-type": "video/mp4" } }); // the file download
}) as unknown as typeof fetch;
