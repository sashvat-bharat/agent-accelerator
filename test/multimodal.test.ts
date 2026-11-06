import { describe, it, expect, afterEach } from "bun:test";
import { normalizeMediaInput, inferMimeType } from "../src/index.ts";
import { OpenAICompatibleChatProvider } from "../src/index.ts";

const ORIGINAL_FETCH = globalThis.fetch;

describe("Input Modalities Support (Text, Image, Audio, Video, File)", () => {
  it("should infer MIME types correctly", () => {
    expect(inferMimeType("photo.png")).toBe("image/png");
    expect(inferMimeType("photo.jpg")).toBe("image/jpeg");
    expect(inferMimeType("audio.mp3")).toBe("audio/mp3");
    expect(inferMimeType("video.mp4")).toBe("video/mp4");
  });

  it("should normalize base64 and data URLs", async () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const norm = await normalizeMediaInput(dataUrl);

    expect(norm.mimeType).toBe("image/png");
    expect(norm.base64Data).toBe("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
    expect(norm.dataUrl).toBe(dataUrl);
  });

  it("should normalize Uint8Array / Buffer inputs", async () => {
    const buffer = Buffer.from("test audio content");
    const norm = await normalizeMediaInput(buffer, "audio/mp3");

    expect(norm.mimeType).toBe("audio/mp3");
    expect(norm.dataUrl.startsWith("data:audio/mp3;base64,")).toBe(true);
  });
});

describe("native chat wire mapping (text, image, audio)", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  const TEXT_RESPONSE = {
    id: "chatcmpl-mm",
    choices: [{ message: { role: "assistant", content: "seen" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
  };

  async function captureBody(context: any) {
    let sentBody: any = null;
    (globalThis as any).fetch = async (_url: unknown, req: any) => {
      sentBody = JSON.parse(req.body);
      return new Response(JSON.stringify(TEXT_RESPONSE), { status: 200 });
    };
    const provider = new OpenAICompatibleChatProvider("groq", { baseUrl: "https://compat.example/v1" });
    // Unlisted model id: the catalog gate skips unknown models so the wire
    // mapping itself is what's under test here.
    await provider.generate("unlisted-model-xyz", context, { apiKey: "k" });
    return sentBody;
  }

  it("sends image inputs as image_url and audio as input_audio", async () => {
    const sentBody = await captureBody({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", image: "data:image/png;base64,iVBORw0KGgo=" } as any,
            { type: "audio", audio: "data:audio/mp3;base64,SUQz", mimeType: "audio/mp3" } as any,
          ],
        },
      ],
    });
    const userMsg = sentBody.messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();
    const kinds = userMsg.content.map((p: any) => p.type);
    expect(kinds).toEqual(["text", "image_url", "input_audio"]);
    expect(userMsg.content[1].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(userMsg.content[2].input_audio.format).toBe("mp3");
    expect(JSON.stringify(sentBody)).not.toContain("reasoning");
  });

  it("drops prior-turn thinking from history but keeps tool calls", async () => {
    const sentBody = await captureBody({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me call the tool" },
            { type: "tool_call", id: "c1", name: "get_status", arguments: { username: "x" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", id: "c1", name: "get_status", result: "ok" }],
        },
      ],
    } as any);
    const asst = sentBody.messages.find((m: any) => m.role === "assistant");
    expect(asst.tool_calls?.length).toBe(1);
    expect(asst.tool_calls[0].function.name).toBe("get_status");
    expect(JSON.stringify(sentBody)).not.toContain("let me call the tool");
    const tool = sentBody.messages.find((m: any) => m.role === "tool");
    expect(tool.tool_call_id).toBe("c1");
  });

  it("fails fast on video parts with a one-line error (no network call)", async () => {
    const provider = new OpenAICompatibleChatProvider("groq");
    (globalThis as any).fetch = async () => {
      throw new Error("network must not be reached");
    };
    const err = await provider
      .generate(
        "m",
        { messages: [{ role: "user", content: [{ type: "video", video: "https://x/y.mp4" }] }] } as any,
        { apiKey: "k" }
      )
      .then(() => null)
      .catch((e) => e);
    expect(String(err?.message ?? err)).toMatch(/unsupported video input/);
  });

  it("fails fast on file parts and points at the document converter", async () => {
    const provider = new OpenAICompatibleChatProvider("groq");
    (globalThis as any).fetch = async () => {
      throw new Error("network must not be reached");
    };
    const err = await provider
      .generate(
        "m",
        {
          messages: [
            {
              role: "user",
              content: [{ type: "file", file: "https://x/y.pdf", mimeType: "application/pdf" }],
            },
          ],
        } as any,
        { apiKey: "k" }
      )
      .then(() => null)
      .catch((e) => e);
    const message = String(err?.message ?? err);
    expect(message).toMatch(/unsupported file input.*file-capable model/);
    expect(message).not.toContain("convert_document_to_markdown");
  });
});

