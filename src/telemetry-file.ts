/**
 * Opt-in disk sink for the telemetry bus (`AgentConfig.telemetry.persist`).
 * Appends one JSON line per event to `<home>/telemetry/<YYYY-MM-DD>.ndjson`.
 * Each event is a single synchronous append, so a process crash keeps every
 * event already emitted: a `tool.call_started` with no ending event was in
 * flight, and the last `tool.progress` shows how far it got. Power loss is not
 * covered (no fsync). `turn.thinking` (full reasoning text) is never written.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { telemetryBus } from "./telemetry.ts";
import { safeStringify } from "./utils/serialization.ts";

const sinks = new Set<string>();

/** Starts appending bus events under `home` (idempotent per folder). */
export function persistTelemetry(home: string): void {
  const dir = path.join(home, "telemetry");
  if (sinks.has(dir)) return;
  sinks.add(dir);
  telemetryBus.onEvent((event) => {
    if (event.code === "turn.thinking") return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${new Date(event.timestamp).toISOString().slice(0, 10)}.ndjson`);
      fs.appendFileSync(file, safeStringify(event) + "\n", { mode: 0o600 });
    } catch {
      // why: a full disk must never fail a run, and reporting it would re-enter this listener.
    }
  });
}
