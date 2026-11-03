/**
 * One log file per tool call, inside the session folder: `tool-logs/<n>-<tool>.ndjson`. The executor writes its own
 * steps into it (input, attempts, retries, result or error, duration) and a tool adds its own with `ctx.log(...)`.
 * Every line is flushed to disk as it is written, so after a crash the file shows how far the call got. The file is for
 * developers and harnesses: it is never sent to the model, and nothing in the SDK reads it back.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fsyncFolder } from "../utils/durable.ts";

/** The log of one tool call, as the executor sees it. */
export interface ToolLogWriter {
  /** Path relative to the session folder (`tool-logs/003-send_email.ndjson`); saved on the call's result. */
  readonly file: string;
  /** Appends one line (`timestamp` is added) and flushes it. Never throws. */
  write(entry: Record<string, unknown>): void;
  /** Closes the file; later writes (a tool still running after a timeout) are ignored. */
  close(): void;
}

/** Hands out the log files of one session folder, numbering them in the order the calls start. */
export class ToolLogs {
  private next: number | undefined;

  constructor(private readonly sessionDir: string) {}

  // Opens `tool-logs/<n>-<tool>.ndjson` for one call; the numbering continues after files from earlier runs and restarts; in: a tool call as the executor starts it, out: the writer the executor and `ctx.log` write through.
  open(call: { name: string }): ToolLogWriter | undefined {
    const dir = path.join(this.sessionDir, "tool-logs");
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.next ??= fs.readdirSync(dir).reduce((max, f) => Math.max(max, Number(/^(\d+)-/.exec(f)?.[1] ?? 0)), 0) + 1;
      const name = `${String(this.next++).padStart(3, "0")}-${call.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)}.ndjson`;
      const fd = fs.openSync(path.join(dir, name), "a", 0o600);
      fsyncFolder(dir);
      let open = true;
      return {
        file: `tool-logs/${name}`,
        write(entry) {
          if (!open) return;
          try {
            fs.writeSync(fd, JSON.stringify({ timestamp: Date.now(), ...entry }) + "\n");
            fs.fdatasyncSync(fd);
          } catch {
            // why: a full disk must never fail the tool call being logged.
          }
        },
        close() {
          if (!open) return;
          open = false;
          try {
            fs.closeSync(fd);
          } catch {
            // why: nothing left to flush.
          }
        },
      };
    } catch {
      return undefined; // logging is best effort: the call runs without a log
    }
  }
}
