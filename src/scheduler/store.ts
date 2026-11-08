/**
 * Disk layer for scheduled actions. Everything lives under one home folder:
 *
 *   <home>/scheduled/<id>/task.json             the action (`{ version: 2, task }`)
 *   <home>/scheduled/<id>/delivery.json         its saved results waiting for their delivery time (`{ version: 2, pending }`)
 *   <home>/scheduled/<id>/<date>.md             one file per run
 *   <home>/scheduled/<id>/.mutex                short lock held while this action's files change
 *   <home>/scheduled/<id>/.heartbeat            written while a process is running the action (pid, host; its mtime is refreshed)
 *
 * One folder per action, so processes working on different actions never touch the same file. The files are the
 * source of truth: every change takes the action's mutex, re-reads first (never writes from a stale copy) and goes
 * through `writeFileDurable` (temp file, fsync, `.bak`, rename). Sync `fs`, like the session store.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { readWithBackup, withFileMutex, writeFileDurable } from "../utils/durable.ts";
import { telemetryBus } from "../telemetry.ts";
import { resolveHome } from "../utils/home.ts";
export { resolveHome };
import { ValidationError } from "../types/errors.ts";
import type { CostSource } from "../session/usage.ts";
import type { ScheduledActionRecord, ScheduledRunStatus } from "../types/scheduler.ts";
import { durationMs, runFileName } from "./time.ts";

/** Lowercase kebab-case. */
export const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 48-char slug + `-` + 6 random chars. */
export const MAX_TASK_ID_LENGTH = 55;

/** A saved run waiting for its delivery time (one entry of an action's `delivery.json`). */
export interface PendingDelivery {
  id: string;
  /** Run file path, relative to `scheduled/`. */
  file: string;
  status: ScheduledRunStatus;
  readyAt: string;
  deliverAt: string;
  /** Set when the run replaced a missed occurrence: it is late whatever the clock says (a `run_now` on a `missed` action, or `onMissed: "run"`). */
  late?: boolean;
}

/** Header written at the top of every run file. */
export interface RunHeader {
  id: string;
  name: string;
  status: ScheduledRunStatus;
  startedAt: string;
  finishedAt: string;
  deliverAt: string;
  /** The run finished after its delivery time. */
  late: boolean;
  model?: string;
  /** Model calls the run made (all attempts), and what they spent: the same numbers `usageReport()` keeps for workers. */
  turns?: number;
  /** Input + output tokens. */
  tokens?: number;
  /** Everything sent; `freshInputTokens + cacheReadTokens + cacheWriteTokens`. */
  inputTokens?: number;
  freshInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Everything generated, thinking included. */
  outputTokens?: number;
  thinkingTokens?: number;
  /** `cacheReadTokens / inputTokens`, 0 to 1; absent when nothing was sent. */
  cacheHitRate?: number;
  /** `unknown` when no turn had a known price (never a made-up 0). */
  costUsd?: number | "unknown";
  /** Where the price came from: the `provider`'s reported cost, the `catalog`, `mixed`, or `unknown`. */
  costSource?: CostSource;
  /** Turns with no known price; when present, `costUsd` is a lower bound. */
  unpricedTurns?: number;
  error?: string;
}

// The `scheduled` folder of a home; in: the path helpers, out: its path.
const baseDir = (home: string): string => path.join(home, "scheduled");

// The folder of one action; refuses anything that is not an action id, so a hand-edited id can never point outside `scheduled/`; in: every per-action helper, out: its path.
function taskDir(home: string, id: string): string {
  if (typeof id !== "string" || !TASK_ID_PATTERN.test(id) || id.length > MAX_TASK_ID_LENGTH) {
    throw new ValidationError(`${JSON.stringify(id)} is not a scheduled action id.`);
  }
  return path.join(baseDir(home), id);
}
// Path of an action's record; in: the task helpers, out: its path.
const taskFile = (dir: string): string => path.join(dir, "task.json");
// Path of an action's saved deliveries; in: the delivery helpers, out: its path.
const deliveryFile = (dir: string): string => path.join(dir, "delivery.json");
// Path of the short mutex that serialises every change to one action (record and deliveries); in: updateTask/updateDeliveries/deleteTask, out: its path.
const mutexFile = (dir: string): string => path.join(dir, ".mutex");

