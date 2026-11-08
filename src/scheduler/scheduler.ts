/**
 * Scheduled actions: dynamic sub-agents that run later (once or on repeat)
 * and write their answer to a file instead of replying in the chat.
 *
 * One clock per home folder, ticking once a second against the machine's own
 * time. Each tick only asks "what is overdue?", so drift, sleep or a clock
 * change cannot skip a run. The files under `<home>/scheduled/` are the
 * source of truth (see `store.ts`); nothing waits in memory, and the timer is
 * unref'd and runs only while something is pending.
 *
 *   waiting --(deliver - cook time)--> cooking --> ready --(deliver time)--> delivered
 *                                         |                                     |
 *                                         +--> failed (recorded, moves on)      +--> waiting (repeat) | done
 */
import * as os from "node:os";
import type { Agent } from "../agent/agent.ts";
import { createChildSessionId } from "../agent/delegation.ts";
import { buildDynamicWorkerConfig, grantWorkerTools, scheduledRunTimeoutMs } from "../agent/worker.ts";
import { telemetryBus } from "../telemetry.ts";
import { readUsage, usageLine, type UsageTotals } from "../session/usage.ts";
import { processAlive } from "../utils/durable.ts";
import { ConfigError, ValidationError } from "../types/errors.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { AgentResponse } from "../types/response.ts";
import type {
  DeleteResult,
  ScheduledActionInput,
  ScheduledActionPatch,
  ScheduledActionRecord,
  ScheduledDelivery,
  ScheduleSpec,
} from "../types/scheduler.ts";
import {
  TASK_ID_PATTERN,
  clearHeartbeat,
  createTask,
  deleteTask,
  findRunFile,
  readDeliveries,
  readHeartbeat,
  readRun,
  readTask,
  readTasks,
  removeTaskFolder,
  resolveHome,
  runPath,
  touchHeartbeat,
  updateDeliveries,
  updateTask,
  validateDelivery,
  validateRecord,
  writeHeartbeat,
  writeRunFile,
  type PendingDelivery,
  type RunHeader,
} from "./store.ts";
import {
  assertCookShorterThanRepeat,
  cookTime,
  durationMs,
  nextAfter,
  nextOccurrence,
  parseLocalIso,
  resolveDelivery,
  toLocalIso,
} from "./time.ts";

/** Default lead time (10 minutes) when the developer API omits `startCookingInAdvance`. */
const DEFAULT_COOK_LEAD = "00:00:10";
const SLUG_MAX = 48;
/** A heartbeat older than this means its owner is gone (it is refreshed every 5 s). */
const HEARTBEAT_STALE_MS = 60_000;
const HEARTBEAT_EVERY_MS = 5_000;
/** How often a live process looks for runs whose owner process died. */
const DEAD_SWEEP_EVERY_MS = 15_000;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Optional `{ home }` accepted by every public function except `createScheduledAction` (the agent knows its home). */
export interface HomeOptions {
  home?: string;
}

type PoolTools = Record<string, ToolDefinition>;
type Outcome = ({ res: AgentResponse } | { error: string }) & { usage?: UsageTotals };
interface RunningEntry {
  /** Aborted by `delete`; every attempt of the run listens to it. */
  controller: AbortController;
  done: Promise<void>;
  deleted: boolean;
  /** Started by `run_now` or `onMissed: "run"`: due when it finishes. */
  manual: boolean;
  /** A manual run that replaces a missed occurrence: always `late`. A plain `run_now` is never late. */
  missed: boolean;
}

// The message of any thrown value; in: catch blocks here, out: event and error text.
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// A run's exact spending as run-header fields, the numbers `usageReport()` keeps for workers (tokens split, cache hit rate, cost and where the price came from); in: the one-shot worker's totals over all attempts, out: finish's RunHeader.
function usageFields(totals: UsageTotals | undefined): Partial<RunHeader> {
  if (!totals || totals.turns === 0) return {};
  const u = usageLine(totals);
  return {
    turns: u.turns,
    tokens: u.tokens.total,
    inputTokens: u.tokens.input,
    freshInputTokens: u.tokens.freshInput,
    cacheReadTokens: u.tokens.cacheRead,
    cacheWriteTokens: u.tokens.cacheWrite,
    outputTokens: u.tokens.output,
    thinkingTokens: u.tokens.thinking,
    ...(u.cacheHitRate !== null ? { cacheHitRate: Math.round(u.cacheHitRate * 10_000) / 10_000 } : {}),
    costUsd: u.cost.totalUsd === null ? "unknown" : Number(u.cost.totalUsd.toFixed(6)),
    costSource: u.cost.source,
    ...(u.cost.unpricedTurns > 0 ? { unpricedTurns: u.cost.unpricedTurns } : {}),
  };
}

// Whole seconds since the epoch: stored times have no milliseconds, so lateness is compared at this precision; in: a clock reading or stored time, out: finish and deliver.
const secondOf = (d: Date): number => Math.floor(d.getTime() / 1000);

// Emits one `scheduled_action.<code>` event on the telemetry bus; in: the scheduler and public functions, out: telemetryBus.
function emit(code: string, message: string, data: Record<string, unknown>, level: "info" | "warn" = "info"): void {
  telemetryBus.emit({ code: `scheduled_action.${code}`, message: `[Agent Accelerator] ${message}`, level, data });
}

// The ValidationError for an unknown action id; in: lookups by id, out: a thrown error.
function notFound(id: string): ValidationError {
  return new ValidationError(`No scheduled action with id "${id}".`);
}

