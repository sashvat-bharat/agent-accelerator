import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { Agent, tool, toolContent, generateImage, generateVideo, generateEmbedding, generateDecision } from "../src/index.ts";
import { normalizeMediaInput } from "../src/utils/media.ts";
import { executeToolCalls } from "../src/tools/executor.ts";
import { clearInteractionChains } from "../src/providers/google.ts";
import { clearSessionRouting } from "../src/providers.ts";
import { sseFrame } from "./helpers.ts";

// A media URL that the SDK downloads itself goes through the caller's `fetch` (the Agent's own, a proxy, a mock) and
// stops when the run is aborted. The global fetch throws in every test here, so a download that bypasses the caller's
// fetch fails the test.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B64 = Buffer.from(PNG).toString("base64");
const MP3 = new TextEncoder().encode("ID3-fake-mp3");
const MP3_B64 = Buffer.from(MP3).toString("base64");
const TXT = "plain notes";

const ORIGINAL_FETCH = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (url: string) => {
    throw new Error(`the global fetch was used for ${url}`);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  clearInteractionChains();
  clearSessionRouting();
});

const isMedia = (url: string): boolean => url.startsWith("https://media.example/");
// The media files the fake host serves.
const mediaReply = (url: string): Response => {
  if (url.endsWith(".png")) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  if (url.endsWith(".mp3")) return new Response(MP3, { status: 200, headers: { "content-type": "audio/mpeg" } });
  return new Response(TXT, { status: 200, headers: { "content-type": "text/plain" } });
};

