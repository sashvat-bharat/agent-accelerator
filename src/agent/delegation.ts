import { z } from "zod";
import { tool } from "../tools/tool.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { AgentResponse, SubAgentExecutionMetadata, SubAgentStep } from "../types/response.ts";
import type { TokenUsage } from "../types/core.ts";
import type { ToolCallRecord } from "../types/tool.ts";
import type { ProviderRawData } from "../types/model.ts";
import type { Agent } from "./agent.ts";
import type { Budget, BudgetState } from "../types/agent.ts";
import { BudgetExceededError } from "../types/errors.ts";
import { makeSubagentResult } from "../tools/subagent-result.ts";
import { hashSessionPart } from "../utils/session.ts";
import { createTrackingId } from "../utils/session.ts";
import { nowMs } from "../utils/session.ts";
import { newRunId } from "../utils/session.ts";
import { newTurnId } from "../utils/session.ts";
import { sanitizeToolName, createLiveWorker } from "./worker.ts";

/** Builds a random child session id that fits the 64-char provider limit, embedding a hash of the parent when it must be cut; in: a parent id + tag from scheduled runs, out: the worker's session id. */
export function createChildSessionId(parentId: string, tag: string): string {
  let rand: string;
  try {
    if (typeof globalThis !== "undefined" && (globalThis as any).crypto?.randomUUID) {
      rand = (globalThis as any).crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    } else {
      // Node fallback - dynamic require avoids bundling issues
      const nodeCrypto: any = (globalThis as any).process?.getBuiltinModule?.("node:crypto") ?? null;
      if (nodeCrypto?.randomUUID) rand = nodeCrypto.randomUUID().replace(/-/g, "").slice(0, 8);
      else rand = Math.random().toString(36).slice(2, 10);
    }
  } catch {
    rand = Math.random().toString(36).slice(2, 10);
  }
  // Provider-safe: OpenAI `prompt_cache_key` enforces max 64 chars (400
  // otherwise). Parent ids are already ~36+ chars (a UUID), so naive
  // `${parent}-sub-${tag}-${rand}` overflows (observed 65-72 chars → every
  // sub-agent 400s with 0 usage). Truncate the parent portion to fit, keeping
  // the tag + rand suffix intact for uniqueness/debuggability.
  // Lineage binding: when truncation is needed, embed an 8-char hash of the
  // full parent id so two distinct parents sharing a prefix still map to
  // distinct child ids (previously they collided and shared provider routing).
  const cleanTag = tag.toLowerCase().slice(0, 16);
  const suffix = `-sub-${cleanTag}-${rand}`;
  const maxParent = Math.max(0, 64 - suffix.length);
  if (parentId.length <= maxParent) return `${parentId}${suffix}`;
  const parentHash = hashSessionPart(parentId);
  const baseLen = Math.max(0, maxParent - 9);
  return `${parentId.slice(0, baseLen)}-${parentHash}${suffix}`;
}

/** Builds a deterministic fixed-subagent session id that fits 64 chars. */
export function createFixedChildSessionId(parentId: string, name: string): string {
  const suffix = `-sub-${name}`;
  if ((parentId + suffix).length <= 64) return parentId + suffix;
  // Truncate parent first (preserves full tool name for debugging), but embed
  // the parent hash so distinct parents sharing a prefix stay distinct.
  // If still over (very long tool name), truncate the name tail as last resort.
  const maxParent = Math.max(0, 64 - suffix.length);
  if (maxParent > 9) {
    const parentHash = hashSessionPart(parentId);
    return `${parentId.slice(0, maxParent - 9)}-${parentHash}${suffix}`;
  }
  if (maxParent > 0) return parentId.slice(0, maxParent) + suffix;
  return `${parentId}-sub-${name}`.slice(0, 64);
}

/**
 * True when `child` was derived from `parent` via the child-session helpers:
 * either an untruncated `parent + suffix` prefix, or the embedded parent hash
 * used when truncation was required. Used to validate lineage before pairing
 * provider state across concurrent agents.
 */
