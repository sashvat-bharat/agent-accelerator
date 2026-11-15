/**
 * The concurrency governor: a FIFO limiter for provider calls. One global limit and one limit per provider; a call waits
 * in line for a slot and releases it exactly once when its response ends, fails, or its stream is cancelled. Off until a
 * limit is set. Waiting is abortable. A rate-limit answer (429 with a Retry-After) pauses that provider's queue until the wait
 * has passed. The loops reach it through `withProviderSlot`.
 */
import { readRetryAfterMs } from "../utils/retry.ts";
import { telemetryBus } from "../telemetry.ts";

// A one-line problem with a `concurrency` setting, or undefined when it is valid; in: configure(), out: its ConfigError.
export function checkConcurrencyConfig(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return "expected an object like { maxRequests: 8, perProvider: { google: 4 } }";
  const r = raw as Record<string, unknown>;
  const whole = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 1;
  for (const k of Object.keys(r)) {
    if (k !== "maxRequests" && k !== "perProvider") return `unknown key "${k}" (use maxRequests or perProvider)`;
  }
  if (r["maxRequests"] !== undefined && !whole(r["maxRequests"])) return "maxRequests must be a whole number >= 1";
  const per = r["perProvider"];
  if (per !== undefined) {
    if (!per || typeof per !== "object" || Array.isArray(per))
      return "perProvider must be an object like { google: 4 }";
    for (const [name, n] of Object.entries(per))
      if (!whole(n)) return `perProvider.${name} must be a whole number >= 1`;
  }
  return undefined;
}

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

/** The clock the governor reads; tests pass a fake one. `later` schedules `fn` after `ms` and returns its canceller. */
export interface GovernorClock {
  now(): number;
  later(fn: () => void, ms: number): () => void;
}

const realClock: GovernorClock = {
  now: () => Date.now(),
  later: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    (timer as { unref?: () => void }).unref?.(); // a pause never keeps the process alive
    return () => clearTimeout(timer);
  },
};

/** Longest a provider is paused for one rate-limit answer (the same 60 s cap as the retry layer). */
export const MAX_PAUSE_MS = 60_000;

/** FIFO limiter: grants slots in arrival order, per provider and overall. */
export class Governor {
  private readonly max: number;
  private readonly per = new Map<string, number>();
  private active = 0;
  private readonly activeBy = new Map<string, number>();
  private readonly queue: Waiter[] = [];
  /** Provider id -> time (clock ms) until which no new call may start. */
  private readonly pausedUntil = new Map<string, number>();
  private readonly wake = new Map<string, () => void>();

  constructor(
    limits: GovernorLimits = {},
    private readonly clock: GovernorClock = realClock
  ) {
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

  /** Stops new calls to `provider` from starting for `ms` (never shortens an earlier pause); calls already running are not touched. In: a 429 with a Retry-After, out: the queue resumes by itself. */
  pause(provider: string, ms: number): void {
    if (!(Number.isFinite(ms) && ms > 0)) return;
    const until = this.clock.now() + Math.min(ms, MAX_PAUSE_MS);
    if (until <= (this.pausedUntil.get(provider) ?? 0)) return;
    this.pausedUntil.set(provider, until);
    telemetryBus.emit({
      code: "concurrency.paused",
      message: `[Agent Accelerator] ${provider} answered 429: no new calls to it for ${until - this.clock.now()} ms.`,
      level: "warn",
      data: { provider, ms: until - this.clock.now(), waiting: this.queue.length },
    });
    this.wake.get(provider)?.();
    this.wake.set(
      provider,
      this.clock.later(() => {
        this.wake.delete(provider);
        this.pump();
      }, until - this.clock.now())
    );
  }

  /** The providers that are paused right now. */
  pausedProviders(): string[] {
    return [...this.pausedUntil.keys()].filter((p) => this.isPaused(p));
  }

  /** Cancels the pending wake-ups (the governor was replaced). */
  dispose(): void {
    for (const cancel of this.wake.values()) cancel();
    this.wake.clear();
  }

  /** True while `provider` is paused by a rate-limit answer. */
  isPaused(provider: string): boolean {
    const until = this.pausedUntil.get(provider);
    if (until === undefined) return false;
    if (this.clock.now() < until) return true;
    this.pausedUntil.delete(provider);
    return false;
  }

  // True when a call to `provider` may start now; in: acquire and pump, out: a boolean.
  private fits(provider: string): boolean {
    return (
      !this.isPaused(provider) &&
      this.active < this.max &&
      (this.activeBy.get(provider) ?? 0) < (this.per.get(provider) ?? Infinity)
    );
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
      telemetryBus.emit({
        code: "concurrency.queued",
        message: `[Agent Accelerator] a ${provider} call waits for a free slot (${this.queue.length} waiting, ${this.active} running).`,
        data: { provider, waiting: this.queue.length, active: this.active, paused: this.isPaused(provider) },
      });
    });
  }
}

// The wait a rate-limit error asks for (HTTP 429 with a Retry-After), else undefined; in: withProviderSlot, out: Governor.pause.
function rateLimitWaitMs(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  if (!e || (e.status ?? e.statusCode) !== 429) return undefined;
  return readRetryAfterMs(err);
}

let current = new Governor();

/** Sets the limits for every provider call from now on (unset keys are unlimited); calls already running keep their slots. Internal until the public setting lands. */
export function setGovernorLimits(limits: GovernorLimits = {}, clock?: GovernorClock): void {
  current.dispose();
  current = new Governor(limits, clock);
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
  } catch (err) {
    const wait = rateLimitWaitMs(err);
    if (wait !== undefined) governor.pause(provider, wait); // the provider said "too many requests, wait": nobody queued behind sends another now
    throw err;
  } finally {
    release();
  }
}

/** What the concurrency limit is doing right now: whether limits are set, calls running and waiting (overall and per provider), and the providers paused after a 429. */
export function getConcurrencyStatus(): {
  limited: boolean;
  active: number;
  waiting: number;
  byProvider: Record<string, number>;
  paused: string[];
} {
  return { limited: current.limited, ...current.status(), paused: current.pausedProviders() };
}
