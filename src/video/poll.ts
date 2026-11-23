/**
 * The poll loop of a provider that makes videos as jobs (OpenRouter): ask how far the job is, wait, ask again, until it is done,
 * the deadline passes or the call is aborted. One loop for every such adapter, so the rules are the same everywhere: a job that
 * is still running when the call ends (a timeout or an abort) stays at the provider and may keep billing, so every error that
 * leaves the loop carries the job's id (`error.jobId`) for the caller to look it up or ask for it again.
 */
import { TimeoutError, abortErrorFor } from "../types/errors.ts";

import { sleep } from "../utils/retry.ts";
import type { VideoProgress } from "../types/video.ts";

/** One answer of a poll: finished with a value, or still going. */
export type PollAnswer<T> = { done: true; value: T } | { done: false; status: string; progress?: number };

// Puts the job id on an error without changing its type or message; in: pollJob's exits, out: the same error.
function withJobId<E>(err: E, jobId: string): E {
  if (err && typeof err === "object" && (err as { jobId?: unknown }).jobId === undefined)
    Object.defineProperty(err, "jobId", { value: jobId, enumerable: false, configurable: true, writable: true });
  return err;
}

/**
 * Polls `poll` every `intervalMs` until it answers `done`, and returns its value. Throws a `TimeoutError` after `deadlineMs`
 * (`Infinity` = never), an `AbortError` as soon as `signal` aborts, and whatever `poll` throws; every one carries `jobId`.
 * `onProgress` hears each "not done yet" answer (a throwing listener never stops the loop). The first poll is made at once.
 */
export async function pollJob<T>(args: {
  jobId: string;
  poll: () => Promise<PollAnswer<T>>;
  intervalMs: number;
  deadlineMs: number;
  signal: AbortSignal;
  onProgress?: (progress: VideoProgress) => void;
  /** What the job is called in messages, e.g. `OpenRouter video job`. */
  what: string;
}): Promise<T> {
  const { jobId, poll, intervalMs, deadlineMs, signal, onProgress, what } = args;
  const started = Date.now();
  for (;;) {
    if (signal.aborted) throw withJobId(abortErrorFor(signal, `${what} ${jobId} aborted`), jobId);
    let answer: PollAnswer<T>;
    try {
      answer = await poll();
    } catch (err) {
      throw withJobId(err, jobId);
    }
    if (answer.done) return answer.value;
    try {
      onProgress?.({
        status: answer.status,
        ...(answer.progress !== undefined ? { progress: answer.progress } : {}),
        jobId,
      });
    } catch {
      // why: a progress listener must never stop a paid job
    }
    const left = deadlineMs - (Date.now() - started);
    if (left <= 0)
      throw withJobId(
        new TimeoutError(
          `[Agent Accelerator] ${what} ${jobId} was still ${answer.status} after ${deadlineMs} ms; it was left running at the provider (job id ${jobId}).`
        ),
        jobId
      );
    try {
      await sleep(Math.min(intervalMs, left), signal);
    } catch (err) {
      throw withJobId(err, jobId);
    }
  }
}