export function isSessionDescendant(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  if (child === parent) return true;
  if (child.startsWith(parent + "-")) return true;
  // Hash includes() is collision-prone; require delimited match to reduce spoofing. Explicit {rootSessionId,parentSessionId} lineage is future work.
  const h = hashSessionPart(parent);
  return child.includes(`-${h}-`) || child.endsWith(`-${h}`);
}

/** Live trace for one spawned worker, keyed by its TrackingID. */
export interface SubAgentTrace {
  /** Sub-agent TrackingID: system-generated 32-char hex. Displayed as `NAME-{TrackingID}`. */
  trackingId: string;
  name: string;
  sessionId: string;
  parentSessionId: string;
  status: "running" | "done" | "error";
  task: string;
  role?: string;
  model?: string;
  provider?: string;
  turns: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  steps: SubAgentStep[];
  text?: string;
  error?: string;
}

const subagentTraces = new Map<string, SubAgentTrace>();
const subagentListeners = new Map<string, Set<(trace: SubAgentTrace) => void>>();

/** Max trace keys held (LRU, evicts oldest whole trace on insert). */
const MAX_SUBAGENT_TRACES = 500;
/** Trace TTL: 1h wall-clock, lazily expired on read. */
const SUBAGENT_TRACE_TTL_MS = 60 * 60 * 1000;
/** Max steps retained per trace; oldest steps are dropped beyond this. */
const MAX_SUBAGENT_STEPS_PER_TRACE = 100;
/** Live subscriptions auto-expire after 5min. */
const SUBAGENT_SUBSCRIBE_TTL_MS = 5 * 60 * 1000;

/** Last-write wall-clock per canonical trackingId (drives TTL; reads do not extend it). */
const traceTouchedAt = new Map<string, number>();

// Removes a trace under all its keys plus its listeners and TTL stamp; in: pruneTraces/lookupTrace, out: the trace store.
function deleteTraceByCanonical(canonical: string): void {
  for (const [key, t] of [...subagentTraces]) {
    if (t.trackingId === canonical) subagentTraces.delete(key);
  }
  traceTouchedAt.delete(canonical);
  subagentListeners.delete(canonical);
}

// True once a trace was not written for SUBAGENT_TRACE_TTL_MS; in: lookup and prune, out: their expiry decision.
function isTraceExpired(canonical: string, now = Date.now()): boolean {
  const touched = traceTouchedAt.get(canonical);
  if (touched === undefined) return false;
  return now - touched > SUBAGENT_TRACE_TTL_MS;
}

// Stamps a trace as just written, which restarts its TTL; in: insert and the live worker hooks, out: traceTouchedAt.
function touchTrace(canonical: string, now = Date.now()): void {
  traceTouchedAt.set(canonical, now);
}

/**
 * Evicts expired traces, then oldest whole traces while over budget.
 * Called on every insert. Whole-trace eviction removes both the canonical
 * key and its display-id alias.
 */
function pruneTraces(now = Date.now()): void {
  for (const canonical of [...new Set([...subagentTraces.values()].map((t) => t.trackingId))]) {
    if (isTraceExpired(canonical, now)) deleteTraceByCanonical(canonical);
  }
  while (subagentTraces.size > MAX_SUBAGENT_TRACES) {
    const oldestKey = subagentTraces.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = subagentTraces.get(oldestKey);
    if (!oldest) {
      subagentTraces.delete(oldestKey);
      continue;
    }
    deleteTraceByCanonical(oldest.trackingId);
  }
}

/** Drops oldest steps beyond {@link MAX_SUBAGENT_STEPS_PER_TRACE}. */
function trimTraceSteps(trace: SubAgentTrace): void {
  if (trace.steps.length > MAX_SUBAGENT_STEPS_PER_TRACE) {
    trace.steps.splice(0, trace.steps.length - MAX_SUBAGENT_STEPS_PER_TRACE);
  }
}

