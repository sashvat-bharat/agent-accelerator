import type { Provider, ProviderRequestOptions, ModelSpec } from "../types/model.ts";
import type { ToolDefinition, ToolCallRecord, ToolResultRecord } from "../types/tool.ts";
import type { TokenUsage } from "../types/core.ts";
import type { AgentRunOptions } from "../types/agent.ts";
import type { ContentPart } from "../types/message.ts";
import { AgentResponse, normalizeFinishReason, type FinishReason, type SubAgentExecutionMetadata, type StreamEvent } from "../types/response.ts";
import { priceUsage, reportUsageAnomaly, telemetryBus } from "../session/store.ts";
export { telemetryBus };
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentContext } from "./context.ts";
import { toStandardToolDeclarations } from "../tools/tool.ts";
import { executeToolCalls } from "../tools/executor.ts";
import { getModelFromCatalog, ensureModelCatalogFresh, validateModelThinking } from "../models/catalog.ts";
import { preprocessFilePartsForBypass } from "../utils/documents.ts";
import { noteProviderTurn, normalizeStructuredOutput, parseStructuredOutput } from "../providers.ts";

/** One mid-session steer request buffered while a run is active. */
export interface SteerEntry {
  prompt: string | ContentPart[];
  options?: AgentRunOptions;
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
  /** Convert `file` parts client-side for pdf-incapable models (see Agent flag). */
  bypassInputFileModality?: boolean;
  /** Called after every turn for durable persistence checkpoints (never fails a turn). */
  onProgress?: () => void;
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

/** Short preview for `steer_injected` / `queued` event payloads (bounded, display-only). */
function steerPreview(prompt: string | ContentPart[]): string {
  if (typeof prompt === "string") return prompt.slice(0, 500);
  try {
    const texts = prompt
      .filter((p) => (p as { type?: unknown }).type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("\n");
    return (texts || "[multipart]").slice(0, 500);
  } catch {
    return "[multipart]";
  }
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
      injected.push(steerPreview(entry.prompt));
    } catch {
      continue;
    }
  }
  return injected;
}

