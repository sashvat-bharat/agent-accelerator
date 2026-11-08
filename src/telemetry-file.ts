/**
 * Opt-in disk sink for the telemetry bus (`AgentConfig.telemetry.persist`). Appends one JSON line per event.
 * An event that carries the id of a persisted session (`data.sessionId`) goes to that session's own file,
 * `<session folder>/telemetry.ndjson`, so a session's trace sits next to its journal and tool logs; every other event
 * goes to `<home>/telemetry/<YYYY-MM-DD>.ndjson`. Nothing is ever written outside a home folder: a session folder
 * that is not inside a home that enabled telemetry (a `persist.dir` pointing elsewhere) falls back to the daily file.
 * Each event is a single synchronous append, so a process crash keeps every event already emitted: a
 * `tool.call_started` with no ending event was in flight, and the last `tool.progress` shows how far it got. Power loss
 * is not covered (no fsync, by design: this is observability, not state). `turn.thinking` (full reasoning text) is never
 * written. Several processes may enable the same home: each event is one append, so lines never mix.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { telemetryBus } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import { safeStringify } from "./utils/serialization.ts";

/** Homes (resolved paths) that asked for telemetry. */
const homes = new Set<string>();
/** Where each persisted session lives, by session id. */
const sessionFolders = new Map<string, string>();
let unsubscribe: (() => void) | undefined;

// True when `folder` is `home` itself or below it; in: the routing decision, out: a boolean.
function inside(home: string, folder: string): boolean {
  const rel = path.relative(home, folder);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Appends one line to a file, creating its folder; a full disk must never fail a run, and reporting it would re-enter this listener; in: the listener, out: the file.
function append(file: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch {
    // why: observability must never fail a run.
  }
}

// The bus listener: skips reasoning text, writes a session's event to its own folder when that folder is inside an enabled home, else to the daily file of every enabled home; in: each bus event, out: NDJSON files.
function onEvent(event: TelemetryEvent): void {
  if (event.code === "turn.thinking") return;
  const line = safeStringify(event) + "\n";
  const id = (event.data as { sessionId?: unknown } | undefined)?.sessionId;
  const folder = typeof id === "string" ? sessionFolders.get(id) : undefined;
  if (folder && [...homes].some((h) => inside(h, folder))) {
    append(path.join(folder, "telemetry.ndjson"), line);
    return;
  }
  const day = new Date(event.timestamp).toISOString().slice(0, 10);
  for (const home of homes) {
    if (!fs.existsSync(home)) {
      homes.delete(home); // a deleted home is not recreated by a stray event
      continue;
    }
    append(path.join(home, "telemetry", `${day}.ndjson`), line);
  }
}

/** Starts appending bus events for `home` (idempotent per folder); one listener serves every enabled home. */
export function persistTelemetry(home: string): void {
  const resolved = path.resolve(home);
  unsubscribe = telemetryBus.onEvent(onEvent); // listeners are a Set, so this is idempotent, and it restores the sink after `telemetryBus.clear()`
  if (homes.has(resolved)) return;
  homes.add(resolved);
}

/** Remembers where a persisted session lives, so its events are written next to it; in: the Agent constructor and `importSession`, out: the routing map. */
export function registerSessionFolder(sessionId: string, folder: string): void {
  sessionFolders.set(sessionId, path.resolve(folder));
}

/** Forgets a session's folder (its events fall back to the daily file); in: `disposeSession` and `importSession`, out: the routing map. */
export function unregisterSessionFolder(sessionId: string): void {
  sessionFolders.delete(sessionId);
}

/** Forgets every enabled home and session and removes the listener. Test hook (not part of the public entry). */
export function resetTelemetryFile(): void {
  homes.clear();
  sessionFolders.clear();
  unsubscribe?.();
  unsubscribe = undefined;
}