// Stores a trace under its tracking id and display id in LRU order, pruning expired and excess traces; in: openWorkerTrace, out: the trace store.
function insertTrace(trace: SubAgentTrace, displayId: string, now = Date.now()): void {
  pruneTraces(now);
  trimTraceSteps(trace);
  subagentTraces.set(trace.trackingId, trace);
  subagentTraces.set(displayId, trace);
  touchTrace(trace.trackingId, now);
  // Keep LRU order: newest at the end (re-set moves existing keys).
  const canonical = subagentTraces.get(trace.trackingId);
  if (canonical) {
    subagentTraces.delete(trace.trackingId);
    subagentTraces.set(trace.trackingId, canonical);
  }
  const alias = subagentTraces.get(displayId);
  if (alias && displayId !== trace.trackingId) {
    subagentTraces.delete(displayId);
    subagentTraces.set(displayId, alias);
  }
  pruneTraces(now);
}

// Finds a trace by tracking id, display id or case-insensitive id, dropping expired ones and refreshing LRU order; in: the scoped getters and subscribe, out: the live trace or undefined.
function lookupTrace(id: string): SubAgentTrace | undefined {
  if (!id) return undefined;
  const direct = subagentTraces.get(id);
  if (direct) {
    if (isTraceExpired(direct.trackingId)) {
      deleteTraceByCanonical(direct.trackingId);
      return undefined;
    }
    // LRU touch (order only; TTL is write-based).
    subagentTraces.delete(id);
    subagentTraces.set(id, direct);
    return direct;
  }
  const lower = id.toLowerCase();
  for (const [key, t] of subagentTraces) {
    if (t.trackingId.toLowerCase() === lower) {
      if (isTraceExpired(t.trackingId)) {
        deleteTraceByCanonical(t.trackingId);
        return undefined;
      }
      subagentTraces.delete(key);
      subagentTraces.set(key, t);
      return t;
    }
  }
  return undefined;
}

// Deep-enough copy of a trace (steps and usage) so callers never see live mutation; in: the getters and notifyTrace, out: a detached SubAgentTrace.
function snapshotTrace(t: SubAgentTrace): SubAgentTrace {
  return { ...t, steps: t.steps.map((s) => ({ ...s })), usage: t.usage ? { ...t.usage } : undefined };
}

// Sends a snapshot of a trace to its live subscribers, ignoring listener errors; in: the live worker hooks, out: subscriber callbacks.
function notifyTrace(trackingId: string): void {
  const t = subagentTraces.get(trackingId);
  if (!t) return;
  const listeners = subagentListeners.get(trackingId);
  if (!listeners || listeners.size === 0) return;
  const snap = snapshotTrace(t);
  for (const fn of [...listeners]) {
    try {
      fn(snap);
    } catch {}
  }
}

/** Scoped lookup across a set of parent session ids (an agent's default + named sessions). */
export function getSubAgentTraceForSessions(
  id: string,
  parentSessionIds: ReadonlySet<string>
): SubAgentTrace | undefined {
  if (!id || parentSessionIds.size === 0) return undefined;
  const t = lookupTrace(id);
  if (!t || !parentSessionIds.has(t.parentSessionId)) return undefined;
  return snapshotTrace(t);
}

/** Raw tracking ids of traces spawned from any of `parentSessionIds` (deduped). */
export function listSubAgentTraceIdsForSessions(parentSessionIds: ReadonlySet<string>): string[] {
  pruneTraces();
  const out = new Set<string>();
  for (const t of subagentTraces.values()) {
    if (parentSessionIds.has(t.parentSessionId)) out.add(t.trackingId);
  }
  return [...out];
}

/**
 * Like {@link subscribeToSubAgent} but refuses (returns a no-op unsubscribe)
 * when the trace exists and belongs to a different parent session. An id that
 * does not exist yet is accepted: ids are 128-bit random, so subscribing early
 * cannot reach another tenant's trace.
 */
export function subscribeToSubAgentForSessions(
  id: string,
  parentSessionIds: ReadonlySet<string>,
  fn: (trace: SubAgentTrace) => void
): () => void {
  const t = lookupTrace(id);
  if (t && !parentSessionIds.has(t.parentSessionId)) return () => {};
  return subscribeToSubAgent(id, fn);
}

