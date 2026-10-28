/**
 * In-process telemetry bus (Q-41). Library code routes warnings, anomalies and
 * per-turn traces here instead of `console.*`. The default has zero listeners,
 * so emission is a no-op; CLIs, tests and observability layers attach with
 * `telemetryBus.onEvent`. Intentionally dependency-free: every module in the
 * SDK (providers, catalog cache, event stream, loop, session store) may import
 * it without creating an import cycle.
 */

/** Telemetry event emitted via the in-process bus (Q-41). */
export interface TelemetryEvent {
  code: string;
  message: string;
  level?: "info" | "warn" | "error";
  data?: unknown;
  timestamp: number;
}

/** Listener subscribed via `telemetryBus.onEvent`. */
export type TelemetryListener = (event: TelemetryEvent) => void;

interface TelemetryBus {
  /** Subscribes to telemetry events. Returns an unsubscribe function. Default: no-op delivery (no listeners, no console). */
  onEvent(listener: TelemetryListener): () => void;
  /** Emits a warning (level `warn`). Never throws, never logs to console. */
  emitWarning(code: string, message: string, data?: unknown): void;
  /** Emits a generic event. Never throws, never logs to console. */
  emit(event: Omit<TelemetryEvent, "timestamp"> & { timestamp?: number }): void;
  /** Removes all listeners (useful in tests). */
  clear(): void;
}

export const telemetryBus: TelemetryBus = (() => {
  const listeners = new Set<TelemetryListener>();
  const deliver = (event: TelemetryEvent): void => {
    for (const l of [...listeners]) {
      try { l(event); } catch {
        // why: a faulty telemetry listener must not break the emitting run.
      }
    }
  };
  return {
    onEvent(listener: TelemetryListener): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emitWarning(code: string, message: string, data?: unknown): void {
      try {
        deliver({ code, message, level: "warn", data, timestamp: Date.now() });
      } catch {
        // why: telemetry emission is observability-only.
      }
    },
    emit(event: Omit<TelemetryEvent, "timestamp"> & { timestamp?: number }): void {
      try {
        deliver({ level: "info", ...event, timestamp: event.timestamp ?? Date.now() });
      } catch {
        // why: telemetry emission is observability-only.
      }
    },
    clear(): void {
      listeners.clear();
    },
  };
})();
