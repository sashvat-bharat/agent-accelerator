/**
 * The end user's saved choices: `<home>/configs.json`, a small visible file the user may also edit by hand. It holds the
 * chosen `model` and `sub_agent_model` and the values of settings the program lets the user change. It is written with the
 * one durable writer (fsync, `.bak`, atomic rename) under a short mutex that re-reads first, so several processes sharing
 * a home never lose each other's changes, and a crash leaves the old file or the new one, never a torn mix.
 *
 * `{ "version": 1, "model": "google/gemini-4-argon", "sub_agent_model": "...", "concurrency": { "max_requests": 2 } }`
 *
 * This module only reads and writes the file (raw values). What a value means, and whether the program allows it, is
 * decided by `settings.ts` and `models.ts`. Reading never throws: a missing, damaged or newer-version file is reported on
 * the telemetry bus and treated as empty.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readWithBackup, withFileMutex, writeFileDurable } from "../utils/durable.ts";
import { onHomeChange, resolveHome } from "../utils/home.ts";
import { telemetryBus } from "../telemetry.ts";
import { ConfigError } from "../types/errors.ts";

/** The file format version this release writes and reads. */
const CONFIGS_VERSION = 1;

/** What the file holds, before the program's rules are applied. */
interface UserFile {
  model?: string;
  sub_agent_model?: string;
  /** Raw setting values by key; unknown keys are kept here so the file is rewritten without losing them. */
  settings: Record<string, unknown>;
}

/** Path of the file in a home folder. */
export function configsPath(home: string): string {
  return path.join(home, "configs.json");
}

let cached: { home: string; file: UserFile } | undefined;
const reported = new Set<string>();

/** Reports a problem with the user's file once per kind and subject; in: the readers here and in `settings.ts` / `models.ts`, out: a warning on the bus. */
export function warnOnce(code: string, message: string, data: Record<string, unknown>): void {
  const key = `${code}:${JSON.stringify(data)}`;
  if (reported.has(key)) return;
  reported.add(key);
  telemetryBus.emitWarning(code, `[Agent Accelerator] ${message}`, data);
}

// Splits file text into its parts, or says why it cannot: "invalid" (not a JSON object) or "version" (another format version); in: readUserFile, out: the parsed file or a tag.
function parse(text: string): UserFile | "invalid" | "version" {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "invalid";
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const { version, model, sub_agent_model, ...settings } = raw as Record<string, unknown>;
  if (version !== undefined && version !== CONFIGS_VERSION) return "version"; // a file without a version (hand-written) counts as version 1
  const file: UserFile = { settings };
  if (typeof model === "string" && model.trim()) file.model = model.trim();
  if (typeof sub_agent_model === "string" && sub_agent_model.trim()) file.sub_agent_model = sub_agent_model.trim();
  return file;
}

// Reads the file of one home; a damaged file is renamed `*.corrupt-<ts>` and its `.bak` (the last good version) used when valid; never throws; in: current() and saveUserFile, out: the parsed file (empty when there is none).
function readUserFile(home: string): UserFile {
  const file = configsPath(home);
  const read = readWithBackup(file, (t) => typeof parse(t) === "object");
  if (!read) return { settings: {} };
  const parsed = parse(read.text);
  if (typeof parsed === "object" && !read.fromBackup) return parsed;
  if (typeof parsed === "object") {
    // The file itself is damaged but its backup is good: keep the damaged one aside and restore the good text.
    const moved = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, moved);
      writeFileDurable(file, read.text, { backup: false });
    } catch {
      // why: restoring is best effort; the good content is returned for this read either way.
    }
    warnOnce(
      "config.file_restored",
      `${file} was damaged; its last good version was restored (the damaged one is kept as ${path.basename(moved)}).`,
      { file }
    );
    return parsed;
  }
  if (parsed === "version") {
    warnOnce(
      "config.file_invalid",
      `${file} has an unsupported version and is ignored (this release reads version ${CONFIGS_VERSION}).`,
      { file, reason: "version" }
    );
  } else {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // why: the file is ignored either way.
    }
    warnOnce(
      "config.file_invalid",
      `${file} is not valid JSON and is ignored (kept as ${path.basename(file)}.corrupt-<time>).`,
      { file, reason: "invalid" }
    );
  }
  return { settings: {} };
}

/** The user's file for the current home, read once per home (a missing file or home is simply empty; nothing is created by reading). */
export function currentUserFile(): UserFile {
  const home = resolveHome();
  if (cached?.home !== home) cached = { home, file: readUserFile(home) };
  return cached.file;
}

/** Forgets what was read, so the next access reads the file again (a new home, a test). */
export function invalidateUserFile(): void {
  cached = undefined;
  reported.clear();
}
onHomeChange(invalidateUserFile);

/**
 * Changes the user's file: under a short mutex it re-reads the file (another process may have written), lets `change`
 * edit a copy, and writes the result durably. The home folder is created on the first write. Throws a `ConfigError` when
 * the file cannot be written; then nothing has changed.
 */
export function saveUserFile(change: (file: UserFile) => void): UserFile {
  const home = resolveHome();
  const target = configsPath(home);
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const next = withFileMutex(path.join(home, ".configs.mutex"), () => {
      const fresh = readUserFile(home);
      const copy: UserFile = { ...fresh, settings: { ...fresh.settings } };
      change(copy);
      const body: Record<string, unknown> = { version: CONFIGS_VERSION };
      if (copy.model) body["model"] = copy.model;
      if (copy.sub_agent_model) body["sub_agent_model"] = copy.sub_agent_model;
      Object.assign(body, copy.settings);
      writeFileDurable(target, JSON.stringify(body, null, 2) + "\n");
      return copy;
    });
    cached = { home, file: next };
    return next;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(
      `[Agent Accelerator] Could not save ${target}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