/**
 * Subscribes to live updates of one worker trace. Returns an unsubscribe fn.
 * Subscriptions auto-expire after 5min to avoid listener leaks.
 */
export function subscribeToSubAgent(id: string, fn: (trace: SubAgentTrace) => void): () => void {
  const t = lookupTrace(id);
  const key = t ? t.trackingId : id;
  let set = subagentListeners.get(key);
  if (!set) {
    set = new Set();
    subagentListeners.set(key, set);
  }
  set.add(fn);
  const timer = setTimeout(() => {
    try {
      subagentListeners.get(key)?.delete(fn);
    } catch {}
  }, SUBAGENT_SUBSCRIBE_TTL_MS);
  try {
    (timer as unknown as { unref?: () => void }).unref?.();
  } catch {}
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      clearTimeout(timer);
    } catch {}
    try {
      subagentListeners.get(key)?.delete(fn);
    } catch {}
  };
}

// ---------------------------------------------------------------------------
// One worker run: live trace + execution metadata (shared by fixed workers and the worker registry)
// ---------------------------------------------------------------------------

/** What a worker run reports when it finished; an `AgentResponse` fits, so does a reply saved before a crash (only `text` is required). */
export interface WorkerRunResult {
  text: string;
  model?: string;
  provider?: string;
  turns?: number;
  usage?: TokenUsage;
  finishReason?: string;
  responseId?: string;
  thinking?: string;
  toolCalls?: ToolCallRecord[];
  raw?: ProviderRawData;
}

/** Live handle of one worker run: its trace plus the hooks that feed it and the closers that finalize it. */
export interface WorkerTraceHandle {
  trackingId: string;
  /** `NAME-{trackingId}`, the id shown in metadata and accepted by `agent.track`. */
  displayId: string;
  onWorkerTurn: ReturnType<typeof createLiveWorker>["onWorkerTurn"];
  attachToStream: ReturnType<typeof createLiveWorker>["attachToStream"];
  /** Marks the run done and copies its result into the trace. */
  finish(result: WorkerRunResult): void;
  /** Marks the run failed. */
  fail(message: string): void;
  /** Copy of the steps logged so far. */
  steps(): SubAgentStep[] | undefined;
}

// Registers one worker run's live trace (visible to `agent.track`) and wires the shared live-worker state machine; in: a fixed-worker call or a registry spawn/message, out: the hooks that feed the trace and the closers that finalize it.
export function openWorkerTrace(a: {
  name: string;
  sessionId: string;
  parentSessionId: string;
  task: string;
  role?: string;
  /** When given, the trace is also kept in this agent's own registry and saved with its session. */
  parent?: Agent;
  emit?: (event: {
    trackingId: string;
    delta?: string;
    thinkingDelta?: string;
    partialText?: string;
    partialThinking?: string;
  }) => void;
}): WorkerTraceHandle {
  const trackingId = createTrackingId();
  const displayId = `${a.name}-${trackingId}`;
  const trace: SubAgentTrace = {
    trackingId,
    name: a.name,
    sessionId: a.sessionId,
    parentSessionId: a.parentSessionId,
    status: "running",
    task: a.task,
    role: a.role,
    turns: 0,
    steps: [],
  };
  insertTrace(trace, displayId);
  if (a.parent) {
    try {
      const registry = ((a.parent as any).subagentTraces ??= {}) as Record<string, SubAgentTrace>;
      registry[trackingId] = trace;
    } catch {}
  }
  const live = createLiveWorker(trace, trackingId, displayId, {
    trim: (t) => trimTraceSteps(t),
    touch: (id) => touchTrace(id),
    notify: (id) => notifyTrace(id),
    ...(a.parent
      ? {
          persist: () => {
            try {
              a.parent!.persistNow();
            } catch {}
          },
        }
      : {}),
    emit: (ev) => {
      try {
        a.emit?.(ev);
      } catch {}
    },
  });
  const settle = (): void => {
    const t = subagentTraces.get(trackingId);
    if (!t) return;
    trimTraceSteps(t);
    touchTrace(t.trackingId);
    notifyTrace(trackingId);
  };
  return {
    trackingId,
    displayId,
    onWorkerTurn: live.onWorkerTurn,
    attachToStream: live.attachToStream,
    finish(result) {
      const t = subagentTraces.get(trackingId);
      if (t) {
        t.status = "done";
        t.model = result.model;
        t.provider = result.provider;
        t.turns = result.turns ?? t.turns;
        t.text = result.text;
        if (result.usage) {
          t.usage = {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
            totalTokens: result.usage.totalTokens ?? 0,
          };
        }
      }
      settle();
    },
    fail(message) {
      const t = subagentTraces.get(trackingId);
      if (t) {
        t.status = "error";
        t.error = message;
      }
      settle();
    },
    steps() {
      return subagentTraces.get(trackingId)?.steps.map((s) => ({ ...s }));
    },
  };
}

