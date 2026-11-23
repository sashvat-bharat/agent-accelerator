import { describe, it, expect } from "bun:test";
import { Agent, setModels, ProviderError, ConfigError } from "../src/index.ts";
import { beforeFirst } from "../src/utils/text.ts";
import { isRecord } from "../src/utils/guards.ts";
import { noop } from "../src/utils/noop.ts";
import { mediaKeyOf, mediaValueOf, makeMediaPart, MEDIA_KEYS } from "../src/utils/media-part.ts";
import { markRetryable } from "../src/utils/errors.ts";
import { resetModels } from "../src/config/models.ts";
import { abortError, abortErrorFor, isAbortError } from "../src/types/errors.ts";
import { modalityTokens } from "../src/providers/shared.ts";
import { pricePerMillion } from "../src/models/openrouter-list.ts";
import { resolveNetworkTimeouts } from "../src/agent/options.ts";

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

describe("an Agent that leaves out `model`", () => {
  it("uses the program's default model, and an explicit model wins", () => {
    setModels({
      default: { model: "google/gemini-3.5-flash-lite", sub_agent_model: "google/gemini-3.5-flash-lite" },
      providers: { google: { models: ["gemini-3.5-flash-lite"] } },
    });
    try {
      expect(new Agent({ instructions: "x" }).modelStringOrSpec).toBe("google/gemini-3.5-flash-lite");
      expect(new Agent({ model: "google/gemini-3.5-flash-lite" }).modelStringOrSpec).toBe("google/gemini-3.5-flash-lite");
    } finally {
      resetModels();
    }
  });

  it("with no model anywhere it builds, and a run fails with a ConfigError before any request", async () => {
    resetModels();
    const guard = (async () => {
      throw new Error("no network call may happen");
    }) as unknown as typeof fetch;
    await expect(new Agent({ fetch: guard }).run("hi")).rejects.toThrow(ConfigError);
  });

  it("has no `Agent.fromEnv`: leaving out `model` does the same", () => {
    expect("fromEnv" in Agent).toBe(false);
  });
});

describe("abortError and abortErrorFor", () => {
  it("make the error that isAbortError recognizes, with the message", () => {
    const err = abortError("Stream aborted");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AbortError");
    expect(err.message).toBe("Stream aborted");
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(new Error("Stream aborted"))).toBe(false);
  });

  it("take the signal's reason message when it is an error, else the fallback", () => {
    const withError = new AbortController();
    withError.abort(new Error("the user pressed stop"));
    expect(abortErrorFor(withError.signal, "fallback").message).toBe("the user pressed stop");
    const withText = new AbortController();
    withText.abort("plain text");
    const err = abortErrorFor(withText.signal, "Video generation aborted");
    expect(err.message).toBe("Video generation aborted");
    expect(isAbortError(err)).toBe(true);
  });
});

describe("modalityTokens", () => {
  it("adds up the entries of one modality, ignoring case, and says undefined when the list has none", () => {
    const list = [
      { modality: "TEXT", tokens: 10 },
      { modality: "text", tokens: 5 },
      { modality: "image", tokens: 100 },
      { modality: "image" }, // no count: adds 0
    ];
    expect(modalityTokens(list, "text")).toBe(15);
    expect(modalityTokens(list, "IMAGE")).toBe(100);
    expect(modalityTokens(list, "audio")).toBeUndefined();
    expect(modalityTokens(undefined, "text")).toBeUndefined();
    expect(modalityTokens([], "text")).toBeUndefined();
  });
});

describe("pricePerMillion", () => {
  it("turns a per-token price into USD per 1M tokens, and refuses what is not a price", () => {
    expect(pricePerMillion("0.00000008")).toBe(0.08);
    expect(pricePerMillion(0.000003)).toBe(3);
    expect(pricePerMillion("0")).toBe(0);
    for (const bad of ["abc", -1, "-0.5", null, undefined, {}, NaN, Infinity]) expect(pricePerMillion(bad)).toBeUndefined();
  });
});

describe("resolveNetworkTimeouts", () => {
  it("gives the defaults, keeps your numbers, and lets 0 or Infinity turn a timeout off", () => {
    expect(resolveNetworkTimeouts(undefined)).toEqual({ requestTimeoutMs: 300_000, firstByteTimeoutMs: 120_000, streamIdleTimeoutMs: 300_000 });
    expect(resolveNetworkTimeouts({ requestTimeoutMs: 5_000, firstByteTimeoutMs: 0, streamIdleTimeoutMs: Infinity })).toEqual({
      requestTimeoutMs: 5_000,
      firstByteTimeoutMs: 0,
      streamIdleTimeoutMs: Infinity,
    });
  });

  it("falls back to the default for anything that is not a number", () => {
    const out = resolveNetworkTimeouts({ requestTimeoutMs: "fast", firstByteTimeoutMs: NaN, streamIdleTimeoutMs: null });
    expect(out).toEqual({ requestTimeoutMs: 300_000, firstByteTimeoutMs: 120_000, streamIdleTimeoutMs: 300_000 });
  });
});