describe("media MIME detection when no type is supplied", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const pdf = new TextEncoder().encode("%PDF-1.7\n....");

  it("sniffs magic bytes for raw bytes (instead of application/octet-stream)", async () => {
    const { normalizeMediaInput, sniffMimeType } = await import("../src/index.ts");
    expect(sniffMimeType(png)).toBe("image/png");
    expect(sniffMimeType(pdf)).toBe("application/pdf");
    expect(sniffMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMimeType(new Uint8Array([1, 2, 3, 4, 5]))).toBeUndefined();
    expect((await normalizeMediaInput(png)).mimeType).toBe("image/png");
    expect((await normalizeMediaInput(pdf)).mimeType).toBe("application/pdf");
    // An explicit hint always wins; unknown bytes stay generic.
    expect((await normalizeMediaInput(png, "image/x-custom")).mimeType).toBe("image/x-custom");
    expect((await normalizeMediaInput(new Uint8Array([1, 2, 3, 4, 5]))).mimeType).toBe("application/octet-stream");
  });

  it("sniffs base64 payloads and generic download types (default jpeg only as a last resort)", async () => {
    const { normalizeMediaInput } = await import("../src/index.ts");
    const longPng = new Uint8Array(200);
    longPng.set(png);
    const b64 = Buffer.from(longPng).toString("base64");
    expect((await normalizeMediaInput(b64)).mimeType).toBe("image/png");
    const prev = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(png, { status: 200, headers: { "content-type": "application/octet-stream" } });
    try {
      expect((await normalizeMediaInput("https://8.8.8.8/download")).mimeType).toBe("image/png");
    } finally {
      globalThis.fetch = prev;
    }
  });
});

describe("audio and video detection (OpenRouter inputs)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as any).fetch = realFetch;
  });
  const bytes = (...head: number[]) => new Uint8Array([...head, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

  it("recognises flac, aiff, aac (ADTS) and m4a by content, and keeps mp3 and mp4 as they were", async () => {
    const { sniffMimeType } = await import("../src/index.ts");
    expect(sniffMimeType(bytes(...ascii("fLaC")))).toBe("audio/flac");
    expect(sniffMimeType(bytes(...ascii("FORM"), 0, 0, 0, 0, ...ascii("AIFF")))).toBe("audio/aiff");
    expect(sniffMimeType(bytes(0xff, 0xf1))).toBe("audio/aac");
    expect(sniffMimeType(bytes(0xff, 0xf9))).toBe("audio/aac");
    expect(sniffMimeType(bytes(0xff, 0xfb))).toBe("audio/mp3"); // an MP3 frame is not AAC
    expect(sniffMimeType(bytes(...ascii("ID3")))).toBe("audio/mp3");
    expect(sniffMimeType(bytes(0, 0, 0, 0x20, ...ascii("ftypM4A ")))).toBe("audio/m4a"); // not video/mp4
    expect(sniffMimeType(bytes(0, 0, 0, 0x20, ...ascii("ftypisom")))).toBe("video/mp4");
    expect(sniffMimeType(bytes(0, 0, 0, 0x14, ...ascii("ftypqt  ")))).toBe("video/quicktime");
    expect(sniffMimeType(bytes(0, 0, 1, 0xba))).toBe("video/mpeg");
  });

  it("infers flac, m4a, aac, aiff and mpeg from the extension", () => {
    expect(inferMimeType("a.flac")).toBe("audio/flac");
    expect(inferMimeType("a.m4a")).toBe("audio/m4a");
    expect(inferMimeType("a.aac")).toBe("audio/aac");
    expect(inferMimeType("a.aiff")).toBe("audio/aiff");
    expect(inferMimeType("v.mpeg")).toBe("video/mpeg");
    expect(inferMimeType("v.mpg")).toBe("video/mpeg");
  });

  it("OpenRouter sends the real audio format and names QuickTime video/mov", async () => {
    const { OpenRouterChatCompletionsProvider } = await import("../src/providers/openrouter.ts");
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_u: unknown, req: any) => {
      bodies.push(JSON.parse(req.body));
      return new Response(`data: ${JSON.stringify({ id: "g", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const formats: Array<[Uint8Array, string | undefined, string]> = [
      [bytes(...ascii("fLaC")), undefined, "flac"],
      [bytes(0, 0, 0, 0x20, ...ascii("ftypM4A ")), undefined, "m4a"],
      [bytes(...ascii("OggS")), undefined, "ogg"],
      [bytes(0xff, 0xf1), undefined, "aac"],
      [bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")), undefined, "wav"],
      [bytes(...ascii("ID3")), undefined, "mp3"],
      [bytes(1, 2, 3, 4), "audio/x-aiff", "aiff"],
    ];
    const provider = new OpenRouterChatCompletionsProvider();
    for (const [audio, mimeType] of formats) {
      await provider.generate("m", { messages: [{ role: "user", content: [{ type: "audio", audio, ...(mimeType ? { mimeType } : {}) } as any] }] }, { apiKey: "k" });
    }
    expect(bodies.map((b) => b.messages[0].content[0].input_audio.format)).toEqual(formats.map((f) => f[2]));
    await provider.generate("m", { messages: [{ role: "user", content: [{ type: "video", video: bytes(0, 0, 0, 0x14, ...ascii("ftypqt  ")) } as any] }] }, { apiKey: "k" });
    expect(bodies.at(-1).messages[0].content[0].video_url.url.startsWith("data:video/mov;base64,")).toBe(true);
  });
});