// Builds the metadata of one worker run, success or failure, so every delegation path reports the same fields and lineage ids; in: the run's result or error, out: the branded result envelope and `AgentResponse.subagents`.
export function workerMetadata(a: {
  name: string;
  displayId: string;
  sessionId?: string;
  parentSessionId?: string;
  role?: string;
  task: string;
  durationMs: number;
  result?: WorkerRunResult;
  error?: string;
  /** Text reported for a failed run; default `Error in NAME: message`. */
  errorText?: string;
  steps?: SubAgentStep[];
  runId: string;
  turnId: string;
}): SubAgentExecutionMetadata {
  const r = a.result;
  const base = {
    name: a.name,
    trackingId: a.displayId,
    sessionId: a.sessionId,
    parentSessionId: a.parentSessionId,
    ...(a.role ? { role: a.role } : {}),
    task: a.task,
    durationMs: a.durationMs,
    steps: a.steps,
  };
  const metadata: SubAgentExecutionMetadata = r
    ? {
        ...base,
        model: r.model ?? "unknown",
        provider: r.provider ?? "unknown",
        usage: r.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turns: r.turns ?? 0,
        finishReason: r.finishReason,
        responseId: r.responseId,
        text: r.text,
        thinking: r.thinking,
        toolCalls: r.toolCalls,
        raw: r.raw,
        isError: false,
      }
    : {
        ...base,
        model: "unknown",
        provider: "unknown",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turns: 0,
        text: a.errorText ?? `Error in ${a.name}: ${a.error}`,
        isError: true,
        error: a.error,
      };
  try {
    const m = metadata as unknown as Record<string, unknown>;
    m["runId"] = a.runId;
    m["turnId"] = a.turnId;
    const extra = (r as { meta?: unknown } | undefined)?.meta;
    if (extra !== undefined) m["meta"] = extra;
  } catch {}
  return metadata;
}

// ---------------------------------------------------------------------------
// Budgets: counters + guards. The loop charges usage per turn; the
// worker registry enforces `maxTotalSubagents` through `reserveSpawn`. Durations use the monotonic `nowMs()`
// clock; TTL timestamps above use wall-clock `Date.now()`.
// ---------------------------------------------------------------------------

// Reads the agent's configured budget; in: budget helpers, out: Budget or undefined.
function readBudget(parentAgent: Agent): Budget | undefined {
  return (parentAgent as unknown as { budget?: Budget }).budget;
}

// Returns the agent's per-run budget counters, creating them on first use; in: charge and reserve helpers, out: BudgetState.
function ensureBudgetState(parentAgent: Agent): BudgetState {
  const host = parentAgent as unknown as { budgetState?: BudgetState };
  if (!host.budgetState) {
    host.budgetState = { spawned: 0, totalTokens: 0, totalCostUsd: 0, startedAtMs: nowMs() };
  }
  return host.budgetState;
}

// Total tokens of a usage value, defensively (total, else input + output); in: budget helpers, out: a non-negative integer.
function usageTokens(usage: unknown): number {
  const u = usage as { totalTokens?: unknown; inputTokens?: unknown; outputTokens?: unknown } | undefined;
  if (!u || typeof u !== "object") return 0;
  if (typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens))
    return Math.max(0, Math.floor(u.totalTokens));
  const inp = typeof u.inputTokens === "number" && Number.isFinite(u.inputTokens) ? u.inputTokens : 0;
  const out = typeof u.outputTokens === "number" && Number.isFinite(u.outputTokens) ? u.outputTokens : 0;
  return Math.max(0, Math.floor(inp + out));
}

