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
    const provider = new OpenAICompatibleChatProvider("groq");
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
    expect(String(err?.message ?? err)).toMatch(/unsupported file input.*convert_document_to_markdown/);
  });
});
