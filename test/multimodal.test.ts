import { describe, it, expect } from "bun:test";
import { normalizeMediaInput, inferMimeType } from "../src/index.ts";

describe("Input Modalities Support (Text, Image, Audio, Video)", () => {
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