// Reported total cost of a usage value in USD, 0 when absent; in: budget helpers, out: a non-negative number.
function usageCostUsd(usage: unknown): number {
  const cost = (usage as { cost?: { totalCost?: unknown } } | undefined)?.cost;
  const v = cost?.totalCost;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
}

/**
 * Throws {@link BudgetExceededError} (with `partial` usage) when any budget
 * limit is exceeded. Pure check — does not mutate state.
 */
export function checkBudget(
  budget: Budget | undefined,
  state: BudgetState | undefined,
  opts?: { usage?: unknown; now?: number }
): void {
  if (!budget) return;
  const now = opts?.now ?? nowMs();
  const spawned = state?.spawned ?? 0;
  const totalTokens = (state?.totalTokens ?? 0) + (opts?.usage !== undefined ? usageTokens(opts.usage) : 0);
  const totalCostUsd = (state?.totalCostUsd ?? 0) + (opts?.usage !== undefined ? usageCostUsd(opts.usage) : 0);
  const elapsedMs = state ? Math.max(0, now - state.startedAtMs) : 0;
  const partial = {
    usage: { inputTokens: 0, outputTokens: 0, totalTokens },
    turns: 0 as number,
    text: undefined as string | undefined,
  };
  if (budget.maxTotalSubagents !== undefined && spawned > budget.maxTotalSubagents) {
    throw new BudgetExceededError(
      `Sub-agent budget exceeded: spawned ${spawned} > maxTotalSubagents ${budget.maxTotalSubagents}.`,
      { context: { partial } }
    );
  }
  if (budget.maxTotalTokens !== undefined && totalTokens > budget.maxTotalTokens) {
    throw new BudgetExceededError(`Token budget exceeded: ${totalTokens} > maxTotalTokens ${budget.maxTotalTokens}.`, {
      context: { partial },
    });
  }
  if (budget.maxCostUsd !== undefined && totalCostUsd > budget.maxCostUsd) {
    throw new BudgetExceededError(
      `Cost budget exceeded: $${totalCostUsd.toFixed(6)} > maxCostUsd $${budget.maxCostUsd}.`,
      { context: { partial } }
    );
  }
  if (budget.maxDurationMs !== undefined && state && elapsedMs > budget.maxDurationMs) {
    throw new BudgetExceededError(
      `Duration budget exceeded: ${Math.round(elapsedMs)}ms > maxDurationMs ${budget.maxDurationMs}ms.`,
      { context: { partial } }
    );
  }
}

/**
 * Adds worker usage to the parent's budget counters. Never throws;
 * call {@link checkBudget} afterwards to enforce.
 */
export function chargeBudgetUsage(parentAgent: Agent, usage: unknown): BudgetState {
  const state = ensureBudgetState(parentAgent);
  state.totalTokens += usageTokens(usage);
  state.totalCostUsd += usageCostUsd(usage);
  return state;
}

/**
 * Reserves `count` spawns against `maxTotalSubagents`. Increments the
 * parent's `budgetState.spawned` and throws {@link BudgetExceededError} when
 * the reservation would exceed the budget. Call before spawning.
 */
export function reserveSpawn(parentAgent: Agent, count = 1): BudgetState {
  const state = ensureBudgetState(parentAgent);
  const budget = readBudget(parentAgent);
  const next = state.spawned + Math.max(0, Math.floor(count));
  if (budget?.maxTotalSubagents !== undefined && next > budget.maxTotalSubagents) {
    throw new BudgetExceededError(
      `Sub-agent budget exceeded: spawning ${count} would reach ${next} > maxTotalSubagents ${budget.maxTotalSubagents}.`,
      {
        context: {
          partial: {
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: state.totalTokens },
            turns: 0,
          },
        },
      }
    );
  }
  state.spawned = next;
  checkBudget(budget, state);
  return state;
}

