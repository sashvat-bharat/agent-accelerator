import { z } from "zod";
import { tool } from "../tools/tool.ts";
import { normalizeToolName } from "../tools/executor.ts";
import { escapeXml } from "../utils/serialization.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { SubAgentExecutionMetadata } from "../types/response.ts";
import type { Agent } from "./agent.ts";
import type { Budget, BudgetState } from "../types/agent.ts";
import { BudgetExceededError } from "../types/errors.ts";
import { resolveModel } from "../providers/registry.ts";
import { hashSessionPart } from "../utils/session.ts";
import { createTrackingId } from "../utils/session.ts";
import { nowMs } from "../utils/session.ts";
import { newRunId } from "../utils/session.ts";
import { newTurnId } from "../utils/session.ts";
import type { SubAgentStep } from "../types/response.ts";

export { escapeXml };

/** Task descriptor accepted by the automatic `spawn_subagents` tool.
 *
 * The Main Agent controls prompts (`name`/`role`/`instructions`/`task`), which
 * worker tools to grant (`tools`), and — only when the developer sets
 * `dynamicSubagents.timeout: -1` — each worker's `timeoutMs`. Model, reasoning
 * level, and history are never LLM-choosable: workers are stateless and run on
 * the developer-configured model.
 */
export interface DynamicSubagentTask {
  name: string;
  role?: string;
  instructions: string;
  task: string;
  /** Names of worker tools to grant this sub-agent. Must be a subset of the developer-configured `dynamicSubagents.tools` pool; unknown names are ignored. Omit for no tools. */
  tools?: string[];
  /** Per-worker timeout in ms. Honored ONLY when the developer sets `dynamicSubagents.timeout: -1`. Must be > 0, otherwise the worker runs with no limit. */
  timeoutMs?: number;
}

function sanitizeXmlTag(raw: string): string {
  let s = raw.toUpperCase().replace(/[^A-Z0-9.-]/g, "-");
  if (!/^[A-Z]/.test(s)) s = `AGENT-${s}`;
  s = s.replace(/[.]/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 64) || "SUBAGENT";
}
function sanitizeToolName(raw: string): string {
  const tag = sanitizeXmlTag(raw);
  return tag.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-{2,}/g, "-").slice(0, 64) || "sub-agent";
}

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
  // otherwise). Parent ids are already ~42 chars (`accel-<uuid>`), so naive
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
  return (`${parentId}-sub-${name}`).slice(0, 64);
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
  // Q-34: hash includes() is collision-prone; require delimited match to reduce spoofing. Explicit {rootSessionId,parentSessionId} lineage is Q-61 future.
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

/** Max trace keys held (LRU, evicts oldest whole trace on insert) (Q-30). */
export const MAX_SUBAGENT_TRACES = 500;
/** Trace TTL: 1h wall-clock, lazily expired on read (Q-30). */
export const SUBAGENT_TRACE_TTL_MS = 60 * 60 * 1000;
/** Max steps retained per trace; oldest steps are dropped beyond this (Q-30). */
export const MAX_SUBAGENT_STEPS_PER_TRACE = 100;
/** Live subscriptions auto-expire after 5min (Q-30). */
export const SUBAGENT_SUBSCRIBE_TTL_MS = 5 * 60 * 1000;

/** Last-write wall-clock per canonical trackingId (drives TTL; reads do not extend it). */
const traceTouchedAt = new Map<string, number>();

function canonicalOf(trace: SubAgentTrace): string {
  return trace.trackingId;
}

function deleteTraceByCanonical(canonical: string): void {
  for (const [key, t] of [...subagentTraces]) {
    if (t.trackingId === canonical) subagentTraces.delete(key);
  }
  traceTouchedAt.delete(canonical);
  subagentListeners.delete(canonical);
}

function isTraceExpired(canonical: string, now = Date.now()): boolean {
  const touched = traceTouchedAt.get(canonical);
  if (touched === undefined) return false;
  return now - touched > SUBAGENT_TRACE_TTL_MS;
}

function touchTrace(canonical: string, now = Date.now()): void {
  traceTouchedAt.set(canonical, now);
}

/**
 * Evicts expired traces, then oldest whole traces while over budget (Q-30).
 * Called on every insert. Whole-trace eviction removes both the canonical
 * key and its display-id alias.
 */