function emitTurn(
  runOptions: AgentRunOptions | undefined,
  turn: { turns: number; text?: string; thinking?: string; toolCalls?: ToolCallRecord[]; toolResults?: ToolResultRecord[] }
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

function emitProgress(config: { onProgress?: () => void }): void {
  try { config.onProgress?.(); } catch {}
}

// ---------------------------------------------------------------------------
// Structured outputs (canonical output wiring for the loop).
// ---------------------------------------------------------------------------

function resolveLoopOutput(config: AgentLoopConfig): { raw: unknown; spec: import("../types/model.ts").StructuredOutputSpec | undefined } {
  const raw = (config as { output?: unknown }).output;
  const fromOptions = (config.options as { output?: import("../types/model.ts").StructuredOutputSpec } | undefined)?.output;
  if (raw !== undefined && raw !== null) {
    // Throws ValidationError for invalid shapes — caught by run/stream catch
    // with partial attached, same as other config validation.
    const spec = normalizeStructuredOutput(raw);
    return { raw, spec };
  }
  if (fromOptions) return { raw: fromOptions, spec: fromOptions };
  return { raw: undefined, spec: undefined };
}

function parseFinalStructuredOutput(text: string, raw: unknown, spec: import("../types/model.ts").StructuredOutputSpec | undefined): unknown | undefined {
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
  // Q-41: no console.* in library code — route via the telemetry bus
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
// Q-19: tool-call/result pairing repair.
// ---------------------------------------------------------------------------

/**
 * Repairs orphaned tool call/result pairs before each provider request
 * (Q-19). Providers reject a `tool_result` without its `tool_call` and
 * vice versa; a prior abort or crash can leave such orphans in history.
 * Synthesizes error results for orphan calls and drops orphan results.
 */
export function ensureToolPairing(context: AgentContext): void {
  try {
    const callIds = new Map<string, string>();
    for (const m of context.messages) {
      if ((m as any)?.role !== "assistant" || !Array.isArray((m as any).content)) continue;
      for (const p of (m as any).content as Array<any>) {
        if (p && p.type === "tool_call" && typeof p.id === "string" && p.id) {
          if (!callIds.has(p.id)) callIds.set(p.id, typeof p.name === "string" ? p.name : "tool");
        }
      }
    }
    if (callIds.size === 0) {
      // No calls: drop any stray tool results.
      const hasOrphan = context.messages.some(
        (m: any) => m?.role === "tool" && Array.isArray(m.content)
      );
      if (!hasOrphan) return;
      context.messages = context.messages.filter((m: any) => m?.role !== "tool");
      return;
    }
    const resultIds = new Set<string>();
    for (const m of context.messages) {
      if ((m as any)?.role !== "tool" || !Array.isArray((m as any).content)) continue;
      for (const p of (m as any).content as Array<any>) {
        if (p && p.type === "tool_result" && typeof p.id === "string" && p.id) {
          resultIds.add(p.id);
        }
      }
    }
    const missing: ToolResultRecord[] = [];
    for (const [id, name] of callIds) {
      if (!resultIds.has(id)) {
        missing.push({
          id,
          name,
          result: `Error: orphan tool_call '${name}' (${id}) without a matching tool result (recovered by ensureToolPairing).`,
          isError: true,
          durationMs: 0,
        });
      }
    }
    if (missing.length > 0) {
      try { context.addToolResults(missing); } catch {}
      for (const r of missing) resultIds.add(r.id);
    }
    // Drop orphan results (result id never issued by the model).
    const filtered = context.messages.filter((m: any) => {
      if (m?.role !== "tool" || !Array.isArray(m.content)) return true;
      const parts = m.content as Array<any>;
      const keep = parts.filter((p) => p?.type !== "tool_result" || callIds.has(p.id));
      if (keep.length === parts.length) return true;
      if (keep.length === 0) return false;
      try { (m as any).content = keep; } catch {}
      return true;
    });
    context.messages = filtered as typeof context.messages;
  } catch {}
}

// ---------------------------------------------------------------------------
// Q-21/Q-22: abort + limits helpers.
// ---------------------------------------------------------------------------

export interface LoopLimits {
  maxTurns?: number;
  deadlineMs?: number;
  maxToolCallsPerRun?: number;
  requestTimeoutMs: number;
  firstByteTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

/** Resolves `(config as any).limits` with Q-22 defaults (timeouts tolerate reasoning). */
function resolveLoopLimits(config: AgentLoopConfig, fallbackMaxTurns: number): LoopLimits & { maxTurns: number; deadlineMs: number; maxToolCallsPerRun: number } {
  const raw = ((config as unknown as { limits?: Record<string, unknown> }).limits ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  let maxTurns = fallbackMaxTurns;
  const limMax = num(raw.maxTurns);
  if (limMax !== undefined) {
    const normLim = normalizeMaxTurns(limMax);
    maxTurns = Math.min(maxTurns, normLim);
  }
  const deadlineMs = num(raw.deadlineMs) ?? Infinity;
  const maxToolCallsPerRun = num(raw.maxToolCallsPerRun) ?? Infinity;
  const requestTimeoutMs = num(raw.requestTimeoutMs) ?? 300_000;
  const firstByteTimeoutMs = num(raw.firstByteTimeoutMs) ?? 120_000;
  const streamIdleTimeoutMs = num(raw.streamIdleTimeoutMs) ?? 300_000;
  return { maxTurns, deadlineMs, maxToolCallsPerRun, requestTimeoutMs, firstByteTimeoutMs, streamIdleTimeoutMs };
}

function loopSessionId(config: AgentLoopConfig): string | undefined {
  try {
    return (
      (config.runOptions as { sessionId?: string } | undefined)?.sessionId ||
      (config.options as { sessionId?: string } | undefined)?.sessionId ||
      (config.options as { cache?: { sessionId?: string } } | undefined)?.cache?.sessionId
    );
  } catch { return undefined; }
}

function makeAbortError(
  partial: { usage: TokenUsage; turns: number; text?: string },
  reason?: unknown
): Error {
  let base: Error;
  if (reason instanceof Error && reason.name === "AbortError") base = reason;
  else if (reason instanceof Error) base = new Error(reason.message || "Aborted");
  else if (typeof reason === "string" && reason) base = new Error(reason);
  else base = new Error("Aborted");
  try { (base as { name: string }).name = "AbortError"; } catch {}
  try { (base as unknown as { partial: unknown }).partial = partial; } catch {}
  return base;
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  partial: { usage: TokenUsage; turns: number; text?: string }
): void {
  if (signal?.aborted) {
    throw makeAbortError(partial, (signal as unknown as { reason?: unknown })?.reason ?? new Error("Aborted"));
  }
}

function checkDeadline(startTime: number, deadlineMs: number): void {
  if (Number.isFinite(deadlineMs) && deadlineMs !== Infinity && Date.now() - startTime > deadlineMs) {
    throw new Error(`[Agent Accelerator] Run deadline exceeded after ${deadlineMs}ms.`);
  }
}

async function generateWithTimeout<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs === Infinity) return task();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`[Agent Accelerator] Request timed out after ${timeoutMs}ms.`);
        e.name = "TimeoutError";
        reject(e);
      }, timeoutMs);
      try { (timer as unknown as { unref?: () => void }).unref?.(); } catch {}
    });
    return await Promise.race([task(), timeoutP]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Compat wrapper around the one cost model (`priceUsage` in session/store.ts, Q-36).
 * Prefers provider-reported totals, else catalog pricing with integer
 * micro-USD accumulation. Returns undefined when unknown (never a 0 object). */
export function computeCostFromPricing(usage: TokenUsage, spec?: ModelSpec): TokenUsage["cost"] {
  try {
    if (usage.cost && usage.cost.totalCost !== undefined && usage.cost.totalCost > 0) {
      return usage.cost;
    }
    if (!spec) return usage.cost;
    const priced = priceUsage(usage, spec);
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

// ---------------------------------------------------------------------------
// Q-35: canonical usage accumulation (pure w.r.t. source).
// Invariants (see assertUsageInvariants in session/store.ts):
// - token counts are finite integers >= 0;
// - cachedTokens/cacheReadTokens are a SUBSET of inputTokens (clamped below
//   so no consumer observes >100% hit rates);
// - thinkingTokens is a SUBSET of outputTokens when both are reported
//   (reasoning is generated output; enforced in the test helper, documented
//   here because providers vary on which side they omit).
// This function never mutates `source` (Q-35): the priced cost is cloned
// into a local before folding into the target.
// ---------------------------------------------------------------------------
function accumulateUsage(target: TokenUsage, source: TokenUsage, spec?: ModelSpec): void {
  target.inputTokens += source.inputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.totalTokens += source.totalTokens || 0;
  target.cachedTokens = (target.cachedTokens ?? 0) + (source.cachedTokens ?? 0);
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (source.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (source.cacheWriteTokens ?? 0);
  target.thinkingTokens = (target.thinkingTokens ?? 0) + (source.thinkingTokens ?? 0);

  // Canonical invariant (provider-agnostic): cache hits are a subset of
  // input. Some providers occasionally report cached > input on long chained
  // runs, which surfaces as >100% hit rates downstream. Clamp the aggregate
  // so no consumer can observe an impossible ratio.
  const preCached = target.cachedTokens ?? 0;
  const preRead = target.cacheReadTokens ?? 0;
  target.cachedTokens = Math.min(preCached, target.inputTokens);
  target.cacheReadTokens = Math.min(preRead, target.inputTokens);
  if ((target.cachedTokens ?? 0) < preCached || (target.cacheReadTokens ?? 0) < preRead) {
    // Q-35: no console — report via the anomaly hook + telemetry bus.
    reportUsageAnomaly({
      type: "cache_clamp",
      inputTokens: target.inputTokens,
      cachedTokens: preCached,
      cacheReadTokens: preRead,
    });
  }

  const priced = computeCostFromPricing(source, spec);
  // Q-35: pure — read `source` only; never assign back to `source.cost`.
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

function sanitizeToolResult(r: ToolResultRecord): { sanitized: ToolResultRecord; metas: SubAgentExecutionMetadata[] } {
  if (r.result && typeof r.result === "object" && "_subagentMetadata" in (r.result as any)) {
    const metaList = (r.result as any)._subagentMetadata as SubAgentExecutionMetadata[];
    const xml = (r.result as any).xml || (r.result as any).toString?.() || String(r.result);
    return {
      sanitized: { ...r, result: xml },
      metas: Array.isArray(metaList) ? metaList : [],
    };
  }
  return { sanitized: r, metas: [] };
}

function toolCallFingerprint(call: ToolCallRecord): string {
  const stableSerialize = (value: any, seen = new Set<any>()): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
    const output = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`).join(",")}}`;
    seen.delete(value);
    return output;
  };
  const args = stableSerialize(call.arguments ?? {});
  return `${call.name}\u0000${args}`;
}

/**
 * Prevents an identical tool call from being executed in consecutive model
 * turns. The synthetic error is sent back to the model so it can reuse the
 * previous result or choose a different action.
 */
async function executeToolCallsWithRepeatGuard(options: {
  tools: Record<string, ToolDefinition>;
  toolCalls: ToolCallRecord[];
  previousFingerprints: Set<string>;
  agentName?: string;
  signal?: AbortSignal;
  sessionId?: string;
  onSubagentEvent?: (event: { trackingId: string; delta?: string; thinkingDelta?: string; partialText?: string; partialThinking?: string }) => void;
}): Promise<{ results: ToolResultRecord[]; fingerprints: Set<string> }> {
  const { toolCalls, previousFingerprints } = options;
  const currentFingerprints = new Set<string>();
  const blocked = new Map<string, ToolResultRecord>();
  const executable: ToolCallRecord[] = [];

  for (const call of toolCalls) {
    const fingerprint = toolCallFingerprint(call);
    currentFingerprints.add(fingerprint);
    if (previousFingerprints.has(fingerprint)) {
      blocked.set(call.id, {
        id: call.id,
        name: call.name,
        result:
          `Error: Tool '${call.name}' was called again immediately with identical arguments. ` +
          "The previous result is already available; reuse it or call the tool with different arguments.",
        isError: true,
        durationMs: 0,
      });
    } else {
      executable.push(call);
    }
  }

  const executed = executable.length > 0
    ? await executeToolCalls({
        tools: options.tools,
        toolCalls: executable,
        agentName: options.agentName,
        parallel: true,
        signal: options.signal,
        sessionId: options.sessionId,
        onSubagentEvent: options.onSubagentEvent,
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
    results: toolCalls
      .map((call) => byId.get(call.id)?.shift())
      .filter((r): r is ToolResultRecord => Boolean(r)),
    fingerprints: currentFingerprints,
  };
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
  // Q-19: pre-run checkpoint for onFailure rollback.
  const preRunCp = context.checkpoint();
  const sessionIdForRollback = loopSessionId(config);

  // Q-37: partial-run state hoisted outside try so the catch block can attach
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
  let previousToolCallFingerprints = new Set<string>();

  try {
  if (config.bypassInputFileModality) {
    await preprocessFilePartsForBypass(config.context.messages, {
      providerId: provider.id,
      modelId,
      signal: runOptions?.signal,
    });
  }

  const standardTools = toStandardToolDeclarations(tools);

  while (turns < maxTurns) {
    // Q-21: fail fast on abort (throws AbortError with partial).
    throwIfAborted(runOptions?.signal, { usage: accumulatedUsage, turns, text: finalResult?.text });
    checkDeadline(startTime, limits.deadlineMs);
    // Q-19: repair orphan tool pairs before every request.
    ensureToolPairing(context);
    turns++;

    const spec = getModelFromCatalog(provider.id, modelId);

    const providerOptions: ProviderRequestOptions = {
      ...options,
      // Merge sessionId from cache or top-level (C4 fix: read both)
      sessionId: runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
      cache: options?.cache,
      tools: standardTools.length > 0 ? standardTools : undefined,
      signal: runOptions?.signal,
      ...(loopOutput.spec ? { output: loopOutput.spec } : {}),
    };
    // Q-22: per-request timeout pass-through (providers honor timeoutMs).
    try {
      if (Number.isFinite(limits.requestTimeoutMs) && limits.requestTimeoutMs !== Infinity) {
        (providerOptions as unknown as { timeoutMs?: number }).timeoutMs = limits.requestTimeoutMs;
      }
    } catch {}
    // Q-25-partial: google:{store:false} opt-out pass-through (provider
    // already respects body.store===false for chaining).
    try {
      const gStore =
        (runOptions as unknown as { googleStore?: unknown } | undefined)?.googleStore ??
        (options as unknown as { googleStore?: unknown } | undefined)?.googleStore ??
        (config as unknown as { googleStore?: unknown }).googleStore;
      if (gStore === false) (providerOptions as unknown as { store?: boolean }).store = false;
    } catch {}

    const genResult = await generateWithTimeout(
      () => provider.generate(
        modelId,
        {
          systemPrompt: context.systemPrompt,
          messages: context.messages,
          cachedContentId: context.cachedContentId,
        },
        providerOptions
      ),
      limits.requestTimeoutMs
    );

    finalResult = genResult;

    // Canonical session routing: lets adapters detect provider switches.
    noteProviderTurn(
      runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
      provider.id
    );

    // Thinking is exposed via events/traces and onTurn (see shouldExposeThinking,
    // default true). Promoting thinking to answer text is gated (Q-15, default
    // OFF): without the explicit opt-in the run returns the provider's empty
    // text with its finishReason instead of fabricating an answer from reasoning.
    if ((!genResult.text || genResult.text.trim() === "") && (!genResult.toolCalls || genResult.toolCalls.length === 0) && genResult.thinking) {
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

    accumulateUsage(accumulatedUsage, genResult.usage, spec);

    // Record assistant turn in context
    context.addAssistantMessage(
      genResult.text,
      genResult.toolCalls,
      genResult.thinking,
      genResult.thoughtSignature
    );

    // Mid-session steer: if new queries arrived during this provider turn,
    // inject them now. Tool turns still execute first (see below) so the
    // current action finishes before redirection.
    const noToolSteered = (!genResult.toolCalls || genResult.toolCalls.length === 0)
      ? drainSteerInbox(context, config.steerInbox)
      : [];

    // If no tool calls, generation is complete — unless steered, in which
    // case the injected message extends the SAME run (no new response).
    if (!genResult.toolCalls || genResult.toolCalls.length === 0) {
      emitTurn(runOptions, { turns, text: genResult.text, thinking: genResult.thinking });
      if (noToolSteered.length > 0) {
        try { config.onSteerInjected?.(noToolSteered); } catch {}
        if (config.bypassInputFileModality) {
          await preprocessFilePartsForBypass(config.context.messages, {
            providerId: provider.id,
            modelId,
            signal: runOptions?.signal,
          });
        }
      }
      emitProgress(config);
      if (noToolSteered.length > 0) continue;
      break;
    }

    // Execute tool calls — always parallel (model-driven, bloatfree DX7)
    // Q-21: check abort before tools (throws AbortError with partial).
    throwIfAborted(runOptions?.signal, { usage: accumulatedUsage, turns, text: genResult.text });
    allToolCalls.push(...genResult.toolCalls);
    // Q-22: per-run tool-call budget.
    if (allToolCalls.length > limits.maxToolCallsPerRun) {
      throw new Error(
        `[Agent Accelerator] maxToolCallsPerRun exceeded (${allToolCalls.length} > ${limits.maxToolCallsPerRun}).`
      );
    }
    const guarded = await executeToolCallsWithRepeatGuard({
      tools,
      toolCalls: genResult.toolCalls,
      previousFingerprints: previousToolCallFingerprints,
      agentName,
      signal: runOptions?.signal,
      sessionId: runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
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
          const subagentSpec = getModelFromCatalog(s.provider, s.model);
          if (subagentSpec && (!s.usage?.cost || !s.usage.cost.totalCost)) {
            s.usage.cost = computeCostFromPricing(s.usage, subagentSpec);
          }
          accumulateUsage(accumulatedUsage, s.usage, subagentSpec);
        }
      }
      sanitizedResults.push(sanitized);
    }

    allToolResults.push(...sanitizedResults);
    context.addToolResults(sanitizedResults);
    // Q-19: results are stored BEFORE the cancellation check so an abort
    // never drops executed tool work from history.
    throwIfAborted(runOptions?.signal, { usage: accumulatedUsage, turns, text: genResult.text });
    emitTurn(runOptions, {
      turns,
      text: genResult.text,
      thinking: genResult.thinking,
      toolCalls: genResult.toolCalls,
      toolResults: sanitizedResults,
    });
    // Steer drain AFTER tool results so call/result pairs stay adjacent.
    // The next loop iteration sends the injected user message to the model
    // within the same run (same usage/turn budget).
    const toolSteered = drainSteerInbox(context, config.steerInbox);
    if (toolSteered.length > 0) {
      try { config.onSteerInjected?.(toolSteered); } catch {}
      if (config.bypassInputFileModality) {
        await preprocessFilePartsForBypass(config.context.messages, {
          providerId: provider.id,
          modelId,
          signal: runOptions?.signal,
        });
      }
    }
    emitProgress(config);

    // Q-21: abort always throws AbortError with partial attached (never
    // silently breaks).
    throwIfAborted(runOptions?.signal, { usage: accumulatedUsage, turns, text: finalResult?.text });
  }

  // maxTurns exhausted while the model still requested tools: the tool
  // results above were never sent back, so the run is truncated — surface
  // it via finishReason + warning instead of silently returning.
  const truncatedByMaxTurns =
    turns >= maxTurns && !!finalResult?.toolCalls && finalResult.toolCalls.length > 0;
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
  if (loopOutput.raw !== undefined && !truncatedByMaxTurns) {
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
    // Q-04: canonical finish reason + raw vendor passthrough.
    ...canonicalFinishReason(finalResult?.finishReason, truncatedByMaxTurns),
    durationMs: Date.now() - startTime,
    raw: finalResult?.raw,
    turns,
  });
  } catch (err) {
    // Q-19: run-level onFailure rollback (default restores pre-run
    // checkpoint; opt out with (config as any).onFailure === "keep").
    // Aborts are excluded so partial history survives interruption.
    const onFailure = (config as unknown as { onFailure?: unknown }).onFailure;
    const isAbort =
      (err as { name?: string } | null)?.name === "AbortError" ||
      !!runOptions?.signal?.aborted;
    if (onFailure !== "keep" && !isAbort) {
      try { context.rollback(preRunCp, sessionIdForRollback); } catch {
        // why: rollback is best-effort — the original error takes precedence.
      }
    }
    // Q-21: ensure aborts surface as AbortError with partial attached.
    if (isAbort && (err as { name?: string } | null)?.name !== "AbortError") {
      throw makeAbortError(
        { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, turns: 0 },
        err
      );
    }
    // Q-37: every failure carries its partial progress for observability.
    try {
      (err as unknown as { partial?: unknown }).partial ??= {
        usage: accumulatedUsage,
        cost: accumulatedUsage.cost,
        turns,
        toolCalls: allToolCalls,
        toolResults: allToolResults,
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
    try { linked.abort((userSignal as any)?.reason); } catch { try { linked.abort(); } catch {} }
  };
  if (userSignal?.aborted) forwardUserAbort();
  else userSignal?.addEventListener("abort", forwardUserAbort, { once: true });
  let currentInner: AssistantMessageEventStream | null = null;
  const removeOuterCancel = outerStream.onCancel(() => {
    try { linked.abort(); } catch {}
    try { currentInner?.cancel(); } catch {}
  });
  linked.signal.addEventListener("abort", () => {
    try { currentInner?.cancel(); } catch {}
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

  // Q-19/Q-22: per-run checkpoint + limits for the streaming loop.
  const streamPreCp = config.context.checkpoint();
  const streamSessionId = loopSessionId(config);
  const streamFallbackMax = normalizeMaxTurns((config as { maxTurns?: number }).maxTurns);
  const streamLimits = resolveLoopLimits(config, streamFallbackMax);
  const streamStartTime = startTime;

  (async () => {
    // Hoisted for catch-block partial reporting (Q-21/Q-37).
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
    // Q-37: tool progress hoisted so failures carry toolCalls/toolResults.
    const allToolCalls: ToolCallRecord[] = [];
    const allToolResults: ToolResultRecord[] = [];
    const allSubagents: SubAgentExecutionMetadata[] = [];
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
      if (config.bypassInputFileModality) {
        await preprocessFilePartsForBypass(config.context.messages, {
          providerId: config.provider.id,
          modelId: config.modelId,
          signal: config.runOptions?.signal,
        });
      }
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

      // Q-37: allToolCalls/allToolResults/allSubagents are hoisted above (fresh
      // per stream run); just reset turn counters here.
      lastResponse = null;
      turns = 0;
      let previousToolCallFingerprints = new Set<string>();

      while (turns < maxTurns) {
        throwIfCancelled({ usage: accumulatedUsage, turns, text: lastResponse?.text });
        checkDeadline(streamStartTime, streamLimits.deadlineMs);
        ensureToolPairing(context);
        turns++;

        const spec2 = getModelFromCatalog(provider.id, modelId);

        const providerOptions: ProviderRequestOptions = {
          ...options,
          sessionId: runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
          cache: options?.cache,
          tools: standardTools.length > 0 ? standardTools : undefined,
          signal: linked.signal,
          ...(streamOutputSpec ? { output: streamOutputSpec } : {}),
        };
        try {
          if (Number.isFinite(streamLimits.requestTimeoutMs) && streamLimits.requestTimeoutMs !== Infinity) {
            (providerOptions as unknown as { timeoutMs?: number }).timeoutMs = streamLimits.requestTimeoutMs;
          }
        } catch {}
        try {
          const gStore =
            (runOptions as unknown as { googleStore?: unknown } | undefined)?.googleStore ??
            (options as unknown as { googleStore?: unknown } | undefined)?.googleStore ??
            (config as unknown as { googleStore?: unknown }).googleStore;
          if (gStore === false) (providerOptions as unknown as { store?: boolean }).store = false;
        } catch {}

        const innerStream = provider.stream(
          modelId,
          {
            systemPrompt: context.systemPrompt,
            messages: context.messages,
            cachedContentId: context.cachedContentId,
          },
          providerOptions
        );
        currentInner = innerStream as AssistantMessageEventStream;

        // Q-22: first-byte + idle timeouts around SSE (tolerate reasoning).
        // Implemented as races on the inner iterator so a hung provider
        // surfaces as TimeoutError instead of hanging the run forever.
        {
          const it = (innerStream as AsyncIterable<StreamEvent>)[Symbol.asyncIterator]();
          let first = true;
          let doneIter = false;
          while (!doneIter) {
            const waitMs = first ? streamLimits.firstByteTimeoutMs : streamLimits.streamIdleTimeoutMs;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeoutP =
              Number.isFinite(waitMs) && waitMs !== Infinity && waitMs > 0
                ? new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                      const e = new Error(
                        `[Agent Accelerator] Stream ${first ? "first-byte" : "idle"} timed out after ${waitMs}ms.`
                      );
                      e.name = "TimeoutError";
                      reject(e);
                    }, waitMs);
                    try { (timer as unknown as { unref?: () => void }).unref?.(); } catch {}
                  })
                : null;
            try {
              const nextP = it.next();
              const res = timeoutP ? await Promise.race([nextP, timeoutP]) : await nextP;
              if (timer) clearTimeout(timer);
              if (res.done) { doneIter = true; break; }
              first = false;
              throwIfCancelled({ usage: accumulatedUsage, turns, text: lastResponse?.text });
              const event = res.value as StreamEvent;
              if ((event as StreamEvent)?.type !== "done") {
                outerStream.push(event);
              }
            } catch (e) {
              if (timer) clearTimeout(timer);
              // Timeout: cancel the hung inner stream before surfacing.
              if ((e as Error)?.name === "TimeoutError") {
                try { currentInner?.cancel(); } catch {}
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
        noteProviderTurn(
          runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
          provider.id
        );

        // Thinking stays on events/traces + onTurn (default exposed). Promoting
        // it to answer text is gated (Q-15, default OFF): without the opt-in
        // the turn keeps the provider's empty text and finishReason.
        if ((!turnResponse.text || turnResponse.text.trim() === "") && (!turnResponse.toolCalls || turnResponse.toolCalls.length === 0) && turnResponse.thinking) {
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

        accumulateUsage(accumulatedUsage, turnResponse.usage, spec2);

        context.addAssistantMessage(
          turnResponse.text,
          turnResponse.toolCalls,
          turnResponse.thinking,
          turnResponse.thoughtSignature
        );

        const noToolSteered = (!turnResponse.toolCalls || turnResponse.toolCalls.length === 0)
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
            try { config.onSteerInjected?.(noToolSteered); } catch {
              // why: user callback — a throw must not fail the run.
            }
          }
          emitProgress(config);
          if (noToolSteered.length > 0) continue;
          break;
        }

        throwIfCancelled({ usage: accumulatedUsage, turns, text: turnResponse.text });
        allToolCalls.push(...turnResponse.toolCalls);
        if (allToolCalls.length > streamLimits.maxToolCallsPerRun) {
          throw new Error(
            `[Agent Accelerator] maxToolCallsPerRun exceeded (${allToolCalls.length} > ${streamLimits.maxToolCallsPerRun}).`
          );
        }
        // Q-40: typed tool lifecycle for streaming consumers.
        try {
          outerStream.push({ type: "tool_start", toolCalls: turnResponse.toolCalls });
        } catch {
          // why: stream push never throws, but guard anyway to protect the loop.
        }
        const guarded = await executeToolCallsWithRepeatGuard({
          tools,
          toolCalls: turnResponse.toolCalls,
          previousFingerprints: previousToolCallFingerprints,
          agentName,
          signal: linked.signal,
          sessionId: runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
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
              const subagentSpec = getModelFromCatalog(s.provider, s.model);
              if (subagentSpec && (!s.usage?.cost || !s.usage.cost.totalCost)) {
                s.usage.cost = computeCostFromPricing(s.usage, subagentSpec);
              }
              accumulateUsage(accumulatedUsage, s.usage, subagentSpec);
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
        // Q-40: close the tool lifecycle opened by `tool_start` above.
        try {
          outerStream.push({ type: "tool_end", toolResults: sanitizedResults });
        } catch {
          // why: stream push never throws, but guard anyway to protect the loop.
        }

        // Q-19: store tool results BEFORE the cancellation check.
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
        const toolSteered = drainSteerInbox(context, config.steerInbox);
        if (toolSteered.length > 0) {
          for (const preview of toolSteered) {
            try {
              outerStream.push({ type: "steer_injected", injectedPrompt: preview });
            } catch {
              // why: stream push never throws, but guard anyway to protect the loop.
            }
          }
          try { config.onSteerInjected?.(toolSteered); } catch {
            // why: user callback — a throw must not fail the run.
          }
        }
        emitProgress(config);
      }

      const truncatedByMaxTurns =
        turns >= maxTurns && !!lastResponse?.toolCalls && lastResponse.toolCalls.length > 0;
      if (truncatedByMaxTurns) {
        warnMaxTurnsHit(
          agentName,
          maxTurns,
          lastResponse!.toolCalls.map((c) => c.name)
        );
      }
      const truncatedFinish = canonicalFinishReason(lastResponse?.finishReason, truncatedByMaxTurns);

      let streamParsed: unknown | undefined;
      if (streamOutputRaw !== undefined && !truncatedByMaxTurns) {
        try {
          streamParsed = parseFinalStructuredOutput(lastResponse?.text || "", streamOutputRaw, streamOutputSpec);
        } catch (err) {
          const raw = err instanceof Error ? err : new Error(String(err));
          try { (raw as unknown as { partial?: unknown }).partial ??= {
            usage: accumulatedUsage,
            cost: accumulatedUsage.cost,
            turns,
            toolCalls: allToolCalls,
            toolResults: allToolResults,
            text: lastResponse?.text,
          }; } catch {}
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
        // Q-04: canonical finish reason + raw vendor passthrough.
        ...truncatedFinish,
        durationMs: Date.now() - startTime,
        raw: lastResponse?.raw as any,
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
      const isAbort =
        linked.signal.aborted ||
        outerStream.isCancelled() ||
        (raw as any)?.name === "AbortError" ||
        /abort|cancell?ed/i.test(String((raw as any)?.message ?? raw));
      // Q-19: streaming onFailure rollback (same policy as runAgentLoop;
      // aborts excluded so partial history survives).
      try {
        const onFailure = (config as unknown as { onFailure?: unknown }).onFailure;
        if (onFailure !== "keep" && !isAbort) {
          try { config.context.rollback(streamPreCp, streamSessionId); } catch {
            // why: rollback is best-effort — the original error takes precedence.
          }
        }
      } catch {
        // why: rollback policy itself must never mask the original error.
      }
      // Q-37: every failure carries its partial progress for observability.
      const partial = {
        usage: accumulatedUsage,
        cost: accumulatedUsage.cost,
        turns,
        toolCalls: allToolCalls,
        toolResults: allToolResults,
        text: lastResponse?.text,
      };
      // Q-21: aborts always surface as AbortError with partial attached.
      if (isAbort) {
        const abortErr =
          raw.name === "AbortError" ? raw : makeAbortError(partial, raw);
        try { (abortErr as unknown as { partial?: unknown }).partial ??= partial; } catch {
          // why: partial attachment is observability-only and must never mask the error.
        }
        outerStream.fail(abortErr);
      } else {
        try { (raw as unknown as { partial?: unknown }).partial ??= partial; } catch {
          // why: partial attachment is observability-only and must never mask the error.
        }
        outerStream.fail(raw);
      }
    } finally {
      try { currentInner?.cancel(); } catch {
        // why: inner streams tolerate double-cancel; cleanup must not throw.
      }
      try { userSignal?.removeEventListener("abort", forwardUserAbort); } catch {
        // why: listener removal is best-effort cleanup.
      }
      try { removeOuterCancel(); } catch {
        // why: unsubscribe is best-effort cleanup.
      }
    }
  })();

  return outerStream;
}

// ---------------------------------------------------------------------------
// Q-15: single thinking-exposure policy + Q-04 canonical finish helper.
// (Appended here to avoid conflicts with other loop sections.)
// ---------------------------------------------------------------------------

/**
 * Single expose-thinking policy (Q-15).
 * - Events/traces/onTurn always carry thinking separately (default true).
 * - Promoting thinking to answer *text* is a separate opt-in
 *   (`thinkingAsAnswerFallback`, default false) — see
 *   `shouldPromoteThinkingToAnswer`.
 *
 * Reads `exposeThinking` from the loop config, run options, or provider
 * options; any explicit `false` hides thinking from events/traces.
 */
export function shouldExposeThinking(config?: unknown): boolean {
  try {
    const c = config as {
      exposeThinking?: unknown;
      runOptions?: { exposeThinking?: unknown };
      options?: { exposeThinking?: unknown };
    } | null | undefined;
    const v = c?.exposeThinking ?? c?.runOptions?.exposeThinking ?? c?.options?.exposeThinking;
    if (v === undefined) return true;
    return Boolean(v);
  } catch {
    // why: policy lookup is best-effort — default to exposing thinking.
    return true;
  }
}

/**
 * Whether an empty-text turn may promote `thinking` to answer `text` (Q-15).
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
    const c = config as {
      thinkingAsAnswerFallback?: unknown;
      runOptions?: { thinkingAsAnswerFallback?: unknown };
    } | null | undefined;
    if (c?.thinkingAsAnswerFallback === true) return true;
    if (c?.runOptions?.thinkingAsAnswerFallback === true) return true;
    return false;
  } catch {
    // why: policy lookup is best-effort — default to NOT promoting thinking.
    return false;
  }
}

/**
 * Canonicalizes a provider finish reason for AgentResponse (Q-04).
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