describe("normalizeMediaInput downloads with the caller's fetch and signal", () => {
  it("uses the given fetch on every redirect hop", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return url.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "https://media.example/p.png" } })
        : mediaReply(url);
    }) as unknown as typeof fetch;
    const media = await normalizeMediaInput("https://cdn.example/start", undefined, { fetch: fetchImpl });
    expect(media.base64Data).toBe(PNG_B64);
    expect(seen).toEqual(["https://cdn.example/start", "https://media.example/p.png"]);
  });

  it("stops a download in progress when the signal aborts", async () => {
    let gotSignal: AbortSignal | undefined;
    // Sends one chunk, then waits; only the signal it was given can end it.
    const slow = (async (_url: string, init: RequestInit) => {
      gotSignal = init.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1000));
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as unknown as typeof fetch;
    const abort = new AbortController();
    const started = Date.now();
    const pending = normalizeMediaInput("https://media.example/huge.mp3", undefined, { signal: abort.signal, fetch: slow });
    setTimeout(() => abort.abort(new DOMException("stop", "AbortError")), 20);
    const err = await pending.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(gotSignal).toBe(abort.signal);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("the chat adapters download with the Agent's fetch", () => {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  // A chat completion, streamed when the request asks for it (OpenRouter streams every run).
  const chat = (body: any) =>
    body.stream
      ? new Response(sseFrame({ id: "c", choices: [{ delta: { content: "ok" } }] }) + sseFrame({ id: "c", choices: [{ delta: {}, finish_reason: "stop" }], usage }) + "data: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      : new Response(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage }), { status: 200 });
  const cases = [
    { model: "groq/m", extra: { baseUrl: "https://groq.test/v1" }, part: { type: "audio", audio: "https://media.example/a.mp3" }, data: MP3_B64, reply: chat },
    { model: "openrouter/vendor/model", extra: {}, part: { type: "audio", audio: "https://media.example/a.mp3" }, data: MP3_B64, reply: chat },
    {
      model: "anthropic/claude-sonnet-5-5",
      extra: {},
      part: { type: "file", file: "https://media.example/notes.txt", mimeType: "text/plain" },
      data: TXT,
      reply: (_body: unknown) => new Response(JSON.stringify({ id: "m1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }),
    },
    {
      model: "google/gemini-3.5-flash-lite",
      extra: {},
      part: { type: "audio", audio: "https://media.example/a.mp3", mimeType: "audio/mpeg" },
      data: MP3_B64,
      reply: (_body: unknown) => new Response(JSON.stringify({ id: "i1", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }] }), { status: 200 }),
    },
  ];

  for (const c of cases) {
    it(`${c.model.split("/")[0]}: the media URL goes through the Agent's fetch, and the provider gets its data`, async () => {
      const media: string[] = [];
      const bodies: string[] = [];
      const fetchImpl = (async (url: string, init: RequestInit) => {
        if (isMedia(url)) return media.push(url), mediaReply(url);
        bodies.push(String(init.body));
        return c.reply(JSON.parse(String(init.body)));
      }) as unknown as typeof fetch;
      const agent = new Agent({ model: c.model, apiKey: "k", fetch: fetchImpl, runRetries: 0, ...c.extra });
      const res = await agent.run([{ type: "text", text: "listen" }, c.part] as never);
      expect(res.text).toBe("ok");
      expect(media).toEqual([String(Object.values(c.part)[1])]);
      expect(bodies[0]).toContain(c.data);
    });
  }
});

describe("tool results download with the Agent's fetch and the run's signal", () => {
  const picture = tool({
    name: "picture",
    description: "show a picture",
    input: z.object({}),
    replay: "safe",
    execute: async () => toolContent([{ type: "image", image: "https://media.example/p.png" }]),
  });

  it("the executor uses the fetch it is given", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => (seen.push(url), mediaReply(url))) as unknown as typeof fetch;
    const [r] = await executeToolCalls({ tools: { picture }, toolCalls: [{ id: "c1", name: "picture", arguments: {} }], fetch: fetchImpl });
    expect(r!.isError).toBe(false);
    expect(r!.parts).toEqual([{ type: "image", image: `data:image/png;base64,${PNG_B64}`, mimeType: "image/png" }]);
    expect(seen).toEqual(["https://media.example/p.png"]);
  });

  // A groq agent whose model calls `picture` once and then answers; the same fetch serves the media.
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const scripted = () => {
    const media: string[] = [];
    let turns = 0;
    const fn = (async (url: string, init: any) => {
      if (isMedia(url)) return media.push(url), mediaReply(url);
      const body = JSON.parse(init.body);
      const first = turns++ === 0;
      const toolCall = { id: "call_1", type: "function", function: { name: "picture", arguments: "{}" } };
      if (body.stream) {
        const delta = first ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: "done" };
        return new Response(
          sseFrame({ id: "r", choices: [{ delta }] }) + sseFrame({ id: "r", choices: [{ delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage }) + "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      const message = first ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: "done" };
      return new Response(JSON.stringify({ id: "r", choices: [{ message, finish_reason: first ? "tool_calls" : "stop" }], usage }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fn, media, skipFirstTurn: () => void turns++ };
  };

  it("run() and stream() pass the Agent's fetch to the tools", async () => {
    for (const mode of ["run", "stream"] as const) {
      const { fn, media } = scripted();
      const agent = new Agent({ model: "groq/m", apiKey: "k", baseUrl: "https://x/v1", fetch: fn, tools: { picture }, runRetries: 0 });
      const res = mode === "run" ? await agent.run("show it") : await agent.stream("show it").result();
      expect(res.toolResults[0]!.isError, mode).toBe(false);
      expect(media, mode).toEqual(["https://media.example/p.png"]);
    }
  });

  it("resume() passes it too", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-media-resume-"));
    try {
      let hang = true;
      const slowPicture = tool({ ...picture, execute: async () => (hang ? new Promise<never>(() => {}) : picture.execute({}, {} as never)) });
      const config = (fn: typeof fetch) => ({ model: "groq/m", apiKey: "k", baseUrl: "https://x/v1", sessionId: "r1", persist: { dir: root }, resume: "explicit" as const, fetch: fn, tools: { picture: slowPicture } });
      void new Agent(config(scripted().fn)).run("show it"); // the tool hangs: the run is cut off
      await new Promise((r) => setTimeout(r, 60));
      hang = false;
      const second = scripted();
      second.skipFirstTurn(); // the resumed run's first request is the answer turn
      const res = await new Agent(config(second.fn)).resume();
      expect(res!.toolResults[0]!.isError).toBe(false);
      expect(second.media).toEqual(["https://media.example/p.png"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the generators download inputs with their fetch option", () => {
  // Serves the media and refuses the provider call: what matters is which fetch made the download.
  const recorder = () => {
    const media: string[] = [];
    const fn = (async (url: string) => (isMedia(url) ? (media.push(url), mediaReply(url)) : new Response("{}", { status: 400 }))) as unknown as typeof fetch;
    return { fn, media };
  };
  const quiet = { apiKey: "k", retry: { maxRetries: 0 } };

  it("generateImage, generateVideo, generateEmbedding and generateDecision", async () => {
    const calls: Array<[string, (fn: typeof fetch) => Promise<unknown>]> = [
      ["image", (fn) => generateImage({ model: "google/gemini-nano-banana-2.1", prompt: "edit", images: ["https://media.example/p.png"], fetch: fn, ...quiet })],
      ["video", (fn) => generateVideo({ model: "google/gemini-omni-1.2-flash", prompt: "move", firstFrame: "https://media.example/p.png", fetch: fn, ...quiet })],
      ["embedding", (fn) => generateEmbedding({ model: "google/gemini-embedding-2", input: { type: "image", image: "https://media.example/p.png" }, fetch: fn, ...quiet })],
      ["decision", (fn) => generateDecision({ model: "google/gemini-decision-1", input: [{ type: "image", image: "https://media.example/p.png" }], questions: { picture: { type: "noul", instructions: "Is it a picture?" } }, fetch: fn, ...quiet })],
    ];
    for (const [name, call] of calls) {
      const { fn, media } = recorder();
      const err = await call(fn).catch((e: unknown) => e);
      expect(String(err), name).not.toContain("the global fetch was used");
      expect(media, name).toEqual(["https://media.example/p.png"]);
    }
  });
});
