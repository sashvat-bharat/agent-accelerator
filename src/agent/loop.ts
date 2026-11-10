import type { Provider, ProviderRequestOptions, ModelSpec, ProviderRawData } from "../types/model.ts";
import type { ToolDefinition, ToolCallRecord, ToolResultRecord } from "../types/tool.ts";
import type { TokenUsage } from "../types/core.ts";
import type { AgentRunOptions } from "../types/agent.ts";
import type { ContentPart } from "../types/message.ts";
import {
  AgentResponse,
  normalizeFinishReason,
  type FinishReason,
  type SubAgentExecutionMetadata,
  type StreamEvent,
} from "../types/response.ts";
import { priceUsage, reportUsageAnomaly } from "../session/store.ts";
import { telemetryBus } from "../telemetry.ts";
export { telemetryBus };
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentContext } from "./context.ts";
import { toStandardToolDeclarations } from "../tools/tool.ts";
import {
  executeToolCalls,
  findToolDefinition,
  isRepeatableTool,
  makeRepeatBlockedResult,
  shouldBlockRepeat,
  toolCallFingerprint,
  traceToolEvent,
  type ExecuteToolsOptions,
} from "../tools/executor.ts";
import { getModelFromCatalog, ensureModelCatalogFresh, validateModelThinking } from "../models/catalog.ts";
import { enforceFileAccess } from "../utils/safe-io.ts";
import { isSubagentResult, normalizeSubagentMetadata } from "../tools/subagent-result.ts";
import { BudgetExceededError, TimeoutError } from "../types/errors.ts";
import { applyCaptureRaw, type CaptureRawMode } from "../utils/raw-capture.ts";
import { previewPrompt } from "../utils/session.ts";
import { noteProviderTurn, normalizeStructuredOutput, parseStructuredOutput } from "../providers.ts";

/** One mid-session steer request buffered while a run is active. */
export interface SteerEntry {
  prompt: string | ContentPart[];
  options?: AgentRunOptions;
  /**
   * @internal Settles the promise handed to the `steer()` caller. If the run
   * ends before the prompt is injected, the entry becomes a queued follow-up
   * (`deferredToQueue`) and the caller's promise resolves with THAT run's
   * response instead of the finished one.
   */
  settle?: { resolve: (res: AgentResponse) => void; reject: (err: unknown) => void; deferredToQueue?: boolean };
}

export interface AgentLoopConfig {
  agentName?: string;
  provider: Provider;
  modelId: string;
  context: AgentContext;
  tools: Record<string, ToolDefinition>;
  options?: ProviderRequestOptions;
  runOptions?: AgentRunOptions;
  maxTurns?: number;
  /** Local-file policy: media paths must resolve inside `roots` (see `AgentConfig.fileAccess`). */
  fileAccess?: { roots?: string[] };
  /**
   * What to do with the conversation when a run fails (not aborts):
   * - `"auto"` (default): roll back to the pre-run checkpoint, UNLESS a tool
   *   already executed. Rolling back then would erase the only record of real
   *   side effects (emails sent, rows written) and a retry would repeat them.
   * - `"rollback"`: always restore the checkpoint.
   * - `"keep"`: never restore it.
   */
  onFailure?: "auto" | "rollback" | "keep";
  /** Wire-exchange capture policy for `AgentResponse.raw` (default `"redacted"`: no bodies). */
  captureRaw?: CaptureRawMode;
  /**
   * Budget hook. Called with no argument at the start of every turn (time /
   * count checks) and with a priced usage snapshot after each model turn and
   * each finished sub-agent (charge + check). Throws `BudgetExceededError`
   * to stop the run.
   */
  enforceBudget?: (usage?: TokenUsage) => void;
  /** Called after every turn for durable persistence checkpoints (never fails a turn). */
  onProgress?: () => void;
  /** Called once per model call this agent made itself (never for its workers), with the provider's usage and the catalog spec: the source of `usageReport()`. */
  onTurnUsage?: (usage: TokenUsage, spec: ModelSpec | undefined) => void;
  /** Called the moment each tool call finishes, before the rest of its batch (the crash-proof record of finished work). */
  onToolResult?: (result: ToolResultRecord) => void;
  /** Opens the log file of one tool call (see `ToolLogs`); unset when the Agent does not persist to a folder. */
  openToolLog?: ExecuteToolsOptions["openToolLog"];
  /**
   * Continue a run that a crash cut off instead of starting from a new prompt: tool calls the last assistant turn made
   * without a stored result are finished first (a result in `stored` is reused, anything else runs now), then the loop goes on.
   */
  resume?: { stored: Map<string, ToolResultRecord> };
  /**
   * Shared steer inbox for mid-session redirection. Entries are drained
   * between turns (after the current provider/tool work finishes) and
   * injected into the *current* turn — same response, same turn budget.
   * Mutated in place by `agent.steer()` / `run(..., { enqueue: "steer" })`.
   */
  steerInbox?: SteerEntry[];
  /** Called after steer entries are injected (streaming loops also push `steer_injected` events). */
  onSteerInjected?: (injectedPrompts: string[]) => void;
  /**
   * Canonical structured-output request (raw `AgentConfig.output`).
   * Normalized per turn for the provider wire; validated once at the end
   * into `AgentResponse.parsed`. Agent-level only.
   */
  output?: unknown;
}

/**
 * Drains pending steer entries into the conversation as new user messages.
 * Returns display previews for events/telemetry. Never throws: invalid
 * entries are skipped so one bad steer cannot fail the active turn.
 */
function drainSteerInbox(context: AgentContext, inbox?: SteerEntry[]): string[] {
  if (!inbox || inbox.length === 0) return [];
  const injected: string[] = [];
  while (inbox.length > 0) {
    const entry = inbox.shift()!;
    try {
      let prompt = entry.prompt as string | ContentPart[];
      const opts = entry.options;
      if (Array.isArray(prompt) && prompt.length === 0) continue;
      if (opts?.additionalContext) {
        const prefix = `[Additional Context]\n${opts.additionalContext}\n\n`;
        if (typeof prompt === "string") prompt = prefix + prompt;
        else prompt = [{ type: "text", text: prefix } as ContentPart, ...prompt];
      }
      context.addUserMessage(prompt);
      injected.push(previewPrompt(entry.prompt));
    } catch {
      continue;
    }
  }
  return injected;
}

// Reports one finished turn to the caller's onTurn hook (ids only), never throwing; in: both loops, out: AgentRunOptions.onTurn.
function emitTurn(
  runOptions: AgentRunOptions | undefined,
  turn: {
    turns: number;
    text?: string;
    thinking?: string;
    toolCalls?: ToolCallRecord[];
    toolResults?: ToolResultRecord[];
  }
): void {
  try {
    runOptions?.onTurn?.({
      turns: turn.turns,
      text: turn.text,
      thinking: turn.thinking,
      toolCalls: turn.toolCalls?.map((c) => ({ id: c.id, name: c.name })),
      toolResults: turn.toolResults?.map((r) => ({ id: r.id, name: r.name, isError: r.isError })),
    });
  } catch {}
}

/**
 * Per-turn `toolChoice`. `"none"` holds for the whole run; a forced choice
 * (`"required"` or a pinned function) applies to the FIRST model turn only:
 * forcing a tool call on every turn would keep the model calling tools until
 * `maxTurns`, so the run could never produce a final answer.
 */
function toolChoiceForTurn(
  choice: ProviderRequestOptions["toolChoice"],
  turn: number
): ProviderRequestOptions["toolChoice"] {
  if (choice === undefined || choice === "auto") return undefined;
  if (choice === "none") return "none";
  return turn === 1 ? choice : undefined;
}

/** Whether a failed run should restore its pre-run checkpoint (see `AgentLoopConfig.onFailure`). */
function shouldRollbackOnFailure(
  policy: "auto" | "rollback" | "keep" | undefined,
  isAbort: boolean,
  toolsExecuted: boolean
): boolean {
  if (isAbort) return false;
  if (policy === "keep") return false;
  if (policy === "rollback") return true;
  return !toolsExecuted;
}

// Calls the persistence checkpoint hook, never throwing; in: both loops after each step, out: Agent.persistNow.
function emitProgress(config: { onProgress?: () => void }): void {
  try {
    config.onProgress?.();
  } catch {}
}

