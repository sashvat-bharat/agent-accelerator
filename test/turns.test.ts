import { describe, it, expect } from "bun:test";
import { finishedTurns, historyUpTo } from "../src/agent/turns.ts";
import type { Message } from "../src/types/message.ts";
import type { SessionRunMark } from "../src/session/store.ts";
import { ValidationError } from "../src/types/errors.ts";

const user = (text: string): Message => ({ role: "user", content: text });
const assistant = (text: string): Message => ({ role: "assistant", content: text });

// Three runs: done, failed (prompt without an answer), done; plus a fourth that is still running.
const messages: Message[] = [user("one"), assistant("A1"), user("two"), user("three"), assistant("A3"), user("four")];
const marks: SessionRunMark[] = [
  { id: "r1", i: 0, at: 1, end: "done" },
  { id: "r2", i: 2, at: 2, end: "failed" },
  { id: "r3", i: 3, at: 3, end: "done" },
  { id: "r4", i: 5, at: 4 },
];

describe("finishedTurns", () => {
  it("lists only finished runs, numbered from 1, with their message range", () => {
    expect(finishedTurns(messages, marks)).toEqual([
      { n: 1, prompt: "one", from: 0, to: 2 },
      { n: 2, prompt: "three", from: 3, to: 5 },
    ]);
  });

  it("counts a run that ended with a tool stop, never the running one", () => {
    const stopped: SessionRunMark[] = [{ id: "r1", i: 0, at: 1, end: "stopped" }, { id: "r2", i: 2, at: 2 }];
    expect(finishedTurns(messages.slice(0, 3), stopped).map((t) => t.n)).toEqual([1]);
  });

  it("gives no turns without run marks, ignores marks past the history, and previews multipart prompts", () => {
    expect(finishedTurns(messages, [])).toEqual([]);
    expect(finishedTurns(messages, [{ id: "x", i: 99, at: 1, end: "done" }])).toEqual([]);
    const parts: Message[] = [{ role: "user", content: [{ type: "text", text: "see image" }, { type: "image", image: "x.png" }] }, assistant("ok")];
    expect(finishedTurns(parts, [{ id: "p", i: 0, at: 1, end: "done" }])[0]!.prompt).toBe("see image");
  });

  it("truncates a long prompt preview", () => {
    const long: Message[] = [user("x".repeat(1000)), assistant("ok")];
    expect(finishedTurns(long, [{ id: "p", i: 0, at: 1, end: "done" }])[0]!.prompt.length).toBe(200);
  });
});

describe("historyUpTo", () => {
  it("copies whole finished turns, leaving out failed runs and the running turn", () => {
    expect(historyUpTo(messages, marks, 1).map((m) => m.content)).toEqual(["one", "A1"]);
    expect(historyUpTo(messages, marks, 2).map((m) => m.content)).toEqual(["one", "A1", "three", "A3"]);
  });

  it("keeps messages that come before the first run mark", () => {
    const withHead = [user("imported"), assistant("old"), ...messages];
    const shifted = marks.map((m) => ({ ...m, i: m.i + 2 }));
    expect(historyUpTo(withHead, shifted, 1).map((m) => m.content)).toEqual(["imported", "old", "one", "A1"]);
  });

  it("returns an empty history for 0 and rejects numbers out of range", () => {
    expect(historyUpTo(messages, marks, 0)).toEqual([]);
    for (const bad of [3, -1, 1.5, Number.NaN]) {
      expect(() => historyUpTo(messages, marks, bad)).toThrow(ValidationError);
    }
    expect(() => historyUpTo(messages, marks, 3)).toThrow("from 1 to 2");
  });

  it("returns an independent copy, media bytes included", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const media: Message[] = [{ role: "user", content: [{ type: "image", image: bytes }] }, assistant("seen")];
    const copy = historyUpTo(media, [{ id: "m", i: 0, at: 1, end: "done" }], 1);
    expect(copy).toEqual(media);
    expect(copy[0]).not.toBe(media[0]);
    ((copy[0]!.content as any)[0].image as Uint8Array)[0] = 9;
    expect(bytes[0]).toBe(1);
  });
});