export function pruneTraces(now = Date.now()): void {
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

/** Drops oldest steps beyond {@link MAX_SUBAGENT_STEPS_PER_TRACE} (Q-30). */
export function trimTraceSteps(trace: SubAgentTrace): void {
  if (trace.steps.length > MAX_SUBAGENT_STEPS_PER_TRACE) {
    trace.steps.splice(0, trace.steps.length - MAX_SUBAGENT_STEPS_PER_TRACE);
  }
}

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

function snapshotTrace(t: SubAgentTrace): SubAgentTrace {
  return { ...t, steps: t.steps.map((s) => ({ ...s })), usage: t.usage ? { ...t.usage } : undefined };
}

function notifyTrace(trackingId: string): void {
  const t = subagentTraces.get(trackingId);
  if (!t) return;
  const listeners = subagentListeners.get(trackingId);
  if (!listeners || listeners.size === 0) return;
  const snap = snapshotTrace(t);
  for (const fn of [...listeners]) {
    try { fn(snap); } catch {}
  }
}

/**
 * Returns a snapshot of one worker's trace by tracking id
 * (`SUBAGENT-NAME-{32hex}` or the raw 32-hex suffix). Used by
 * `agent.track(id)` for realtime inspection.
 *
 * Prefer {@link getSubAgentTraceScoped} when the parent session is known:
 * this compat lookup matches any parent and can confuse sibling workers
 * whose display names collide across sessions.
 */
export function getSubAgentTrace(id: string): SubAgentTrace | undefined {
  const t = lookupTrace(id);
  return t ? snapshotTrace(t) : undefined;
}

/**
 * Scoped trace lookup (Q-30, preferred): like {@link getSubAgentTrace} but
 * only matches when `trace.parentSessionId === parentSessionId`. Use this
 * from `Agent.track` (or any parent-bound caller) so truncated/aliased ids
 * cannot leak across sessions.
 */
export function getSubAgentTraceScoped(id: string, parentSessionId: string): SubAgentTrace | undefined {
  if (!id || !parentSessionId) return undefined;
  const t = lookupTrace(id);
  if (!t) return undefined;
  if (t.parentSessionId !== parentSessionId) return undefined;
  return snapshotTrace(t);
}

/** Lists tracking ids of known worker traces (mainly for `track` misses). */
export function listSubAgentTraceIds(): string[] {
  pruneTraces();
  return [...subagentTraces.keys()];
}

/**
 * Subscribes to live updates of one worker trace. Returns an unsubscribe fn.
 * Subscriptions auto-expire after 5min to avoid listener leaks (Q-30).
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
    try { subagentListeners.get(key)?.delete(fn); } catch {}
  }, SUBAGENT_SUBSCRIBE_TTL_MS);
  try { (timer as unknown as { unref?: () => void }).unref?.(); } catch {}
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try { clearTimeout(timer); } catch {}
    try { subagentListeners.get(key)?.delete(fn); } catch {}
  };
}

/** Appends a step to a worker trace and notifies live subscribers. */
export function appendSubAgentStep(trackingId: string, step: SubAgentStep): void {
  const t = subagentTraces.get(trackingId) ?? lookupTrace(trackingId);
  if (!t) return;
  if (isTraceExpired(t.trackingId)) {
    deleteTraceByCanonical(t.trackingId);
    return;
  }
  t.steps.push(step);
  trimTraceSteps(t);
  t.turns = Math.max(t.turns, step.turn);
  touchTrace(t.trackingId);
  notifyTrace(trackingId);
}

// ---------------------------------------------------------------------------
// Budgets (Q-39): unenforced counters + guards. The loop owner wires
// per-turn charging; the spawn tool below enforces `maxTotalSubagents` and
// charges completed worker usage. Durations use the monotonic `nowMs()`
// clock; TTL timestamps above use wall-clock `Date.now()`.
// ---------------------------------------------------------------------------

function readBudget(parentAgent: Agent): Budget | undefined {
  return (parentAgent as unknown as { budget?: Budget }).budget;
}

function readBudgetState(parentAgent: Agent): BudgetState | undefined {
  return (parentAgent as unknown as { budgetState?: BudgetState }).budgetState;
}

function ensureBudgetState(parentAgent: Agent): BudgetState {
  const host = parentAgent as unknown as { budgetState?: BudgetState };
  if (!host.budgetState) {
    host.budgetState = { spawned: 0, totalTokens: 0, totalCostUsd: 0, startedAtMs: nowMs() };
  }
  return host.budgetState;
}

function usageTokens(usage: unknown): number {
  const u = usage as { totalTokens?: unknown; inputTokens?: unknown; outputTokens?: unknown } | undefined;
  if (!u || typeof u !== "object") return 0;
  if (typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens)) return Math.max(0, Math.floor(u.totalTokens));
  const inp = typeof u.inputTokens === "number" && Number.isFinite(u.inputTokens) ? u.inputTokens : 0;
  const out = typeof u.outputTokens === "number" && Number.isFinite(u.outputTokens) ? u.outputTokens : 0;
  return Math.max(0, Math.floor(inp + out));
}

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
    throw new BudgetExceededError(
      `Token budget exceeded: ${totalTokens} > maxTotalTokens ${budget.maxTotalTokens}.`,
      { context: { partial } }
    );
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
 * Adds worker usage to the parent's budget counters (Q-39). Never throws;
 * call {@link checkBudget} afterwards to enforce.
 */
export function chargeBudgetUsage(parentAgent: Agent, usage: unknown): BudgetState {
  const state = ensureBudgetState(parentAgent);
  state.totalTokens += usageTokens(usage);
  state.totalCostUsd += usageCostUsd(usage);
  return state;
}

/**
 * Reserves `count` spawns against `maxTotalSubagents` (Q-39). Increments the
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

// ---------------------------------------------------------------------------
// Single core loop note + streaming-loop guard (Q-44, partial).
// The canonical run/stream loops live in `loop.ts` + `agent.ts` (other
// owners) and are intentionally NOT duplicated here. This guard exists so
// future consolidation can branch on streaming handles without importing
// the loop.
// ---------------------------------------------------------------------------

/** Minimal shape of a streaming run handle (has subscribe + terminal promise). */
export interface StreamingLoopHandle {
  on: (...args: unknown[]) => unknown;
  result: (...args: unknown[]) => Promise<unknown>;
}

/** Type guard for streaming-loop handles (Q-44). */
export function isStreamingLoop(value: unknown): value is StreamingLoopHandle {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r["on"] === "function" && typeof r["result"] === "function";
}

