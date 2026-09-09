import { bytesToBase64 } from "./base64.ts";
/**
 * Converts arbitrary tool output into values that are safe to put in model
 * context or JSON responses. Circular references and unsupported primitives
 * are represented instead of causing JSON.stringify to throw.
 */
/**
 * Converts arbitrary tool output into a circular/reference-safe JSON value.
 *
 * @example `const safe = toJsonSafe({ result, request });`
 */
export function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value === undefined ? null : value;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (typeof value === "function") return `[Function${value.name ? `: ${value.name}` : ""}]`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value !== "object") return value;

  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  try {
    if (value instanceof Error) {
      const error: Record<string, unknown> = {
        name: value.name,
        message: value.message,
        ...(value.stack ? { stack: value.stack } : {}),
      };
      for (const key of Object.keys(value as any)) {
        error[key] = toJsonSafe((value as any)[key], seen);
      }
      return error;
    }

    if (value instanceof Date) return value.toISOString();

    if (value instanceof Uint8Array) {
      return {
        type: "Uint8Array",
        base64: bytesToBase64(value),
        byteLength: value.byteLength,
      };
    }

    if (value instanceof ArrayBuffer) {
      const bytes = new Uint8Array(value);
      return {
        type: "ArrayBuffer",
        base64: bytesToBase64(bytes),
        byteLength: bytes.byteLength,
      };
    }

    if (value instanceof Map) {
      return Array.from(value.entries()).map(([key, entry]) => [
        toJsonSafe(key, seen),
        toJsonSafe(entry, seen),
      ]);
    }

    if (value instanceof Set) {
      return Array.from(value.values()).map((entry) => toJsonSafe(entry, seen));
    }

    if (Array.isArray(value)) {
      return value.map((entry) => toJsonSafe(entry, seen));
    }

    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as any)) {
      output[key] = toJsonSafe((value as any)[key], seen);
    }
    return output;
  } finally {
    seen.delete(value as object);
  }
}

/**
 * Safely serializes arbitrary values without throwing on circular or unsupported data.
 *
 * @example `logger.info(safeStringify(toolResult));`
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(toJsonSafe(value)) ?? "null";
  } catch {
    return String(value);
  }
}
