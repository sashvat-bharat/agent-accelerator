import type { StreamEvent, AgentResponse } from "../types/response.ts";

/** Listener invoked for a matching stream event type or `*`. */
export type StreamEventListener = (event: StreamEvent) => void;

/** Options for AssistantMessageEventStream (Q-29). */
export interface EventStreamOptions {
  /**
   * When false, `partialText`/`partialThinking` cumulative fields are stripped
   * from events before delivery. Default true for compat (providers attach
   * cumulative partials; consumers like wrapThinking rely on them).
   */
  includePartial?: boolean;
  /** Max buffered events when no iterator is attached. Default 1000. Oldest dropped. */
  maxBufferedEvents?: number;
  /** Max approx bytes for a single delta event. Default 1MB. Oversized dropped. */
  maxEventBytes?: number;
}

type Resolver = {
  resolve: (value: IteratorResult<StreamEvent>) => void;
  reject: (err: Error) => void;
};

/** Default max buffered events (Q-29). */
export const MAX_BUFFERED_EVENTS = 1000;
/** Default max approx bytes per delta event (Q-29). */
export const MAX_EVENT_BYTES = 1_048_576;

function approxEventBytes(event: StreamEvent): number {
  let n = 0;
  if (typeof event.delta === "string") n += event.delta.length;
  if (typeof event.thinkingDelta === "string") n += event.thinkingDelta.length;
  if (typeof event.partialText === "string") n += event.partialText.length;
  if (typeof event.partialThinking === "string") n += event.partialThinking.length;
  return n;
}

function reportStreamAnomaly(detail: unknown): void {
  // why: telemetry hook only, never console — streams are hot paths and
  // logging per-drop would spam and break no-console policy (Q-29/Q-41).
  try {
    (globalThis as unknown as { __agentAccelAnomaly?: (d: unknown) => void }).__agentAccelAnomaly?.(detail);
  } catch {
    // why: anomaly reporting must never break the stream itself.
  }
}

/** Async-iterable event stream returned by Agent.stream and streaming Agent.run. */
export class AssistantMessageEventStream implements AsyncIterable<StreamEvent> {
  private queue: StreamEvent[] = [];
  private resolvers: Resolver[] = [];
  private listeners: Map<string, Set<StreamEventListener>> = new Map();
  private finished = false;
  private error: Error | null = null;
  private cancelled = false;
  private cancelHandlers = new Set<() => void>();
  private finalResultPromise: Promise<AgentResponse>;
  private resolveFinalResult!: (result: AgentResponse) => void;
  private rejectFinalResult!: (err: Error) => void;
  private readonly includePartial: boolean;
  private readonly maxBufferedEvents: number;
  private readonly maxEventBytes: number;
  /** First listener exception captured for inspection (Q-29/Q-41). */
  private listenerError: Error | null = null;
  /** Count of events dropped by bounds (buffer cap / oversize / unbuffered). */
  private droppedEvents = 0;

  /**
   * Creates an empty event stream. `Agent.stream()` creates and completes
   * streams automatically; this constructor is useful for custom adapters.
   *
   * @example
   * ```ts
   * const stream = new AssistantMessageEventStream();
   * stream.on("text_delta", (event) => process.stdout.write(event.delta ?? ""));
   * ```
   */
  constructor(opts?: EventStreamOptions) {
    this.includePartial = opts?.includePartial !== false;
    this.maxBufferedEvents =
      typeof opts?.maxBufferedEvents === "number" && Number.isFinite(opts.maxBufferedEvents) && opts.maxBufferedEvents > 0
        ? Math.floor(opts.maxBufferedEvents)
        : MAX_BUFFERED_EVENTS;
    this.maxEventBytes =
      typeof opts?.maxEventBytes === "number" && Number.isFinite(opts.maxEventBytes) && opts.maxEventBytes > 0
        ? Math.floor(opts.maxEventBytes)
        : MAX_EVENT_BYTES;
    this.finalResultPromise = new Promise<AgentResponse>((resolve, reject) => {
      this.resolveFinalResult = resolve;
      this.rejectFinalResult = reject;
    });
    // Prevent unhandled rejection when no one awaits result()
    this.finalResultPromise.catch(() => {});
  }

  /** First listener exception, if any listener threw (stored, never logged). */
  getListenerError(): Error | null {
    return this.listenerError;
  }

  /** Number of events dropped by Q-29 bounds. */
  getDroppedCount(): number {
    return this.droppedEvents;
  }

