import type { Provider, ProviderRequestOptions } from "../types/model.ts";
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

function accumulateUsage(target: TokenUsage, source: TokenUsage): void {
  target.inputTokens += source.inputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.totalTokens += source.totalTokens || 0;
  target.cachedTokens = (target.cachedTokens ?? 0) + (source.cachedTokens ?? 0);
  target.cacheReadTokens = (target.cacheReadTokens ?? 0) + (source.cacheReadTokens ?? 0);
  target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + (source.cacheWriteTokens ?? 0);
  target.thinkingTokens = (target.thinkingTokens ?? 0) + (source.thinkingTokens ?? 0);
  if (source.cost || target.cost) {
    target.cost = {
      inputCost: (target.cost?.inputCost ?? 0) + (source.cost?.inputCost ?? 0),
      outputCost: (target.cost?.outputCost ?? 0) + (source.cost?.outputCost ?? 0),
      cacheReadCost: (target.cost?.cacheReadCost ?? 0) + (source.cost?.cacheReadCost ?? 0),
      cacheWriteCost: (target.cost?.cacheWriteCost ?? 0) + (source.cost?.cacheWriteCost ?? 0),
      totalCost: (target.cost?.totalCost ?? 0) + (source.cost?.totalCost ?? 0),
    };
    // Prune zero cost
    if (target.cost.totalCost === 0 && !source.cost?.totalCost) {
      // keep but allow undefined later — leave as is
    }
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
        cachedContentId: (context as any).cachedContentId,
      },
      providerOptions
    );

    finalResult = genResult;

    accumulateUsage(accumulatedUsage, genResult.usage);

    // Record assistant turn in context
    context.addAssistantMessage(
      genResult.text,
      genResult.toolCalls,
      genResult.thinking,
      genResult.thoughtSignature
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
    });

    // Process results and extract any sub-agent execution metadata
    const sanitizedResults: ToolResultRecord[] = [];

    for (const r of results) {
      const { sanitized, metas } = sanitizeToolResult(r);
      if (metas.length > 0) {
        allSubagents.push(...metas);
        for (const s of metas) {
          accumulateUsage(accumulatedUsage, s.usage);
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
            context.messages = context.messages.slice(-keep2);
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
            cachedContentId: (context as any).cachedContentId,
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

        accumulateUsage(accumulatedUsage, turnResponse.usage);

        context.addAssistantMessage(
          turnResponse.text,
          turnResponse.toolCalls,
          turnResponse.thinking,
          turnResponse.thoughtSignature
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
        });

        const sanitizedResults: ToolResultRecord[] = [];

        for (const r of results) {
          const { sanitized, metas } = sanitizeToolResult(r);
          if (metas.length > 0) {
            allSubagents.push(...metas);
            for (const s of metas) {
              accumulateUsage(accumulatedUsage, s.usage);
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
