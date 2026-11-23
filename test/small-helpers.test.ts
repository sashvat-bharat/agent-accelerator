import { describe, it, expect } from "bun:test";
import { Agent, setModels, ProviderError, ConfigError } from "../src/index.ts";
import { beforeFirst } from "../src/utils/text.ts";
import { isRecord } from "../src/utils/guards.ts";
import { noop } from "../src/utils/noop.ts";
import { mediaKeyOf, mediaValueOf, makeMediaPart, MEDIA_KEYS } from "../src/utils/media-part.ts";
import { markRetryable } from "../src/utils/errors.ts";
import { resetModels } from "../src/config/models.ts";

describe("beforeFirst", () => {
  it("cuts at the first separator, and keeps all of the text when there is none", () => {
    expect(beforeFirst("audio/mp3; q=1; x=2", ";")).toBe("audio/mp3");
    expect(beforeFirst("a?b?c", "?")).toBe("a");
    expect(beforeFirst("plain", ";")).toBe("plain");
    expect(beforeFirst("", ";")).toBe("");
    expect(beforeFirst(";x", ";")).toBe("");
  });
});

describe("isRecord", () => {
  it("is true only for a plain object", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const no of [null, undefined, [], [1], "x", 5, true, () => 1]) expect(isRecord(no)).toBe(false);
  });
});

describe("noop", () => {
  it("does nothing and returns nothing, and can swallow a rejection", async () => {
    expect(noop()).toBeUndefined();
    await expect(Promise.reject(new Error("x")).catch(noop)).resolves.toBeUndefined();
  });
});

describe("media parts", () => {
  it("mediaKeyOf reads only `type`, so it is safe for untrusted data", () => {
    expect(mediaKeyOf({ type: "image", image: "x" })).toBe("image");
    expect(mediaKeyOf({ type: "file" })).toBe("file"); // a saved part with no payload still has a key
    for (const no of [null, undefined, 5, "image", [], {}, { type: "text" }, { type: 7 }, { type: "IMAGE" }]) {
      expect(mediaKeyOf(no)).toBeUndefined();
    }
    expect([...MEDIA_KEYS]).toEqual(["image", "audio", "video", "file"]);
  });

  it("mediaValueOf gives the payload of each kind", () => {
    const bytes = new Uint8Array([1]);
    expect(mediaValueOf({ type: "image", image: "i" })).toBe("i");
    expect(mediaValueOf({ type: "audio", audio: bytes })).toBe(bytes);
    expect(mediaValueOf({ type: "video", video: "v" })).toBe("v");
    expect(mediaValueOf({ type: "file", file: "f" })).toBe("f");
  });

  it("makeMediaPart builds each kind with only the extras that kind supports", () => {
    expect(makeMediaPart("image", "d", { mimeType: "image/png", resolution: "high", filename: "x.png" })).toEqual({
      type: "image",
      image: "d",
      mimeType: "image/png",
      resolution: "high",
    });
    expect(makeMediaPart("audio", "d", { mimeType: "audio/mp3", resolution: "high" })).toEqual({
      type: "audio",
      audio: "d",
      mimeType: "audio/mp3",
    });
    expect(makeMediaPart("video", "d", { resolution: "low" })).toEqual({ type: "video", video: "d", resolution: "low" });
    expect(makeMediaPart("file", "d", { mimeType: "application/pdf", filename: "a.pdf" })).toEqual({
      type: "file",
      file: "d",
      mimeType: "application/pdf",
      filename: "a.pdf",
    });
    expect(makeMediaPart("file", "d")).toEqual({ type: "file", file: "d" });
  });
});

describe("markRetryable", () => {
  it("sets both flags the retry layers read", () => {
    const err = new Error("x");
    markRetryable(err);
    expect(Reflect.get(err, "retryable")).toBe(true);
    expect(Reflect.get(err, "transient")).toBe(true);
  });

  it("works on an SDK error whose `retryable` starts false", () => {
    const err = new ProviderError("p", { retryable: false });
    markRetryable(err);
    expect(err.retryable).toBe(true);
  });
});

describe("Agent.fromEnv", () => {
  it("is a real static method: an explicit model wins, else the program's default is used", () => {
    setModels({
      default: { model: "google/gemini-3.5-flash-lite", sub_agent_model: "google/gemini-3.5-flash-lite" },
      providers: { google: { models: ["gemini-3.5-flash-lite"] } },
    });
    try {
      expect(typeof Agent.fromEnv).toBe("function");
      expect(Agent.fromEnv({ instructions: "x" }).modelStringOrSpec).toBe("google/gemini-3.5-flash-lite");
      expect(Agent.fromEnv({ model: "google/gemini-3.5-flash-lite" }).modelStringOrSpec).toBe("google/gemini-3.5-flash-lite");
    } finally {
      resetModels();
    }
  });

  it("with no model anywhere it builds, and a run fails the same way `new Agent` does", async () => {
    resetModels();
    const guard = (async () => {
      throw new Error("no network call may happen");
    }) as unknown as typeof fetch;
    await expect(Agent.fromEnv({ fetch: guard }).run("hi")).rejects.toThrow(ConfigError);
  });
});
