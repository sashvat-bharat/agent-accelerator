/**
 * The concurrency governor: a FIFO limiter for provider calls. One global limit and one limit per provider; a call waits
 * in line for a slot and releases it exactly once when its response ends, fails, or its stream is cancelled. Off until a
 * limit is set. Waiting is abortable. Pure and dependency-free: the loops reach it through `withProviderSlot`.
 */

/** What the governor limits; every key is optional and unset means unlimited. */
export interface GovernorLimits {
  /** Provider calls in flight at once, across every provider. */
  maxRequests?: number;
  /** Provider calls in flight at once, per provider id (`google`, `openai`, a custom prefix ...). */
  perProvider?: Record<string, number>;
}

interface Waiter {
  provider: string;
  grant: (release: () => void) => void;
  fail: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

// A limit as a usable number (whole, >= 1), else Infinity; in: the Governor constructor, out: its limits.
function limitOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : Infinity;
}

// The error a waiter gets when its signal aborts while it queues; in: acquire, out: a rejection the loops treat as an abort.
function abortError(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  return Object.assign(
    reason instanceof Error ? new Error(reason.message) : new Error("Aborted while waiting for a provider slot"),
    {
      name: "AbortError",
    }
  );
}

/** FIFO limiter: grants slots in arrival order, per provider and overall. */
export class Governor {
  private readonly max: number;
  private readonly per = new Map<string, number>();
  private active = 0;
  private readonly activeBy = new Map<string, number>();
  private readonly queue: Waiter[] = [];

  constructor(limits: GovernorLimits = {}) {
    this.max = limitOf(limits.maxRequests);
    for (const [provider, n] of Object.entries(limits.perProvider ?? {})) this.per.set(provider, limitOf(n));
  }

  /** True when any limit is set (an unlimited governor never queues). */
  get limited(): boolean {
    return this.max !== Infinity || [...this.per.values()].some((n) => n !== Infinity);
  }

  /** Calls running now, overall and per provider. */
  status(): { active: number; waiting: number; byProvider: Record<string, number> } {
    return { active: this.active, waiting: this.queue.length, byProvider: Object.fromEntries(this.activeBy) };
  }

  // True when a call to `provider` may start now; in: acquire and pump, out: a boolean.
  private fits(provider: string): boolean {
    return this.active < this.max && (this.activeBy.get(provider) ?? 0) < (this.per.get(provider) ?? Infinity);
  }

  // Takes the slot for `provider` and returns its release, which does something only the first time; in: acquire and pump, out: the release function.
  private take(provider: string): () => void {
    this.active++;
    this.activeBy.set(provider, (this.activeBy.get(provider) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const n = (this.activeBy.get(provider) ?? 1) - 1;
      if (n <= 0) this.activeBy.delete(provider);
      else this.activeBy.set(provider, n);
      this.pump();
    };
  }

  // Grants slots to waiting calls in arrival order; a waiter blocked only by its own provider's limit does not hold back the others; in: every release, out: grants.
  private pump(): void {
    for (let i = 0; i < this.queue.length && this.active < this.max; ) {
      const w = this.queue[i]!;
      if (!this.fits(w.provider)) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      if (w.onAbort) w.signal?.removeEventListener("abort", w.onAbort);
      w.grant(this.take(w.provider));
    }
  }

  /** Waits in line for a slot of `provider` (at once when there is room) and resolves with its release; rejects with an `AbortError` when `signal` aborts first. */
  acquire(provider: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.fits(provider)) return Promise.resolve(this.take(provider));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { provider, grant: resolve, fail: reject, signal };
      waiter.onAbort = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(abortError(signal!));
        this.pump(); // a removed waiter may have been the one holding the line
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }
}

let current = new Governor();

/** Sets the limits for every provider call from now on (unset keys are unlimited); calls already running keep their slots. Internal until the public setting lands. */
export function setGovernorLimits(limits: GovernorLimits = {}): void {
  current = new Governor(limits);
}

/** The governor in use now. */
export function getGovernor(): Governor {
  return current;
}

/**
 * Runs `task` while holding a slot of `provider` and releases it when the task ends, fails or is aborted. With no limit
 * set it just runs the task. The wait for the slot is abortable by `signal` and is NOT part of the task, so request
 * timeouts that start inside `task` begin only after the slot is held.
 */
export async function withProviderSlot<T>(
  provider: string,
  signal: AbortSignal | undefined,
  task: () => Promise<T>
): Promise<T> {
  const governor = current;
  if (!governor.limited) return task();
  const release = await governor.acquire(provider, signal);
  try {
    return await task();
  } finally {
    release();
  }
}