// ---------------------------------------------------------------------------
// Structured outputs (canonical output wiring for the loop).
// ---------------------------------------------------------------------------

// Normalizes the structured-output option once per run (raw value + provider spec); in: AgentLoopConfig.output, out: the final-answer validation.
function resolveLoopOutput(config: AgentLoopConfig): {
  raw: unknown;
  spec: import("../types/model.ts").StructuredOutputSpec | undefined;
} {
  const raw = (config as { output?: unknown }).output;
  const fromOptions = (config.options as { output?: import("../types/model.ts").StructuredOutputSpec } | undefined)
    ?.output;
  if (raw !== undefined && raw !== null) {
    // Throws ValidationError for invalid shapes — caught by run/stream catch
    // with partial attached, same as other config validation.
    const spec = normalizeStructuredOutput(raw);
    return { raw, spec };
  }
  if (fromOptions) return { raw: fromOptions, spec: fromOptions };
  return { raw: undefined, spec: undefined };
}

// Validates the final text against the structured-output option, throwing ValidationError on mismatch; in: the last model text, out: AgentResponse.parsed.
function parseFinalStructuredOutput(
  text: string,
  raw: unknown,
  spec: import("../types/model.ts").StructuredOutputSpec | undefined
): unknown | undefined {
  if (raw === undefined && spec === undefined) return undefined;
  // Strict-fail when opted in: invalid JSON/schema throws ValidationError.
  // Tool turns skip this (called only for final no-tool text).
  return parseStructuredOutput(text, raw ?? spec);
}

/**
 * Normalizes `maxTurns` to a safe positive integer (default Infinity).
 * `0` means infinite (no limit), matching the `timeout: 0` convention.
 * Prevents silent zero-turn runs from negative values (clamped to 1).
 */
function normalizeMaxTurns(value?: number): number {
  if (value === undefined) return Infinity;
  if (value === 0 || value === Infinity) return Infinity;
  if (!Number.isFinite(value as number)) return Infinity;
  return Math.max(1, Math.floor(value as number));
}

/**
 * Warns when an agent run stops because `maxTurns` was exhausted while
 * the model still wanted to call tools. Without this, the loop simply
 * returns the last tool-turn text (often empty) with `finishReason:
 * "tool_calls"`, which looks like success while dropping pending work.
 */
function warnMaxTurnsHit(agentName: string | undefined, maxTurns: number, pendingTools: string[]): void {
  const who = agentName ? `"${agentName}"` : "Agent";
  const tools = pendingTools.length > 0 ? ` Pending tool calls dropped: ${pendingTools.join(", ")}.` : "";
  // No console.* in library code — route via the telemetry bus
  // (default no-op; CLIs attach a pretty logger via telemetryBus.onEvent).
  try {
    telemetryBus.emitWarning(
      "agent.max_turns_truncated",
      `[Agent Accelerator] "${who}" hit maxTurns (${maxTurns}) with unfinished tool calls.${tools} Increase maxTurns or split the task.`,
      { agentName, maxTurns, pendingTools }
    );
  } catch {
    // why: telemetry emission is observability-only and must never throw.
  }
}

// ---------------------------------------------------------------------------
// Tool-call/result pairing repair.
// ---------------------------------------------------------------------------

/**
 * Repairs tool call/result pairing before each provider request.
 *
 * Providers reject a `tool_result` without its `tool_call`, a `tool_call`
 * without its result, AND (Chat-Completions style APIs) results that are not
 * directly after the assistant message that issued the calls. A prior abort or
 * crash can leave any of these in history, so the repair:
 * - re-emits every result immediately after its assistant message, in call order;
 * - synthesizes an error result for calls that never got one (e.g. `interrupt()`
 *   fired before the tools ran), at that same position;
 * - drops results whose id the model never issued.
 * Open-weight models that reuse one id for several calls keep one result per call.
 */
export function ensureToolPairing(context: AgentContext): void {
  try {
    type ToolResultPart = Extract<ContentPart, { type: "tool_result" }>;
    const messages = context.messages;
    // Pass 1: queue every existing result part by id (document order).
    const results = new Map<string, Array<{ part: ToolResultPart; message: (typeof messages)[number] }>>();
    for (const m of messages) {
      if (m?.role !== "tool" || !Array.isArray(m.content)) continue;
      for (const p of m.content) {
        if (p && p.type === "tool_result" && typeof p.id === "string" && p.id) {
          const q = results.get(p.id) ?? [];
          q.push({ part: p, message: m });
          results.set(p.id, q);
        }
      }
    }
    // Pass 2: rebuild, placing each assistant's results right behind it.
    const rebuilt: typeof messages = [];
    for (const m of messages) {
      if (m?.role === "tool") continue; // re-emitted next to their calls (orphans dropped)
      rebuilt.push(m);
      if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const p of m.content) {
        if (!p || p.type !== "tool_call" || typeof p.id !== "string" || !p.id) continue;
        const hit = results.get(p.id)?.shift();
        if (hit) {
          // Reuse the original message object when it carried exactly this result.
          rebuilt.push(
            hit.message.content.length === 1 ? hit.message : { role: "tool", name: hit.part.name, content: [hit.part] }
          );
        } else {
          const name = typeof p.name === "string" ? p.name : "tool";
          traceToolEvent("call_interrupted", "warn", { id: p.id, name }, {});
          rebuilt.push({
            role: "tool",
            name,
            content: [
              {
                type: "tool_result",
                id: p.id,
                name,
                result: `Error: tool_call '${name}' (${p.id}) has no result because the run was interrupted before it completed (recovered by ensureToolPairing). It may have partially executed: check the tool trace before repeating side-effecting work.`,
                isError: true,
              },
            ],
          });
        }
      }
    }
    const unchanged = rebuilt.length === messages.length && rebuilt.every((m, i) => m === messages[i]);
    if (!unchanged) context.messages = rebuilt;
  } catch {}
}

// ---------------------------------------------------------------------------
// Abort + limits helpers.
// ---------------------------------------------------------------------------

