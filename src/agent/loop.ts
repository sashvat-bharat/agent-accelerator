import type { Provider, ProviderRequestOptions, ModelSpec } from "../types/model.ts";
import type { ToolDefinition, ToolCallRecord, ToolResultRecord } from "../types/tool.ts";
import type { TokenUsage } from "../types/core.ts";
import type { AgentRunOptions } from "../types/agent.ts";
import { AgentResponse, type SubAgentExecutionMetadata, type StreamEvent } from "../types/response.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentContext } from "./context.ts";
import { toStandardToolDeclarations } from "../tools/tool.ts";
import { executeToolCalls } from "../tools/executor.ts";
import { getModelFromCatalog } from "../models/catalog.ts";
import { countTokens } from "../tokens/counter.ts";

export interface AgentLoopConfig {
  agentName?: string;
  provider: Provider;
  modelId: string;
  context: AgentContext;
  tools: Record<string, ToolDefinition>;
  options?: ProviderRequestOptions;
  runOptions?: AgentRunOptions;
  maxTurns?: number;
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

/**
 * Runs a single non-streaming agent turn or multi-turn loop
 */
export async function runAgentLoop(config: AgentLoopConfig): Promise<AgentResponse> {
  const {
    agentName,
    provider,
    modelId,
    context,
    tools,
    options,
    runOptions,
    maxTurns = 10,
  } = config;

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

  while (turns < maxTurns) {
    turns++;

    // Battle-tested context window check — trim oldest history if needed, keep cached prefix (system+tools)
    const spec = getModelFromCatalog(provider.id, modelId);
    const contextWindow = spec?.limit?.context ?? spec?.contextWindow ?? 128000;
    const maxOutput = spec?.limit?.output ?? spec?.maxOutputTokens ?? 8192;
    // Reserve for output + 10% headroom, ensure first turn already cache-friendly
    const budgetForInput = Math.floor(contextWindow * 0.9) - maxOutput;
    let estimated = 0;
    try {
      estimated = countTokens({ systemPrompt: context.systemPrompt, messages: context.messages, tools: standardTools as any });
    } catch {}
    if (estimated > budgetForInput && context.messages.length > 2) {
      // Keep system + last 70% of history, drop oldest middle (preserve cached prefix stability)
      const keepCount = Math.max(2, Math.floor(context.messages.length * 0.7));
      const toKeep = context.messages.slice(-keepCount);
      // Preserve at least system and first user if possible
      const firstUserIdx = context.messages.findIndex((m) => m.role === "user");
      if (firstUserIdx >= 0 && firstUserIdx < context.messages.length - keepCount) {
        // Drop middle, keep head + tail for cache stability
        const head = context.messages.slice(0, 1);
        context.messages = [...head, ...toKeep];
      } else {
        context.messages = toKeep;
      }
    }

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
      genResult.thoughtSignature,
      {
        thinkingSignature: genResult.thinkingSignature,
        textSignature: genResult.textSignature,
      }
    );

    // If no tool calls, generation is complete!
    if (!genResult.toolCalls || genResult.toolCalls.length === 0) {
      break;
    }

    // Execute tool calls — always parallel (model-driven, bloatfree DX7)
    allToolCalls.push(...genResult.toolCalls);
    const results = await executeToolCalls({
      tools,
      toolCalls: genResult.toolCalls,
      agentName,
      parallel: true,
      signal: runOptions?.signal,
      sessionId: runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
    });

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

    if (runOptions?.signal?.aborted) break;
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
    finishReason: finalResult?.finishReason,
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

  (async () => {
    try {
      const {
        agentName,
        provider,
        modelId,
        context,
        tools,
        options,
        runOptions,
        maxTurns = 10,
      } = config;

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

      while (turns < maxTurns) {
        if (runOptions?.signal?.aborted) break;
        turns++;

        // Same context-window trim as non-stream (ensure cache prefix stable)
        const spec2 = getModelFromCatalog(provider.id, modelId);
        const cw2 = spec2?.limit?.context ?? spec2?.contextWindow ?? 128000;
        const mo2 = spec2?.limit?.output ?? spec2?.maxOutputTokens ?? 8192;
        const budget2 = Math.floor(cw2 * 0.9) - mo2;
        try {
          const est2 = countTokens({ systemPrompt: context.systemPrompt, messages: context.messages, tools: standardTools as any });
          if (est2 > budget2 && context.messages.length > 2) {
            const keep2 = Math.max(2, Math.floor(context.messages.length * 0.7));
            const toKeep = context.messages.slice(-keep2);
            const firstUserIdx = context.messages.findIndex((m) => m.role === "user");
            if (firstUserIdx >= 0 && firstUserIdx < context.messages.length - keep2) {
              const head = context.messages.slice(0, 1);
              context.messages = [...head, ...toKeep];
            } else {
              context.messages = toKeep;
            }
          }
        } catch {}

        const providerOptions: ProviderRequestOptions = {
          ...options,
          sessionId: runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
          cache: options?.cache,
          tools: standardTools.length > 0 ? standardTools : undefined,
          signal: runOptions?.signal,
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

        for await (const event of innerStream) {
          if (event.type !== "done") {
            outerStream.push(event);
          }
        }

        const turnResponse = await innerStream.result();
        lastResponse = turnResponse;

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
          turnResponse.thoughtSignature,
          {
            thinkingSignature: turnResponse.thinkingSignature,
            textSignature: turnResponse.textSignature,
          }
        );

        if (!turnResponse.toolCalls || turnResponse.toolCalls.length === 0) {
          break;
        }

        allToolCalls.push(...turnResponse.toolCalls);
        const results = await executeToolCalls({
          tools,
          toolCalls: turnResponse.toolCalls,
          agentName,
          parallel: true,
          signal: runOptions?.signal,
          sessionId: runOptions?.sessionId || options?.sessionId || options?.cache?.sessionId,
        });

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
      }

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
        finishReason: lastResponse?.finishReason,
        durationMs: Date.now() - startTime,
        raw: lastResponse?.raw as any,
        turns,
      });

      outerStream.push({
        type: "done",
        delta: "",
        usage: accumulatedUsage,
        finishReason: lastResponse?.finishReason,
        responseId: lastResponse?.responseId,
      });

      outerStream.end(finalAgentResponse);
    } catch (err: any) {
      outerStream.fail(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return outerStream;
}