// ---------------------------------------------------------------------------
// Validation (collects EVERY problem so the model can fix a call in one go)
// ---------------------------------------------------------------------------

// Runs one validation step and records its message instead of throwing, so one call can report every problem; in: validateInput/checkSchedule, out: the problems list.
function collect(problems: string[], fn: () => void): void {
  try {
    fn();
  } catch (err) {
    problems.push(errText(err));
  }
}

// Throws unless the value is a non-empty string; in: field validation, out: collect.
function requireText(field: string, value: unknown): void {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${field}: required, a non-empty string.`);
}

// Throws unless every requested worker tool name exists in the developer's pool; in: create/update validation, out: collect.
function checkTools(value: unknown, pool: PoolTools): void {
  if (!Array.isArray(value) || value.some((n) => typeof n !== "string")) {
    throw new ValidationError("tools: must be an array of worker tool names, e.g. [\"recent_news\"].");
  }
  const unknown = (value as string[]).filter((n) => Object.keys(grantWorkerTools(pool, [n])).length === 0);
  if (unknown.length > 0) {
    const names = Object.keys(pool);
    throw new ValidationError(
      `tools: unknown worker tool(s) ${unknown.map((n) => `"${n}"`).join(", ")}; ` +
        (names.length > 0 ? `the pool is [${names.join(", ")}].` : "no worker tools are available, omit tools.")
    );
  }
}

/** Schedule rules shared by create (resolve the delivery date) and update (merged fields). */
function checkSchedule(
  sa: Partial<ScheduleSpec>,
  now: Date,
  problems: string[],
  opts: { resolve: boolean; defaultLead: boolean }
): void {
  if (opts.resolve) collect(problems, () => resolveDelivery(now, sa.timeToDeliver, sa.meridiem));
  let cookMs: number | undefined;
  const lead = sa.startCookingInAdvance ?? (opts.defaultLead ? DEFAULT_COOK_LEAD : undefined);
  collect(problems, () => {
    cookMs = durationMs(lead, "scheduled_action.startCookingInAdvance");
  });
  if (sa.repeatEvery !== undefined) {
    collect(problems, () => {
      const repeatMs = durationMs(sa.repeatEvery, "scheduled_action.repeatEvery");
      if (repeatMs === 0) {
        throw new ValidationError('scheduled_action.repeatEvery: must be greater than 00:00:00 (e.g. "01:00:00" = every day).');
      }
      if (cookMs !== undefined) assertCookShorterThanRepeat(cookMs, repeatMs);
    });
  }
  if (sa.retries !== undefined && !(Number.isInteger(sa.retries) && sa.retries >= 0)) {
    problems.push("scheduled_action.retries: must be a whole number >= 0.");
  }
  if (sa.onMissed !== undefined && sa.onMissed !== "skip" && sa.onMissed !== "run") {
    problems.push(`scheduled_action.onMissed: must be "skip" or "run" (omit it to decide later with run_now or skip); got ${JSON.stringify(sa.onMissed)}.`);
  }
}

// Validates role, tools and timeoutMs of a create or update; in: validateInput/updateScheduledAction, out: the problems list.
function checkOptionalFields(input: Pick<ScheduledActionPatch, "role" | "tools" | "timeoutMs">, pool: PoolTools | undefined, problems: string[]): void {
  if (input.role !== undefined && typeof input.role !== "string") problems.push("role: must be a string.");
  if (input.tools !== undefined && pool) collect(problems, () => checkTools(input.tools, pool));
  if (input.timeoutMs !== undefined && !(typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0)) {
    problems.push("timeoutMs: must be a number of milliseconds > 0.");
  }
}

/**
 * Every problem with a `create` input, or `[]` when it is valid. The LLM tool
 * passes `requireLead` (the model must state `startCookingInAdvance`); the
 * developer API defaults it to 10 minutes.
 */
export function validateInput(
  input: ScheduledActionInput,
  pool: PoolTools,
  now: Date,
  opts: { requireLead?: boolean } = {}
): string[] {
  const problems: string[] = [];
  const sa: Partial<ScheduledActionInput["scheduled_action"]> = input?.scheduled_action ?? {};
  collect(problems, () => requireText("instructions", input?.instructions));
  collect(problems, () => requireText("task", input?.task));
  checkOptionalFields(input ?? {}, pool, problems);
  collect(problems, () => requireText("scheduled_action.name", sa.name));
  if (typeof sa.id !== "string" || sa.id.length > SLUG_MAX || !TASK_ID_PATTERN.test(sa.id)) {
    problems.push(
      `scheduled_action.id: lowercase kebab-case, at most ${SLUG_MAX} characters (e.g. "check-portfolio-returns"); got ${JSON.stringify(sa.id)}.`
    );
  }
  checkSchedule(sa, now, problems, { resolve: true, defaultLead: !opts.requireLead });
  return problems;
}

// Joins validation problems into one numbered ValidationError message; in: create/update failures, out: the error text.
const joinProblems = (what: string, problems: string[]): string =>
  `${what} (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.map((p, i) => `(${i + 1}) ${p}`).join(" ")}`;

// Six random lowercase/digit characters appended to an action id; in: createScheduledAction, out: the unique id suffix.
function randomSuffix(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ID_ALPHABET.charAt(b % ID_ALPHABET.length)).join("");
}

// ---------------------------------------------------------------------------
// Scheduler (one per home folder)
// ---------------------------------------------------------------------------

export class Scheduler {
  /** Live agents that may run actions, by name (latest registration wins). */
  readonly agents = new Map<string, WeakRef<Agent>>();
  /** Runs in flight, by action id. */
  readonly running = new Map<string, RunningEntry>();
  /** Injectable for tests. */
  now: () => Date = () => new Date();
  tickMs = 1000;
  private timer: ReturnType<typeof setInterval> | undefined;
  private swept = false;
  /** Names this scheduler instance in the heartbeat files of the runs it owns. */
  private readonly token = Math.random().toString(36).slice(2, 10);
  private lastDeadSweep = 0;
  private lastBeat = 0;
  private readonly warned = new Set<string>();

  constructor(readonly home: string) {}

  // ----- clock -------------------------------------------------------------

  /** Starts the clock if something is pending. The timer never keeps the process alive. */
  ensureRunning(): void {
    if (this.timer || !this.hasPending()) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  // Stops the clock's interval; in: tick when nothing is pending and resetSchedulers, out: no more ticks.
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Delivers what is due, starts what is due. Synchronous and never throws. */
  tick(): void {
    try {
      const now = this.now();
      const first = !this.swept;
      if (first) {
        this.swept = true;
        this.startupSweep(now);
      }
      this.keepHeartbeats(now);
      this.sweepDeadRuns(now);
      this.deliverDue(now);
      this.startDue(now);
      if (!this.hasPending()) this.stop();
    } catch (err) {
      telemetryBus.emitWarning("scheduled_action.error", `[Agent Accelerator] Scheduler tick failed: ${errText(err)}`, {});
    }
  }

  // Reports an invalid record or delivery once per file/id/problem and leaves the file untouched; in: snapshot/startCook, out: a scheduled_action.invalid warning.
  private warnInvalid(id: string, problem: string, file = "task.json"): void {
    const key = `${file}:${id}:${problem}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    telemetryBus.emitWarning(
      "scheduled_action.invalid",
      `[Agent Accelerator] Scheduled action "${id}" in ${file} is invalid and is skipped: ${problem}`,
      { id, problem, file }
    );
  }

  /** Valid records and deliveries (invalid ones are reported once and left untouched in their file). */
  private snapshot(): { live: ScheduledActionRecord[]; pending: PendingDelivery[] } {
    const live = readTasks(this.home).filter((t) => {
      const problem = validateRecord(t);
      if (problem) this.warnInvalid(String((t as { id?: unknown }).id), problem);
      return !problem;
    });
    const pending = readDeliveries(this.home).filter((p) => {
      const problem = validateDelivery(p);
      if (problem) this.warnInvalid(String((p as { id?: unknown }).id), problem, "delivery.json");
      return !problem;
    });
    return { live, pending };
  }

  // True while anything keeps the clock useful (a run in flight, a saved delivery, a waiting or cooking action); in: ensureRunning and tick, out: start/stop of the interval.
  private hasPending(): boolean {
    const { live, pending } = this.snapshot();
    return this.running.size > 0 || pending.length > 0 || live.some((t) => t.state === "waiting" || t.state === "cooking");
  }

  // ----- startup -----------------------------------------------------------

  /**
   * First tick after start (not the constructor, so a listener attached right
   * after creating the Agent still sees the events). Nothing runs by itself:
   * anything whose moment passed while the process was down is only marked.
   */
  private startupSweep(now: Date): void {
    for (const t of this.snapshot().live) {
      if (!this.ownsHere(t.agent)) continue; // another process's action (or nobody's: startDue handles that)
      if (t.state === "waiting" && t.nextDeliverAt && parseLocalIso(t.nextDeliverAt).getTime() <= now.getTime()) {
        this.markMissed(t.id, "process_down", "waiting", t.schedule.onMissed);
      }
    }
  }

  // True when a live Agent with this name is registered in THIS process: only then may this process start, deliver or recover its actions; in: the sweeps, startDue and deliverDue, out: a boolean.
  private ownsHere(agentName: string): boolean {
    return !!this.agents.get(agentName)?.deref();
  }

  // True while the process that started a run is still running it: its heartbeat is fresh and (same host) its pid exists; this process counts only for runs in this.running; in: the dead-run sweep and delete, out: the heartbeat or undefined.
  private liveOwner(id: string): { pid: number } | undefined {
    if (this.running.has(id)) return { pid: process.pid };
    const hb = readHeartbeat(this.home, id);
    if (!hb || hb.ageMs > HEARTBEAT_STALE_MS) return undefined;
    if (hb.pid === process.pid) return undefined; // an earlier scheduler of this very process is gone
    if (hb.host === os.hostname() && !processAlive(hb.pid)) return undefined;
    return { pid: hb.pid };
  }

  // Refreshes the heartbeat of every run in flight (at most every 5 s); in: tick, out: the .heartbeat files.
  private keepHeartbeats(now: Date): void {
    if (this.running.size === 0 || Math.abs(now.getTime() - this.lastBeat) < HEARTBEAT_EVERY_MS) return;
    this.lastBeat = now.getTime();
    for (const id of this.running.keys()) touchHeartbeat(this.home, id);
  }

  // Recovers the runs whose owner is gone (a killed process), but only for actions this process owns, at start and then every 15 s; in: tick, out: recoverCooking calls.
  private sweepDeadRuns(now: Date): void {
    if (this.lastDeadSweep !== 0 && Math.abs(now.getTime() - this.lastDeadSweep) < DEAD_SWEEP_EVERY_MS) return;
    this.lastDeadSweep = now.getTime();
    for (const t of this.snapshot().live) {
      if (t.state === "cooking" && this.ownsHere(t.agent) && !this.liveOwner(t.id)) this.recoverCooking(t);
    }
  }

  /** The process died mid-cook: rebuild the delivery if the run file was already written, else it is missed. */
  private recoverCooking(t: ScheduledActionRecord): void {
    const current = t.current!;
    const file = findRunFile(this.home, t.id, parseLocalIso(current.deliverAt), current.cookStartedAt);
    const run = file ? readRun(this.home, file) : undefined;
    if (!file || !run) {
      this.markMissed(t.id, "interrupted", "cooking", t.schedule.onMissed);
      return;
    }
    updateDeliveries(this.home, t.id, (pending) => {
      if (pending.some((p) => p.file === file)) return;
      pending.push({
        id: t.id,
        file,
        status: run.header["status"] === "failed" ? "failed" : "ok",
        readyAt: run.header["finishedAt"] ?? current.deliverAt,
        deliverAt: current.deliverAt,
        ...(run.header["late"] === "true" ? { late: true } : {}),
      });
    });
    updateTask(this.home, t.id, (rec) => {
      if (!rec || rec.state !== "cooking") return;
      delete rec.current;
      rec.state = rec.nextDeliverAt ? "waiting" : "done";
    });
  }

  // Marks a run whose moment passed as missed, then applies the action's onMissed policy: `skip` moves on to the next time, `run` runs it now, unset waits for run_now / skip; only when the action is still in the state the caller saw (`from`), so two processes never both mark it; in: the sweeps, out: task.json + the missed (and skipped / started) events.
  private markMissed(id: string, reason: string, from: "waiting" | "cooking", policy?: "skip" | "run"): void {
    let name = id;
    const changed = updateTask(this.home, id, (t) => {
      if (!t || t.state !== from) return false; // another process already dealt with it
      name = t.name;
      t.state = "missed";
      delete t.current;
      return true;
    });
    if (!changed) return;
    const next = policy === "skip" ? "Skipping it (onMissed: skip)." : policy === "run" ? "Running it now (onMissed: run)." : "Use run_now or skip.";
    emit("missed", `"${name}" (${id}) missed its run (${reason}). ${next}`, { id, name, reason, ...(policy ? { onMissed: policy } : {}) }, "warn");
    if (policy === "skip") this.skip(id);
    else if (policy === "run") this.startCook(id, true);
  }

  // ----- delivery ----------------------------------------------------------

  // Delivers every saved run whose delivery time has come; in: tick, out: deliver calls.
  private deliverDue(now: Date): void {
    for (const entry of this.snapshot().pending) {
      if (parseLocalIso(entry.deliverAt).getTime() > now.getTime()) continue;
      const owner = readTask(this.home, entry.id)?.agent; // the delivered event must fire in the process that owns the action
      if (owner === undefined || this.ownsHere(owner)) this.deliver(entry, now);
    }
  }

  // Removes the entry (only the process that removed it goes on), records `lastRun`, THEN emits (whether or not anyone listens); late = it replaced a missed occurrence, was delivered over two ticks after its time, or finished after it; in: deliverDue, out: task.json + the delivered event.
  private deliver(entry: PendingDelivery, now: Date): void {
    const removed = updateDeliveries(this.home, entry.id, (pending) => {
      const i = pending.findIndex((p) => p.id === entry.id && p.file === entry.file);
      if (i < 0) return false;
      pending.splice(i, 1);
      return true;
    });
    if (!removed) return; // another process took this delivery: exactly one process delivers it
    const deliverAt = parseLocalIso(entry.deliverAt).getTime();
    const late = entry.late === true || now.getTime() - deliverAt > 2 * this.tickMs || parseLocalIso(entry.readyAt).getTime() > deliverAt;
    let name = entry.id;
    updateTask(this.home, entry.id, (t) => {
      if (!t) return;
      name = t.name;
      t.lastRun = { status: entry.status, file: entry.file, deliverAt: entry.deliverAt, deliveredAt: toLocalIso(now), late };
    });
    const delivery: ScheduledDelivery = {
      id: entry.id,
      name,
      status: entry.status,
      file: runPath(this.home, entry.file),
      readyAt: entry.readyAt,
      deliverAt: entry.deliverAt,
      late,
    };
    emit("delivered", `"${name}" is ready: ${delivery.file}`, { ...delivery });
  }

  // ----- starting runs -----------------------------------------------------

  // Starts waiting actions whose cook time has come and skips the overlap of those still cooking; in: tick, out: startCook/skipOverlap calls.
  private startDue(now: Date): void {
    for (const t of this.snapshot().live) {
      if (!this.ownsHere(t.agent)) {
        // Nobody here can run it. Another process may own it, so only once its delivery time has passed with no run started is it missed.
        if (t.state === "waiting" && t.nextDeliverAt && parseLocalIso(t.nextDeliverAt).getTime() <= now.getTime()) {
          this.markMissed(t.id, "no_agent", "waiting");
        }
        continue;
      }
      if (!t.nextCookAt || parseLocalIso(t.nextCookAt).getTime() > now.getTime()) continue;
      if (t.state === "waiting") this.startCook(t.id, false);
      else if (t.state === "cooking") this.skipOverlap(t.id, now);
    }
  }

  /** Next delivery after a missed one: the following occurrence after `now`, or none for a one-shot. */
  private afterMissed(t: ScheduledActionRecord, now: Date): { cook: string | null; deliver: string | null } {
    if (!t.schedule.repeatEvery || !t.nextDeliverAt) return { cook: null, deliver: null };
    const deliverAt = nextAfter(parseLocalIso(t.nextDeliverAt), t.schedule.repeatEvery, now);
    const cookMs = durationMs(t.schedule.startCookingInAdvance, "schedule.startCookingInAdvance");
    return { cook: toLocalIso(cookTime(deliverAt, cookMs)), deliver: toLocalIso(deliverAt) };
  }

  /**
   * Re-reads and validates the action (the file is the truth), flips it to
   * `cooking` and advances its next times BEFORE the run starts, then launches
   * the worker without awaiting it. `manual` (run_now) delivers at `now` and
   * leaves the schedule alone, except that it consumes a missed occurrence.
   */
  private startCook(id: string, manual: boolean): ScheduledActionRecord | undefined {
    const now = this.now();
    const ctx: { agent?: Agent; noAgent?: boolean; replacesMissed?: boolean } = {};
    const started = updateTask(this.home, id, (t) => {
      if (!t) return undefined;
      const problem = validateRecord(t);
      if (problem) {
        this.warnInvalid(id, problem);
        return undefined;
      }
      if (t.state === "cooking") return undefined;
      // Another process may have started (and even finished) this run since the caller looked: a scheduled start needs the action to be waiting and due right now.
      if (!manual && (t.state !== "waiting" || !t.nextCookAt || parseLocalIso(t.nextCookAt).getTime() > now.getTime())) return undefined;
      ctx.replacesMissed = manual && t.state === "missed";
      ctx.agent = this.agents.get(t.agent)?.deref();
      if (!ctx.agent) {
        t.state = "missed";
        delete t.current;
        ctx.noAgent = true;
        return undefined;
      }
      const cookMs = durationMs(t.schedule.startCookingInAdvance, "schedule.startCookingInAdvance");
      const deliverAt = manual || !t.nextDeliverAt ? now : parseLocalIso(t.nextDeliverAt);
      let next = { cook: t.nextCookAt, deliver: t.nextDeliverAt };
      if (!manual) {
        const following = t.schedule.repeatEvery && t.nextDeliverAt ? nextOccurrence(deliverAt, t.schedule.repeatEvery) : undefined;
        next = following
          ? { cook: toLocalIso(cookTime(following, cookMs)), deliver: toLocalIso(following) }
          : { cook: null, deliver: null };
      } else if (t.state === "missed") {
        next = this.afterMissed(t, now);
      }
      t.state = "cooking";
      t.current = { cookStartedAt: toLocalIso(now), deliverAt: toLocalIso(deliverAt) };
      t.nextCookAt = next.cook;
      t.nextDeliverAt = next.deliver;
      writeHeartbeat(this.home, id, this.token); // before the record shows `cooking`, so no process sees a cooking action without an owner
      return t;
    });
    if (ctx.noAgent) {
      const name = this.nameOf(id);
      emit("missed", `"${name}" (${id}) cannot run: no live Agent named in its task.json is registered.`, { id, name, reason: "no_agent" }, "warn");
    }
    if (!started || !ctx.agent) return undefined;
    emit("started", `"${started.name}" (${id}) started cooking.`, {
      id,
      name: started.name,
      cookStartedAt: started.current!.cookStartedAt,
      deliverAt: started.current!.deliverAt,
    });
    this.launch(started, ctx.agent, manual, ctx.replacesMissed === true);
    return started;
  }

  // The display name of an action from task.json, else its id; in: startCook's no-agent message, out: event text.
  private nameOf(id: string): string {
    return readTask(this.home, id)?.name ?? id;
  }

  /** The next run is due while this one still cooks: never stack. Skip that occurrence. */
  private skipOverlap(id: string, now: Date): void {
    const ctx: { skipped?: { name: string; deliverAt: string } } = {};
    updateTask(this.home, id, (t) => {
      if (!t || t.state !== "cooking" || !t.nextCookAt || !t.nextDeliverAt) return;
      ctx.skipped = { name: t.name, deliverAt: t.nextDeliverAt };
      if (!t.schedule.repeatEvery) {
        t.nextCookAt = t.nextDeliverAt = null;
        return;
      }
      const cookMs = durationMs(t.schedule.startCookingInAdvance, "schedule.startCookingInAdvance");
      let deliverAt = parseLocalIso(t.nextDeliverAt);
      while (cookTime(deliverAt, cookMs).getTime() <= now.getTime()) deliverAt = nextOccurrence(deliverAt, t.schedule.repeatEvery);
      t.nextDeliverAt = toLocalIso(deliverAt);
      t.nextCookAt = toLocalIso(cookTime(deliverAt, cookMs));
    });
    if (ctx.skipped) {
      const { name, deliverAt } = ctx.skipped;
      emit("skipped", `"${name}" (${id}) skipped a run: the previous one is still cooking.`, { id, name, reason: "overlap", deliverAt }, "warn");
    }
  }

  // Starts one run without awaiting it and tracks it until it ends; in: startCook, out: this.running + the run's files.
  private launch(task: ScheduledActionRecord, agent: Agent, manual: boolean, missed: boolean): void {
    const entry: RunningEntry = { controller: new AbortController(), done: Promise.resolve(), deleted: false, manual, missed };
    this.running.set(task.id, entry);
    entry.done = this.runWorker(task, agent, entry)
      .catch((err) => {
        telemetryBus.emitWarning("scheduled_action.error", `[Agent Accelerator] Run of "${task.id}" failed unexpectedly: ${errText(err)}`, { id: task.id });
      })
      .finally(() => {
        this.running.delete(task.id);
        clearHeartbeat(this.home, task.id);
      });
    this.ensureRunning();
  }

  // ----- the run -----------------------------------------------------------

  // Runs one action to its outcome and writes the result unless the action was deleted meanwhile; in: launch, out: finish.
  private async runWorker(task: ScheduledActionRecord, agent: Agent, entry: RunningEntry): Promise<void> {
    const deliverAt = parseLocalIso(task.current!.deliverAt);
    const outcome = await this.execute(task, agent, entry, deliverAt);
    if (entry.deleted) return; // deleted: no run file, nothing delivered
    this.finish(task, outcome, task.current!.cookStartedAt, deliverAt, entry);
  }

  /** A fresh stateless worker built from the saved fields; retries only while there is time before delivery. */
  private async execute(task: ScheduledActionRecord, agent: Agent, entry: RunningEntry, deliverAt: Date): Promise<Outcome> {
    let worker: Agent | undefined;
    try {
      const { Agent: AgentClass } = await import("../agent/agent.ts");
      const pool = agent.dynamicSubagents?.tools ?? {};
      const missing = task.tools.filter((n) => Object.keys(grantWorkerTools(pool, [n])).length === 0);
      if (missing.length > 0) {
        throw new Error(`worker tool(s) no longer in the pool: ${missing.join(", ")} (available: ${Object.keys(pool).join(", ") || "none"})`);
      }
      worker = new AgentClass(
        buildDynamicWorkerConfig(agent, {
          name: task.name,
          role: task.role,
          instructions: task.instructions,
          sessionId: createChildSessionId(agent.sessionId, task.id),
          tools: grantWorkerTools(pool, task.tools),
        })
      );
      const attempts = 1 + (task.schedule.retries ?? 0);
      for (let attempt = 1; ; attempt++) {
        try {
          return { res: await this.attempt(worker, task, agent, entry), usage: readUsage(worker.usageTotals) };
        } catch (err) {
          if (entry.deleted || attempt >= attempts || this.now().getTime() >= deliverAt.getTime()) throw err;
        }
      }
    } catch (err) {
      return { error: errText(err), ...(worker ? { usage: readUsage(worker.usageTotals) } : {}) };
    } finally {
      try {
        worker?.reset();
      } catch {
        // why: freeing the one-shot worker's chain/routing state is best-effort.
      }
    }
  }

  // One worker run with a per-attempt timeout and the delete signal, raced so a hung provider cannot hold it; in: execute, out: the worker's AgentResponse.
  private async attempt(worker: Agent, task: ScheduledActionRecord, agent: Agent, entry: RunningEntry): Promise<AgentResponse> {
    const ms = scheduledRunTimeoutMs(agent.dynamicSubagents?.workerTimeoutMs ?? Infinity, task.timeoutMs);
    // One controller per attempt (the timeout is per attempt), fed by the entry's delete controller.
    const controller = new AbortController();
    const onDelete = () => controller.abort(entry.controller.signal.reason ?? new Error("deleted"));
    if (entry.controller.signal.aborted) onDelete();
    else entry.controller.signal.addEventListener("abort", onDelete, { once: true });
    const timer = ms > 0 ? setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms) : undefined;
    // Raced so a timeout or delete ends the attempt even if the provider ignores the signal.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new Error("aborted")), { once: true });
    });
    try {
      return await Promise.race([worker.run(task.task, { signal: controller.signal }), aborted]);
    } finally {
      clearTimeout(timer);
      entry.controller.signal.removeEventListener("abort", onDelete);
    }
  }

  // Writes a finished run: run file, then the `delivery.json` entry, then `task.json` (a crash in between is repaired on start); a manual run is due when it finishes and is late only if it replaced a missed occurrence, a scheduled one is late only past its second; in: runWorker, out: the files and the ready/failed event.
  private finish(task: ScheduledActionRecord, outcome: Outcome, startedAt: string, deliverAt: Date, run: Pick<RunningEntry, "manual" | "missed">): void {
    const now = this.now();
    const ok = "res" in outcome;
    const finishedAt = toLocalIso(now);
    const due = run.manual ? now : deliverAt;
    const late = run.missed || secondOf(now) > secondOf(due);
    const header: RunHeader = {
      id: task.id,
      name: task.name,
      status: ok ? "ok" : "failed",
      startedAt,
      finishedAt,
      deliverAt: toLocalIso(due),
      late,
      ...(ok ? { model: `${outcome.res.provider}/${outcome.res.model}` } : {}),
      ...usageFields(outcome.usage),
      ...(ok ? {} : { error: outcome.error }),
    };
    const body = ok ? outcome.res.text.trim() || "[The worker returned no text.]" : `The run failed: ${outcome.error}`;
    const file = writeRunFile(this.home, task.id, deliverAt, header, body);
    updateDeliveries(this.home, task.id, (pending) => {
      pending.push({ id: task.id, file, status: header.status, readyAt: finishedAt, deliverAt: header.deliverAt, ...(run.missed ? { late: true } : {}) });
    });
    updateTask(this.home, task.id, (t) => {
      if (!t || t.state !== "cooking") return;
      delete t.current;
      t.state = t.nextDeliverAt ? "waiting" : "done";
    });
    const data = { id: task.id, name: task.name, file: runPath(this.home, file), readyAt: finishedAt, deliverAt: header.deliverAt };
    if (ok) emit("ready", `"${task.name}" (${task.id}) finished; its result is saved.`, data);
    else emit("failed", `"${task.name}" (${task.id}) failed: ${(outcome as { error: string }).error}`, { ...data, error: (outcome as { error: string }).error }, "warn");
  }

  // ----- commands ----------------------------------------------------------

  // Starts an action immediately outside its schedule (also resolves a missed one); in: runScheduledAction, out: the cooking record.
  runNow(id: string): ScheduledActionRecord {
    const rec = readTask(this.home, id);
    if (!rec) throw notFound(id);
    if (rec.state === "cooking" || this.running.has(id)) {
      throw new ValidationError(`Scheduled action "${id}" is already cooking; wait for it to finish.`);
    }
    if (!this.agents.get(rec.agent)?.deref()) {
      throw new ConfigError(
        `[Agent Accelerator] No live Agent named "${rec.agent}" to run "${id}". Construct it (with dynamicSubagents.allowScheduledActions) first.`
      );
    }
    const started = this.startCook(id, true);
    if (!started) throw new ValidationError(`Scheduled action "${id}" could not be started (see the scheduled_action.invalid warning).`);
    return started;
  }

  // Ignores a missed occurrence and schedules the next one (a one-shot becomes done); in: skipScheduledAction and onMissed: skip, out: the updated record.
  skip(id: string): ScheduledActionRecord {
    const now = this.now();
    const rec = updateTask(this.home, id, (t) => {
      if (!t) throw notFound(id);
      if (t.state !== "missed") throw new ValidationError(`Scheduled action "${id}" is ${t.state}, not missed: nothing to skip.`);
      const next = this.afterMissed(t, now);
      t.nextCookAt = next.cook;
      t.nextDeliverAt = next.deliver;
      t.state = next.deliver ? "waiting" : "done";
      delete t.current;
      return t;
    });
    emit("skipped", `"${rec.name}" (${id}) skipped its missed run.`, { id, name: rec.name, reason: "skip", nextDeliverAt: rec.nextDeliverAt });
    this.ensureRunning();
    return rec;
  }

  // Deletes an action (aborting a cooking run only with force) and optionally purges its run files; in: deleteScheduledAction, out: a DeleteResult.
  async delete(id: string, opts: { force?: boolean; purge?: boolean }): Promise<DeleteResult> {
    const rec = readTask(this.home, id);
    if (!rec) return { ok: false, reason: "not_found" };
    const run = this.running.get(id);
    const other = !run && rec.state === "cooking" ? this.liveOwner(id) : undefined;
    if (other) {
      return {
        ok: false,
        reason: "running",
        message: `"${id}" is cooking in another process (pid ${other.pid}), so nothing was changed. Only that process can abort it: wait for it to finish, or delete it from there.`,
      };
    }
    if (run && !opts.force) {
      return {
        ok: false,
        reason: "running",
        message: `"${id}" is cooking right now, so nothing was changed. Ask the user whether to abort it; if they agree, call delete again with force: true.`,
      };
    }
    if (run) {
      run.deleted = true;
      run.controller.abort(new Error("deleted"));
      await run.done;
    }
    if (!deleteTask(this.home, id)) return { ok: false, reason: "not_found" }; // another process deleted it first; only the one that removed it reports it
    if (opts.purge) removeTaskFolder(this.home, id);
    emit("deleted", `"${rec.name}" (${id}) was deleted.`, { id, name: rec.name, forced: !!run, purged: !!opts.purge });
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Registry (one scheduler per resolved home) and agent registration
// ---------------------------------------------------------------------------

const schedulers = new Map<string, Scheduler>();

/** The scheduler of a RESOLVED home folder (created on first use; nothing runs until something is pending). */
export function getScheduler(home: string): Scheduler {
  let s = schedulers.get(home);
  if (!s) {
    schedulers.set(home, (s = new Scheduler(home)));
  }
  return s;
}

/** Stops every clock and forgets all schedulers. Test hook. */
export function resetSchedulers(): void {
  for (const s of schedulers.values()) s.stop();
  schedulers.clear();
}

// The scheduler of a resolved home (option, setHome, env or default); in: the public functions, out: a Scheduler.
const schedulerFor = (opts?: HomeOptions): Scheduler => getScheduler(resolveHome(opts?.home));

/** Makes `agent` the live runner for actions created under its name, and starts the clock if work is pending. */
export function registerAgent(agent: Agent): void {
  const s = getScheduler(agent.home);
  s.agents.set(agent.name, new WeakRef(agent));
  s.ensureRunning();
}

// ---------------------------------------------------------------------------
// Public functions (exported from the barrel; the LLM tool is a thin wrapper)
// ---------------------------------------------------------------------------

/** Schedules a new action under `agent` (needs `dynamicSubagents.allowScheduledActions`). Returns the saved record. */
export function createScheduledAction(agent: Agent, input: ScheduledActionInput): ScheduledActionRecord {
  const dyn = agent.dynamicSubagents;
  if (!dyn?.allowScheduledActions) {
    throw new ConfigError(
      "[Agent Accelerator] Scheduled actions are off for this agent: set dynamicSubagents.allowScheduledActions: true (and a worker model)."
    );
  }
  const s = getScheduler(agent.home);
  const now = s.now();
  const problems = validateInput(input, dyn.tools, now);
  if (problems.length > 0) throw new ValidationError(joinProblems("Invalid scheduled action", problems));

  const sa = input.scheduled_action;
  const lead = sa.startCookingInAdvance ?? DEFAULT_COOK_LEAD;
  const deliverAt = resolveDelivery(now, sa.timeToDeliver, sa.meridiem);
  const record = createTask(s.home, () => `${sa.id}-${randomSuffix()}`, (id) => {
    const rec: ScheduledActionRecord = {
      id,
      name: sa.name.trim(),
      agent: agent.name,
      ...(input.role ? { role: input.role } : {}),
      instructions: input.instructions,
      task: input.task,
      tools: input.tools ?? [],
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      schedule: {
        timeToDeliver: sa.timeToDeliver,
        meridiem: sa.meridiem,
        startCookingInAdvance: lead,
        ...(sa.repeatEvery !== undefined ? { repeatEvery: sa.repeatEvery } : {}),
        ...(sa.retries !== undefined ? { retries: sa.retries } : {}),
        ...(sa.onMissed !== undefined ? { onMissed: sa.onMissed } : {}),
      },
      state: "waiting",
      nextCookAt: toLocalIso(cookTime(deliverAt, durationMs(lead, "scheduled_action.startCookingInAdvance"))),
      nextDeliverAt: toLocalIso(deliverAt),
      createdAt: toLocalIso(now),
    };
    return rec;
  });
  s.agents.set(agent.name, new WeakRef(agent));
  emit("created", `"${record.name}" (${record.id}) scheduled for ${record.nextDeliverAt}.`, {
    id: record.id,
    name: record.name,
    nextCookAt: record.nextCookAt,
    nextDeliverAt: record.nextDeliverAt,
  });
  s.ensureRunning();
  return record;
}

/** Every action with its full metadata and state, plus a `running` flag. */
export function listScheduledActions(opts?: HomeOptions): Array<ScheduledActionRecord & { running: boolean }> {
  const s = schedulerFor(opts);
  return readTasks(s.home).map((t) => ({ ...t, running: s.running.has(t.id) }));
}

/**
 * Changes instructions, task, tools, timeout, role or any schedule field.
 * `id` and the creating agent are immutable. Changing the delivery time
 * recomputes the schedule (`DD` relative to now); schedule changes are
 * refused while the action is cooking.
 */
export function updateScheduledAction(id: string, patch: ScheduledActionPatch, opts?: HomeOptions): ScheduledActionRecord {
  const s = schedulerFor(opts);
  const now = s.now();
  const sa = patch.scheduled_action ?? {};
  const { name, ...scheduleChange } = sa;
  const rec = updateTask(s.home, id, (t) => {
    if (!t) throw notFound(id);
    const stored = validateRecord(t);
    if (stored) throw new ValidationError(`Scheduled action "${id}" is invalid in its task.json: ${stored}`);
    const scheduleChanged = Object.values(scheduleChange).some((v) => v !== undefined);
    if (scheduleChanged && t.state === "cooking") {
      throw new ValidationError(`Scheduled action "${id}" is cooking right now; schedule changes are refused while it runs. Try again after it finishes.`);
    }
    const deliveryChanged = scheduleChange.timeToDeliver !== undefined || scheduleChange.meridiem !== undefined;
    const merged = { ...t.schedule };
    for (const [key, value] of Object.entries(scheduleChange)) if (value !== undefined) (merged as Record<string, unknown>)[key] = value;

    const problems: string[] = [];
    const pool = s.agents.get(t.agent)?.deref()?.dynamicSubagents?.tools;
    if (patch.instructions !== undefined) collect(problems, () => requireText("instructions", patch.instructions));
    if (patch.task !== undefined) collect(problems, () => requireText("task", patch.task));
    if (name !== undefined) collect(problems, () => requireText("scheduled_action.name", name));
    checkOptionalFields(patch, pool, problems);
    if (scheduleChanged) checkSchedule(merged, now, problems, { resolve: deliveryChanged, defaultLead: false });
    if (problems.length > 0) throw new ValidationError(joinProblems("Invalid update", problems));

    if (patch.role !== undefined) t.role = patch.role || undefined;
    if (patch.instructions !== undefined) t.instructions = patch.instructions;
    if (patch.task !== undefined) t.task = patch.task;
    if (patch.tools !== undefined) t.tools = patch.tools;
    if (patch.timeoutMs !== undefined) t.timeoutMs = patch.timeoutMs;
    if (name !== undefined) t.name = name.trim();
    if (scheduleChanged) {
      t.schedule = merged;
      const cookMs = durationMs(merged.startCookingInAdvance, "scheduled_action.startCookingInAdvance");
      if (deliveryChanged) {
        const deliverAt = resolveDelivery(now, merged.timeToDeliver, merged.meridiem);
        t.nextDeliverAt = toLocalIso(deliverAt);
        t.nextCookAt = toLocalIso(cookTime(deliverAt, cookMs));
        t.state = "waiting";
      } else if (t.nextDeliverAt) {
        t.nextCookAt = toLocalIso(cookTime(parseLocalIso(t.nextDeliverAt), cookMs));
      }
    }
    return t;
  });
  emit("updated", `"${rec.name}" (${id}) updated.`, { id, name: rec.name, nextCookAt: rec.nextCookAt, nextDeliverAt: rec.nextDeliverAt });
  s.ensureRunning();
  return rec;
}

/** Runs an action now, outside its schedule (also resolves a missed run). Needs the creating Agent to be alive. */
export function runScheduledAction(id: string, opts?: HomeOptions): ScheduledActionRecord {
  return schedulerFor(opts).runNow(id);
}

/** Ignores a missed run and waits for the next scheduled time (a one-shot becomes `done`). */
export function skipScheduledAction(id: string, opts?: HomeOptions): ScheduledActionRecord {
  return schedulerFor(opts).skip(id);
}

/**
 * Deletes an action for good. While it is cooking nothing changes unless
 * `force: true` (the run is aborted, then deleted). Past run files are kept
 * unless `purge: true`.
 */
export function deleteScheduledAction(id: string, opts?: HomeOptions & { force?: boolean; purge?: boolean }): Promise<DeleteResult> {
  return schedulerFor(opts).delete(id, { force: opts?.force, purge: opts?.purge });
}
