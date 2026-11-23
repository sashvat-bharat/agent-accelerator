/**
 * Mid-session control of one Agent: the run that is active now, the follow-ups waiting behind it, and what happens when
 * a new prompt arrives while busy (`steer`, `queue`, `interrupt`). `Agent` keeps the public methods and calls into this
 * class; the class only needs the few things in {@link RunHost}.
 */
import type { AgentRunOptions, MidSessionConfig } from "../types/agent.ts";
import { noop } from "../utils/noop.ts";
import type { ContentPart } from "../types/message.ts";
import type { AgentResponse, StreamEvent } from "../types/response.ts";
import type { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { ValidationError, abortError } from "../types/errors.ts";
import type { SteerEntry } from "./loop.ts";

/** The run that is active right now. */
interface ActiveRun {
  steerInbox: SteerEntry[];
  outerStream?: AssistantMessageEventStream;
  runPromise?: Promise<AgentResponse>;
  abortController: AbortController;
}

/** A prompt waiting for the active run to finish. */
export interface QueuedPrompt {
  prompt: string | ContentPart[];
  options?: AgentRunOptions;
  isStream: boolean;
  deferredStream?: AssistantMessageEventStream;
  resolve: (res: AgentResponse) => void;
  reject: (err: unknown) => void;
  /** Put here by `interrupt(message)`: runs before every other waiting prompt. */
  urgent?: boolean;
}

/** What the run control needs from its Agent. */
interface RunHost {
  persistNow(): void;
  run(prompt: string | ContentPart[], options?: AgentRunOptions): Promise<AgentResponse>;
  startNonStreamingRun(prompt: string | ContentPart[], options?: AgentRunOptions): Promise<AgentResponse>;
  startStreamingRun(prompt: string | ContentPart[], options?: AgentRunOptions): AssistantMessageEventStream;
  readonly midSessionConfig: Required<Pick<MidSessionConfig, "mode">> & MidSessionConfig;
  readonly maxSteers: number;
}

// Deferred streams whose events the real run already pipes into them (so their own completion handler must stay out); in: pumpQueue marks, Agent.stream reads.
const pipedStreams = new WeakSet<AssistantMessageEventStream>();

/** True once a queued stream's real run started and pipes its events into it. */
export function isPiped(stream: AssistantMessageEventStream): boolean {
  return pipedStreams.has(stream);
}

/** The active run and the waiting queue of one Agent. */
export class RunControl {
  /** The run in flight, or null when idle. */
  current: ActiveRun | null = null;
  /** Prompts waiting behind it (urgent ones first). */
  readonly queue: QueuedPrompt[] = [];

  constructor(private readonly host: RunHost) {}

  /** Throws when the steer inbox is at its bound. */
  assertSteerRoom(inbox: SteerEntry[]): void {
    const max = this.host.maxSteers ?? 20;
    if (inbox.length >= max) {
      throw new ValidationError(
        `[Agent Accelerator] Steer inbox is full (${inbox.length}/${max}). Wait for the active run to drain or increase midSession.maxSteers.`
      );
    }
  }

  // Picks steer or queue for a call that arrives while busy: the developer's enforced midSession mode wins over the per-call request; in: run()/stream() `enqueue`, out: their busy branch.
  resolveEnqueueMode(requested?: "steer" | "queue"): "steer" | "queue" {
    const enforced = this.host.midSessionConfig.mode;
    if (enforced === "steer" || enforced === "queue") return enforced;
    return requested === "steer" ? "steer" : "queue";
  }

  // Aborts the active run (provider request, tools, workers, stream) through its own controller; no-op when idle; in: interrupt and queueUrgent, out: the run settles as AbortError.
  abortActive(reason?: Error): void {
    const active = this.current;
    if (!active) return;
    try {
      active.abortController.abort(reason ?? new Error("Agent interrupted"));
    } catch {
      // why: cancelling or releasing something that is already closed is harmless.
    }
    try {
      active.outerStream?.cancel(reason);
    } catch {
      // why: cancelling or releasing something that is already closed is harmless.
    }
  }

  // Puts a prompt ahead of everything waiting (behind earlier interrupts) and aborts the active run, so it starts as soon as that run has settled; ignores midSession mode and maxQueued; in: run()/stream() with enqueue "interrupt", out: pendingQueue + the abort.
  queueUrgent(entry: QueuedPrompt): void {
    entry.urgent = true;
    const firstOrdinary = this.queue.findIndex((e) => !e.urgent);
    this.queue.splice(firstOrdinary < 0 ? this.queue.length : firstOrdinary, 0, entry);
    this.host.persistNow();
    this.abortActive();
  }

  /**
   * Buffers a steer prompt into the active run and returns a promise for ITS
   * reply: the active run's response when the prompt is injected, or (if the
   * run ends first and the prompt becomes a queued follow-up) the follow-up
   * run's response, so a late steer's answer is never lost.
   */
  steerInto(active: ActiveRun, prompt: string | ContentPart[], options?: AgentRunOptions): Promise<AgentResponse> {
    this.assertSteerRoom(active.steerInbox);
    const runDone = active.runPromise ?? active.outerStream?.result();
    if (!runDone) return this.host.run(prompt, options) as Promise<AgentResponse>;
    const entry: SteerEntry = { prompt, options };
    const reply = new Promise<AgentResponse>((resolve, reject) => {
      entry.settle = { resolve, reject };
    });
    reply.catch(noop); // a fire-and-forget caller must not trigger an unhandled rejection
    active.steerInbox.push(entry);
    this.host.persistNow();
    runDone.then(
      (res) => {
        if (!entry.settle?.deferredToQueue) entry.settle?.resolve(res);
      },
      (err) => {
        if (!entry.settle?.deferredToQueue) entry.settle?.reject(err);
      }
    );
    return reply;
  }

  // Starts the next waiting prompt (urgent ones first, aborted ones rejected) as a streaming or non-streaming run once the agent is idle; in: finishCurrentRun and queue changes, out: a new run whose result settles the queued caller.
  pumpQueue(): void {
    if (this.current !== null) return;
    const next = this.queue.shift();
    if (!next) return;
    this.host.persistNow();
    // Reject queued items whose signal aborted before start.
    try {
      if ((next.options as { signal?: AbortSignal } | undefined)?.signal?.aborted) {
        const reason = (next.options as { signal?: AbortSignal }).signal?.reason;
        const abortErr = Object.assign(
          reason instanceof Error ? reason : new Error("Queued run aborted before start"),
          { name: "AbortError" }
        );
        try {
          next.reject(abortErr);
        } catch {
          // why: a promise or stream that has already settled cannot be settled twice, and that is fine.
        }
        try {
          next.deferredStream?.fail(abortErr instanceof Error ? abortErr : new Error(String(abortErr)));
        } catch {
          // why: a promise or stream that has already settled cannot be settled twice, and that is fine.
        }
        queueMicrotask(() => this.pumpQueue());
        return;
      }
    } catch {
      // why: a promise or stream that has already settled cannot be settled twice, and that is fine.
    }
    if (next.isStream && next.deferredStream) {
      const deferred = next.deferredStream;
      try {
        const real = this.host.startStreamingRun(next.prompt, next.options);
        pipedStreams.add(deferred);
        const forward = (e: StreamEvent) => {
          try {
            deferred.push(e);
          } catch {
            // why: a promise or stream that has already settled cannot be settled twice, and that is fine.
          }
        };
        real.on("*", forward);
        try {
          deferred.onCancel(() => {
            try {
              real.cancel();
            } catch {
              // why: cancelling or releasing something that is already closed is harmless.
            }
          });
        } catch {
          // why: cancelling or releasing something that is already closed is harmless.
        }
        real.result().then(
          (res) => {
            try {
              next.resolve(res);
            } catch {
              // why: a promise or stream that has already settled cannot be settled twice, and that is fine.
            }
            try {
              deferred.end(res);
            } catch {
              // why: a promise or stream that has already settled cannot be settled twice, and that is fine.
            }
          },
          (err) => {
            try {
              next.reject(err);
            } catch {
              // why: a promise or stream that has already settled cannot be settled twice, and that is fine.
            }
            // Pipe failures into the deferred stream so for-await sees them.
            try {
              deferred.fail(err instanceof Error ? err : new Error(String(err)));
            } catch {
              // why: a promise or stream that has already settled cannot be settled twice, and that is fine.
            }
          }
        );
      } catch (err) {
        try {
          next.reject(err);
        } catch {
          // why: a promise or stream that has already settled cannot be settled twice, and that is fine.
        }
        try {
          deferred.fail(err instanceof Error ? err : new Error(String(err)));
        } catch {
          // why: a promise or stream that has already settled cannot be settled twice, and that is fine.
        }
        // Keep draining even if starting failed.
        queueMicrotask(() => this.pumpQueue());
      }
      return;
    }
    this.host.startNonStreamingRun(next.prompt, next.options).then(next.resolve, next.reject);
  }

  // Ends the active run slot: leftover steers become follow-ups at the FRONT of the queue (behind urgent ones), then the queue is pumped; in: a settled run, out: pendingQueue + persistNow.
  finishCurrentRun(): void {
    // Leftover steer entries become queued follow-ups instead of dropping.
    let leftover: SteerEntry[] = [];
    try {
      leftover = this.current?.steerInbox?.splice(0) ?? [];
    } catch {
      leftover = [];
    }
    this.current = null;
    if (leftover.length > 0) {
      try {
        const max = this.host.midSessionConfig.maxQueued ?? 20;
        // Late steers were typed BEFORE anything already queued: they go to the front, in the order they arrived.
        const lateSteers: QueuedPrompt[] = [];
        for (const entry of leftover) {
          try {
            if ((entry.options as { signal?: AbortSignal } | undefined)?.signal?.aborted) {
              entry.settle?.reject(abortError("Steer aborted before it could run"));
              continue;
            }
          } catch {
            continue;
          }
          if (this.queue.length + lateSteers.length >= max) {
            entry.settle?.reject(
              new ValidationError("[Agent Accelerator] Steer dropped: the follow-up queue is full.")
            );
            continue;
          }
          // The steer was never injected: it now runs as a follow-up, and the
          // caller's promise resolves with that run's response.
          if (entry.settle) entry.settle.deferredToQueue = true;
          lateSteers.push({
            prompt: entry.prompt,
            options: entry.options,
            isStream: false,
            resolve: entry.settle?.resolve ?? noop,
            reject: entry.settle?.reject ?? noop,
          });
        }
        // ...but behind an interrupt(message), which is the newest and most urgent instruction.
        const firstOrdinary = this.queue.findIndex((e) => !e.urgent);
        this.queue.splice(firstOrdinary < 0 ? this.queue.length : firstOrdinary, 0, ...lateSteers);
      } catch {
        // why: this runs while a run is being closed; a failure here must not hide that run's own result.
      }
    }
    this.host.persistNow();
    // Defer pump so the completing run's .then handlers settle first.
    queueMicrotask(() => this.pumpQueue());
  }
}