  /** Publishes an event to listeners and async iterators. */
  push(event: StreamEvent): void {
    if (this.finished) return;

    // Q-29: 1MB oversize guard — drop oversized deltas (no console).
    if (approxEventBytes(event) > this.maxEventBytes) {
      this.droppedEvents++;
      reportStreamAnomaly({ type: "stream_event_oversize", eventType: event.type });
      return;
    }

    let out: StreamEvent = event;
    if (!this.includePartial && (event.partialText !== undefined || event.partialThinking !== undefined)) {
      out = { ...event };
      delete (out as { partialText?: unknown }).partialText;
      delete (out as { partialThinking?: unknown }).partialThinking;
    }

    if (out.type === "error") {
      this.error = (out.error instanceof Error ? out.error : new Error(String(out.error))) ?? new Error("Unknown error in stream");
      // Single error semantic (Q-29): deliver the error event to listeners,
      // reject result(), mark finished, reject pending iterators, and queue
      // the error event so a late iterator observes it before failing.
      this.deliverToListeners(out);
      try { this.rejectFinalResult(this.error); } catch {
        // why: rejecting an already-settled promise helper must not throw.
      }
      this.finished = true;
      while (this.resolvers.length > 0) {
        const r = this.resolvers.shift()!;
        r.reject(this.error!);
      }
      this.enqueueBounded(out);
      return;
    }

    // Trigger registered event listener callbacks
    this.deliverToListeners(out);

    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver.resolve({ value: out, done: false });
    } else {
      // No waiter right now (typical between `next()` polls of a burst):
      // buffer for the iterator with a hard cap (Q-29). Overflow drops the
      // oldest with an anomaly report — see `enqueueBounded`.
      this.enqueueBounded(out);
    }
  }

  private deliverToListeners(event: StreamEvent): void {
    const specificListeners = this.listeners.get(event.type);
    if (specificListeners) {
      for (const listener of specificListeners) {
        try { listener(event); } catch (e) {
          // why: one bad listener must not break the stream or other
          // listeners; capture the first exception for inspection instead.
          if (!this.listenerError) {
            this.listenerError = e instanceof Error ? e : new Error(String(e));
          }
        }
      }
    }
    const allListeners = this.listeners.get("*");
    if (allListeners) {
      for (const listener of allListeners) {
        try { listener(event); } catch (e) {
          // why: same as above — isolate wildcard-listener failures.
          if (!this.listenerError) {
            this.listenerError = e instanceof Error ? e : new Error(String(e));
          }
        }
      }
    }
  }

  private enqueueBounded(event: StreamEvent): void {
    this.queue.push(event);
    while (this.queue.length > this.maxBufferedEvents) {
      // Drop oldest buffered event to bound memory (Q-29). Error events are
      // never dropped: if the oldest is an error, drop the next-oldest
      // non-error instead; if the queue is all errors, keep them.
      if (this.queue[0]?.type === "error") {
        const idx = this.queue.findIndex((e) => e.type !== "error");
        if (idx === -1) break;
        this.queue.splice(idx, 1);
      } else {
        this.queue.shift();
      }
      this.droppedEvents++;
      reportStreamAnomaly({ type: "stream_buffer_overflow" });
    }
  }

  /** Completes the stream and resolves result() with the final response. */
  end(finalResponse?: AgentResponse): void {
    if (this.finished) return;
    if (!finalResponse) {
      // Q-29: never hang result() — ending without a response is a
      // programming error, so fail loudly instead of leaving consumers
      // waiting forever.
      this.fail(new Error("end() requires response"));
      return;
    }
    this.finished = true;

    this.resolveFinalResult(finalResponse);

    // Flush any waiting resolvers as done
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver.resolve({ value: undefined as unknown as StreamEvent, done: true });
    }
  }

  /** Fails the stream and rejects pending consumers. */
  fail(error: Error): void {
    if (this.finished) return;
    // Delegate to push for unified error handling (listeners + queue + rejection)
    this.push({ type: "error", error } as StreamEvent);
  }

  /** True once cancel() has been called. Background work should stop. */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /** Registers a callback invoked once on cancel(). Returns an unsubscribe fn. */
  onCancel(handler: () => void): () => void {
    if (this.cancelled) {
      try { handler(); } catch {
        // why: a throwing cancel handler must not break the canceller.
      }
      return () => {};
    }
    this.cancelHandlers.add(handler);
    return () => { this.cancelHandlers.delete(handler); };
  }

  /** Cancels the stream: stops background work and rejects result() with AbortError.
   * Safe to call multiple times. Breaking out of for-await calls this automatically. */
  cancel(reason?: unknown): void {
    if (this.finished || this.cancelled) return;
    this.cancelled = true;
    for (const h of [...this.cancelHandlers]) {
      try { h(); } catch {
        // why: isolate faulty cancel handlers so every handler still runs.
      }
    }
    this.cancelHandlers.clear();
    const err = reason instanceof Error ? reason : null;
    const abortErr: Error =
      err && (err.name === "AbortError" || /abort|cancel/i.test(err.message))
        ? err
        : Object.assign(new Error("Stream aborted"), { name: "AbortError" });
    this.fail(abortErr);
  }

  /** Registers a listener for an event type or `*`. */
  on(event: string, listener: StreamEventListener): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  /** Removes a previously registered listener. */
  off(event: string, listener: StreamEventListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  /** Resolves when the stream finishes with the normalized AgentResponse. */
  result(): Promise<AgentResponse> {
    return this.finalResultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    let iteratorDone = false;
    return {
      return: (): Promise<IteratorResult<StreamEvent>> => {
        if (!iteratorDone) {
          iteratorDone = true;
          this.cancel();
        }
        return Promise.resolve({ value: undefined as unknown as StreamEvent, done: true });
      },
      throw: (err?: unknown): Promise<IteratorResult<StreamEvent>> => {
        if (!iteratorDone) {
          iteratorDone = true;
          this.cancel(err);
        }
        return Promise.reject(err);
      },
      next: (): Promise<IteratorResult<StreamEvent>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          // If queued error, deliver the error event first; the NEXT next()
          // call rejects so consumers observe the event before the failure.
          if (value.type === "error" && this.error) {
            return Promise.resolve({ value, done: false });
          }
          return Promise.resolve({ value, done: false });
        }

        if (this.finished) {
          if (this.error) {
            return Promise.reject(this.error);
          }
          return Promise.resolve({ value: undefined as unknown as StreamEvent, done: true });
        }

        return new Promise<IteratorResult<StreamEvent>>((resolve, reject) => {
          this.resolvers.push({ resolve, reject });
        });
      },
    };
  }
}
