/**
 * Scheduled actions: dynamic sub-agents that run later (once or on repeat)
 * and write their answer to a file instead of replying in the chat.
 *
 * One clock per home folder, ticking once a second against the machine's own
 * time. Each tick only asks "what is overdue?", so drift, sleep or a clock
 * change cannot skip a run. The files under `<home>/scheduled_tasks/` are the
 * source of truth (see `store.ts`); nothing waits in memory, and the timer is
 * unref'd and runs only while something is pending.
 *
 *   waiting --(deliver - cook time)--> cooking --> ready --(deliver time)--> delivered
 *                                         |                                     |
 *                                         +--> failed (recorded, moves on)      +--> waiting (repeat) | done
 */
import type { Agent } from "../agent/agent.ts";
import { createChildSessionId } from "../agent/delegation.ts";
import { buildDynamicWorkerConfig, grantWorkerTools, normalizeWorkerTimeoutValue } from "../agent/worker.ts";
import { telemetryBus } from "../telemetry.ts";
import { ConfigError, ValidationError } from "../types/errors.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { AgentResponse } from "../types/response.ts";
import type {
  KillResult,
  ScheduledActionInput,
  ScheduledActionPatch,
  ScheduledActionRecord,
  ScheduledDelivery,
  ScheduleSpec,
} from "../types/scheduler.ts";
import {
  TASK_ID_PATTERN,
  findRunFile,
  readDeliveries,
  readRun,
  readTasks,
  removeTaskFolder,
  resolveHome,
  runPath,
  updateDeliveries,
  updateTasks,
  validateDelivery,
  validateRecord,
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
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Optional `{ home }` accepted by every public function except `createScheduledAction` (the agent knows its home). */
export interface HomeOptions {
  home?: string;
}

type PoolTools = Record<string, ToolDefinition>;
type Outcome = { res: AgentResponse } | { error: string };
interface RunningEntry {
  /** Aborted by `kill`; every attempt of the run listens to it. */
  controller: AbortController;
  done: Promise<void>;
  killed: boolean;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function emit(code: string, message: string, data: Record<string, unknown>, level: "info" | "warn" = "info"): void {
  telemetryBus.emit({ code: `scheduled_action.${code}`, message: `[Agent Accelerator] ${message}`, level, data });
}

function notFound(id: string): ValidationError {
  return new ValidationError(`No scheduled action with id "${id}".`);
}

// ---------------------------------------------------------------------------
// Validation (collects EVERY problem so the model can fix a call in one go)
// ---------------------------------------------------------------------------

function collect(problems: string[], fn: () => void): void {
  try {
    fn();
  } catch (err) {
    problems.push(errText(err));
  }
}

function requireText(field: string, value: unknown): void {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${field}: required, a non-empty string.`);
}

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
}

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

const joinProblems = (what: string, problems: string[]): string =>
  `${what} (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.map((p, i) => `(${i + 1}) ${p}`).join(" ")}`;

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
  private readonly warned = new Set<string>();

  constructor(readonly home: string) {}

  // ----- clock -------------------------------------------------------------

  /** Starts the clock if something is pending. The timer never keeps the process alive. */
  ensureRunning(): void {
    if (this.timer || !this.hasPending()) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

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
      this.deliverDue(now, first);
      this.startDue(now);
      if (!this.hasPending()) this.stop();
    } catch (err) {
      telemetryBus.emitWarning("scheduled_action.error", `[Agent Accelerator] Scheduler tick failed: ${errText(err)}`, {});
    }
  }

  private warnInvalid(id: string, problem: string, file = "tasks.json"): void {
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
      if (problem) this.warnInvalid(String((p as { id?: unknown }).id), problem, "deliveries.json");
      return !problem;
    });
    return { live, pending };
  }

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
      if (t.state === "cooking") this.recoverCooking(t);
      else if (t.state === "waiting" && t.nextDeliverAt && parseLocalIso(t.nextDeliverAt).getTime() <= now.getTime()) {
        this.markMissed(t.id, "process_down");
      }
    }
  }

  /** The process died mid-cook: rebuild the delivery if the run file was already written, else it is missed. */
  private recoverCooking(t: ScheduledActionRecord): void {
    const current = t.current!;
    const file = findRunFile(this.home, t.id, parseLocalIso(current.deliverAt), current.cookStartedAt);
    const run = file ? readRun(this.home, file) : undefined;
    if (!file || !run) {
      this.markMissed(t.id, "interrupted");
      return;
    }
    updateDeliveries(this.home, (pending) => {
      if (pending.some((p) => p.file === file)) return;
      pending.push({
        id: t.id,
        file,
        status: run.header["status"] === "failed" ? "failed" : "ok",
        readyAt: run.header["finishedAt"] ?? current.deliverAt,
        deliverAt: current.deliverAt,
      });
    });
    updateTasks(this.home, (tasks) => {
      const rec = tasks.find((x) => x.id === t.id);
      if (!rec || rec.state !== "cooking") return;
      delete rec.current;
      rec.state = rec.nextDeliverAt ? "waiting" : "done";
    });
  }

  private markMissed(id: string, reason: string): void {
    let name = id;
    updateTasks(this.home, (tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) return;
      name = t.name;
      t.state = "missed";
      delete t.current;
    });
    emit("missed", `"${name}" (${id}) missed its run (${reason}). Use run_now or skip.`, { id, name, reason }, "warn");
  }

  // ----- delivery ----------------------------------------------------------

  private deliverDue(now: Date, first: boolean): void {
    for (const entry of this.snapshot().pending) {
      if (parseLocalIso(entry.deliverAt).getTime() <= now.getTime()) this.deliver(entry, now, first);
    }
  }

  /** Removes the entry, records `lastRun`, THEN emits (whether or not anyone listens). */
  private deliver(entry: PendingDelivery, now: Date, first: boolean): void {
    updateDeliveries(this.home, (pending) => {
      const i = pending.findIndex((p) => p.id === entry.id && p.file === entry.file);
      if (i >= 0) pending.splice(i, 1);
    });
    const deliverAt = parseLocalIso(entry.deliverAt).getTime();
    const late = first || now.getTime() - deliverAt > 2 * this.tickMs || parseLocalIso(entry.readyAt).getTime() > deliverAt;
    let name = entry.id;
    updateTasks(this.home, (tasks) => {
      const t = tasks.find((x) => x.id === entry.id);
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

  private startDue(now: Date): void {
    for (const t of this.snapshot().live) {
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
    const ctx: { agent?: Agent; noAgent?: boolean } = {};
    const started = updateTasks(this.home, (tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) return undefined;
      const problem = validateRecord(t);
      if (problem) {
        this.warnInvalid(id, problem);
        return undefined;
      }
      if (t.state === "cooking") return undefined;
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
      return t;
    });
    if (ctx.noAgent) {
      const name = this.nameOf(id);
      emit("missed", `"${name}" (${id}) cannot run: no live Agent named in tasks.json is registered.`, { id, name, reason: "no_agent" }, "warn");
    }
    if (!started || !ctx.agent) return undefined;
    emit("started", `"${started.name}" (${id}) started cooking.`, {
      id,
      name: started.name,
      cookStartedAt: started.current!.cookStartedAt,
      deliverAt: started.current!.deliverAt,
    });
    this.launch(started, ctx.agent);
    return started;
  }

  private nameOf(id: string): string {
    return readTasks(this.home).find((t) => t.id === id)?.name ?? id;
  }

  /** The next run is due while this one still cooks: never stack. Skip that occurrence. */
  private skipOverlap(id: string, now: Date): void {
    const ctx: { skipped?: { name: string; deliverAt: string } } = {};
    updateTasks(this.home, (tasks) => {
      const t = tasks.find((x) => x.id === id);
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

  private launch(task: ScheduledActionRecord, agent: Agent): void {
    const entry: RunningEntry = { controller: new AbortController(), done: Promise.resolve(), killed: false };
    this.running.set(task.id, entry);
    entry.done = this.runWorker(task, agent, entry)
      .catch((err) => {
        telemetryBus.emitWarning("scheduled_action.error", `[Agent Accelerator] Run of "${task.id}" failed unexpectedly: ${errText(err)}`, { id: task.id });
      })
      .finally(() => {
        this.running.delete(task.id);
      });
    this.ensureRunning();
  }

  // ----- the run -----------------------------------------------------------

  private async runWorker(task: ScheduledActionRecord, agent: Agent, entry: RunningEntry): Promise<void> {
    const deliverAt = parseLocalIso(task.current!.deliverAt);
    const outcome = await this.execute(task, agent, entry, deliverAt);
    if (entry.killed) return; // killed: no run file, nothing delivered
    this.finish(task, outcome, task.current!.cookStartedAt, deliverAt);
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
          return { res: await this.attempt(worker, task, agent, entry) };
        } catch (err) {
          if (entry.killed || attempt >= attempts || this.now().getTime() >= deliverAt.getTime()) throw err;
        }
      }
    } catch (err) {
      return { error: errText(err) };
    } finally {
      try {
        worker?.reset();
      } catch {
        // why: freeing the one-shot worker's chain/routing state is best-effort.
      }
    }
  }

  private async attempt(worker: Agent, task: ScheduledActionRecord, agent: Agent, entry: RunningEntry): Promise<AgentResponse> {
    const ms = normalizeWorkerTimeoutValue(agent.dynamicSubagents?.timeout ?? 0, task.timeoutMs);
    // One controller per attempt (the timeout is per attempt), fed by the entry's kill controller.
    const controller = new AbortController();
    const kill = () => controller.abort(entry.controller.signal.reason ?? new Error("killed"));
    if (entry.controller.signal.aborted) kill();
    else entry.controller.signal.addEventListener("abort", kill, { once: true });
    const timer = ms > 0 ? setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms) : undefined;
    // Raced so a timeout or kill ends the attempt even if the provider ignores the signal.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new Error("aborted")), { once: true });
    });
    try {
      return await Promise.race([worker.run(task.task, { signal: controller.signal }), aborted]);
    } finally {
      clearTimeout(timer);
      entry.controller.signal.removeEventListener("abort", kill);
    }
  }

  /** Write order: run file, then the `deliveries.json` entry, then `tasks.json`. A crash in between is repaired on start. */
  private finish(task: ScheduledActionRecord, outcome: Outcome, startedAt: string, deliverAt: Date): void {
    const now = this.now();
    const ok = "res" in outcome;
    const finishedAt = toLocalIso(now);
    const header: RunHeader = {
      id: task.id,
      name: task.name,
      status: ok ? "ok" : "failed",
      startedAt,
      finishedAt,
      deliverAt: toLocalIso(deliverAt),
      late: now.getTime() > deliverAt.getTime(),
      ...(ok
        ? {
            model: `${outcome.res.provider}/${outcome.res.model}`,
            tokens: outcome.res.usage.totalTokens,
            costUsd: outcome.res.usage.cost?.totalCost ?? "unknown",
          }
        : { error: outcome.error }),
    };
    const body = ok ? outcome.res.text.trim() || "[The worker returned no text.]" : `The run failed: ${outcome.error}`;
    const file = writeRunFile(this.home, task.id, deliverAt, header, body);
    updateDeliveries(this.home, (pending) => {
      pending.push({ id: task.id, file, status: header.status, readyAt: finishedAt, deliverAt: header.deliverAt });
    });
    updateTasks(this.home, (tasks) => {
      const t = tasks.find((x) => x.id === task.id);
      if (!t || t.state !== "cooking") return;
      delete t.current;
      t.state = t.nextDeliverAt ? "waiting" : "done";
    });
    const data = { id: task.id, name: task.name, file: runPath(this.home, file), readyAt: finishedAt, deliverAt: header.deliverAt };
    if (ok) emit("ready", `"${task.name}" (${task.id}) finished; its result is saved.`, data);
    else emit("failed", `"${task.name}" (${task.id}) failed: ${(outcome as { error: string }).error}`, { ...data, error: (outcome as { error: string }).error }, "warn");
  }

  // ----- commands ----------------------------------------------------------

  runNow(id: string): ScheduledActionRecord {
    const rec = readTasks(this.home).find((t) => t.id === id);
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

  skip(id: string): ScheduledActionRecord {
    const now = this.now();
    const rec = updateTasks(this.home, (tasks) => {
      const t = tasks.find((x) => x.id === id);
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

  async kill(id: string, opts: { force?: boolean; purge?: boolean }): Promise<KillResult> {
    const rec = readTasks(this.home).find((t) => t.id === id);
    if (!rec) return { ok: false, reason: "not_found" };
    const run = this.running.get(id);
    if (run && !opts.force) {
      return {
        ok: false,
        reason: "running",
        message: `"${id}" is cooking right now, so nothing was changed. Ask the user whether to abort it; if they agree, call kill again with force: true.`,
      };
    }
    if (run) {
      run.killed = true;
      run.controller.abort(new Error("killed"));
      await run.done;
    }
    updateTasks(this.home, (tasks) => {
      const i = tasks.findIndex((t) => t.id === id);
      if (i >= 0) tasks.splice(i, 1);
    });
    updateDeliveries(this.home, (pending) => {
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.id === id) pending.splice(i, 1);
    });
    if (opts.purge) removeTaskFolder(this.home, id);
    emit("killed", `"${rec.name}" (${id}) was killed.`, { id, name: rec.name, forced: !!run, purged: !!opts.purge });
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
  if (!s) schedulers.set(home, (s = new Scheduler(home)));
  return s;
}

/** Stops every clock and forgets all schedulers. Test hook. */
export function resetSchedulers(): void {
  for (const s of schedulers.values()) s.stop();
  schedulers.clear();
}

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
  const record = updateTasks(s.home, (tasks) => {
    const taken = new Set(tasks.map((t) => t.id));
    let id: string;
    do id = `${sa.id}-${randomSuffix()}`;
    while (taken.has(id));
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
      },
      state: "waiting",
      nextCookAt: toLocalIso(cookTime(deliverAt, durationMs(lead, "scheduled_action.startCookingInAdvance"))),
      nextDeliverAt: toLocalIso(deliverAt),
      createdAt: toLocalIso(now),
    };
    tasks.push(rec);
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
  const rec = updateTasks(s.home, (tasks) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) throw notFound(id);
    const stored = validateRecord(t);
    if (stored) throw new ValidationError(`Scheduled action "${id}" is invalid in tasks.json: ${stored}`);
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
export function killScheduledAction(id: string, opts?: HomeOptions & { force?: boolean; purge?: boolean }): Promise<KillResult> {
  return schedulerFor(opts).kill(id, { force: opts?.force, purge: opts?.purge });
}
