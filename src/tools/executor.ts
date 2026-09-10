import type {
  ToolDefinition,
  ToolCallRecord,
  ToolResultRecord,
  ToolExecutionContext,
} from "../types/tool.ts";
import { toJsonSafe } from "../utils/serialization.ts";

export interface ExecuteToolsOptions {
  tools: Record<string, ToolDefinition>;
  toolCalls: ToolCallRecord[];
  agentName?: string;
  parallel?: boolean;
  signal?: AbortSignal;
  sessionId?: string;
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

function normalizeToolName(name: string): string {
  return name
    .trim()
    .replace(/^(?:functions?|tools?)\./i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
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
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("Tool execution aborted"));
    if (this.limit === Number.POSITIVE_INFINITY || this.active < this.limit) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      this.waiters.push(waiter);
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Tool execution aborted"));
      };
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
      waiter.resolve(() => this.release());
      return;
    }
  }
}

function isTransientError(error: any): boolean {
  if (!error) return false;
  if (error.transient === true || error.code === "ETIMEDOUT") return true;
  const status = Number(error.status ?? error.statusCode ?? error.response?.status);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = String(error.code || "").toUpperCase();
  if (["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "EPIPE"].includes(code)) return true;
  return /(?:timed? ?out|temporar(?:y|ily)|connection reset|connection refused|service unavailable|rate limit|\b5\d\d\b)/i.test(
    String(error.message || error)
  );
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
  const { tools, toolCalls, agentName, parallel = true, signal, sessionId } = options;
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
      // A positive value is the total attempt count.  0/omitted deliberately
      // means there is no configured retry limit for transient failures.
      const maxAttempts = configuredTries && configuredTries > 0 ? configuredTries : Number.POSITIVE_INFINITY;
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
          // A timeout is already a deliberate per-attempt deadline. Retrying
          // it forever by default would make timeoutMs ineffective; callers
          // can opt into timeout retries with an explicit maxTries value.
          if (err?.code === "ETIMEDOUT" && (!configuredTries || configuredTries <= 0)) throw err;
          await waitForRetry(Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7)), signal);
        }
      }

      return {
        id: call.id,
        name: resolved.name,
        result: rawResult !== undefined ? toJsonSafe(rawResult) : "Success",
        isError: false,
        durationMs: elapsedMs(executionStartTime),
      };
    } catch (err: any) {
      return {
        id: call.id,
        name: call.name,
        result: `Error executing ${call.name}: ${err?.message || String(err)}`,
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