export interface LoopLimits {
  maxTurns?: number;
  deadlineMs?: number;
  maxToolCallsPerRun?: number;
  maxTotalTokens?: number;
  requestTimeoutMs: number;
  firstByteTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

/** Resolves `(config as any).limits` with defaults (timeouts tolerate reasoning). */
function resolveLoopLimits(
  config: AgentLoopConfig,
  fallbackMaxTurns: number
): LoopLimits & { maxTurns: number; deadlineMs: number; maxToolCallsPerRun: number; maxTotalTokens: number } {
  const raw = ((config as unknown as { limits?: Record<string, unknown> }).limits ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  let maxTurns = fallbackMaxTurns;
  const limMax = num(raw.maxTurns);
  if (limMax !== undefined) {
    const normLim = normalizeMaxTurns(limMax);
    maxTurns = Math.min(maxTurns, normLim);
  }
  const deadlineMs = num(raw.deadlineMs) ?? Infinity;
  const maxToolCallsPerRun = num(raw.maxToolCallsPerRun) ?? Infinity;
  const maxTotalTokens = num(raw.maxTotalTokens) ?? Infinity;
  // A network timeout: `0` or `Infinity` turns it off, any other number is milliseconds, anything else is unset (the default applies).
  const timeout = (v: unknown): number | undefined => (typeof v === "number" && !Number.isNaN(v) ? v : undefined);
  const requestTimeoutMs = timeout(raw.requestTimeoutMs) ?? 300_000;
  const firstByteTimeoutMs = timeout(raw.firstByteTimeoutMs) ?? 120_000;
  const streamIdleTimeoutMs = timeout(raw.streamIdleTimeoutMs) ?? 300_000;
  return {
    maxTurns,
    deadlineMs,
    maxToolCallsPerRun,
    maxTotalTokens,
    requestTimeoutMs,
    firstByteTimeoutMs,
    streamIdleTimeoutMs,
  };
}

// The session id a run's provider calls use (run override, else agent default); in: AgentLoopConfig, out: rollback and routing.
function loopSessionId(config: AgentLoopConfig): string | undefined {
  try {
    return (
      (config.runOptions as { sessionId?: string } | undefined)?.sessionId ||
      (config.options as { sessionId?: string } | undefined)?.sessionId
    );
  } catch {
    return undefined;
  }
}

// Builds an AbortError that carries the run's partial progress; in: an abort reason + partial usage, out: the error the run rejects with.
function makeAbortError(partial: { usage: TokenUsage; turns: number; text?: string }, reason?: unknown): Error {
  let base: Error;
  if (reason instanceof Error && reason.name === "AbortError") base = reason;
  else if (reason instanceof Error) base = new Error(reason.message || "Aborted");
  else if (typeof reason === "string" && reason) base = new Error(reason);
  else base = new Error("Aborted");
  try {
    (base as { name: string }).name = "AbortError";
  } catch {}
  try {
    (base as unknown as { partial: unknown }).partial = partial;
  } catch {}
  return base;
}

// Throws the run's AbortError as soon as its signal is aborted; in: loop checkpoints, out: nothing or a thrown abort.
function throwIfAborted(
  signal: AbortSignal | undefined,
  partial: { usage: TokenUsage; turns: number; text?: string }
): void {
  if (signal?.aborted) {
    throw makeAbortError(partial, (signal as unknown as { reason?: unknown })?.reason ?? new Error("Aborted"));
  }
}

// Throws BudgetExceededError when the run's tokens pass limits.maxTotalTokens; in: both loops after usage changes, out: nothing or a thrown error.
function checkTokenLimit(usage: TokenUsage, maxTotalTokens: number): void {
  if (Number.isFinite(maxTotalTokens) && usage.totalTokens > maxTotalTokens) {
    throw new BudgetExceededError(
      `Token limit exceeded: ${usage.totalTokens} > limits.maxTotalTokens ${maxTotalTokens}.`,
      { context: { partial: { usage, turns: 0 } } }
    );
  }
}

// Throws when the run has been going longer than limits.deadlineMs; in: both loops each turn, out: nothing or a thrown error.
function checkDeadline(startTime: number, deadlineMs: number): void {
  if (Number.isFinite(deadlineMs) && deadlineMs !== Infinity && Date.now() - startTime > deadlineMs) {
    throw new BudgetExceededError(`[Agent Accelerator] Run deadline exceeded after ${deadlineMs}ms.`);
  }
}

// Races one provider call against the request timeout (a TimeoutError), clearing its timer either way; in: runAgentLoop, out: the call's result.
async function generateWithTimeout<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs === Infinity) return task();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TimeoutError(`[Agent Accelerator] Request timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      try {
        (timer as unknown as { unref?: () => void }).unref?.();
      } catch {}
    });
    return await Promise.race([task(), timeoutP]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Prices one usage snapshot with the one cost model (`priceUsage`): provider-reported total first, else catalog pricing scaled by `serviceTier`; undefined when unknown. In: loop turns and `accumulateUsage`, out: `usage.cost`. */
export function computeCostFromPricing(usage: TokenUsage, spec?: ModelSpec, serviceTier?: string): TokenUsage["cost"] {
  try {
    if (usage.cost && typeof usage.cost.totalCost === "number" && usage.cost.totalCost >= 0) {
      return usage.cost;
    }
    if (!spec) return usage.cost;
    const priced = priceUsage(usage, spec, serviceTier ? { serviceTier } : undefined);
    return priced
      ? {
          inputCost: priced.inputCost,
          outputCost: priced.outputCost,
          cacheReadCost: priced.cacheReadCost,
          cacheWriteCost: priced.cacheWriteCost,
          totalCost: priced.totalCost,
        }
      : usage.cost;
  } catch {
    // why: cost is observability-only — pricing failures must never break turns.
    return usage.cost;
  }
}

// Adds the media token details of `source` into `target` (kept only when something was reported); in: accumulateUsage, out: target.inputDetails / outputDetails.
function sumDetails(target: TokenUsage, source: TokenUsage, key: "inputDetails" | "outputDetails"): void {
  const from = source[key] as Record<string, number | undefined> | undefined;
  if (!from) return;
  const into = ((target[key] as Record<string, number> | undefined) ??= {});
  for (const [k, v] of Object.entries(from)) if (typeof v === "number") into[k] = (into[k] ?? 0) + v;
}

// ---------------------------------------------------------------------------
// Canonical usage accumulation (pure w.r.t. source).
// Invariants (see assertUsageInvariants in session/store.ts):
// - token counts are finite integers >= 0;
// - cachedTokens/cacheReadTokens are a SUBSET of inputTokens (clamped below
//   so no consumer observes >100% hit rates);
// - thinkingTokens is a SUBSET of outputTokens when both are reported
//   (reasoning is generated output; enforced in the test helper, documented
//   here because providers vary on which side they omit).
// This function never mutates `source`: the priced cost is cloned
// into a local before folding into the target.
// ---------------------------------------------------------------------------
// Adds one turn's usage (and its priced cost) into a running total without touching the source; in: both loops per model turn and finished worker, out: the run's accumulatedUsage.
export function accumulateUsage(target: TokenUsage, source: TokenUsage, spec?: ModelSpec, serviceTier?: string): void {
  target.inputTokens += source.inputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.totalTokens += source.totalTokens || 0;
  target.cachedTokens = (target.cachedTokens ?? 0) + (source.cachedTokens ?? 0);
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (source.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (source.cacheWriteTokens ?? 0);
  target.thinkingTokens = (target.thinkingTokens ?? 0) + (source.thinkingTokens ?? 0);
  sumDetails(target, source, "inputDetails");
  sumDetails(target, source, "outputDetails");

  // Canonical invariant (provider-agnostic): cache hits are a subset of
  // input. Some providers occasionally report cached > input on long chained
  // runs, which surfaces as >100% hit rates downstream. Clamp the aggregate
  // so no consumer can observe an impossible ratio.
  const preCached = target.cachedTokens ?? 0;
  const preRead = target.cacheReadTokens ?? 0;
  target.cachedTokens = Math.min(preCached, target.inputTokens);
  target.cacheReadTokens = Math.min(preRead, target.inputTokens);
  if ((target.cachedTokens ?? 0) < preCached || (target.cacheReadTokens ?? 0) < preRead) {
    // No console — report via the anomaly hook + telemetry bus.
    reportUsageAnomaly({
      type: "cache_clamp",
      inputTokens: target.inputTokens,
      cachedTokens: preCached,
      cacheReadTokens: preRead,
    });
  }

  const priced = computeCostFromPricing(source, spec, serviceTier);
  // Pure — read `source` only; never assign back to `source.cost`.
  // Clone the priced cost so later target folds cannot alias source state.
  const sourceCost = priced ? { ...priced } : undefined;

  if (sourceCost || target.cost) {
    target.cost = {
      inputCost: (target.cost?.inputCost ?? 0) + (sourceCost?.inputCost ?? 0),
      outputCost: (target.cost?.outputCost ?? 0) + (sourceCost?.outputCost ?? 0),
      cacheReadCost: (target.cost?.cacheReadCost ?? 0) + (sourceCost?.cacheReadCost ?? 0),
      cacheWriteCost: (target.cost?.cacheWriteCost ?? 0) + (sourceCost?.cacheWriteCost ?? 0),
      totalCost: (target.cost?.totalCost ?? 0) + (sourceCost?.totalCost ?? 0),
    };
  }
}

// Turns a tool result into what the model sees: a branded delegation envelope becomes its text and yields validated worker metadata, anything else passes through; in: executed results, out: history + usage roll-up.
function sanitizeToolResult(r: ToolResultRecord): { sanitized: ToolResultRecord; metas: SubAgentExecutionMetadata[] } {
  // Only SDK-branded delegation envelopes are trusted. A plain object that
  // merely carries a `_subagentMetadata` key (e.g. scraped JSON) is ordinary
  // tool output: it must not replace what the model sees or touch billing.
  if (isSubagentResult(r.result)) {
    const xml = r.result.xml || r.result.toString?.() || String(r.result);
    return {
      sanitized: { ...r, result: xml },
      metas: normalizeSubagentMetadata(r.result._subagentMetadata),
    };
  }
  return { sanitized: r, metas: [] };
}

/**
 * Stops a model from hammering the same call. Per fingerprint (name + stable
 * args) the guard counts CONSECUTIVE turns: the first two identical calls run,
 * the third in a row is answered with a synthetic `repeat_blocked` error so
 * the model reuses the earlier result or changes approach. Tools declared
 * `repeatable` (or `idempotent`, e.g. status polling) are never blocked.
 * A fingerprint that skips a turn starts over.
 */
async function executeToolCallsWithRepeatGuard(options: {
  tools: Record<string, ToolDefinition>;
  toolCalls: ToolCallRecord[];
  onResult?: (result: ToolResultRecord) => void;
  openToolLog?: ExecuteToolsOptions["openToolLog"];
  previousFingerprints: Set<string>;
  repeatCounts: Map<string, number>;
  agentName?: string;
  signal?: AbortSignal;
  sessionId?: string;
  onSubagentEvent?: (event: {
    trackingId: string;
    delta?: string;
    thinkingDelta?: string;
    partialText?: string;
    partialThinking?: string;
  }) => void;
}): Promise<{ results: ToolResultRecord[]; fingerprints: Set<string> }> {
  const { toolCalls, previousFingerprints, repeatCounts } = options;
  const currentFingerprints = new Set<string>();
  const blocked = new Map<string, ToolResultRecord>();
  const executable: ToolCallRecord[] = [];

  for (const call of toolCalls) {
    const fingerprint = toolCallFingerprint(call);
    currentFingerprints.add(fingerprint);
    const def = findToolDefinition(options.tools, call.name);
    if (def && isRepeatableTool(def)) {
      executable.push(call);
      continue;
    }
    if (!previousFingerprints.has(fingerprint)) repeatCounts.delete(fingerprint); // streak broken
    if (shouldBlockRepeat(previousFingerprints, call, repeatCounts)) {
      traceToolEvent(
        "call_blocked",
        "warn",
        call,
        { agentName: options.agentName, sessionId: options.sessionId },
        { reason: "repeat_blocked" }
      );
      blocked.set(call.id, makeRepeatBlockedResult(call));
    } else {
      executable.push(call);
    }
  }
  // Streaks only survive while the fingerprint keeps appearing every turn.
  for (const fp of [...repeatCounts.keys()]) if (!currentFingerprints.has(fp)) repeatCounts.delete(fp);

  const executed =
    executable.length > 0
      ? await executeToolCalls({
          tools: options.tools,
          toolCalls: executable,
          agentName: options.agentName,
          parallel: true,
          signal: options.signal,
          sessionId: options.sessionId,
          onSubagentEvent: options.onSubagentEvent,
          onResult: options.onResult,
          openToolLog: options.openToolLog,
        })
      : [];
  const byId = new Map<string, ToolResultRecord[]>();
  for (const result of executed) {
    const queue = byId.get(result.id) ?? [];
    queue.push(result);
    byId.set(result.id, queue);
  }
  for (const [id, result] of blocked) {
    const queue = byId.get(id) ?? [];
    queue.push(result);
    byId.set(id, queue);
  }

  return {
    // Consume per-id queues in call order: some open-weights models reuse one
    // id for several distinct calls in a turn, and a plain id->result map
    // would hand every call the last result. Queues keep each result aligned
    // with its own call.
    results: toolCalls.map((call) => byId.get(call.id)?.shift()).filter((r): r is ToolResultRecord => Boolean(r)),
    fingerprints: currentFingerprints,
  };
}

/** Tool calls of the LAST assistant message that have no result in the conversation yet (a crash or interrupt cut them off). */
export function unfinishedToolCalls(messages: AgentContext["messages"]): ToolCallRecord[] {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const calls = lastAssistant < 0 ? [] : messages[lastAssistant]!.content;
  if (!Array.isArray(calls)) return [];
  const answered = new Set<string>();
  for (const m of messages.slice(lastAssistant + 1)) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const p of m.content) if (p.type === "tool_result") answered.add(p.id);
  }
  const open: ToolCallRecord[] = [];
  for (const p of calls) {
    if (p.type === "tool_call" && !answered.has(p.id)) {
      open.push({
        id: p.id,
        name: p.name,
        arguments: p.arguments,
        ...(p.rawArguments ? { rawArguments: p.rawArguments } : {}),
        ...(p.callId ? { callId: p.callId } : {}),
      });
    }
  }
  return open;
}

/** True when the conversation ends with tool results of a batch in which a tool called `ctx.stop` (the run was meant to end there). */
export function endsWithStop(messages: AgentContext["messages"]): boolean {
  for (let i = messages.length - 1; i >= 0 && messages[i]!.role === "tool"; i--) {
    const content = messages[i]!.content;
    if (Array.isArray(content) && content.some((p) => p.type === "tool_result" && p.stopped === true)) return true;
  }
  return false;
}

// Finishes the tool calls a crash left open (stored result reused, anything else executed now) and records the results in the conversation; in: a resumed run's config, out: tool results in context + what the response should report.
async function finishInterruptedTools(
  config: AgentLoopConfig
): Promise<{ calls: ToolCallRecord[]; results: ToolResultRecord[]; subagents: SubAgentExecutionMetadata[] }> {
  const open = unfinishedToolCalls(config.context.messages);
  const none = { calls: [], results: [], subagents: [] };
  if (open.length === 0 || !config.resume) return none;
  const stored = config.resume.stored;
  const toRun = open.filter((c) => !stored.has(c.id));
  const executed = toRun.length
    ? await executeToolCalls({
        tools: config.tools,
        toolCalls: toRun,
        agentName: config.agentName,
        parallel: true,
        signal: config.runOptions?.signal,
        sessionId: config.runOptions?.sessionId || config.options?.sessionId,
        onResult: config.onToolResult,
        openToolLog: config.openToolLog,
      })
    : [];
  const ran = new Map(executed.map((r) => [r.id, r]));
  const subagents: SubAgentExecutionMetadata[] = [];
  const results = open.map((call) => {
    const { sanitized, metas } = sanitizeToolResult(ran.get(call.id) ?? stored.get(call.id)!);
    subagents.push(...metas);
    return sanitized;
  });
  config.context.addToolResults(results);
  emitProgress(config);
  return { calls: open, results, subagents };
}

/**
 * Runs a single non-streaming agent turn or multi-turn loop
 */
export async function runAgentLoop(config: AgentLoopConfig): Promise<AgentResponse> {
  await ensureModelCatalogFresh();
  const {
    agentName,
    provider,
    modelId,
    context,
    tools,
    options,
    runOptions,
    maxTurns: rawMaxTurns = Infinity,
  } = config;
  const fallbackMaxTurns = normalizeMaxTurns(rawMaxTurns);
  const limits = resolveLoopLimits(config, fallbackMaxTurns);
  const maxTurns = limits.maxTurns;
  // Structured outputs: normalize once (throws ValidationError for bad shapes).
  const loopOutput = resolveLoopOutput(config);
  // Pre-run checkpoint for onFailure rollback.
  const preRunCp = context.checkpoint();
  const sessionIdForRollback = loopSessionId(config);

  // Partial-run state hoisted outside try so the catch block can attach
  // {usage,cost,turns,toolCalls,toolResults,text} to ANY thrown error.
  const startTime = Date.now();
  const accumulatedUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
  };
  const allToolCalls: ToolCallRecord[] = [];
  const allToolResults: ToolResultRecord[] = [];
  const allSubagents: SubAgentExecutionMetadata[] = [];
  let finalResult: any = null;
  let turns = 0;
  let toolsExecuted = false;
  let stoppedByTool = false;
  let previousToolCallFingerprints = new Set<string>();
  const repeatCounts = new Map<string, number>();

  try {
    const standardTools = toStandardToolDeclarations(tools);

    if (config.resume) {
      const finished = await finishInterruptedTools(config);
      stoppedByTool = finished.results.some((r) => r.stopped) || endsWithStop(context.messages);
      if (finished.calls.length > 0) {
        toolsExecuted = true;
        allToolCalls.push(...finished.calls);
        allToolResults.push(...finished.results);
        for (const meta of finished.subagents) {
          allSubagents.push(meta);
          accumulateUsage(accumulatedUsage, meta.usage, getModelFromCatalog(meta.provider, meta.model));
        }
      }
    }

    while (!stoppedByTool && turns < maxTurns) {
      // Fail fast on abort (throws AbortError with partial).
      throwIfAborted(runOptions?.signal, { usage: accumulatedUsage, turns, text: finalResult?.text });
      checkDeadline(startTime, limits.deadlineMs);
      config.enforceBudget?.();
      // Repair orphan tool pairs before every request.
      ensureToolPairing(context);
      if (config.fileAccess?.roots) await enforceFileAccess(context.messages, config.fileAccess.roots);
      turns++;

      const spec = getModelFromCatalog(provider.id, modelId);

      const providerOptions: ProviderRequestOptions = {
        ...options,
        sessionId: runOptions?.sessionId || options?.sessionId,
        cache: options?.cache,
        tools: standardTools.length > 0 ? standardTools : undefined,
        signal: runOptions?.signal,
        toolChoice: toolChoiceForTurn(options?.toolChoice, turns),
        ...(loopOutput.spec ? { output: loopOutput.spec } : {}),
      };
      // Per-request timeout pass-through (providers honor timeoutMs).
      try {
        if (Number.isFinite(limits.requestTimeoutMs) && limits.requestTimeoutMs !== Infinity) {
          (providerOptions as unknown as { timeoutMs?: number }).timeoutMs = limits.requestTimeoutMs;
        }
      } catch {}

      // A long-running call (e.g. Google long decode) times each HTTP request itself: no whole-call race.
      const longRunning = provider.isLongRunning?.(modelId, providerOptions) === true;
      const genResult = await generateWithTimeout(
        () =>
          provider.generate(
            modelId,
            {
              systemPrompt: context.systemPrompt,
              messages: context.messages,
            },
            providerOptions
          ),
        longRunning ? Infinity : limits.requestTimeoutMs
      );

      finalResult = genResult;

      // Canonical session routing: lets adapters detect provider switches.
      noteProviderTurn(runOptions?.sessionId || options?.sessionId, provider.id);

      // Thinking is exposed via events/traces and onTurn. Promoting it to answer text is gated (default
      // OFF): without the opt-in the run returns the provider's empty text and finishReason.
      if (
        (!genResult.text || genResult.text.trim() === "") &&
        (!genResult.toolCalls || genResult.toolCalls.length === 0) &&
        genResult.thinking
      ) {
        if (shouldPromoteThinkingToAnswer(config, runOptions)) {
          if (genResult.thinking.includes("</think>")) {
            const parts = genResult.thinking.split(/<\/(?:think|thought)>/i);
            genResult.thinking = parts[0]!.replace(/<(?:think|thought)>/i, "").trim() || undefined;
            genResult.text = parts.slice(1).join("").trim();
          } else {
            genResult.text = genResult.thinking;
            genResult.thinking = undefined;
          }
        }
      }

      accumulateUsage(accumulatedUsage, genResult.usage, spec, options?.serviceTier);
      try {
        config.onTurnUsage?.(genResult.usage, spec);
      } catch {}
      config.enforceBudget?.({
        ...genResult.usage,
        cost: computeCostFromPricing(genResult.usage, spec, options?.serviceTier),
      });
      checkTokenLimit(accumulatedUsage, limits.maxTotalTokens);

      // Record assistant turn in context
      context.addAssistantMessage(
        genResult.text,
        genResult.toolCalls,
        genResult.thinking,
        genResult.thoughtSignature,
        genResult.providerSteps
      );

      // Thinking-trace telemetry (observability-only, full text, no limit):
      // one bus event per thinking turn carrying the text + thought signature.
      // Never touches provider payloads, history, or persistence formats.
      if (genResult.thinking) {
        try {
          telemetryBus.emit({
            code: "turn.thinking",
            message: `[Agent Accelerator] turn ${turns} thinking (${provider.id}/${modelId})`,
            data: {
              turns,
              model: modelId,
              provider: provider.id,
              sessionId: runOptions?.sessionId || options?.sessionId,
              thinking: genResult.thinking,
              ...(genResult.thoughtSignature ? { thoughtSignature: genResult.thoughtSignature } : {}),
            },
          });
        } catch {}
      }

      // Mid-session steer: if new queries arrived during this provider turn,
      // inject them now. Tool turns still execute first (see below) so the
      // current action finishes before redirection.
      const noToolSteered =
        !genResult.toolCalls || genResult.toolCalls.length === 0 ? drainSteerInbox(context, config.steerInbox) : [];

      // If no tool calls, generation is complete — unless steered, in which
      // case the injected message extends the SAME run (no new response).
      if (!genResult.toolCalls || genResult.toolCalls.length === 0) {
        emitTurn(runOptions, { turns, text: genResult.text, thinking: genResult.thinking });
        if (noToolSteered.length > 0) {
          try {
            config.onSteerInjected?.(noToolSteered);
          } catch {}
        }
        emitProgress(config);
        if (noToolSteered.length > 0) continue;
        break;
      }

      // Execute tool calls — always parallel (model-driven, bloatfree DX7)
      // Check abort before tools (throws AbortError with partial).
      throwIfAborted(runOptions?.signal, { usage: accumulatedUsage, turns, text: genResult.text });
      emitProgress(config); // the calls are on record BEFORE they run, so a crash can finish them instead of forgetting them
      allToolCalls.push(...genResult.toolCalls);
      // Per-run tool-call budget.
      if (allToolCalls.length > limits.maxToolCallsPerRun) {
        throw new BudgetExceededError(
          `[Agent Accelerator] maxToolCallsPerRun exceeded (${allToolCalls.length} > ${limits.maxToolCallsPerRun}).`
        );
      }
      toolsExecuted = true;
      const guarded = await executeToolCallsWithRepeatGuard({
        tools,
        toolCalls: genResult.toolCalls,
        previousFingerprints: previousToolCallFingerprints,
        repeatCounts,
        agentName,
        signal: runOptions?.signal,
        sessionId: runOptions?.sessionId || options?.sessionId,
        onResult: config.onToolResult,
        openToolLog: config.openToolLog,
      });
      const results = guarded.results;
      previousToolCallFingerprints = guarded.fingerprints;

      // Process results and extract any sub-agent execution metadata
      const sanitizedResults: ToolResultRecord[] = [];

      for (const r of results) {
        const { sanitized, metas } = sanitizeToolResult(r);
        if (metas.length > 0) {
          allSubagents.push(...metas);
          for (const s of metas) {
            if (s.raw) s.raw = applyCaptureRaw(s.raw, config.captureRaw);
            const subagentSpec = getModelFromCatalog(s.provider, s.model);
            if (subagentSpec && (!s.usage?.cost || !s.usage.cost.totalCost)) {
              s.usage.cost = computeCostFromPricing(s.usage, subagentSpec);
            }
            accumulateUsage(accumulatedUsage, s.usage, subagentSpec);
            config.enforceBudget?.(s.usage);
          }
        }
        sanitizedResults.push(sanitized);
      }

      allToolResults.push(...sanitizedResults);
      context.addToolResults(sanitizedResults);
      checkTokenLimit(accumulatedUsage, limits.maxTotalTokens);
      // Results are stored BEFORE the cancellation check so an abort
      // never drops executed tool work from history.
      throwIfAborted(runOptions?.signal, { usage: accumulatedUsage, turns, text: genResult.text });
      emitTurn(runOptions, {
        turns,
        text: genResult.text,
        thinking: genResult.thinking,
        toolCalls: genResult.toolCalls,
        toolResults: sanitizedResults,
      });
      // A tool ended the run (`ctx.stop`): the whole batch has finished, so stop here. Waiting steers become follow-ups.
      if (sanitizedResults.some((r) => r.stopped)) {
        stoppedByTool = true;
        emitProgress(config);
        break;
      }
      // Steer drain AFTER tool results so call/result pairs stay adjacent.
      // The next loop iteration sends the injected user message to the model
      // within the same run (same usage/turn budget).
      const toolSteered = drainSteerInbox(context, config.steerInbox);
      if (toolSteered.length > 0) {
        try {
          config.onSteerInjected?.(toolSteered);
        } catch {}
      }
      emitProgress(config);

      // Abort always throws AbortError with partial attached (never
      // silently breaks).
      throwIfAborted(runOptions?.signal, { usage: accumulatedUsage, turns, text: finalResult?.text });
    }

    // maxTurns exhausted while the model still requested tools: the tool
    // results above were never sent back, so the run is truncated — surface
    // it via finishReason + warning instead of silently returning.
    const truncatedByMaxTurns =
      !stoppedByTool && turns >= maxTurns && !!finalResult?.toolCalls && finalResult.toolCalls.length > 0;
    if (truncatedByMaxTurns) {
      warnMaxTurnsHit(
        agentName,
        maxTurns,
        finalResult.toolCalls.map((c: ToolCallRecord) => c.name)
      );
    }

    // Structured outputs: validate final text only (tool turns skip this).
    // Strict-fail throws ValidationError with partial attached via catch below.
    let parsedOutput: unknown | undefined;
    if (loopOutput.raw !== undefined && !truncatedByMaxTurns && !stoppedByTool) {
      parsedOutput = parseFinalStructuredOutput(finalResult?.text || "", loopOutput.raw, loopOutput.spec);
    }

    return new AgentResponse({
      text: finalResult?.text || "",
      ...(parsedOutput !== undefined ? { parsed: parsedOutput } : {}),
      thinking: finalResult?.thinking,
      thoughtSignature: finalResult?.thoughtSignature,
      toolCalls: allToolCalls,
      toolResults: allToolResults,
      subagents: allSubagents,
      usage: accumulatedUsage,
      responseId: finalResult?.responseId,
      model: modelId,
      provider: provider.id,
      // Canonical finish reason + raw vendor passthrough.
      ...(stoppedByTool
        ? {
            finishReason: "stopped" as const,
            ...(finalResult?.finishReason ? { rawFinishReason: finalResult.finishReason } : {}),
          }
        : canonicalFinishReason(finalResult?.finishReason, truncatedByMaxTurns)),
      durationMs: Date.now() - startTime,
      raw: applyCaptureRaw(finalResult?.raw, config.captureRaw) as ProviderRawData,
      turns,
    });
  } catch (err) {
    // Run-level onFailure rollback (default restores pre-run
    // checkpoint; opt out with (config as any).onFailure === "keep").
    // Aborts are excluded so partial history survives interruption.
    const isAbort = (err as { name?: string } | null)?.name === "AbortError" || !!runOptions?.signal?.aborted;
    if (shouldRollbackOnFailure(config.onFailure, isAbort, toolsExecuted)) {
      try {
        context.rollback(preRunCp, sessionIdForRollback);
      } catch {
        // why: rollback is best-effort — the original error takes precedence.
      }
    }
    // Ensure aborts surface as AbortError with partial attached.
    if (isAbort && (err as { name?: string } | null)?.name !== "AbortError") {
      throw makeAbortError({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, turns: 0 }, err);
    }
    // Every failure carries its partial progress for observability.
    try {
      (err as unknown as { partial?: unknown }).partial ??= {
        usage: accumulatedUsage,
        cost: accumulatedUsage.cost,
        turns,
        toolCalls: allToolCalls,
        toolResults: allToolResults,
        subagents: allSubagents,
        text: finalResult?.text,
      };
    } catch {
      // why: partial attachment is observability-only and must never mask the error.
    }
    throw err;
  }
}

/**
 * Runs a streaming agent loop, pushing deltas to an AssistantMessageEventStream
 */
export function streamAgentLoop(config: AgentLoopConfig): AssistantMessageEventStream {
  const outerStream = new AssistantMessageEventStream();
  const startTime = Date.now();

  // Cancellation: merge user signal + outer cancel() into one linked controller.
  // Native fetch honors abortSignal on every provider, so aborting this
  // stops the HTTP request; we also cancel the active inner provider stream.
  const linked = new AbortController();
  const userSignal = config.runOptions?.signal;
  const forwardUserAbort = () => {
    try {
      linked.abort((userSignal as any)?.reason);
    } catch {
      try {
        linked.abort();
      } catch {}
    }
  };
  if (userSignal?.aborted) forwardUserAbort();
  else userSignal?.addEventListener("abort", forwardUserAbort, { once: true });
  let currentInner: AssistantMessageEventStream | null = null;
  const removeOuterCancel = outerStream.onCancel(() => {
    try {
      linked.abort();
    } catch {}
    try {
      currentInner?.cancel();
    } catch {}
  });
  linked.signal.addEventListener("abort", () => {
    try {
      currentInner?.cancel();
    } catch {}
  });
  const throwIfCancelled = (partial?: { usage: TokenUsage; turns: number; text?: string }) => {
    if (linked.signal.aborted || outerStream.isCancelled()) {
      const fallback: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      throw makeAbortError(
        partial ?? { usage: fallback, turns: 0 },
        (linked.signal as unknown as { reason?: unknown })?.reason ?? new Error("Stream aborted")
      );
    }
  };

  // Per-run checkpoint + limits for the streaming loop.
  const streamPreCp = config.context.checkpoint();
  const streamSessionId = loopSessionId(config);
  const streamFallbackMax = normalizeMaxTurns((config as { maxTurns?: number }).maxTurns);
  const streamLimits = resolveLoopLimits(config, streamFallbackMax);
  const streamStartTime = startTime;

  (async () => {
    // Hoisted for catch-block partial reporting.
    let accumulatedUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      thinkingTokens: 0,
    };
    let lastResponse: AgentResponse | null = null;
    let turns = 0;
    // Tool progress hoisted so failures carry toolCalls/toolResults.
    const allToolCalls: ToolCallRecord[] = [];
    const allToolResults: ToolResultRecord[] = [];
    const allSubagents: SubAgentExecutionMetadata[] = [];
    let toolsExecuted = false;
    try {
      await ensureModelCatalogFresh();
      // Re-validate after refresh: Agent.stream() validates before the catalog
      // is guaranteed fresh, so a cold cache validates permissively. A mismatch
      // discovered here fails the stream instead of reaching the provider.
      {
        const lvl = config.runOptions?.thinkingLevel ?? config.options?.thinking?.level;
        if (lvl) {
          try {
            validateModelThinking(config.provider.id, config.modelId, lvl);
          } catch (err) {
            outerStream.fail(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
      }
      const { agentName, provider, modelId, context, tools, options, runOptions } = config;
      const maxTurns = streamLimits.maxTurns;

      const standardTools = toStandardToolDeclarations(tools);
      // Structured outputs: normalize once for the whole stream run.
      let streamOutputRaw: unknown;
      let streamOutputSpec: import("../types/model.ts").StructuredOutputSpec | undefined;
      try {
        const resolved = resolveLoopOutput(config);
        streamOutputRaw = resolved.raw;
        streamOutputSpec = resolved.spec;
      } catch (err) {
        outerStream.fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      accumulatedUsage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
      };

      // allToolCalls/allToolResults/allSubagents are hoisted above (fresh
      // per stream run); just reset turn counters here.
      lastResponse = null;
      turns = 0;
      let previousToolCallFingerprints = new Set<string>();
      const repeatCounts = new Map<string, number>();
      let stoppedByTool = false;

      while (turns < maxTurns) {
        throwIfCancelled({ usage: accumulatedUsage, turns, text: lastResponse?.text });
        checkDeadline(streamStartTime, streamLimits.deadlineMs);
        config.enforceBudget?.();
        ensureToolPairing(context);
        if (config.fileAccess?.roots) await enforceFileAccess(context.messages, config.fileAccess.roots);
        turns++;

        const spec2 = getModelFromCatalog(provider.id, modelId);

        const providerOptions: ProviderRequestOptions = {
          ...options,
          sessionId: runOptions?.sessionId || options?.sessionId,
          cache: options?.cache,
          tools: standardTools.length > 0 ? standardTools : undefined,
          signal: linked.signal,
          toolChoice: toolChoiceForTurn(options?.toolChoice, turns),
          ...(streamOutputSpec ? { output: streamOutputSpec } : {}),
        };
        try {
          if (Number.isFinite(streamLimits.requestTimeoutMs) && streamLimits.requestTimeoutMs !== Infinity) {
            (providerOptions as unknown as { timeoutMs?: number }).timeoutMs = streamLimits.requestTimeoutMs;
          }
        } catch {}

        const longRunning = provider.isLongRunning?.(modelId, providerOptions) === true;
        const innerStream = provider.stream(
          modelId,
          {
            systemPrompt: context.systemPrompt,
            messages: context.messages,
          },
          providerOptions
        );
        currentInner = innerStream as AssistantMessageEventStream;

        // First-byte + idle timeouts around SSE (tolerate reasoning).
        // Implemented as races on the inner iterator so a hung provider
        // surfaces as TimeoutError instead of hanging the run forever.
        {
          const it = (innerStream as AsyncIterable<StreamEvent>)[Symbol.asyncIterator]();
          let first = true;
          let doneIter = false;
          while (!doneIter) {
            // Long-running streams pause for minutes between chunks; the adapter guards stalls and reconnects.
            const waitMs = longRunning
              ? Infinity
              : first
                ? streamLimits.firstByteTimeoutMs
                : streamLimits.streamIdleTimeoutMs;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeoutP =
              Number.isFinite(waitMs) && waitMs !== Infinity && waitMs > 0
                ? new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                      reject(
                        new TimeoutError(
                          `[Agent Accelerator] Stream ${first ? "first-byte" : "idle"} timed out after ${waitMs}ms.`
                        )
                      );
                    }, waitMs);
                    try {
                      (timer as unknown as { unref?: () => void }).unref?.();
                    } catch {}
                  })
                : null;
            try {
              const nextP = it.next();
              const res = timeoutP ? await Promise.race([nextP, timeoutP]) : await nextP;
              if (timer) clearTimeout(timer);
              if (res.done) {
                doneIter = true;
                break;
              }
              first = false;
              throwIfCancelled({ usage: accumulatedUsage, turns, text: lastResponse?.text });
              const event = res.value as StreamEvent;
              if ((event as StreamEvent)?.type !== "done") {
                // The provider's `start` event carries the request audit record: apply the capture policy.
                outerStream.push(
                  event.type === "start" && event.raw
                    ? { ...event, raw: applyCaptureRaw(event.raw, config.captureRaw) }
                    : event
                );
              }
            } catch (e) {
              if (timer) clearTimeout(timer);
              // Timeout: cancel the hung inner stream before surfacing.
              if ((e as Error)?.name === "TimeoutError") {
                try {
                  currentInner?.cancel();
                } catch {}
              }
              throw e;
            }
          }
        }

        const turnResponse = await innerStream.result();
        currentInner = null;
        throwIfCancelled({ usage: accumulatedUsage, turns, text: (turnResponse as { text?: string })?.text });
        lastResponse = turnResponse;
        // Canonical session routing: lets adapters detect provider switches.
        noteProviderTurn(runOptions?.sessionId || options?.sessionId, provider.id);

        // Thinking stays on events/traces + onTurn (default exposed). Promoting
        // it to answer text is gated (default OFF): without the opt-in
        // the turn keeps the provider's empty text and finishReason.
        if (
          (!turnResponse.text || turnResponse.text.trim() === "") &&
          (!turnResponse.toolCalls || turnResponse.toolCalls.length === 0) &&
          turnResponse.thinking
        ) {
          if (shouldPromoteThinkingToAnswer(config, runOptions)) {
            if (turnResponse.thinking.includes("</think>")) {
              const parts = turnResponse.thinking.split(/<\/(?:think|thought)>/i);
              (turnResponse as any).thinking = parts[0]!.replace(/<(?:think|thought)>/i, "").trim() || undefined;
              (turnResponse as any).text = parts.slice(1).join("").trim();
            } else {
              (turnResponse as any).text = turnResponse.thinking;
              (turnResponse as any).thinking = undefined;
            }
          }
        }

        accumulateUsage(accumulatedUsage, turnResponse.usage, spec2, options?.serviceTier);
        try {
          config.onTurnUsage?.(turnResponse.usage, spec2);
        } catch {}
        config.enforceBudget?.({
          ...turnResponse.usage,
          cost: computeCostFromPricing(turnResponse.usage, spec2, options?.serviceTier),
        });
        checkTokenLimit(accumulatedUsage, streamLimits.maxTotalTokens);

        context.addAssistantMessage(
          turnResponse.text,
          turnResponse.toolCalls,
          turnResponse.thinking,
          turnResponse.thoughtSignature,
          turnResponse.providerSteps
        );

        // Thinking-trace telemetry (observability-only, full text, no limit):
        // mirrors the non-streaming loop above; bus-only, never wire/history.
        if (turnResponse.thinking) {
          try {
            telemetryBus.emit({
              code: "turn.thinking",
              message: `[Agent Accelerator] turn ${turns} thinking (${provider.id}/${modelId})`,
              data: {
                turns,
                model: modelId,
                provider: provider.id,
                sessionId: runOptions?.sessionId || options?.sessionId,
                thinking: turnResponse.thinking,
                ...(turnResponse.thoughtSignature ? { thoughtSignature: turnResponse.thoughtSignature } : {}),
              },
            });
          } catch {}
        }

        const noToolSteered =
          !turnResponse.toolCalls || turnResponse.toolCalls.length === 0
            ? drainSteerInbox(context, config.steerInbox)
            : [];
        if (!turnResponse.toolCalls || turnResponse.toolCalls.length === 0) {
          emitTurn(runOptions, { turns, text: turnResponse.text, thinking: turnResponse.thinking });
          if (noToolSteered.length > 0) {
            for (const preview of noToolSteered) {
              try {
                outerStream.push({ type: "steer_injected", injectedPrompt: preview });
              } catch {
                // why: stream push never throws, but guard anyway to protect the loop.
              }
            }
            try {
              config.onSteerInjected?.(noToolSteered);
            } catch {
              // why: user callback — a throw must not fail the run.
            }
          }
          emitProgress(config);
          if (noToolSteered.length > 0) continue;
          break;
        }

        throwIfCancelled({ usage: accumulatedUsage, turns, text: turnResponse.text });
        emitProgress(config); // the calls are on record BEFORE they run, so a crash can finish them instead of forgetting them
        allToolCalls.push(...turnResponse.toolCalls);
        if (allToolCalls.length > streamLimits.maxToolCallsPerRun) {
          throw new BudgetExceededError(
            `[Agent Accelerator] maxToolCallsPerRun exceeded (${allToolCalls.length} > ${streamLimits.maxToolCallsPerRun}).`
          );
        }
        // Typed tool lifecycle for streaming consumers.
        try {
          outerStream.push({ type: "tool_start", toolCalls: turnResponse.toolCalls });
        } catch {
          // why: stream push never throws, but guard anyway to protect the loop.
        }
        toolsExecuted = true;
        const guarded = await executeToolCallsWithRepeatGuard({
          tools,
          toolCalls: turnResponse.toolCalls,
          previousFingerprints: previousToolCallFingerprints,
          repeatCounts,
          agentName,
          signal: linked.signal,
          sessionId: runOptions?.sessionId || options?.sessionId,
          onResult: config.onToolResult,
          openToolLog: config.openToolLog,
          onSubagentEvent: (ev) => {
            try {
              outerStream.push({
                type: "subagent_delta",
                subagentTrackingId: ev.trackingId,
                delta: ev.delta,
                thinkingDelta: ev.thinkingDelta,
                partialText: ev.partialText,
                partialThinking: ev.partialThinking,
              });
            } catch {
              // why: stream push never throws; keep subagent progress flowing.
            }
          },
        });
        const results = guarded.results;
        previousToolCallFingerprints = guarded.fingerprints;

        const sanitizedResults: ToolResultRecord[] = [];

        for (const r of results) {
          const { sanitized, metas } = sanitizeToolResult(r);
          if (metas.length > 0) {
            allSubagents.push(...metas);
            for (const s of metas) {
              if (s.raw) s.raw = applyCaptureRaw(s.raw, config.captureRaw);
              const subagentSpec = getModelFromCatalog(s.provider, s.model);
              if (subagentSpec && (!s.usage?.cost || !s.usage.cost.totalCost)) {
                s.usage.cost = computeCostFromPricing(s.usage, subagentSpec);
              }
              accumulateUsage(accumulatedUsage, s.usage, subagentSpec);
              config.enforceBudget?.(s.usage);
              outerStream.push({
                type: "subagent_complete",
                subagent: s,
              });
            }
          }
          sanitizedResults.push(sanitized);
        }

        for (const res of sanitizedResults) {
          outerStream.push({
            type: "tool_result",
            toolResult: res,
          });
        }
        // Close the tool lifecycle opened by `tool_start` above.
        try {
          outerStream.push({ type: "tool_end", toolResults: sanitizedResults });
        } catch {
          // why: stream push never throws, but guard anyway to protect the loop.
        }

        // Store tool results BEFORE the cancellation check.
        allToolResults.push(...sanitizedResults);
        context.addToolResults(sanitizedResults);
        throwIfCancelled({ usage: accumulatedUsage, turns, text: turnResponse.text });
        emitTurn(runOptions, {
          turns,
          text: turnResponse.text,
          thinking: turnResponse.thinking,
          toolCalls: turnResponse.toolCalls,
          toolResults: sanitizedResults,
        });
        // A tool ended the run (`ctx.stop`): the whole batch has finished, so stop here. Waiting steers become follow-ups.
        if (sanitizedResults.some((r) => r.stopped)) {
          stoppedByTool = true;
          emitProgress(config);
          break;
        }
        const toolSteered = drainSteerInbox(context, config.steerInbox);
        if (toolSteered.length > 0) {
          for (const preview of toolSteered) {
            try {
              outerStream.push({ type: "steer_injected", injectedPrompt: preview });
            } catch {
              // why: stream push never throws, but guard anyway to protect the loop.
            }
          }
          try {
            config.onSteerInjected?.(toolSteered);
          } catch {
            // why: user callback — a throw must not fail the run.
          }
        }
        emitProgress(config);
      }

      const truncatedByMaxTurns =
        !stoppedByTool && turns >= maxTurns && !!lastResponse?.toolCalls && lastResponse.toolCalls.length > 0;
      if (truncatedByMaxTurns) {
        warnMaxTurnsHit(
          agentName,
          maxTurns,
          lastResponse!.toolCalls.map((c) => c.name)
        );
      }
      const truncatedFinish = stoppedByTool
        ? {
            finishReason: "stopped" as const,
            ...(lastResponse?.finishReason ? { rawFinishReason: lastResponse.finishReason } : {}),
          }
        : canonicalFinishReason(lastResponse?.finishReason, truncatedByMaxTurns);

      let streamParsed: unknown | undefined;
      if (streamOutputRaw !== undefined && !truncatedByMaxTurns && !stoppedByTool) {
        try {
          streamParsed = parseFinalStructuredOutput(lastResponse?.text || "", streamOutputRaw, streamOutputSpec);
        } catch (err) {
          const raw = err instanceof Error ? err : new Error(String(err));
          try {
            (raw as unknown as { partial?: unknown }).partial ??= {
              usage: accumulatedUsage,
              cost: accumulatedUsage.cost,
              turns,
              toolCalls: allToolCalls,
              toolResults: allToolResults,
              subagents: allSubagents,
              text: lastResponse?.text,
            };
          } catch {}
          outerStream.fail(raw);
          return;
        }
      }

      const finalAgentResponse = new AgentResponse({
        text: lastResponse?.text || "",
        ...(streamParsed !== undefined ? { parsed: streamParsed } : {}),
        thinking: lastResponse?.thinking,
        thoughtSignature: lastResponse?.thoughtSignature,
        toolCalls: allToolCalls,
        toolResults: allToolResults,
        subagents: allSubagents,
        usage: accumulatedUsage,
        responseId: lastResponse?.responseId,
        model: modelId,
        provider: provider.id,
        // Canonical finish reason + raw vendor passthrough.
        ...truncatedFinish,
        durationMs: Date.now() - startTime,
        raw: applyCaptureRaw(lastResponse?.raw, config.captureRaw) as ProviderRawData,
        turns,
      });

      outerStream.push({
        type: "done",
        delta: "",
        usage: accumulatedUsage,
        finishReason: truncatedFinish.finishReason ?? lastResponse?.finishReason,
        rawFinishReason: truncatedFinish.rawFinishReason,
        responseId: lastResponse?.responseId,
      });

      outerStream.end(finalAgentResponse);
    } catch (err: any) {
      const raw = err instanceof Error ? err : new Error(String(err));
      const isAbort = linked.signal.aborted || outerStream.isCancelled() || (raw as any)?.name === "AbortError";
      // Streaming onFailure rollback (same policy as runAgentLoop;
      // aborts excluded so partial history survives).
      try {
        if (shouldRollbackOnFailure(config.onFailure, isAbort, toolsExecuted)) {
          try {
            config.context.rollback(streamPreCp, streamSessionId);
          } catch {
            // why: rollback is best-effort — the original error takes precedence.
          }
        }
      } catch {
        // why: rollback policy itself must never mask the original error.
      }
      // Every failure carries its partial progress for observability.
      const partial = {
        usage: accumulatedUsage,
        cost: accumulatedUsage.cost,
        turns,
        toolCalls: allToolCalls,
        toolResults: allToolResults,
        subagents: allSubagents,
        text: lastResponse?.text,
      };
      // Aborts always surface as AbortError with partial attached.
      if (isAbort) {
        const abortErr = raw.name === "AbortError" ? raw : makeAbortError(partial, raw);
        try {
          (abortErr as unknown as { partial?: unknown }).partial ??= partial;
        } catch {
          // why: partial attachment is observability-only and must never mask the error.
        }
        outerStream.fail(abortErr);
      } else {
        try {
          (raw as unknown as { partial?: unknown }).partial ??= partial;
        } catch {
          // why: partial attachment is observability-only and must never mask the error.
        }
        outerStream.fail(raw);
      }
    } finally {
      try {
        currentInner?.cancel();
      } catch {
        // why: inner streams tolerate double-cancel; cleanup must not throw.
      }
      try {
        userSignal?.removeEventListener("abort", forwardUserAbort);
      } catch {
        // why: listener removal is best-effort cleanup.
      }
      try {
        removeOuterCancel();
      } catch {
        // why: unsubscribe is best-effort cleanup.
      }
    }
  })();

  return outerStream;
}

// ---------------------------------------------------------------------------
// Thinking-promotion policy + canonical finish helper.
// (Appended here to avoid conflicts with other loop sections.)
// ---------------------------------------------------------------------------

/**
 * Whether an empty-text turn may promote `thinking` to answer `text`.
 * Default false: the run returns the provider's empty text with its
 * finishReason instead of fabricating an answer from reasoning. Opt in via
 * `(runOptions as any).thinkingAsAnswerFallback === true` or
 * `(config as any).thinkingAsAnswerFallback === true`.
 */
export function shouldPromoteThinkingToAnswer(config?: unknown, runOptions?: unknown): boolean {
  try {
    if ((runOptions as { thinkingAsAnswerFallback?: unknown } | null | undefined)?.thinkingAsAnswerFallback === true) {
      return true;
    }
    const c = config as
      | {
          thinkingAsAnswerFallback?: unknown;
          runOptions?: { thinkingAsAnswerFallback?: unknown };
        }
      | null
      | undefined;
    if (c?.thinkingAsAnswerFallback === true) return true;
    if (c?.runOptions?.thinkingAsAnswerFallback === true) return true;
    return false;
  } catch {
    // why: policy lookup is best-effort — default to NOT promoting thinking.
    return false;
  }
}

/**
 * Canonicalizes a provider finish reason for AgentResponse.
 * When `truncated` (maxTurns exhausted with pending tools), forces
 * `"max_turns"` and preserves the provider's reason in `rawFinishReason`.
 * Otherwise delegates to `normalizeFinishReason` (unknown vendor strings map
 * to `"error"` with the original in `rawFinishReason`).
 */
export function canonicalFinishReason(
  providerReason: unknown,
  truncated: boolean
): { finishReason?: FinishReason; rawFinishReason?: string } {
  if (truncated) {
    if (typeof providerReason === "string" && providerReason && providerReason !== "max_turns") {
      return { finishReason: "max_turns", rawFinishReason: providerReason };
    }
    return { finishReason: "max_turns" };
  }
  if (typeof providerReason !== "string" || providerReason === "") return {};
  return normalizeFinishReason(providerReason);
}