// Path of the file a running action's owner keeps fresh; in: the heartbeat helpers, out: its path.
const heartbeatFile = (dir: string): string => path.join(dir, ".heartbeat");

/** Who is running an action and how long ago they last said so. */
export interface Heartbeat {
  pid: number;
  host: string;
  /** Identifies the scheduler instance inside that process. */
  token: string;
  ageMs: number;
}

/** Marks an action as running in this process (pid, host, token); written before the record flips to `cooking`; in: startCook, out: `<id>/.heartbeat`. */
export function writeHeartbeat(home: string, id: string, token: string): void {
  fs.writeFileSync(heartbeatFile(taskDir(home, id)), JSON.stringify({ pid: process.pid, host: os.hostname(), token }), { mode: 0o600 });
}

/** Refreshes the heartbeat's modification time; false when the file is gone; in: the scheduler tick for each run in flight. */
export function touchHeartbeat(home: string, id: string): boolean {
  try {
    const now = new Date();
    fs.utimesSync(heartbeatFile(taskDir(home, id)), now, now);
    return true;
  } catch {
    return false;
  }
}

/** The heartbeat of an action, or undefined when it has none or the file is unreadable; in: the dead-owner checks and `delete`. */
export function readHeartbeat(home: string, id: string): Heartbeat | undefined {
  try {
    const file = heartbeatFile(taskDir(home, id));
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Heartbeat>;
    if (typeof raw.pid !== "number" || typeof raw.host !== "string" || typeof raw.token !== "string") return undefined;
    return { pid: raw.pid, host: raw.host, token: raw.token, ageMs: Date.now() - fs.statSync(file).mtimeMs };
  } catch {
    return undefined;
  }
}

/** Removes the heartbeat when a run ends; in: the scheduler after a run, out: nothing. */
export function clearHeartbeat(home: string, id: string): void {
  try {
    fs.rmSync(heartbeatFile(taskDir(home, id)), { force: true });
  } catch {
    // why: a leftover heartbeat of a finished run is harmless (it is only read for actions that are cooking).
  }
}

// Deletes the leftover temp files of a task.json / delivery.json write that never finished (a killed process); only called while holding the action's mutex, which is what makes it safe (run files are written outside the mutex, so they are never touched); in: the three mutating helpers, out: nothing.
function sweepShardTemps(dir: string): void {
  try {
    for (const name of fs.readdirSync(dir)) if (/^(task|delivery)\.json\.tmp-\d+-[0-9a-z]+$/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
  } catch {
    // why: an unreadable folder or an undeletable leftover is harmless.
  }
}

/** Absolute path of a run file given its `scheduled/`-relative path. */
export function runPath(home: string, relativeFile: string): string {
  return path.resolve(baseDir(home), relativeFile);
}

type Raw = Record<string, unknown>;

// Parses `{ version, task: {...} }` into the record; undefined when the text is not that shape; in: readShard, out: the record.
function parseTask(text: string): Raw | undefined {
  try {
    const task = (JSON.parse(text) as Raw | null)?.["task"];
    return task && typeof task === "object" && !Array.isArray(task) ? (task as Raw) : undefined;
  } catch {
    return undefined;
  }
}

// Parses `{ version, pending: [...] }` into its object entries; undefined when the text is not that shape; in: readShard, out: the entries.
function parsePending(text: string): Raw[] | undefined {
  try {
    const list = (JSON.parse(text) as Raw | null)?.["pending"];
    if (!Array.isArray(list)) return undefined;
    return list.filter((x): x is Raw => !!x && typeof x === "object" && !Array.isArray(x));
  } catch {
    return undefined;
  }
}

/**
 * Reads one JSON file of an action. Missing = undefined. A damaged file is renamed `*.corrupt-<ts>`; if its `.bak`
 * (the last good version) is valid it is restored and returned, else undefined (the action is treated as absent).
 */
function readShard<T>(file: string, parse: (text: string) => T | undefined): T | undefined {
  const read = readWithBackup(file, (t) => parse(t) !== undefined);
  if (!read) return undefined;
  const value = parse(read.text);
  if (value !== undefined && !read.fromBackup) return value;
  const moved = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, moved);
  } catch {
    // why: quarantine is best-effort; the file is ignored either way.
  }
  if (value !== undefined) {
    try {
      writeFileDurable(file, read.text, { backup: false }); // keep the good .bak where it is
    } catch {
      // why: the backup content is still returned for this read.
    }
  }
  telemetryBus.emitWarning(
    "scheduled_action.store_corrupt",
    `[Agent Accelerator] ${path.relative(baseDir(path.dirname(path.dirname(file))), file)} is not valid; moved to ${path.basename(moved)} and ${value !== undefined ? "restored from its backup" : "ignored"}.`,
    { file: moved, restored: value !== undefined }
  );
  return value;
}

