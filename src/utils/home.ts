import * as path from "node:path";
import { getEnv } from "./env.ts";

/**
 * The Agent Accelerator home: ONE folder that holds everything the SDK stores
 * (`sessions/`, `scheduled_actions/`, `telemetry/`, `catalog/`), so nothing is
 * scattered across the project or the package.
 */
let defaultHome: string | undefined;
const listeners = new Set<() => void>();

/**
 * Sets where the home lives for every Agent created afterwards, so nothing lands
 * in the working directory unless you want it there. Call once at startup;
 * `setHome()` clears it.
 */
export function setHome(dir?: string): void {
  defaultHome = dir ? path.resolve(dir) : undefined;
  for (const fn of listeners) fn();
}

/** The home folder: explicit `home`, else `setHome()`, else `AGENT_ACCEL_HOME`, else `.agent-accel/` in the working directory. */
export function resolveHome(home?: string): string {
  return path.resolve(home || defaultHome || getEnv("AGENT_ACCEL_HOME") || ".agent-accel");
}

/** Runs `fn` whenever `setHome` changes the default (the catalog cache reloads from the new place). */
export function onHomeChange(fn: () => void): void {
  listeners.add(fn);
}
