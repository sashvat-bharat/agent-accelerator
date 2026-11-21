import { describe, it, expect } from "bun:test";
import { pollJob, type PollAnswer } from "../src/video/poll.ts";
import { TimeoutError } from "../src/types/errors.ts";
import type { VideoProgress } from "../src/types/video.ts";

const base = { jobId: "gen-vid-1-abc", intervalMs: 5, deadlineMs: 2000, what: "OpenRouter video job" };

// A poll that says "not done" `n` times (with the given statuses), then returns `value`.
function script<T>(value: T, statuses: Array<{ status: string; progress?: number }>) {
  let calls = 0;
  const poll = async (): Promise<PollAnswer<T>> => {
    const s = statuses[calls++];
    return s ? { done: false, ...s } : { done: true, value };
  };
  return { poll, calls: () => calls };
}

describe("pollJob", () => {
  it("polls at once, then every interval, until the job is done, and reports each step", async () => {
    const s = script("video", [{ status: "pending" }, { status: "in_progress", progress: 40.5 }, { status: "in_progress", progress: 90 }]);
    const seen: VideoProgress[] = [];
    const value = await pollJob({ ...base, poll: s.poll, signal: new AbortController().signal, onProgress: (p) => seen.push(p) });
    expect(value).toBe("video");
    expect(s.calls()).toBe(4);
    expect(seen).toEqual([
      { status: "pending", jobId: "gen-vid-1-abc" },
      { status: "in_progress", progress: 40.5, jobId: "gen-vid-1-abc" },
      { status: "in_progress", progress: 90, jobId: "gen-vid-1-abc" },
    ]);
  });

  it("a job that is done at the first poll never waits", async () => {
    const s = script(1, []);
    const t = Date.now();
    expect(await pollJob({ ...base, intervalMs: 5000, poll: s.poll, signal: new AbortController().signal })).toBe(1);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it("past the deadline it throws a TimeoutError that carries the job id and says the job was left running", async () => {
    const poll = async (): Promise<PollAnswer<string>> => ({ done: false, status: "in_progress" });
    const err = await pollJob({ ...base, deadlineMs: 30, poll, signal: new AbortController().signal }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.jobId).toBe("gen-vid-1-abc");
    expect(err.message).toContain("left running at the provider");
    expect(err.message).toContain("gen-vid-1-abc");
    expect(err.message).not.toContain("\n");
  });

  it("an abort during the wait throws an AbortError with the job id, at once", async () => {
    const ctl = new AbortController();
    const poll = async (): Promise<PollAnswer<string>> => ({ done: false, status: "pending" });
    setTimeout(() => ctl.abort(new Error("user pressed stop")), 15);
    const t = Date.now();
    const err = await pollJob({ ...base, intervalMs: 10_000, poll, signal: ctl.signal }).catch((e) => e);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(err.name).toBe("AbortError");
    expect(err.jobId).toBe("gen-vid-1-abc");
  });

  it("an already aborted signal never polls", async () => {
    const ctl = new AbortController();
    ctl.abort();
    let polled = 0;
    const err = await pollJob({ ...base, poll: async () => (polled++, { done: true, value: 1 }), signal: ctl.signal }).catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(polled).toBe(0);
  });

  it("an error from the poll keeps its type and gets the job id", async () => {
    const boom = Object.assign(new Error("HTTP 500"), { status: 500 });
    const err: Error & { jobId?: string } = await pollJob<string>({
      ...base,
      poll: async () => Promise.reject(boom),
      signal: new AbortController().signal,
    }).catch((e) => e);
    expect(err).toBe(boom);
    expect(err.jobId).toBe("gen-vid-1-abc");
    expect(Object.keys(err)).not.toContain("jobId"); // not enumerable: logs and JSON stay as they were
  });

  it("a throwing progress listener never stops the job", async () => {
    const s = script("ok", [{ status: "pending" }]);
    const value = await pollJob({ ...base, poll: s.poll, signal: new AbortController().signal, onProgress: () => { throw new Error("listener bug"); } });
    expect(value).toBe("ok");
  });

  it("deadline Infinity means no deadline", async () => {
    const s = script("ok", [{ status: "a" }, { status: "b" }, { status: "c" }]);
    expect(await pollJob({ ...base, deadlineMs: Infinity, poll: s.poll, signal: new AbortController().signal })).toBe("ok");
  });
});