function providerOf(modelStr: string | any | undefined): string | undefined {
  if (!modelStr) return undefined;
  try {
    const m = typeof modelStr === "string" ? modelStr : (modelStr as any)?.model ?? (modelStr as any)?.id ?? String(modelStr);
    return resolveModel(m as any).provider.id;
  } catch {
    return undefined;
  }
}

/**
 * Creates the built-in tool that spawns stateless dynamic sub-agents concurrently.
 *
 * Workers run on the developer-configured model with the developer-configured
 * reasoning level. The Main Agent controls prompts, per-worker tool grants, and
 * (when `dynamicSubagents.timeout: -1`) per-worker timeouts — nothing else.
 *
 * @example `new Agent({ model, dynamicSubagents: { enabled: true, maxSpawn: 4 } })`
 */
export function createSubagentSpawnTool(parentAgent: Agent): ToolDefinition {
  const dyn = (parentAgent as any).dynamicSubagents as
    | { maxSpawn: number; tools: Record<string, unknown>; timeout: number }
    | undefined;
  const maxSpawn = dyn && Number.isFinite(dyn.maxSpawn) ? Math.max(1, Math.floor(dyn.maxSpawn)) : 4;
  const poolNames = dyn ? Object.keys(dyn.tools ?? {}) : [];
  const parentTimeout = dyn && Number.isFinite(dyn.timeout) ? Math.floor(dyn.timeout) : 0;
  const timeoutNote =
    parentTimeout === -1
      ? "Set a per-task timeoutMs (ms, > 0) to time-limit a worker; omit it for no limit."
      : parentTimeout === 0
        ? "Workers run with no time limit; any per-task timeoutMs is ignored."
        : `Every worker is limited to ${parentTimeout}ms; any per-task timeoutMs is ignored.`;
  return tool({
    name: "spawn_subagents",
    description:
      "Dynamically creates and runs specialized stateless sub-agents concurrently to handle sub-tasks. " +
      "Use this whenever a query or task benefits from modular delegation, parallel research, multi-perspective analysis, or division of labor. " +
      "All sub-agent outputs are aggregated and returned inside structured XML tags. " +
      `You may spawn at most ${maxSpawn} sub-agent(s) per call — extra tasks beyond ${maxSpawn} are ignored. ` +
      "Workers are stateless: each receives one task, returns its result, then shuts down; no conversation history is kept. " +
      "You cannot choose worker models or reasoning levels. " +
      (poolNames.length > 0
        ? `Worker-available tools: ${poolNames.join(", ")}. Grant each worker ONLY the tools its task needs via the per-task tools list; omit it for no tools. `
        : "No worker tools are available; omit the per-task tools list. ") +
      timeoutNote + " " +
      "Every entry in tasks MUST include all of: name (UPPER-KEBAB tag), instructions (system prompt for the worker), task (concrete assignment for the worker). " +
      "Example: {\"tasks\": [{\"name\": \"RESEARCH-ANALYST\", \"role\": \"memory market analyst\", \"instructions\": \"You are a memory market analyst. Return sourced findings only.\", \"task\": \"Research market pricing and supply constraints.\", \"tools\": [\"recent_news\"]}]}",
    input: z.object({
      tasks: z
        .array(
          z.object({
            name: z
              .string()
              .optional()
              .describe("Unique UPPER-KEBAB role tag dynamically derived from task (e.g. RESEARCH-ANALYST, MARKET-ANALYST, CODE-REVIEWER). Auto-generated when omitted."),
            role: z
              .string()
              .optional()
              .describe("Short persona / domain expertise for this sub-agent"),
            instructions: z
              .string()
              .optional()
              .describe("Personalized system prompt crafted by Main Agent to increase instruction following. Falls back to task when omitted."),
            task: z
              .string()
              .optional()
              .describe("Specific research/task prompt for this sub-agent. REQUIRED — falls back to instructions when omitted."),
            tools: z
              .array(z.string())
              .optional()
              .describe(
                poolNames.length > 0
                  ? `Tool names to grant this worker (subset of: ${poolNames.join(", ")}). Unknown names are ignored. Omit for no tools.`
                  : "No worker tools are available; omit this field."
              ),
            timeoutMs: z
              .number()
              .optional()
              .describe(
                parentTimeout === -1
                  ? "Per-worker timeout in ms (> 0). Honored because the developer set timeout: -1. Omit for no limit."
                  : "Per-worker timeout is developer-controlled; this field is ignored."
              ),
          })
        )
        .min(1)
        .describe(`Array of sub-agents to spawn (max ${maxSpawn} per call) — each gets a personalized prompt and runs statelessly on the developer-configured model`),
    }),
    execute: async ({ tasks }, context) => {
      if (!tasks || tasks.length === 0) {
        return "Error: tasks array is empty. Provide at least one entry shaped like {\"name\": \"RESEARCH-ANALYST\", \"role\": \"memory market analyst\", \"instructions\": \"<system prompt>\", \"task\": \"<concrete assignment>\"}. Fix the arguments and call spawn_subagents again.";
      }
      const repaired = tasks.map((entry: Record<string, unknown>, index: number) => {
        const rec = (entry ?? {}) as Record<string, unknown>;
        const taskText =
          (typeof rec["task"] === "string" && rec["task"].trim()) ||
          (typeof rec["instructions"] === "string" && (rec["instructions"] as string).trim()) ||
          "";
        const instructionsText =
          (typeof rec["instructions"] === "string" && (rec["instructions"] as string).trim()) ||
          (typeof rec["task"] === "string" && (rec["task"] as string).trim()) ||
          (typeof rec["role"] === "string" && (rec["role"] as string).trim()) ||
          "";
        const nameText =
          (typeof rec["name"] === "string" && (rec["name"] as string).trim()) ||
          `SUBAGENT-${index + 1}`;
        const roleText =
          typeof rec["role"] === "string" ? ((rec["role"] as string).trim() || undefined) : undefined;
        const toolsList = Array.isArray(rec["tools"])
          ? (rec["tools"] as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
          : undefined;
        const timeoutRaw = rec["timeoutMs"];
        const timeoutMs = typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) ? Math.floor(timeoutRaw) : undefined;
        return { ...rec, name: nameText, role: roleText, instructions: instructionsText, task: taskText, tools: toolsList, timeoutMs };
      });
      const invalid = repaired.findIndex((r) => !r.task);
      if (invalid >= 0) {
        const keys = Object.keys((tasks[invalid] ?? {}) as object).join(", ") || "(none)";
        return (
          `Error: tasks[${invalid}].task is missing and could not be inferred. ` +
          `Received keys: [${keys}]. ` +
          `Each tasks[] entry MUST include task (concrete assignment) plus instructions (system prompt) and name (UPPER-KEBAB tag). ` +
          `Example: {\"name\": \"RESEARCH-ANALYST\", \"role\": \"memory market analyst\", \"instructions\": \"You are a memory market analyst.\", \"task\": \"Research market pricing.\"}. ` +
          `Fix the entry and call spawn_subagents again.`
        );
      }
      if (context?.signal?.aborted) {
        throw new Error("Sub-agent spawning aborted");
      }

      const dynCfg = (parentAgent as any).dynamicSubagents as
        | { model?: unknown; maxSpawn: number; thinkingLevel?: string; tools: Record<string, ToolDefinition>; timeout: number }
        | undefined;
      const effectiveMax = dynCfg && Number.isFinite(dynCfg.maxSpawn) ? Math.max(1, Math.floor(dynCfg.maxSpawn)) : 4;
      const toolPool: Record<string, ToolDefinition> = (dynCfg?.tools as any) ?? {};
      const cfgTimeout = dynCfg && Number.isFinite(dynCfg.timeout) ? Math.floor(dynCfg.timeout) : 0;

      if (!parentAgent.subagentModel) {
        throw new Error(
          "[Agent Accelerator] Cannot spawn sub-agents: no sub-agent model is configured. " +
          "Set dynamicSubagents.model in Agent config or set the SUB_AGENT_MODEL environment variable."
        );
      }

      const { Agent: AgentClass } = await import("./agent.ts");

      const subagentMetadataList: SubAgentExecutionMetadata[] = [];
      const seenNames = new Set<string>();

      // maxSpawn: trim extras safely — only the first N tasks run.
      const limitedTasks = repaired.slice(0, effectiveMax);
      // Q-39: reserve spawns against maxTotalSubagents before running.
      reserveSpawn(parentAgent, limitedTasks.length);
      // Q-42: batch run id for lineage; per-worker ids attach to metadata.
      const batchRunId = newRunId();
      const parentRunId =
        (parentAgent as unknown as { currentRunId?: unknown; runId?: unknown }).currentRunId ??
        (parentAgent as unknown as { runId?: unknown }).runId;
      const rootRunId =
        (parentAgent as unknown as { rootRunId?: unknown }).rootRunId ?? parentRunId;
      const executedResults = await Promise.all(
        limitedTasks.map(async (t) => {
          const startTime = nowMs();
          const workerTurnId = newTurnId();
          let sanitized = sanitizeXmlTag(t.name);
          let deduped = sanitized;
          let suffix = 1;
          while (seenNames.has(deduped)) {
            deduped = `${sanitized}-${suffix++}`;
          }
          seenNames.add(deduped);
          const subagentName = deduped;
          // Stable tracking id: `SUBAGENT-NAME-{32hex}` addresses one worker
          // among many concurrent ones for `agent.track(id)` + session logs.
          const trackingId = createTrackingId();
          const displayId = `${subagentName}-${trackingId}`;
          let workerSessionId: string | undefined;

          // Fixed developer-configured worker model — never LLM-choosable.
          const chosenModel: any = parentAgent.subagentModel;
          // Normalize chosenModel to string|ModelSpec handling
          let chosenModelStrForProvider = typeof chosenModel === "string" ? chosenModel : (chosenModel as any)?.model ?? (chosenModel as any)?.id ?? String(chosenModel);
          let attemptedProvider = providerOf(chosenModelStrForProvider);
          // Determine creds: only reuse parent creds if provider matches parent provider, else let env resolve for cross-provider
          const parentProvider = providerOf(parentAgent.modelStringOrSpec as any);
          const targetProviderFinal = providerOf(chosenModelStrForProvider);
          let apiKeyToUse: string | undefined;
          let baseUrlToUse: string | undefined;
          if (targetProviderFinal === parentProvider) {
            apiKeyToUse = parentAgent.apiKey;
            baseUrlToUse = parentAgent.baseUrl;
          } else {
            apiKeyToUse = undefined;
            baseUrlToUse = undefined;
          }

          const runWithModel = async (modelToUse: any, apiKey: string | undefined, baseUrl: string | undefined) => {
            if (context?.signal?.aborted) throw new Error("Aborted before spawn");
            const childSessionId = createChildSessionId(parentAgent.sessionId, subagentName);
            workerSessionId = childSessionId;
            // Register the live trace BEFORE the run so `agent.track(id)`
            // sees every step in realtime, even while the worker runs.
            const trace: SubAgentTrace = {
              trackingId,
              name: subagentName,
              sessionId: childSessionId,
              parentSessionId: parentAgent.sessionId,
              status: "running",
              task: t.task,
              role: t.role,
              turns: 0,
              steps: [],
            };
            insertTrace(trace, displayId);
            try {
              const parentTraces = ((parentAgent as any).subagentTraces ??= {}) as Record<string, SubAgentTrace>;
              parentTraces[trackingId] = trace;
            } catch {}
            const persistParent = () => {
              try { (parentAgent as any).persistNow?.(); } catch {}
            };
            const onWorkerTurn = (turn: { turns: number; text?: string; thinking?: string; toolCalls?: Array<{ name: string }>; toolResults?: Array<{ name: string; isError?: boolean }> }) => {
              try {
                liveTurn = turn.turns;
                // Finalize any partial streaming entry for this turn, then
                // log structural steps (tool calls/results) as before.
                const timestamp = Date.now();
                const partialEntry = findPartial(liveTurn);
                if (partialEntry) {
                  if (turn.text) partialEntry.text = turn.text;
                  if (turn.thinking) partialEntry.thinking = turn.thinking;
                  delete (partialEntry as any).partial;
                } else if (turn.text) {
                  trace.steps.push({ turn: turn.turns, type: "assistant", text: turn.text.slice(0, 2000), timestamp });
                }
                for (const tc of turn.toolCalls ?? []) {
                  trace.steps.push({ turn: turn.turns, type: "tool_call", name: tc.name, timestamp });
                }
                for (const tr of turn.toolResults ?? []) {
                  trace.steps.push({ turn: turn.turns, type: "tool_result", name: tr.name, isError: tr.isError, timestamp });
                }
                trace.turns = Math.max(trace.turns, turn.turns);
                trimTraceSteps(trace);
                touchTrace(trace.trackingId);
                notifyTrace(trackingId);
                persistParent();
              } catch {}
            };
            // Realtime thinking/text: the worker is streamed internally and
            // every delta lands in the trace (partial entry, updated in
            // place) so `agent.track(id)` shows generation as it happens —
            // not just at turn end. Deltas also ride to the parent stream via
            // `context.onSubagentEvent` (streaming parent runs only).
            let liveTurn = 1;
            let partialText = "";
            let partialThinking = "";
            const findPartial = (turn: number): SubAgentStep | undefined => {
              for (let i = trace.steps.length - 1; i >= 0; i--) {
                const s = trace.steps[i]!;
                if (s.turn === turn && s.partial) return s;
              }
              return undefined;
            };
            const forwardDelta = (delta?: string, thinkingDelta?: string) => {
              try {
                context?.onSubagentEvent?.({
                  trackingId: displayId,
                  delta,
                  thinkingDelta,
                  partialText: partialText || undefined,
                  partialThinking: partialThinking || undefined,
                });
              } catch {}
            };
            const onWorkerDelta = (delta?: string, thinkingDelta?: string) => {
              try {
                if (delta) {
                  partialText = (partialText + delta).slice(-10000);
                  let entry = findPartial(liveTurn);
                  if (!entry) {
                    entry = { turn: liveTurn, type: "assistant", text: "", partial: true, timestamp: Date.now() };
                    trace.steps.push(entry);
                  }
                  entry.text = partialText;
                  entry.timestamp = Date.now();
                }
                if (thinkingDelta) {
                  partialThinking = (partialThinking + thinkingDelta).slice(-10000);
                  let entry = findPartial(liveTurn);
                  if (!entry) {
                    entry = { turn: liveTurn, type: "assistant", text: "", partial: true, timestamp: Date.now() };
                    trace.steps.push(entry);
                  }
                  entry.thinking = partialThinking;
                  entry.timestamp = Date.now();
                }
                trimTraceSteps(trace);
                notifyTrace(trackingId);
                forwardDelta(delta, thinkingDelta);
              } catch {}
            };
            // Grant ONLY the Main Agent-selected subset from the developer pool. Unknown names are dropped.
            // Matching is case/format-insensitive (same rules as tool execution): the model may emit
            // "RECENT_NEWS" or "recent news" for a registered "recent_news" tool.
            const poolByNormalized = new Map<string, ToolDefinition>();
            for (const [key, def] of Object.entries(toolPool)) {
              poolByNormalized.set(normalizeToolName(key), def);
              const declared = (def as ToolDefinition)?.name;
              if (declared) poolByNormalized.set(normalizeToolName(declared), def);
            }
            const grantedTools: Record<string, ToolDefinition> = {};
            for (const toolName of (t as any).tools ?? []) {
              const pooled = toolPool[toolName] ?? poolByNormalized.get(normalizeToolName(String(toolName)));
              if (pooled) grantedTools[(pooled as ToolDefinition).name || toolName] = pooled;
            }
            // Timeout: >0 fixed for every worker; 0 = no limit; -1 = per-task timeoutMs from the Main Agent.
            const workerTimeout = cfgTimeout > 0 ? cfgTimeout : cfgTimeout === -1 && (t as any).timeoutMs > 0 ? (t as any).timeoutMs : 0;
            const subAgent = new AgentClass({
              name: t.name,
              description: t.role || `Sub-agent ${t.name}`,
              instructions: t.instructions,
              model: modelToUse,
              apiKey,
              baseUrl,
              thinkingLevel: (dynCfg?.thinkingLevel as any) ?? parentAgent.thinkingConfig?.level,
              sessionId: childSessionId,
              tools: grantedTools,
              // Stateless by design: one task in, one result out, then shut down. No history, no recursion.
              stateless: true,
              serviceTier: parentAgent.serviceTier,
              headers: parentAgent.customHeaders,
              maxTurns: parentAgent.maxTurns,
            });
            // Lineage binding: child records its parent session so persisted
            // snapshots and routing can tell siblings apart even when ids
            // are truncated to 64 chars.
            try {
              (subAgent as any).parentSessionId = parentAgent.sessionId;
            } catch {}
            let abortListener: (() => void) | null = null;
            // Per-worker controller: the parent signal alone cannot stop a
            // worker that hits its own timeout, so the timeout path aborts
            // the worker explicitly instead of leaving it running unseen.
            const workerController = new AbortController();
            const parentSignal = context?.signal;
            const forwardParentAbort = () => {
              try {
                workerController.abort((parentSignal as any)?.reason);
              } catch {
                try { workerController.abort(); } catch {}
              }
            };
            if (parentSignal?.aborted) forwardParentAbort();
            else parentSignal?.addEventListener("abort", forwardParentAbort, { once: true });
            const abortPromise = parentSignal
              ? new Promise<never>((_, reject) => {
                  const onAbort = () => reject(new Error("Sub-agent aborted via parent signal"));
                  abortListener = onAbort;
                  if (parentSignal.aborted) reject(new Error("Sub-agent aborted via parent signal"));
                  else parentSignal.addEventListener("abort", onAbort, { once: true });
                })
              : null;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;
            const timeoutPromise = workerTimeout > 0
              ? new Promise<never>((_, reject) => {
                  timeoutId = setTimeout(() => {
                    try {
                      workerController.abort(new Error(`Sub-agent ${subagentName} timed out after ${workerTimeout}ms`));
                    } catch {}
                    reject(new Error(`Sub-agent ${subagentName} timed out after ${workerTimeout}ms`));
                  }, workerTimeout);
                })
              : null;
            // Streamed internally (consumed to completion): same final result
            // as run(), but text/thinking deltas flow into the trace live.
            const workerStream = subAgent.stream(t.task, { signal: workerController.signal, onTurn: onWorkerTurn } as any);
            const textListener = (e: any) => onWorkerDelta(e.delta, undefined);
            const thinkingListener = (e: any) => onWorkerDelta(undefined, e.thinkingDelta);
            workerStream.on("text_delta", textListener);
            workerStream.on("thinking_delta", thinkingListener);
            const taskPromise = workerStream.result();
            try {
              const racers: Promise<unknown>[] = [taskPromise as unknown as Promise<unknown>];
              if (abortPromise) racers.push(abortPromise);
              if (timeoutPromise) racers.push(timeoutPromise);
              const res = await Promise.race(racers);
              return res;
            } finally {
              if (timeoutId) clearTimeout(timeoutId);
              try { workerStream.cancel(); } catch {}
              try { workerStream.off("text_delta", textListener); } catch {}
              try { workerStream.off("thinking_delta", thinkingListener); } catch {}
              if (abortListener && parentSignal) {
                try { parentSignal.removeEventListener("abort", abortListener as any); } catch {}
              }
              try { parentSignal?.removeEventListener("abort", forwardParentAbort); } catch {}
            }
          };

          try {
            const res: any = await runWithModel(chosenModel, apiKeyToUse, baseUrlToUse);

            const durationMs = Math.max(0, nowMs() - startTime);
            const rawText = (res as any).text;
            const subagentText = typeof rawText === "string" && rawText.trim().length > 0
              ? rawText
              : `[Sub-agent ${subagentName} produced no output (empty response).]`;

            const live = subagentTraces.get(trackingId);
            if (live) {
              live.status = "done";
              live.model = (res as any).model;
              live.provider = (res as any).provider;
              live.turns = (res as any).turns ?? live.turns;
              live.usage = (res as any).usage
                ? { inputTokens: (res as any).usage.inputTokens ?? 0, outputTokens: (res as any).usage.outputTokens ?? 0, totalTokens: (res as any).usage.totalTokens ?? 0 }
                : live.usage;
              live.text = subagentText;
              trimTraceSteps(live);
              touchTrace(live.trackingId);
              notifyTrace(trackingId);
            }
            try { (parentAgent as any).persistNow?.(); } catch {}
            // Q-39: charge completed worker usage, then enforce token/cost/duration budgets.
            try { chargeBudgetUsage(parentAgent, (res as any).usage); } catch {}
            try {
              checkBudget(readBudget(parentAgent), readBudgetState(parentAgent), { usage: undefined });
            } catch (budgetErr) {
              const be = budgetErr as { context?: { partial?: Record<string, unknown> } };
              try {
                if (be && typeof be === "object" && be.context?.partial) {
                  (be.context.partial as Record<string, unknown>)["text"] = subagentText;
                  (be.context.partial as Record<string, unknown>)["turns"] = (res as any).turns ?? 0;
                  (be.context.partial as Record<string, unknown>)["usage"] = (res as any).usage;
                }
              } catch {}
              throw budgetErr;
            }
            const metadata: SubAgentExecutionMetadata = {
              name: subagentName,
              trackingId: displayId,
              sessionId: workerSessionId,
              parentSessionId: parentAgent.sessionId,
              role: t.role,
              task: t.task,
              model: (res as any).model,
              provider: (res as any).provider,
              durationMs,
              usage: (res as any).usage,
              turns: (res as any).turns,
              finishReason: (res as any).finishReason,
              responseId: (res as any).responseId,
              text: subagentText,
              thinking: (res as any).thinking,
              toolCalls: (res as any).toolCalls,
              raw: (res as any).raw,
              steps: live ? live.steps.map((s) => ({ ...s })) : undefined,
              isError: false,
            };
            // Q-42 lineage (untyped: response.ts is owned elsewhere) + Q-43 provider meta passthrough.
            try {
              const m = metadata as unknown as Record<string, unknown>;
              m["runId"] = newRunId();
              m["turnId"] = workerTurnId;
              if (parentRunId !== undefined) m["parentRunId"] = parentRunId;
              if (rootRunId !== undefined) m["rootRunId"] = rootRunId;
              else if (parentRunId !== undefined) m["rootRunId"] = parentRunId;
              else m["rootRunId"] = batchRunId;
              if ((res as any).meta !== undefined) m["meta"] = (res as any).meta;
            } catch {}
            return { name: subagentName, trackingId: displayId, text: subagentText, metadata };
          } catch (err: any) {
            if (err && (err as { code?: unknown }).code === "budget_exceeded") throw err;
            const durationMs = Math.max(0, nowMs() - startTime);
            const errorMessage = err?.message || String(err);
            const prov = attemptedProvider || providerOf(chosenModelStrForProvider) || providerOf(chosenModel as any) || "unknown";
            const live = subagentTraces.get(trackingId);
            if (live) {
              live.status = "error";
              live.error = errorMessage;
              notifyTrace(trackingId);
            }
            try { (parentAgent as any).persistNow?.(); } catch {}
            const metadata: SubAgentExecutionMetadata = {
              name: subagentName,
              trackingId: displayId,
              sessionId: workerSessionId,
              parentSessionId: parentAgent.sessionId,
              role: t.role,
              task: t.task,
              model: typeof chosenModel === "string" ? chosenModel : ((chosenModel as any)?.model ?? (chosenModel as any)?.id ?? "unknown"),
              provider: prov,
              durationMs,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              turns: 0,
              text: `Error executing sub-agent ${t.name}: ${errorMessage}`,
              steps: live ? live.steps.map((s) => ({ ...s })) : undefined,
              isError: true,
              error: errorMessage,
            };
            try {
              const m = metadata as unknown as Record<string, unknown>;
              m["runId"] = newRunId();
              m["turnId"] = workerTurnId;
              if (parentRunId !== undefined) m["parentRunId"] = parentRunId;
              if (rootRunId !== undefined) m["rootRunId"] = rootRunId;
              else if (parentRunId !== undefined) m["rootRunId"] = parentRunId;
              else m["rootRunId"] = batchRunId;
            } catch {}
            return { name: subagentName, trackingId: displayId, text: `Error executing sub-agent ${t.name}: ${errorMessage}`, metadata };
          }
        })
      );

      const xmlBlocks = executedResults.map((r) => {
        subagentMetadataList.push(r.metadata);
        const escaped = escapeXml(r.text);
        const indentedText = escaped.split("\n").map((line) => `        ${line}`).join("\n");
        return `    <${r.name}>\n${indentedText}\n    </${r.name}>`;
      });

      const xmlOutput = `<SUB-AGENTS-RESPONSE>\n${xmlBlocks.join("\n")}\n</SUB-AGENTS-RESPONSE>`;

      const resultPayload = {
        xml: xmlOutput,
        _subagentMetadata: subagentMetadataList,
        toString() { return xmlOutput; },
      };
      return resultPayload;
    },
  });
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
export function agentToTool(
  input: Agent | AgentAsToolTarget
): ToolDefinition {
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
      const trackingId = createTrackingId();
      const displayId = `${name}-${trackingId}`;
      // Q-42 lineage for fixed-delegation calls.
      const callRunId = newRunId();
      const callTurnId = newTurnId();
      try {
        const parentSessionId = ctx?.sessionId || agentInstance.sessionId || "session";
        const subSessionId = createFixedChildSessionId(parentSessionId, sanitizeToolName(name));
        const trace: SubAgentTrace = {
          trackingId,
          name,
          sessionId: subSessionId,
          parentSessionId,
          status: "running",
          task,
          turns: 0,
          steps: [],
        };
        insertTrace(trace, displayId);
        const onWorkerTurn = (turn: { turns: number; text?: string; thinking?: string; toolCalls?: Array<{ name: string }>; toolResults?: Array<{ name: string; isError?: boolean }> }) => {
          try {
            liveTurn = turn.turns;
            const timestamp = Date.now();
            const partialEntry = findPartial(liveTurn);
            if (partialEntry) {
              if (turn.text) partialEntry.text = turn.text;
              if (turn.thinking) partialEntry.thinking = turn.thinking;
              delete (partialEntry as any).partial;
            } else if (turn.text) {
              trace.steps.push({ turn: turn.turns, type: "assistant", text: turn.text.slice(0, 2000), timestamp });
            }
            for (const tc of turn.toolCalls ?? []) trace.steps.push({ turn: turn.turns, type: "tool_call", name: tc.name, timestamp });
            for (const tr of turn.toolResults ?? []) trace.steps.push({ turn: turn.turns, type: "tool_result", name: tr.name, isError: tr.isError, timestamp });
            trace.turns = Math.max(trace.turns, turn.turns);
            trimTraceSteps(trace);
            touchTrace(trace.trackingId);
            notifyTrace(trackingId);
          } catch {}
        };
        let liveTurn = 1;
        let partialText = "";
        let partialThinking = "";
        const findPartial = (turn: number): SubAgentStep | undefined => {
          for (let i = trace.steps.length - 1; i >= 0; i--) {
            const s = trace.steps[i]!;
            if (s.turn === turn && s.partial) return s;
          }
          return undefined;
        };
        const onWorkerDelta = (delta?: string, thinkingDelta?: string) => {
          try {
            if (delta) {
              partialText = (partialText + delta).slice(-10000);
              let entry = findPartial(liveTurn);
              if (!entry) {
                entry = { turn: liveTurn, type: "assistant", text: "", partial: true, timestamp: Date.now() };
                trace.steps.push(entry);
              }
              entry.text = partialText;
              entry.timestamp = Date.now();
            }
            if (thinkingDelta) {
              partialThinking = (partialThinking + thinkingDelta).slice(-10000);
              let entry = findPartial(liveTurn);
              if (!entry) {
                entry = { turn: liveTurn, type: "assistant", text: "", partial: true, timestamp: Date.now() };
                trace.steps.push(entry);
              }
              entry.thinking = partialThinking;
              entry.timestamp = Date.now();
            }
            trimTraceSteps(trace);
            notifyTrace(trackingId);
            try {
              ctx?.onSubagentEvent?.({
                trackingId: displayId,
                delta,
                thinkingDelta,
                partialText: partialText || undefined,
                partialThinking: partialThinking || undefined,
              });
            } catch {}
          } catch {}
        };
        const workerStream = agentInstance.stream(task, { signal: ctx?.signal, sessionId: subSessionId, onTurn: onWorkerTurn } as any);
        const textListener = (e: any) => onWorkerDelta(e.delta, undefined);
        const thinkingListener = (e: any) => onWorkerDelta(undefined, e.thinkingDelta);
        workerStream.on("text_delta", textListener);
        workerStream.on("thinking_delta", thinkingListener);
        let response: any;
        try {
          response = await workerStream.result();
        } finally {
          try { workerStream.off("text_delta", textListener); } catch {}
          try { workerStream.off("thinking_delta", thinkingListener); } catch {}
        }
        const durationMs = Math.max(0, nowMs() - startTime);
        const live = subagentTraces.get(trackingId);
        if (live) {
          live.status = "done";
          live.model = response.model;
          live.provider = response.provider;
          live.turns = response.turns ?? live.turns;
          live.text = response.text;
          trimTraceSteps(live);
          touchTrace(live.trackingId);
          notifyTrace(trackingId);
        }
        const metadata: SubAgentExecutionMetadata = {
          name,
          trackingId: displayId,
          sessionId: subSessionId,
          parentSessionId,
          task,
          model: response.model,
          provider: response.provider,
          durationMs,
          usage: response.usage,
          turns: response.turns,
          finishReason: response.finishReason,
          responseId: response.responseId,
          text: response.text,
          thinking: response.thinking,
          toolCalls: response.toolCalls,
          raw: response.raw,
          steps: live ? live.steps.map((s) => ({ ...s })) : undefined,
          isError: false,
        };
        try {
          const m = metadata as unknown as Record<string, unknown>;
          m["runId"] = callRunId;
          m["turnId"] = callTurnId;
          if (response.meta !== undefined) m["meta"] = response.meta;
        } catch {}
        const wrapper: any = {
          xml: response.text,
          _subagentMetadata: [metadata],
          toString() { return response.text; },
        };
        return wrapper;
      } catch (err: any) {
        const durationMs = Math.max(0, nowMs() - startTime);
        const msg = err?.message || String(err);
        const live = subagentTraces.get(trackingId);
        if (live) {
          live.status = "error";
          live.error = msg;
          trimTraceSteps(live);
          touchTrace(live.trackingId);
          notifyTrace(trackingId);
        }
        const metadata: SubAgentExecutionMetadata = {
          name,
          trackingId: displayId,
          task,
          model: "unknown",
          provider: "unknown",
          durationMs,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          turns: 0,
          text: `Error in ${name}: ${msg}`,
          steps: live ? live.steps.map((s) => ({ ...s })) : undefined,
          isError: true,
          error: msg,
        };
        try {
          const m = metadata as unknown as Record<string, unknown>;
          m["runId"] = callRunId;
          m["turnId"] = callTurnId;
        } catch {}
        const wrapper: any = {
          xml: `Error in ${name}: ${msg}`,
          _subagentMetadata: [metadata],
          toString() { return `Error in ${name}: ${msg}`; },
        };
        return wrapper;
      }
    },
  });
}

/**
 * Converts a list of agents into uniquely named delegation tools.
 *
 * @example `const tools = buildAgentTools([researcher, reviewer]);`
 */
export function buildAgentTools(
  agents?: (Agent | AgentAsToolTarget)[]
): Record<string, ToolDefinition> {
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
