import type { StreamEvent, AgentResponse } from "../types/response.ts";

export type StreamEventListener = (event: StreamEvent) => void;

type Resolver = {
  resolve: (value: IteratorResult<StreamEvent>) => void;
  reject: (err: Error) => void;
};

export class AssistantMessageEventStream implements AsyncIterable<StreamEvent> {
  private queue: StreamEvent[] = [];
  private resolvers: Resolver[] = [];
  private listeners: Map<string, Set<StreamEventListener>> = new Map();
  private finished = false;
  private error: Error | null = null;
  private finalResultPromise: Promise<AgentResponse>;
  private resolveFinalResult!: (result: AgentResponse) => void;
  private rejectFinalResult!: (err: Error) => void;

  constructor() {
    this.finalResultPromise = new Promise<AgentResponse>((resolve, reject) => {
      this.resolveFinalResult = resolve;
      this.rejectFinalResult = reject;
    });
    // Prevent unhandled rejection when no one awaits result()
    this.finalResultPromise.catch(() => {});
  }

  push(event: StreamEvent): void {
    if (this.finished) return;

    if (event.type === "error") {
      this.error = (event.error instanceof Error ? event.error : new Error(String(event.error))) ?? new Error("Unknown error in stream");
      // Reject final result but don't finish iterator yet — let iterators receive error event then fail
      // Still deliver error event to listeners/consumers before marking finished? Keep consistent with pi: error terminates stream
      try { this.rejectFinalResult(this.error); } catch {}
    }

    // Trigger registered event listener callbacks
    const specificListeners = this.listeners.get(event.type);
    if (specificListeners) {
      for (const listener of specificListeners) {
        try { listener(event); } catch {}
      }
    }
    const allListeners = this.listeners.get("*");
    if (allListeners) {
      for (const listener of allListeners) {
        try { listener(event); } catch {}
      }
    }

    if (event.type === "error") {
      // Mark finished after delivering error event, reject pending resolvers
      this.finished = true;
      while (this.resolvers.length > 0) {
        const r = this.resolvers.shift()!;
        // First deliver error event if they were waiting, then reject next call
        // For simplicity, reject immediately — consumer will see error via result() or next()
        r.reject(this.error!);
      }
      // Also queue error event for later pulls if no resolver
      if (this.queue.length === 0) this.queue.push(event);
      else this.queue.push(event);
      return;
    }

    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver.resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(finalResponse?: AgentResponse): void {
    if (this.finished) return;
    this.finished = true;

    if (finalResponse) {
      this.resolveFinalResult(finalResponse);
    } else {
      // Resolve with empty if no response — should not happen, but prevent hanging
      // Do not reject; just finish
    }

    // Flush any waiting resolvers as done
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver.resolve({ value: undefined as any, done: true });
    }
  }

  fail(error: Error): void {
    if (this.finished) return;
    // Delegate to push for unified error handling (listeners + queue + rejection)
    this.push({ type: "error", error } as StreamEvent);
  }

  on(event: string, listener: StreamEventListener): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  off(event: string, listener: StreamEventListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  result(): Promise<AgentResponse> {
    return this.finalResultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: (): Promise<IteratorResult<StreamEvent>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          // If queued error, next call should reject, but deliver error event first?
          // Deliver error event then on next call reject
          if (value.type === "error" && this.error) {
            // Return error event as value, next next() will reject
            return Promise.resolve({ value, done: false });
          }
          return Promise.resolve({ value, done: false });
        }

        if (this.finished) {
          if (this.error) {
            return Promise.reject(this.error);
          }
          return Promise.resolve({ value: undefined as any, done: true });
        }

        return new Promise<IteratorResult<StreamEvent>>((resolve, reject) => {
          this.resolvers.push({ resolve, reject });
        });
      },
    };
  }
}
