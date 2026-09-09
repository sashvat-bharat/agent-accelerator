import { describe, it, expect } from "bun:test";
import { normalizeMediaInput, inferMimeType } from "../src/index.ts";
import { toAiSdkPrompt } from "../src/ai-sdk/converters.ts";

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

describe("Vercel V4 prompt mapping (all five modalities)", () => {
  it("should map text/image/audio/video/file to valid V4 parts", async () => {
    const prompt = await toAiSdkPrompt({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", image: "data:image/png;base64,iVBORw0KGgo=" } as any,
            { type: "audio", audio: "data:audio/mp3;base64,SUQz" } as any,
            { type: "video", video: "data:video/mp4;base64,AAAA" } as any,
            { type: "file", file: "data:application/pdf;base64,JVBERg==", mimeType: "application/pdf", filename: "doc.pdf" } as any,
          ],
        },
      ],
    });
    const userMsg: any = prompt.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg.content.length).toBe(5);
    // V4 has no `image` part: everything media is a tagged `file` part
    for (const part of userMsg.content.slice(1)) {
      expect(part.type).toBe("file");
      expect(part.data?.type).toBe("data");
      expect(part.data?.data instanceof Uint8Array).toBe(true);
    }
    const mediaTypes = userMsg.content.slice(1).map((x: any) => x.mediaType);
    expect(mediaTypes).toEqual(["image/png", "audio/mp3", "video/mp4", "application/pdf"]);
    const filePart = userMsg.content[4];
    expect(filePart.filename).toBe("doc.pdf");
  });
});