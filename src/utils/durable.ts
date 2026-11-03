/**
 * How the SDK writes state to disk safely. One writer for sessions, scheduled
 * actions and the catalog cache: a crash or a power cut leaves either the old
 * file or the new one, never a torn mix, and the last good version is kept as
 * `<file>.bak`. Also the one-process-per-folder lock and the stale temp-file sweep.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigError } from "../types/errors.ts";

// Flushes a folder's entries (a new or renamed file) to disk; best effort because some platforms cannot open a folder; in: the folder of a written file, out: nothing.
function fsyncFolder(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // why: Windows (and some filesystems) refuse to open or fsync a folder; the file itself is already flushed.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // why: closing a read-only folder handle cannot lose data.
      }
    }
  }
}

/**
 * Durable atomic write: temp file (0600) -> fsync -> previous version kept as `<file>.bak` (hard link, no copy)
 * -> rename -> fsync of the folder. Throws on failure; the temp file is removed. `backup: false` skips the `.bak`.
 */
export function writeFileDurable(filePath: string, content: string | Uint8Array, opts: { backup?: boolean } = {}): void {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // why: a missing folder surfaces as the open() error below, with a clearer path.
  }
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 8);
  const tmp = `${filePath}.tmp-${process.pid}-${rand}`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (opts.backup !== false) {
      try {
        fs.rmSync(`${filePath}.bak`, { force: true });
        fs.linkSync(filePath, `${filePath}.bak`); // the old inode survives the rename below
      } catch {
        // why: no previous version (first write) or no hard links on this filesystem: the write still goes ahead.
      }
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // why: the original error is the one worth reporting.
    }
    throw err;
  }
  fsyncFolder(dir);
}

/**
 * Reads `file`; when `isValid` rejects it, falls back to `<file>.bak`. `undefined` when the file is missing (a deleted
 * file is never resurrected from its backup). When both are invalid the primary text comes back, `fromBackup: false`.
 */
export function readWithBackup(file: string, isValid: (text: string) => boolean): { text: string; fromBackup: boolean } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  if (isValid(text)) return { text, fromBackup: false };
  try {
    const backup = fs.readFileSync(`${file}.bak`, "utf8");
    if (isValid(backup)) return { text: backup, fromBackup: true };
  } catch {
    // why: no backup to fall back to.
  }
  return { text, fromBackup: false };
}

// ---------------------------------------------------------------------------
// One process per folder
// ---------------------------------------------------------------------------

/** Folders this process already holds (the lock is re-entrant: many Agents share one home). */
const heldFolders = new Set<string>();
let exitHookInstalled = false;

// Blocks the thread for `ms` (a lock file being written by another process is the only reason to wait); in: a short delay, out: nothing.
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// True while process `pid` exists (EPERM means it exists but belongs to someone else); in: a pid from a lock file, out: lockFolder's stale check.
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

// Removes the locks this process still holds when it exits normally; a killed process leaves its lock for the next start to detect as stale.
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const dir of heldFolders) {
      try {
        fs.rmSync(path.join(dir, ".lock"), { force: true });
      } catch {
        // why: nothing can be reported while exiting; a leftover lock is detected as stale.
      }
    }
  });
}

// Deletes leftover `<file>.tmp-<pid>-<rand>` files of writes that never finished; only safe while holding the folder lock; in: a locked folder, out: nothing.
function sweepTempFiles(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sweepTempFiles(full);
    else if (/\.tmp-\d+-[0-9a-z]+$/.test(entry.name)) {
      try {
        fs.rmSync(full, { force: true });
      } catch {
        // why: an undeletable leftover is harmless.
      }
    }
  }
}

/**
 * Takes the one-process lock of a folder (`<dir>/.lock` = pid, host, start time) and sweeps the temp files of writes
 * that never finished. Re-entrant inside one process. Throws `ConfigError` at once when another live process holds it;
 * a lock left by a dead process (same host, pid gone) or an unreadable one is taken over. Local disks only.
 */
export function lockFolder(folder: string): void {
  const dir = path.resolve(folder);
  if (heldFolders.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(dir, ".lock");
  const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() });
  let unreadable = 0;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      try {
        fs.writeFileSync(fd, mine);
      } finally {
        fs.closeSync(fd);
      }
      heldFolders.add(dir);
      installExitHook();
      sweepTempFiles(dir);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
    }
    let text = "";
    try {
      text = fs.readFileSync(lockFile, "utf8");
    } catch {
      continue; // released between the open and the read: try again
    }
    let owner: { pid?: unknown; host?: unknown; startedAt?: unknown } | undefined;
    try {
      owner = JSON.parse(text);
    } catch {
      owner = undefined;
    }
    if (typeof owner?.pid !== "number") {
      // Empty or garbage: another process may be mid-write. Give it a moment, then treat it as stale.
      if (++unreadable <= 5) {
        pause(40);
        continue;
      }
    } else if (owner.pid !== process.pid) {
      if (owner.host !== os.hostname()) {
        throw new ConfigError(
          `[Agent Accelerator] Folder "${dir}" is locked by host "${String(owner.host)}" (process ${owner.pid}). Only local disks are supported: use a folder on this machine.`
        );
      }
      if (processAlive(owner.pid)) {
        throw new ConfigError(
          `[Agent Accelerator] Folder "${dir}" is already in use by process ${owner.pid} (started ${String(owner.startedAt)}). ` +
            `Only one process may use it at a time: stop that process or use another folder (Agent \`home\`, setHome(), AGENT_ACCEL_HOME). ` +
            `If that process is gone, delete "${lockFile}".`
        );
      }
    }
    // Stale (dead owner, our own pid from an earlier life, or unreadable): take it over, but only if nobody replaced it meanwhile.
    try {
      if (fs.readFileSync(lockFile, "utf8") === text) fs.rmSync(lockFile, { force: true });
    } catch {
      // why: it vanished: the next loop turn creates it.
    }
  }
}
