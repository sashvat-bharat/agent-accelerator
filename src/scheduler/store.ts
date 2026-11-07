/**
 * Disk layer for scheduled actions. Everything lives under one home folder:
 *
 *   <home>/scheduled_actions/tasks.json         every action, one file
 *   <home>/scheduled_actions/deliveries.json    saved results waiting for their delivery time
 *   <home>/scheduled_actions/<id>/<date>.md     one file per run
 *
 * The files are the source of truth: every write re-reads first (never writes
 * from a stale copy) and goes through `writeFileDurable` (temp file, fsync, `.bak`, rename).
 * Sync `fs`, like the session store.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { readWithBackup, writeFileDurable } from "../utils/durable.ts";
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

/** A saved run waiting for its delivery time (one entry of `deliveries.json`). */
export interface PendingDelivery {
  id: string;
  /** Run file path, relative to `scheduled_actions/`. */
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

// The `scheduled_actions` folder of a home; in: the path helpers, out: its path.
const baseDir = (home: string): string => path.join(home, "scheduled_actions");
// Path of tasks.json; in: readTasks/updateTasks, out: its path.
const tasksFile = (home: string): string => path.join(baseDir(home), "tasks.json");
// Path of deliveries.json; in: readDeliveries/updateDeliveries, out: its path.
const deliveriesFile = (home: string): string => path.join(baseDir(home), "deliveries.json");

/** Absolute path of a run file given its `scheduled_actions/`-relative path. */
export function runPath(home: string, relativeFile: string): string {
  return path.resolve(baseDir(home), relativeFile);
}

/** Renames the pre-0.5.0 `scheduled_tasks/` folder to `scheduled_actions/` (once, only when the new one does not exist). */
export function migrateLegacyFolder(home: string): void {
  const legacy = path.join(home, "scheduled_tasks");
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(baseDir(home))) fs.renameSync(legacy, baseDir(home));
  } catch {
    // why: best effort; the old folder simply stays where it is.
  }
}

type Raw = Record<string, unknown>;

// Parses a `{ version, <key>: [...] }` file into its object entries; undefined when the text is not that shape; in: raw file text, out: readList.
function parseList(text: string, key: "tasks" | "pending"): Raw[] | undefined {
  try {
    const list = (JSON.parse(text) as Raw | null)?.[key];
    if (!Array.isArray(list)) return undefined;
    return list.filter((x): x is Raw => !!x && typeof x === "object" && !Array.isArray(x));
  } catch {
    return undefined;
  }
}

/**
 * Reads a `{ version, <key>: [...] }` file. Missing = empty. A damaged file is renamed `*.corrupt-<ts>`; if its `.bak`
 * (the last good version) is valid it is restored, else the list starts empty.
 */
function readList(file: string, key: "tasks" | "pending"): Raw[] {
  const read = readWithBackup(file, (t) => parseList(t, key) !== undefined);
  if (!read) return [];
  const list = parseList(read.text, key);
  if (list && !read.fromBackup) return list;
  const moved = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, moved);
  } catch {
    // why: quarantine is best-effort; the file is ignored either way.
  }
  if (list) {
    try {
      writeFileDurable(file, read.text, { backup: false }); // keep the good .bak where it is
    } catch {
      // why: the backup content is still returned for this read.
    }
  }
  telemetryBus.emitWarning(
    "scheduled_action.store_corrupt",
    `[Agent Accelerator] ${path.basename(file)} is not valid; moved to ${path.basename(moved)} and ${list ? "restored from its backup" : "starting empty"}.`,
    { file: moved, restored: !!list }
  );
  return list ?? [];
}

// Writes `{ version, <key>: [...] }` durably (with a .bak); in: updateTasks/updateDeliveries, out: the file.
function writeList(file: string, key: "tasks" | "pending", list: Raw[]): void {
  writeFileDurable(file, JSON.stringify({ version: 1, [key]: list }, null, 2) + "\n");
}

/** Every record as stored. Records may be invalid: check with {@link validateRecord} before acting on one. */
export function readTasks(home: string): ScheduledActionRecord[] {
  return readList(tasksFile(home), "tasks") as unknown as ScheduledActionRecord[];
}

/** Re-reads `tasks.json`, applies `fn` (mutating the array/records in place) and writes it back. */
export function updateTasks<T>(home: string, fn: (tasks: ScheduledActionRecord[]) => T): T {
  const tasks = readTasks(home);
  const result = fn(tasks);
  writeList(tasksFile(home), "tasks", tasks as unknown as Raw[]);
  return result;
}

/** Every saved delivery as stored (entries may be invalid: check with validateDelivery); in: the scheduler, out: PendingDelivery[]. */
export function readDeliveries(home: string): PendingDelivery[] {
  return readList(deliveriesFile(home), "pending") as unknown as PendingDelivery[];
}

/** Re-reads `deliveries.json`, applies `fn` (mutating in place) and writes it back. */
export function updateDeliveries<T>(home: string, fn: (pending: PendingDelivery[]) => T): T {
  const pending = readDeliveries(home);
  const result = fn(pending);
  writeList(deliveriesFile(home), "pending", pending as unknown as Raw[]);
  return result;
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

/** `undefined` when a `deliveries.json` entry is usable, else a one-line reason. Never throws. */
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
 * same-day clash) and returns its path relative to `scheduled_actions/`.
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

/** Deletes an action's folder (`purge`). Only ever inside `scheduled_actions/`. */
export function removeTaskFolder(home: string, id: string): void {
  const root = baseDir(home);
  const dir = path.resolve(root, id);
  if (!TASK_ID_PATTERN.test(id) || id.length > MAX_TASK_ID_LENGTH || !dir.startsWith(root + path.sep)) {
    throw new ValidationError(`Refusing to remove ${JSON.stringify(id)}: not a scheduled action id.`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