/** Optional name/description wrapper for converting an Agent into a tool. */
export interface AgentAsToolTarget {
  name?: string;
  description?: string;
  agent: Agent;
}

/**
 * Converts one agent into a `{ task: string }` ToolDefinition.
 *
 * @example `const researchTool = researcher.asTool("research");`
 */
export function agentToTool(input: Agent | AgentAsToolTarget): ToolDefinition {
  const agentInstance = "agent" in input ? input.agent : input;
  const rawName =
    ("name" in input && (input as any).name) ||
    agentInstance.name ||
    `sub-agent-${Math.random().toString(36).slice(2, 7)}`;
  const name = sanitizeToolName(rawName);
  const description =
    ("description" in input && (input as any).description) ||
    agentInstance.description ||
    `Calls the sub-agent '${name}' to perform tasks.`;

  return tool({
    name,
    description,
    input: z.object({
      task: z.string().describe("The detailed instruction or prompt to pass to this sub-agent."),
    }),
    execute: async ({ task }, ctx) => {
      const startTime = nowMs();
      // Lineage for fixed-delegation calls.
      const callRunId = newRunId();
      const callTurnId = newTurnId();
      const parentSessionId = ctx?.sessionId || agentInstance.sessionId || "session";
      const subSessionId = createFixedChildSessionId(parentSessionId, sanitizeToolName(name));
      const live = openWorkerTrace({
        name,
        sessionId: subSessionId,
        parentSessionId,
        task,
        emit: (ev) => ctx?.onSubagentEvent?.(ev),
      });
      const lineage = {
        name,
        displayId: live.displayId,
        sessionId: subSessionId,
        parentSessionId,
        task,
        runId: callRunId,
        turnId: callTurnId,
      };
      try {
        // One isolated copy per call: the shared instance is single-flight, so
        // calling it directly would serialize (or steer) parallel tool calls.
        const worker: Agent =
          typeof (agentInstance as Agent).fork === "function"
            ? agentInstance.fork(subSessionId, parentSessionId)
            : agentInstance;
        const workerStream = worker.stream(task, {
          signal: ctx?.signal,
          sessionId: subSessionId,
          onTurn: live.onWorkerTurn,
        } as any);
        const detachWorkerListeners = live.attachToStream(
          workerStream as unknown as Parameters<typeof live.attachToStream>[0]
        );
        let response: AgentResponse;
        try {
          response = await workerStream.result();
        } finally {
          try {
            detachWorkerListeners();
          } catch {}
          // The per-call session id is never reused: drop its provider chain/routing state.
          if (worker !== agentInstance) {
            try {
              agentInstance.absorbUsage(worker.usageTotals);
            } catch {} // the template keeps what its copies spent
            try {
              worker.reset();
            } catch {}
          }
        }
        live.finish(response);
        return makeSubagentResult(response.text, [
          workerMetadata({
            ...lineage,
            durationMs: Math.max(0, nowMs() - startTime),
            result: response,
            steps: live.steps(),
          }),
        ]);
      } catch (err: any) {
        const msg = err?.message || String(err);
        live.fail(msg);
        return makeSubagentResult(`Error in ${name}: ${msg}`, [
          workerMetadata({ ...lineage, durationMs: Math.max(0, nowMs() - startTime), error: msg, steps: live.steps() }),
        ]);
      }
    },
  });
}

/**
 * Converts a list of agents into uniquely named delegation tools.
 *
 * @example `const tools = buildAgentTools([researcher, reviewer]);`
 */
export function buildAgentTools(agents?: (Agent | AgentAsToolTarget)[]): Record<string, ToolDefinition> {
  if (!agents || agents.length === 0) return {};

  const tools: Record<string, ToolDefinition> = {};
  for (const item of agents) {
    const t = agentToTool(item);
    if (t.name) {
      let finalName = t.name;
      let n = 1;
      while (tools[finalName]) {
        finalName = `${t.name}-${n++}`;
      }
      tools[finalName] = { ...t, name: finalName };
    }
  }
  return tools;
}
