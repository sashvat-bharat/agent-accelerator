/**
 * How the SDK writes state to disk safely. One writer for sessions, scheduled
 * actions and the catalog cache: a crash or a power cut leaves either the old
 * file or the new one, never a torn mix, and the last good version is kept as
 * `<file>.bak`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

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
