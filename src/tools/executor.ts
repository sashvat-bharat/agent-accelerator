import type {
  ToolDefinition,
  ToolCallRecord,
  ToolResultRecord,
  ToolExecutionContext,
} from "../types/tool.ts";
import { toJsonSafe } from "../utils/serialization.ts";
import { ConfigError } from "../types/errors.ts";

export interface ExecuteToolsOptions {
  tools: Record<string, ToolDefinition>;
  toolCalls: ToolCallRecord[];
  agentName?: string;
  parallel?: boolean;
  signal?: AbortSignal;
  sessionId?: string;
  /** Forwards live sub-agent deltas (realtime worker thinking/text) to the caller. */
  onSubagentEvent?: (event: { trackingId: string; delta?: string; thinkingDelta?: string; partialText?: string; partialThinking?: string }) => void;
}

const DEFAULT_TOOL_CONCURRENCY = 8;

function nowMs(): number {
  return Date.now();
}

function elapsedMs(start: number): number {
  return Math.max(1, nowMs() - start);
}

function numericOption(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function integerOption(value: number | string | undefined): number | undefined {
  const parsed = numericOption(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

/** Normalizes a tool name for case/format-insensitive matching (shared with delegation grants). */
export function normalizeToolName(name: string): string {
  return name
    .trim()
    .replace(/^(?:functions?|tools?)\./i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

/** Default cap for string tool results kept for model context. */
export const DEFAULT_MAX_RESULT_CHARS = 20000;

/** Identical-call repeats blocked once the per-fingerprint count reaches this. */
export const REPEAT_BLOCK_THRESHOLD = 3;

/**
 * True when a tool call carries only `{ raw: string }` arguments — the marker
 * shape produced by `parseStreamedToolArguments` when streamed JSON chunks
 * never parsed to an object (truncated/incomplete arguments). Such calls must
 * NOT execute: the model must retry with complete JSON.
 *
 * @example `if (isTruncatedToolCall(call)) return truncatedError(call);`
 */
export function isTruncatedToolCall(call: ToolCallRecord): boolean {
  const args = call?.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const keys = Object.keys(args);
  return (
    keys.length === 1 &&
    keys[0] === "raw" &&
    typeof (args as Record<string, unknown>).raw === "string"
  );
}

/**
 * Throws {@link ConfigError} when two distinct tool entries normalize to the
 * same name (case/format-insensitive via {@link normalizeToolName}), which
 * would otherwise make model tool calls ambiguous.
 */
export function assertNoToolCollisions(
  tools: Record<string, ToolDefinition>
): void {
  if (!tools) return;
  const seen = new Map<string, string>();
  for (const [key, definition] of Object.entries(tools)) {
    const declared = definition?.name || key;
    for (const candidate of new Set([key, declared])) {
      const normalized = normalizeToolName(candidate);
      const previous = seen.get(normalized);
      if (previous !== undefined && previous !== key) {
        throw new ConfigError(
          `Tool name collision: '${previous}' and '${key}' both normalize to '${normalized}'. Rename one tool so model calls are unambiguous.`
        );
      }
      seen.set(normalized, key);
    }
  }
}

/**
 * Redacts secrets and machine-local details from an error message before it
 * is sent back to the model: credentials in URLs/connection strings
 * (`scheme://...@` → `scheme://[redacted]@`) and absolute file paths
 * (`/home/...`, `/Users/...`, `C:\...` → `[redacted-path]`).
 */
export function sanitizeErrorMessage(message: string): string {
  let out = message;
  out = out.replace(
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s"'`@]+@/g,
    "$1[redacted]@"
  );
  out = out.replace(/\/home\/[^\s"'`:;,)]*/g, "[redacted-path]");
  out = out.replace(/\/Users\/[^\s"'`:;,)]*/g, "[redacted-path]");
  out = out.replace(/[A-Za-z]:\\[^\s"'`:;,)]*/g, "[redacted-path]");
  return out;
}

function resultCharLimit(toolDef: ToolDefinition): number {
  const configured = integerOption((toolDef as any).maxResultChars);
  return configured && configured > 0 ? configured : DEFAULT_MAX_RESULT_CHARS;
}

function truncateResultString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + `\n[Truncated: showing ${limit} of ${value.length} chars]`;
}

/**
 * Drops `stack` from an Error-shaped sanitized result for model context.
 * Keeps `{ name, message }` plus any custom keys; nested values untouched.
 */
function stripTopLevelErrorStack(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (
    typeof record.name === "string" &&
    typeof record.message === "string" &&
    "stack" in record
  ) {
    const { stack: _dropped, ...rest } = record;
    return rest;
  }
  return value;
}

/** Stable serialization for repeat-guard fingerprints (key order independent). */
function stableSerialize(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`)
      .join(",");
    return `{${body}}`;
  } finally {
    seen.delete(value);
  }
}

/** Fingerprint identifying an identical tool call (name + canonical args). */
export function toolCallFingerprint(call: ToolCallRecord): string {
  return `${call.name}\u0000${stableSerialize(call.arguments ?? {})}`;
}

/**
 * Whether a tool definition allows identical repeats across consecutive
 * turns. Explicit `repeatable` wins; otherwise idempotent tools default to
 * repeatable, side-effecting tools do not.
 */
export function isRepeatableTool(toolDef: ToolDefinition): boolean {
  const explicit = (toolDef as any).repeatable;
  if (typeof explicit === "boolean") return explicit;
  return (toolDef as any).idempotent === true;
}

/**
 * Repeat-guard helper for the agent loop (which owns consecutive-turn state).
 * Tracks per-fingerprint occurrence counts in `countMap`: a first sighting
 * records count 1 and never blocks; a fingerprint already present in
 * `fingerprints` (the previous turn's set) increments and blocks once the
 * count reaches {@link REPEAT_BLOCK_THRESHOLD} (3). Callers must skip this
 * check for repeatable tools (see {@link isRepeatableTool}); this helper
 * itself stays tool-agnostic for backward compatibility.
 */
export function shouldBlockRepeat(
  fingerprints: Set<string>,
  call: ToolCallRecord,
  countMap: Map<string, number>
): boolean {
  const fingerprint = toolCallFingerprint(call);
  if (!fingerprints.has(fingerprint)) {
    if (!countMap.has(fingerprint)) countMap.set(fingerprint, 1);
    return false;
  }
  const next = (countMap.get(fingerprint) ?? 1) + 1;
  countMap.set(fingerprint, next);
  return next >= REPEAT_BLOCK_THRESHOLD;
}

/**
 * Builds the synthetic blocked result for a repeat-guarded call. The
 * machine-readable code lives at `(result as any).errorCode` while the human
 * prefix keeps plain-string consumers working.
 */
export function makeRepeatBlockedResult(call: ToolCallRecord): ToolResultRecord {
  const message =
    `repeat_blocked: Tool '${call.name}' was called again with identical arguments. ` +
    "The previous result is already available; reuse it or call the tool with different arguments.";
  return {
    id: call.id,
    name: call.name,
    result: { message, errorCode: "repeat_blocked" },
    isError: true,
    durationMs: 1,
  };
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = a[i - 1] === b[j - 1]
        ? previous
        : Math.min(previous + 1, row[j - 1]! + 1, current + 1);
      previous = current;
    }
  }
  return row[b.length]!;
}

interface ResolvedTool {
  definition?: ToolDefinition;
  name: string;
  suggestion?: string;
}

function resolveTool(tools: Record<string, ToolDefinition>, requestedName: string): ResolvedTool {
  const direct = tools[requestedName];
  if (direct) return { definition: direct, name: direct.name || requestedName };

  const normalized = normalizeToolName(requestedName);
  const entries = Object.entries(tools);
  for (const [key, definition] of entries) {
    const declared = definition.name || key;
    if (normalizeToolName(key) === normalized || normalizeToolName(declared) === normalized) {
      return { definition, name: declared };
    }
  }

  let best: { name: string; distance: number } | undefined;
  for (const [key, definition] of entries) {
    const declared = definition.name || key;
    const distance = levenshtein(normalized, normalizeToolName(declared));
    if (!best || distance < best.distance) best = { name: declared, distance };
  }
  const threshold = Math.max(2, Math.floor(normalized.length * 0.35));
  return {
    name: requestedName,
    suggestion: best && best.distance <= threshold ? best.name : undefined,
  };
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("Tool execution aborted"));
    if (this.limit === Number.POSITIVE_INFINITY || this.active < this.limit) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const waiter: {
        resolve: (release: () => void) => void;
        reject: (error: Error) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, signal };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Tool execution aborted"));
      };
      waiter.onAbort = onAbort;
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal?.aborted) {
        waiter.reject(new Error("Tool execution aborted"));
        continue;
      }
      this.active++;
      // The waiter is leaving the queue: drop its abort listener so long-lived
      // session signals don't accumulate one listener per queued tool call.
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(() => this.release());
      return;
    }
  }
}

/**
 * True for retry-worthy failures: explicit opt-in flags (`transient` /
 * `retryable`), retryable HTTP statuses, or retryable network codes. Never
 * matches on message text — message content is untrusted and locale-fragile.
 */
function isTransientError(error: any): boolean {
  if (!error) return false;
  if (error.transient === true || error.retryable === true) return true;
  const status = Number(error.status ?? error.statusCode ?? error.response?.status);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = String(error.code || "").toUpperCase();
  if (["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return true;
  return false;
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Tool execution aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function executeAttempt(
  toolDef: ToolDefinition,
  parsedInput: unknown,
  context: ToolExecutionContext,
  timeoutMs: number | undefined
): Promise<unknown> {
  if (!timeoutMs || timeoutMs <= 0) {
    return toolDef.execute(parsedInput as any, context);
  }

  const controller = new AbortController();
  const parentAbort = () => controller.abort();
  context.signal?.addEventListener("abort", parentAbort, { once: true });
  const executionContext = { ...context, signal: controller.signal };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = nowMs();
  const makeTimeoutError = () => {
    const error: any = new Error(`Tool execution timed out after ${timeoutMs}ms`);
    error.code = "ETIMEDOUT";
    error.transient = true;
    return error;
  };
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(makeTimeoutError());
      }, timeoutMs);
    });
    const result = await Promise.race([
      Promise.resolve(toolDef.execute(parsedInput as any, executionContext)),
      timeout,
    ]);
    // A resolved promise can beat a timer callback even when the event loop
    // has already crossed the deadline. Enforce the wall-clock deadline too.
    if (nowMs() - startedAt >= timeoutMs) {
      controller.abort();
      throw makeTimeoutError();
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    context.signal?.removeEventListener("abort", parentAbort);
  }
}

/**
 * Executes one or more tool calls in parallel or sequence, handling errors safely
 */
/**
 * Executes model tool calls with validation, timeout, retry, serialization, and bounded concurrency.
 *
 * @example `const results = await executeToolCalls({ tools, toolCalls });`
 */
export async function executeToolCalls(
  options: ExecuteToolsOptions
): Promise<ToolResultRecord[]> {
  const { tools, toolCalls, agentName, parallel = true, signal, sessionId, onSubagentEvent } = options;
  assertNoToolCollisions(tools);
  const globalSemaphore = new Semaphore(DEFAULT_TOOL_CONCURRENCY);
  const perToolSemaphores = new Map<string, Semaphore>();

  const getToolSemaphore = (name: string, definition: ToolDefinition): Semaphore => {
    const existing = perToolSemaphores.get(name);
    if (existing) return existing;
    const configured = integerOption(
      definition.maxConcurrency
    );
    const limit = configured && configured > 0 ? configured : DEFAULT_TOOL_CONCURRENCY;
    const semaphore = new Semaphore(limit);
    perToolSemaphores.set(name, semaphore);
    return semaphore;
  };

  const runSingle = async (call: ToolCallRecord): Promise<ToolResultRecord> => {
    const startTime = nowMs();

    // Truncated streamed arguments (Q-12): the `{ raw }` marker means the
    // provider's partial JSON never parsed. Never execute or overwrite wire
    // finishReason here — return a synthetic error so the model retries with
    // complete JSON.
    if (isTruncatedToolCall(call)) {
      return {
        id: call.id,
        name: call.name,
        result:
          `Error: Tool '${call.name}' arguments are truncated or incomplete and could not be parsed. ` +
          "Call the tool again with the complete JSON arguments. Do not explain the error, just retry the call.",
        isError: true,
        durationMs: elapsedMs(startTime),
      };
    }

    const resolved = resolveTool(tools, call.name);
    const toolDef = resolved.definition;

    if (!toolDef) {
      const suffix = resolved.suggestion ? ` Did you mean '${resolved.suggestion}'?` : "";
      return {
        id: call.id,
        name: call.name,
        result: `Error: Tool '${call.name}' not found.${suffix}`,
        isError: true,
        durationMs: elapsedMs(startTime),
      };
    }

    let releaseGlobal: (() => void) | undefined;
    let releaseTool: (() => void) | undefined;
    let executionStartTime = startTime;

    try {
      if (signal?.aborted) {
        throw new Error("Tool execution aborted");
      }

      releaseGlobal = await globalSemaphore.acquire(signal);
      releaseTool = await getToolSemaphore(resolved.name, toolDef).acquire(signal);

      const context: ToolExecutionContext = {
        toolCallId: call.id,
        agentName,
        signal,
        sessionId,
        onSubagentEvent,
      };

      // Validate input if Zod schema is provided
      let parsedInput = call.arguments;
      if (toolDef.input && typeof (toolDef.input as any).safeParse === "function") {
        const parseRes = (toolDef.input as any).safeParse(call.arguments);
        if (!parseRes.success) {
          const receivedKeys =
            call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
              ? Object.keys(call.arguments as Record<string, unknown>).join(", ") || "(none)"
              : typeof call.arguments;
          const expectedParams =
            toolDef.parameters && typeof toolDef.parameters === "object"
              ? JSON.stringify(toolDef.parameters).slice(0, 800)
              : undefined;
          const detail = parseRes.error.message;
          const hint = expectedParams
            ? ` Expected parameters: ${expectedParams}.`
            : "";
          return {
            id: call.id,
            name: call.name,
            result:
              `Schema validation error for tool '${call.name}': ${detail}` +
              ` Received argument keys: [${receivedKeys}].` +
              hint +
              ` Fix the arguments and call the tool again with corrected JSON. Do not explain the error, just retry the call.`,
            isError: true,
            durationMs: elapsedMs(startTime),
          };
        }
        parsedInput = parseRes.data;
      }

      const configuredTries = integerOption(toolDef.maxTries);
      // Total attempt count. Default is a single attempt: only tools marked
      // idempotent opt into a bounded retry default (3 attempts). An explicit
      // maxTries overrides both defaults. An unbounded retry loop on a
      // persistently failing dependency (e.g. steady 503/429) would hang the
      // agent loop forever, so retries are always bounded.
      // Attempts run serially in the while loop below — never concurrently —
      // so a non-idempotent tool cannot execute twice at the same time.
      const isIdempotent = (toolDef as any).idempotent === true;
      const maxAttempts = configuredTries && configuredTries > 0 ? configuredTries : (isIdempotent ? 3 : 1);
      const timeoutMs = numericOption(toolDef.timeoutMs);
      // Telemetry starts when the tool body is about to run, excluding queue
      // wait and schema validation. Retries/backoff remain part of this call.
      executionStartTime = nowMs();
      let rawResult: unknown;
      let attempt = 0;
      while (true) {
        attempt++;
        try {
          rawResult = await executeAttempt(toolDef, parsedInput, context, timeoutMs);
          break;
        } catch (err: any) {
          if (signal?.aborted) throw new Error("Tool execution aborted");
          if (!isTransientError(err) || attempt >= maxAttempts) throw err;
          // A timeout is a deliberate per-attempt deadline, not a parent
          // cancellation (which rejects via the abort signal instead and is
          // never retried). Retrying timeouts by default would make timeoutMs
          // ineffective; callers opt into timeout retries with explicit
          // maxTries. Note ctx.signal is cooperative: the timeout races the
          // tool body, but a tool that ignores the signal still resolves.
          if (err?.code === "ETIMEDOUT" && (!configuredTries || configuredTries <= 0)) throw err;
          await waitForRetry(Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7)), signal);
        }
      }

      // Undefined means "no value", serialized null-safe as "null" (changed
      // from the legacy "Success" marker so model context stays valid JSON).
      if (rawResult === undefined) {
        return {
          id: call.id,
          name: resolved.name,
          result: "null",
          isError: false,
          durationMs: elapsedMs(executionStartTime),
        };
      }
      // Stack traces stay in server logs, not model context: keep
      // { name, message } plus custom keys, drop stack.
      let safeResult = stripTopLevelErrorStack(toJsonSafe(rawResult));
      if (typeof safeResult === "string") {
        safeResult = truncateResultString(safeResult, resultCharLimit(toolDef));
      }
      return {
        id: call.id,
        name: resolved.name,
        result: safeResult,
        isError: false,
        durationMs: elapsedMs(executionStartTime),
      };
    } catch (err: any) {
      // Never leak secrets/paths to the model. A per-tool redactError hook
      // wins; otherwise sanitize the message (credentials, file paths).
      let message: string;
      const redactError = (toolDef as any)?.redactError;
      if (typeof redactError === "function") {
        try {
          message = String(redactError(err));
        } catch {
          message = sanitizeErrorMessage(err?.message || String(err));
        }
      } else {
        message = sanitizeErrorMessage(err?.message || String(err));
      }
      return {
        id: call.id,
        name: call.name,
        result: `Error executing ${call.name}: ${message}`,
        isError: true,
        durationMs: elapsedMs(executionStartTime),
      };
    } finally {
      releaseTool?.();
      releaseGlobal?.();
    }
  };

  if (parallel && toolCalls.length > 1) {
    const results = await Promise.all(toolCalls.map((tc) => runSingle(tc)));
    return results;
  }

  const results: ToolResultRecord[] = [];
  for (const tc of toolCalls) {
    results.push(await runSingle(tc));
  }
  return results;
}
