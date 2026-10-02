import type { Provider, ProviderRequestOptions, ModelSpec } from "../types/model.ts";
import type { ToolDefinition, ToolCallRecord, ToolResultRecord } from "../types/tool.ts";
import type { TokenUsage } from "../types/core.ts";
import type { AgentRunOptions } from "../types/agent.ts";
import type { ContentPart } from "../types/message.ts";
import { AgentResponse, type SubAgentExecutionMetadata, type StreamEvent } from "../types/response.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentContext } from "./context.ts";
import { toStandardToolDeclarations } from "../tools/tool.ts";
import { executeToolCalls } from "../tools/executor.ts";
import { getModelFromCatalog, ensureModelCatalogFresh, validateModelThinking } from "../models/catalog.ts";
import { preprocessFilePartsForBypass } from "../utils/documents.ts";
import { noteProviderTurn } from "../providers.ts";

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
  // Leading newline: runs often end mid-line on streamed output; without it
  // the warning glues onto the last streamed chunk.
  console.warn(`\n[Agent Accelerator] WARNING [agent] ${who} hit maxTurns (${maxTurns}) with unfinished tool calls.${tools} Increase maxTurns or split the task.`);
}

export function computeCostFromPricing(usage: TokenUsage, spec?: ModelSpec): TokenUsage["cost"] {
  if (usage.cost && usage.cost.totalCost !== undefined && usage.cost.totalCost > 0) {
    return usage.cost;
  }
  if (!spec) return usage.cost;

  const costData = spec.cost || {};
  const pricingData = spec.pricing || {};
  const inputPrice = pricingData.inputPerMillion ?? costData.input ?? 0;
  const outputPrice = pricingData.outputPerMillion ?? costData.output ?? 0;
  const cacheReadPrice = pricingData.cacheReadPerMillion ?? costData.cache_read ?? 0;
  const cacheWritePrice = pricingData.cacheWritePerMillion ?? costData.cache_write ?? 0;

  if (inputPrice === 0 && outputPrice === 0 && cacheReadPrice === 0 && cacheWritePrice === 0) {
    return usage.cost;
  }

  const cachedTokens = usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
  const nonCachedInputTokens = Math.max(0, (usage.inputTokens || 0) - cachedTokens);
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;

  const inputCost = (nonCachedInputTokens / 1_000_000) * inputPrice;
  const cacheReadCost = (cachedTokens / 1_000_000) * cacheReadPrice;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * cacheWritePrice;
  const outputCost = (outputTokens / 1_000_000) * outputPrice;
  const totalCost = inputCost + cacheReadCost + cacheWriteCost + outputCost;

  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    totalCost,
  };
}

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
  target.cachedTokens = Math.min(target.cachedTokens ?? 0, target.inputTokens);
  target.cacheReadTokens = Math.min(target.cacheReadTokens ?? 0, target.inputTokens);

  const sourceCost = computeCostFromPricing(source, spec);
  if (sourceCost) {
    source.cost = sourceCost;
  }

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
  const maxTurns = normalizeMaxTurns(rawMaxTurns);

  if (config.bypassInputFileModality) {
    await preprocessFilePartsForBypass(config.context.messages, {
      providerId: provider.id,
      modelId,
      signal: runOptions?.signal,
    });
  }

  const standardTools = toStandardToolDeclarations(tools);
  const startTime = Date.now();

  let accumulatedUsage: TokenUsage = {
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

  while (turns < maxTurns) {
    turns++;

    const spec = getModelFromCatalog(provider.id, modelId);

    const providerOptions: ProviderRequestOptions = {
      ...options,
      // Merge sessionId from cache or top-level (C4 fix: read both)
      sessionId: runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
      cache: options?.cache,
      tools: standardTools.length > 0 ? standardTools : undefined,
      signal: runOptions?.signal,
    };

    const genResult = await provider.generate(
      modelId,
      {
        systemPrompt: context.systemPrompt,
        messages: context.messages,
        cachedContentId: context.cachedContentId,
      },
      providerOptions
    );

    finalResult = genResult;

    // Canonical session routing: lets adapters detect provider switches.
    noteProviderTurn(
      runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
      provider.id
    );

    // Safety fallback: if no tool calls and text is empty, rescue answer from thinking
    if ((!genResult.text || genResult.text.trim() === "") && (!genResult.toolCalls || genResult.toolCalls.length === 0) && genResult.thinking) {
      if (genResult.thinking.includes("</think>")) {
        const parts = genResult.thinking.split(/<\/(?:think|thought)>/i);
        genResult.thinking = parts[0]!.replace(/<(?:think|thought)>/i, "").trim() || undefined;
        genResult.text = parts.slice(1).join("").trim();
      } else {
        genResult.text = genResult.thinking;
        genResult.thinking = undefined;
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
    allToolCalls.push(...genResult.toolCalls);
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

    if (runOptions?.signal?.aborted) break;
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

  return new AgentResponse({
    text: finalResult?.text || "",
    thinking: finalResult?.thinking,
    thoughtSignature: finalResult?.thoughtSignature,
    toolCalls: allToolCalls,
    toolResults: allToolResults,
    subagents: allSubagents,
    usage: accumulatedUsage,
    responseId: finalResult?.responseId,
    model: modelId,
    provider: provider.id,
    finishReason: truncatedByMaxTurns ? "max_turns" : finalResult?.finishReason,
    durationMs: Date.now() - startTime,
    raw: finalResult?.raw,
    turns,
  });
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
  const throwIfCancelled = () => {
    if (linked.signal.aborted || outerStream.isCancelled())
      throw Object.assign(new Error("Stream aborted"), { name: "AbortError" });
  };

  (async () => {
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
      const maxTurns = normalizeMaxTurns(rawMaxTurns);

      const standardTools = toStandardToolDeclarations(tools);

      let accumulatedUsage: TokenUsage = {
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
      let lastResponse: AgentResponse | null = null;
      let turns = 0;
      let previousToolCallFingerprints = new Set<string>();

      while (turns < maxTurns) {
        throwIfCancelled();
        turns++;

        const spec2 = getModelFromCatalog(provider.id, modelId);

        const providerOptions: ProviderRequestOptions = {
          ...options,
          sessionId: runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
          cache: options?.cache,
          tools: standardTools.length > 0 ? standardTools : undefined,
          signal: linked.signal,
        };

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

        for await (const event of innerStream) {
          throwIfCancelled();
          if (event.type !== "done") {
            outerStream.push(event);
          }
        }

        const turnResponse = await innerStream.result();
        currentInner = null;
        throwIfCancelled();
        lastResponse = turnResponse;
        // Canonical session routing: lets adapters detect provider switches.
        noteProviderTurn(
          runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
          provider.id
        );

        // Safety fallback: if no tool calls and text is empty, rescue answer from thinking
        if ((!turnResponse.text || turnResponse.text.trim() === "") && (!turnResponse.toolCalls || turnResponse.toolCalls.length === 0) && turnResponse.thinking) {
          if (turnResponse.thinking.includes("</think>")) {
            const parts = turnResponse.thinking.split(/<\/(?:think|thought)>/i);
            (turnResponse as any).thinking = parts[0]!.replace(/<(?:think|thought)>/i, "").trim() || undefined;
            (turnResponse as any).text = parts.slice(1).join("").trim();
          } else {
            (turnResponse as any).text = turnResponse.thinking;
            (turnResponse as any).thinking = undefined;
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
                outerStream.push({ type: "steer_injected", injectedPrompt: preview } as any);
              } catch {}
            }
            try { config.onSteerInjected?.(noToolSteered); } catch {}
          }
          emitProgress(config);
          if (noToolSteered.length > 0) continue;
          break;
        }

        allToolCalls.push(...turnResponse.toolCalls);
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
            } catch {}
          },
        });
        throwIfCancelled();
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

        allToolResults.push(...sanitizedResults);
        context.addToolResults(sanitizedResults);
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
              outerStream.push({ type: "steer_injected", injectedPrompt: preview } as any);
            } catch {}
          }
          try { config.onSteerInjected?.(toolSteered); } catch {}
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
      const truncatedFinishReason = truncatedByMaxTurns ? "max_turns" : lastResponse?.finishReason;

      const finalAgentResponse = new AgentResponse({
        text: lastResponse?.text || "",
        thinking: lastResponse?.thinking,
        thoughtSignature: lastResponse?.thoughtSignature,
        toolCalls: allToolCalls,
        toolResults: allToolResults,
        subagents: allSubagents,
        usage: accumulatedUsage,
        responseId: lastResponse?.responseId,
        model: modelId,
        provider: provider.id,
        finishReason: truncatedFinishReason,
        durationMs: Date.now() - startTime,
        raw: lastResponse?.raw as any,
        turns,
      });

      outerStream.push({
        type: "done",
        delta: "",
        usage: accumulatedUsage,
        finishReason: truncatedFinishReason,
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
      outerStream.fail(
        isAbort
          ? Object.assign(raw.name === "AbortError" ? raw : new Error("Stream aborted"), { name: "AbortError" })
          : raw
      );
    } finally {
      try { currentInner?.cancel(); } catch {}
      try { userSignal?.removeEventListener("abort", forwardUserAbort); } catch {}
      try { removeOuterCancel(); } catch {}
    }
  })();

  return outerStream;
}
