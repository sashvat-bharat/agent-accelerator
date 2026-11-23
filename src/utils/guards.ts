/** Small type guards shared across the SDK. Each one checks exactly what its type says. */

/** True for a plain object (not null and not an array): the shape of a parsed JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