// Names of the action folders of a home (every folder not starting with a dot), sorted; in: readTasks/readDeliveries, out: folder names.
function actionFolders(home: string): string[] {
  try {
    return fs
      .readdirSync(baseDir(home), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Folder/id mismatches already reported, so a bad hand edit warns once per process. */
const reportedMismatch = new Set<string>();
// True when a record or delivery names the folder it sits in; otherwise warns once and says no; in: readTasks/readDeliveries, out: a boolean.
function inOwnFolder(file: string, folder: string, id: unknown): boolean {
  if (id === folder) return true;
  const key = `${file}:${String(id)}`;
  if (!reportedMismatch.has(key)) {
    reportedMismatch.add(key);
    telemetryBus.emitWarning(
      "scheduled_action.invalid",
      `[Agent Accelerator] ${folder}/${path.basename(file)} names the id ${JSON.stringify(id)} but sits in the folder "${folder}" and is skipped.`,
      { id: String(id), problem: "id: does not match its folder", file: path.basename(file) }
    );
  }
  return false;
}

// Orders records by creation time, then id, so listings are stable; in: readTasks, out: a comparison number.
function byCreation(a: ScheduledActionRecord, b: ScheduledActionRecord): number {
  return (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id);
}

/** One action as stored (`task.json`), or undefined when it does not exist or `id` is not an action id. May be invalid: check with {@link validateRecord}. */
export function readTask(home: string, id: string): ScheduledActionRecord | undefined {
  let dir: string;
  try {
    dir = taskDir(home, id);
  } catch {
    return undefined;
  }
  const raw = readShard(taskFile(dir), parseTask);
  return raw && inOwnFolder(taskFile(dir), id, raw["id"]) ? (raw as unknown as ScheduledActionRecord) : undefined;
}

/** Every record as stored, oldest first. Records may be invalid: check with {@link validateRecord} before acting on one. */
export function readTasks(home: string): ScheduledActionRecord[] {
  const out: ScheduledActionRecord[] = [];
  for (const folder of actionFolders(home)) {
    if (!TASK_ID_PATTERN.test(folder) || folder.length > MAX_TASK_ID_LENGTH) continue; // not an action folder
    const rec = readTask(home, folder);
    if (rec) out.push(rec);
  }
  return out.sort(byCreation);
}

/**
 * Changes one action under its own short mutex: re-reads `task.json`, calls `fn` (which may mutate the record in place;
 * it gets `undefined` when the action does not exist) and writes the record back if it changed. If `fn` throws nothing
 * is written. Other actions are never locked, so processes working on different actions do not wait for each other.
 */
export function updateTask<T>(home: string, id: string, fn: (rec: ScheduledActionRecord | undefined) => T): T {
  let dir: string;
  try {
    dir = taskDir(home, id);
  } catch {
    return fn(undefined); // not an action id: nothing to change
  }
  if (!fs.existsSync(dir)) return fn(undefined);
  return withFileMutex(mutexFile(dir), () => {
    sweepShardTemps(dir);
    const rec = readTask(home, id);
    const before = rec ? JSON.stringify(rec) : "";
    const result = fn(rec);
    if (rec && JSON.stringify(rec) !== before) writeFileDurable(taskFile(dir), JSON.stringify({ version: 2, task: rec }, null, 2) + "\n");
    return result;
  });
}

/**
 * Creates an action in a new folder. The folder is made with a create-only `mkdir`, so two processes can never take the
 * same id; `nextId` is called again until a free one is found, then `build` makes the record for it.
 */
export function createTask(home: string, nextId: () => string, build: (id: string) => ScheduledActionRecord): ScheduledActionRecord {
  fs.mkdirSync(baseDir(home), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = nextId();
    const dir = taskDir(home, id);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") continue;
      throw err;
    }
    const rec = build(id);
    withFileMutex(mutexFile(dir), () => {
      sweepShardTemps(dir);
      writeFileDurable(taskFile(dir), JSON.stringify({ version: 2, task: rec }, null, 2) + "\n");
    });
    return rec;
  }
  throw new ValidationError("Could not find a free scheduled action id.");
}

/** Removes an action's record and saved deliveries (run files stay); true when there was something to remove. An emptied folder is removed too. */
export function deleteTask(home: string, id: string): boolean {
  const dir = taskDir(home, id);
  if (!fs.existsSync(dir)) return false;
  const removed = withFileMutex(mutexFile(dir), () => {
    const had = fs.existsSync(taskFile(dir)) || fs.existsSync(deliveryFile(dir));
    for (const f of [taskFile(dir), deliveryFile(dir)]) fs.rmSync(f, { force: true }), fs.rmSync(`${f}.bak`, { force: true });
    fs.rmSync(heartbeatFile(dir), { force: true });
    return had;
  });
  try {
    fs.rmdirSync(dir); // only succeeds when nothing is left in it
  } catch {
    // why: run files (or another process's new action) keep the folder.
  }
  return removed;
}

/** Every saved delivery of every action as stored, soonest first (entries may be invalid: check with validateDelivery). */
export function readDeliveries(home: string): PendingDelivery[] {
  const out: PendingDelivery[] = [];
  for (const folder of actionFolders(home)) {
    if (!TASK_ID_PATTERN.test(folder) || folder.length > MAX_TASK_ID_LENGTH) continue;
    const file = deliveryFile(taskDir(home, folder));
    for (const entry of readShard(file, parsePending) ?? []) if (inOwnFolder(file, folder, entry["id"])) out.push(entry as unknown as PendingDelivery);
  }
  return out.sort((a, b) => String(a.deliverAt).localeCompare(String(b.deliverAt)));
}

/** Changes the saved deliveries of ONE action under its short mutex (`fn` mutates the array in place); the file is removed when the list ends up empty. */
export function updateDeliveries<T>(home: string, id: string, fn: (pending: PendingDelivery[]) => T): T {
  const dir = taskDir(home, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withFileMutex(mutexFile(dir), () => {
    sweepShardTemps(dir);
    const file = deliveryFile(dir);
    const pending = (readShard(file, parsePending) ?? []) as unknown as PendingDelivery[];
    const result = fn(pending);
    if (pending.length === 0) {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.bak`, { force: true });
    } else {
      writeFileDurable(file, JSON.stringify({ version: 2, pending }, null, 2) + "\n");
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Record validation (the file is hand/agent-editable, so it is untrusted)
// ---------------------------------------------------------------------------

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
const recordSchema = z
  .object({
    id: z.string().max(MAX_TASK_ID_LENGTH).regex(TASK_ID_PATTERN),
    name: z.string().min(1),
    agent: z.string().min(1),
    instructions: z.string().min(1),
    task: z.string().min(1),
    tools: z.array(z.string()),
    timeoutMs: z.number().optional(),
    schedule: z.object({
      timeToDeliver: z.string(),
      meridiem: z.enum(["AM", "PM"]),
      startCookingInAdvance: z.string(),
      repeatEvery: z.string().optional(),
      retries: z.number().int().min(0).optional(),
      onMissed: z.enum(["skip", "run"]).optional(),
    }),
    state: z.enum(["waiting", "cooking", "missed", "done"]),
    nextCookAt: iso.nullable(),
    nextDeliverAt: iso.nullable(),
    current: z.object({ cookStartedAt: iso, deliverAt: iso }).optional(),
  })
  .refine((r) => r.state !== "cooking" || r.current !== undefined, { message: "current: required while cooking" });

/** `undefined` when the record is usable, else a one-line reason. Never throws. */
export function validateRecord(raw: unknown): string | undefined {
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`).join("; ");
  }
  const { startCookingInAdvance, repeatEvery } = parsed.data.schedule;
  try {
    durationMs(startCookingInAdvance, "schedule.startCookingInAdvance");
    if (repeatEvery !== undefined && durationMs(repeatEvery, "schedule.repeatEvery") === 0) {
      return "schedule.repeatEvery: must be greater than 00:00:00";
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return undefined;
}

const deliverySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  status: z.enum(["ok", "failed"]),
  readyAt: iso,
  deliverAt: iso,
  late: z.boolean().optional(),
});

/** `undefined` when a `delivery.json` entry is usable, else a one-line reason. Never throws. */
export function validateDelivery(raw: unknown): string | undefined {
  const parsed = deliverySchema.safeParse(raw);
  return parsed.success ? undefined : parsed.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`).join("; ");
}

// ---------------------------------------------------------------------------
// Run files
// ---------------------------------------------------------------------------

// Renders a run file: the `---` header lines, a blank line, the result text; in: writeRunFile, out: the file text.
function renderRun(header: RunHeader, body: string): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(header)) {
    if (value !== undefined) lines.push(`${key}: ${String(value).replace(/\s+/g, " ")}`);
  }
  lines.push("---", "", body);
  return lines.join("\n") + "\n";
}

/**
 * Writes one run under its final name (`27-october-2026.md`, `-2`, `-3` on a
 * same-day clash) and returns its path relative to `scheduled/`.
 */
export function writeRunFile(home: string, id: string, deliverAt: Date, header: RunHeader, body: string): string {
  const dir = path.join(baseDir(home), id);
  const base = runFileName(deliverAt);
  let name = `${base}.md`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}.md`;
  writeFileDurable(path.join(dir, name), renderRun(header, body), { backup: false }); // written once, never rewritten
  return `${id}/${name}`;
}

/** Reads a run file (header fields as strings + result text). `undefined` when missing or outside the folder. */
export function readRun(home: string, relativeFile: string): { header: Record<string, string>; body: string } | undefined {
  const file = runPath(home, relativeFile);
  if (!file.startsWith(baseDir(home) + path.sep)) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  const header: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(": ");
    if (i > 0) header[line.slice(0, i)] = line.slice(i + 2);
  }
  return { header, body: m[2]!.replace(/\n$/, "") };
}

/** The run file a crashed cook already wrote (matched by its `startedAt`), if any. */
export function findRunFile(home: string, id: string, deliverAt: Date, startedAt: string): string | undefined {
  const base = runFileName(deliverAt);
  let names: string[];
  try {
    names = fs.readdirSync(path.join(baseDir(home), id));
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.startsWith(base) || !name.endsWith(".md")) continue;
    if (readRun(home, `${id}/${name}`)?.header["startedAt"] === startedAt) return `${id}/${name}`;
  }
  return undefined;
}

/** Deletes an action's folder (`purge`). Only ever inside `scheduled/`. */
export function removeTaskFolder(home: string, id: string): void {
  const root = baseDir(home);
  const dir = path.resolve(root, id);
  if (!TASK_ID_PATTERN.test(id) || id.length > MAX_TASK_ID_LENGTH || !dir.startsWith(root + path.sep)) {
    throw new ValidationError(`Refusing to remove ${JSON.stringify(id)}: not a scheduled action id.`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
