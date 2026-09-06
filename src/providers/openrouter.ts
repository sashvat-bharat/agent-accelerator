import { BaseProvider } from "./base.ts";
import type {
  ProviderId,
  ModelSpec,
  ProviderRequestOptions,
  ProviderGenerateResult,
  ProviderRawData,
} from "../types/model.ts";
import type { ProviderContext, ContentPart } from "../types/message.ts";
import type { ToolCallRecord } from "../types/tool.ts";
import type { TokenUsage } from "../types/core.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { SSEParser } from "../streaming/sse-parser.ts";
import { getApiKey } from "../utils/env.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import { buildSessionHeaders } from "../utils/headers.ts";
import { applyAnthropicCacheControl, clampCacheKey, getPromptCacheRetention } from "../utils/cache.ts";
import { getModelsForProvider } from "../models/catalog.ts";

// ============================================================================
// OpenRouter Provider Types
// ============================================================================

export interface OpenRouterProviderRouting {
  order?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
}

export interface OpenRouterReasoning {
  effort?: "none" | "low" | "medium" | "high";
  enabled?: boolean;
  max_tokens?: number;
}

export interface OpenRouterParameters {
  temperature?: number;
  max_tokens?: number;
  transforms?: string[];
  models?: string[];
  route?: "fallback";
  provider?: OpenRouterProviderRouting;
}

export interface OpenRouterChatRequest {
  model: string;
  messages: any[];
  tools?: any[];
  tool_choice?: any;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  reasoning?: OpenRouterReasoning;
  include_reasoning?: boolean;
  prompt_cache_key?: string;
  prompt_cache_retention?: string;
  session_id?: string;
  provider?: OpenRouterProviderRouting;
}

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  cached_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  total_cost?: number;
}

export interface OpenRouterResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content?: string;
      tool_calls?: any[];
      reasoning?: string;
      reasoning_content?: string;
      reasoning_text?: string;
      thinking?: string;
      thought?: string;
    };
    finish_reason: string;
  }>;
  usage?: OpenRouterUsage;
}

// ============================================================================
// OpenRouter Models Fallback & Catalog dynamic view
// ============================================================================

const FALLBACK_MODELS: ModelSpec[] = [
  {
    id: "anthropic/claude-3.7-sonnet",
    provider: "openrouter",
    name: "Claude 3.7 Sonnet (OpenRouter)",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    limit: { context: 200000, output: 64000 },
    cost: { input: 3.0, output: 15.0, cache_read: 0.3 },
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: {
      supportsThinking: true,
      supportsThinkingLevel: true,
      supportsImplicitCaching: true,
      supportsExplicitCaching: false,
      supportsLongCacheRetention: true,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text", "image"],
    },
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0, cacheReadPerMillion: 0.3 },
  },
  {
    id: "openai/gpt-4o",
    provider: "openrouter",
    name: "GPT-4o (OpenRouter)",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    limit: { context: 128000, output: 16384 },
    cost: { input: 2.5, output: 10.0, cache_read: 1.25 },
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: {
      supportsThinking: false,
      supportsThinkingLevel: false,
      supportsImplicitCaching: true,
      supportsExplicitCaching: false,
      supportsLongCacheRetention: false,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text", "image"],
    },
    pricing: { inputPerMillion: 2.5, outputPerMillion: 10.0, cacheReadPerMillion: 1.25 },
  },
];

const dynamicOpenRouterModels = getModelsForProvider("openrouter");
export const OPENROUTER_MODELS: ModelSpec[] =
  dynamicOpenRouterModels.length > 2 ? dynamicOpenRouterModels : FALLBACK_MODELS;

// ============================================================================
// OpenRouter Provider Implementation
// ============================================================================

export class OpenRouterProvider extends BaseProvider {
  readonly id: ProviderId = "openrouter";
  readonly name = "OpenRouter";
  readonly models = OPENROUTER_MODELS;

  private defaultBaseUrl = "https://openrouter.ai/api/v1";

  private cleanModelId(model: string | ModelSpec): string {
    const rawId = typeof model === "string" ? model : model.id;
    return rawId.replace(/^openrouter\//, "");
  }

  private async convertContentPart(part: ContentPart): Promise<Record<string, unknown>> {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image": {
        const norm = await normalizeMediaInput(part.image, part.mimeType);
        return {
          type: "image_url",
          image_url: { url: norm.dataUrl },
        };
      }
      case "audio": {
        const norm = await normalizeMediaInput(part.audio, part.mimeType);
        return {
          type: "input_audio",
          input_audio: { data: norm.base64Data, format: norm.mimeType.split("/")[1] || "mp3" },
        };
      }
      case "video": {
        const norm = await normalizeMediaInput(part.video, part.mimeType);
        return {
          type: "video_url",
          video_url: { url: norm.dataUrl },
        };
      }
      default:
        return { type: "text", text: "" };
    }
  }

  private async buildPayload(
    modelId: string,
    context: ProviderContext,
    options?: ProviderRequestOptions,
    stream = false
  ): Promise<OpenRouterChatRequest> {
    const messages: Array<Record<string, unknown>> = [];

    if (context.systemPrompt) {
      messages.push({
        role: "system",
        content: context.systemPrompt,
      });
    }

    for (const msg of context.messages) {
      if (typeof msg.content === "string") {
        messages.push({
          role: msg.role === "tool" ? "tool" : msg.role,
          content: msg.content,
          ...(msg.name ? { name: msg.name } : {}),
        });
      } else if (Array.isArray(msg.content)) {
        const toolCalls: any[] = [];
        const contentParts: any[] = [];
        let assistantThinking: string | undefined;

        for (const part of msg.content) {
          if (part.type === "tool_call") {
            toolCalls.push({
              id: part.id,
              type: "function",
              function: {
                name: part.name,
                arguments: typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.arguments),
              },
            });
          } else if (part.type === "tool_result") {
            messages.push({
              role: "tool",
              tool_call_id: part.id,
              name: part.name,
              content: typeof part.result === "string" ? part.result : JSON.stringify(part.result),
            });
          } else if (part.type === "text" && part.text) {
            contentParts.push({ type: "text", text: part.text });
          } else if (part.type === "thinking" && part.thinking) {
            assistantThinking = (assistantThinking ? assistantThinking + "\n" : "") + part.thinking;
          } else if (part.type !== "thinking") {
            const converted = await this.convertContentPart(part);
            if (converted) {
              contentParts.push(converted);
            }
          }
        }

        if (contentParts.length > 0 || toolCalls.length > 0 || assistantThinking) {
          const textOnly = contentParts.length === 1 && contentParts[0].type === "text" ? contentParts[0].text : (contentParts.length > 0 ? contentParts : undefined);
          messages.push({
            role: msg.role,
            content: textOnly ?? "",
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            ...(assistantThinking ? { reasoning_content: assistantThinking } : {}),
          });
        }
      }
    }

    const payload: OpenRouterChatRequest = {
      model: modelId,
      messages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };

    // Tools
    if (options?.tools && options.tools.length > 0) {
      payload.tools = options.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          ...(t.strict !== undefined ? { strict: t.strict } : {}),
        },
      }));
      if (options.toolChoice) {
        payload.tool_choice = options.toolChoice;
      }
    }

    // Prompt cache control for high hit rates
    const retention = options?.cache?.retention;
    const modelSpecForCache = this.getModel(modelId);
    const isAnthropicModel =
      modelId.startsWith("anthropic/") ||
      modelId.includes("claude");
    if (isAnthropicModel) {
      applyAnthropicCacheControl(messages, payload.tools as any, retention, modelSpecForCache);
    }
    const sessionId = options?.sessionId || options?.cache?.sessionId;
    if (sessionId) {
      const ck = clampCacheKey(sessionId);
      if (ck) {
        payload.session_id = ck;
        if (retention) {
          payload.prompt_cache_key = ck;
          const pcr = getPromptCacheRetention(retention, modelSpecForCache?.capabilities.supportsLongCacheRetention ?? true);
          if (pcr) payload.prompt_cache_retention = pcr;
        }
      }
    }

    // Reasoning / Thinking options
    const level = options?.thinking?.level;
    const isDisabled = options?.thinking?.enabled === false || (level as any) === "none";
    if (isDisabled) {
      payload.reasoning = { effort: "none" };
      return payload;
    } else if (options?.thinking?.enabled !== false && level) {
      const spec = this.getModel(modelId);
      const caps = spec?.capabilities;
      const hasToggle = !!caps?.supportsReasoningToggle;
      const hasEffort = !!caps?.supportsReasoningEffort;
      const effort =
        level === "minimal" || level === "low"
          ? "low"
          : level === "medium" || level === "dynamic"
          ? "medium"
          : "high";
      if (hasToggle && !hasEffort) {
        payload.reasoning = { enabled: true };
        payload.include_reasoning = true;
      } else if (hasEffort || !spec) {
        payload.reasoning = { effort };
      } else if (caps?.supportsThinking) {
        payload.reasoning = { effort };
      }
    }

    // ServiceTier provider routing
    if (options?.serviceTier) {
      payload.provider = {
        order:
          options.serviceTier === "flex"
            ? ["Together", "DeepInfra", "Fireworks", "Lepton"]
            : options.serviceTier === "priority"
            ? ["Anthropic", "OpenAI", "Google"]
            : undefined,
        allow_fallbacks: true,
      };
    }

    return payload;
  }

  private extractUsage(usageData?: OpenRouterUsage): TokenUsage {
    if (!usageData) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
    const input = usageData.prompt_tokens ?? 0;
    const output = usageData.completion_tokens ?? 0;
    const total = usageData.total_tokens ?? input + output;
    const cached =
      usageData.prompt_tokens_details?.cached_tokens ??
      usageData.cached_tokens ??
      0;
    const cacheWrite =
      usageData.prompt_tokens_details?.cache_write_tokens ?? usageData.cache_write_tokens ?? 0;
    const thinking =
      usageData.completion_tokens_details?.reasoning_tokens ??
      usageData.reasoning_tokens ??
      0;

    const cost = usageData.total_cost !== undefined ? { totalCost: usageData.total_cost } : undefined;

    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
      cachedTokens: cached,
      cacheReadTokens: cached,
      cacheWriteTokens: cacheWrite,
      thinkingTokens: thinking,
      cost,
    };
  }

  async generate(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): Promise<ProviderGenerateResult> {
    const startTime = Date.now();
    const modelId = this.cleanModelId(model);
    const apiKey = getApiKey(this.id, options?.apiKey, options?.env);

    if (!apiKey) {
      throw new Error("OpenRouter API key is missing. Set OPENROUTER_API_KEY or pass apiKey in options.");
    }

    const baseUrl = options?.baseUrl || this.defaultBaseUrl;
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const payload = await this.buildPayload(modelId, context, options, false);

    const headers = buildSessionHeaders(
      this.id,
      options?.cache,
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...options?.headers,
      },
      options?.sessionId
    );

    const raw: ProviderRawData = {
      request: {
        url,
        method: "POST",
        headers: { ...headers, Authorization: "Bearer [REDACTED]" },
        body: payload,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: options?.signal,
    });

    let responseJson: any;
    try {
      responseJson = await response.json();
    } catch {
      const t = await response.text().catch(() => "");
      throw new Error(`OpenRouter API error (${response.status} ${response.statusText}): ${t}`);
    }

    raw.response = {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseJson,
    };

    if (!response.ok) {
      throw new Error(
        `OpenRouter API error (${response.status} ${response.statusText}): ${JSON.stringify(responseJson)}`
      );
    }

    const choice = responseJson.choices?.[0];
    const message = choice?.message;
    const text = message?.content || "";

    let thinking: string | undefined;
    if (typeof message?.reasoning === "string" && message.reasoning) thinking = message.reasoning;
    else if (typeof message?.reasoning_content === "string" && message.reasoning_content) thinking = message.reasoning_content;
    else if (typeof message?.reasoning_text === "string" && message.reasoning_text) thinking = message.reasoning_text;
    else if (typeof (message as any)?.thinking === "string" && (message as any).thinking) thinking = (message as any).thinking;
    else if (typeof (message as any)?.thought === "string" && (message as any).thought) thinking = (message as any).thought;
    else if (Array.isArray((message as any)?.reasoning_details)) {
      const parts = (message as any).reasoning_details.map((r: any) => r.text || r.content || "").filter(Boolean);
      if (parts.length) thinking = parts.join("");
    }

    const toolCalls: ToolCallRecord[] = [];
    if (message?.tool_calls && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        let args = {};
        try {
          args = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {};
        } catch {
          args = { raw: tc.function?.arguments };
        }

        toolCalls.push({
          id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
          name: tc.function?.name || "",
          arguments: args,
          rawArguments: tc.function?.arguments,
        });
      }
    }

    const usage = this.extractUsage(responseJson.usage);

    let finalText = text;
    let finalThinking = thinking;
    if (!finalText && toolCalls.length === 0 && thinking) {
      if (thinking.includes("</think>")) {
        const parts = thinking.split(/<\/(?:think|thought)>/i);
        finalThinking = parts[0]!.replace(/<(?:think|thought)>/i, "").trim() || undefined;
        finalText = parts.slice(1).join("").trim();
      } else {
        finalText = thinking;
        finalThinking = undefined;
      }
    } else if (finalText && finalText.includes("<think>") && finalText.includes("</think>")) {
      const parts = finalText.split(/<\/(?:think|thought)>/i);
      finalThinking = (finalThinking ? finalThinking + "\n" : "") + parts[0]!.replace(/<(?:think|thought)>/i, "").trim();
      finalText = parts.slice(1).join("").trim();
    }

    return {
      text: finalText,
      thinking: finalThinking,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      finishReason: choice?.finish_reason || "stop",
      responseId: responseJson.id,
      model: modelId,
      provider: this.id,
      raw,
      durationMs: Date.now() - startTime,
    };
  }

  stream(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): AssistantMessageEventStream {
    const eventStream = new AssistantMessageEventStream();
    const startTime = Date.now();
    const modelId = this.cleanModelId(model);

    (async () => {
      try {
        const apiKey = getApiKey(this.id, options?.apiKey, options?.env);
        if (!apiKey) {
          throw new Error("OpenRouter API key is missing. Set OPENROUTER_API_KEY or pass apiKey in options.");
        }

        const baseUrl = options?.baseUrl || this.defaultBaseUrl;
        const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
        const payload = await this.buildPayload(modelId, context, options, true);

        const headers = buildSessionHeaders(
          this.id,
          options?.cache,
          {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...options?.headers,
          },
          options?.sessionId
        );

        const raw: ProviderRawData = {
          request: {
            url,
            method: "POST",
            headers: { ...headers, Authorization: "Bearer [REDACTED]" },
            body: payload,
          },
        };

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: options?.signal,
        });

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`OpenRouter stream error (${response.status} ${response.statusText}): ${errBody}`);
        }

        if (!response.body) {
          throw new Error("Response body is empty for stream");
        }

        eventStream.push({ type: "start", raw });

        const parser = new SSEParser();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let accumulatedText = "";
        let accumulatedThinking = "";
        let reasoningSwitchedToContent = false;
        let rollingReasoningTail = "";
        let inContentThinking = false;
        const toolCallsMap: Map<number, { id: string; name: string; args: string }> = new Map();
        let finalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        let finalFinishReason = "stop";
        let finalResponseId: string | undefined;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunkStr = decoder.decode(value, { stream: true });
          const messages = parser.feed(chunkStr);

          for (const msg of messages) {
            if (!msg.data || msg.data === "[DONE]") continue;

            try {
              const chunkJson = JSON.parse(msg.data);
              if (chunkJson.id) {
                finalResponseId = chunkJson.id;
              }

              if (chunkJson.usage) {
                finalUsage = this.extractUsage(chunkJson.usage);
                eventStream.push({ type: "usage", usage: finalUsage });
              }

              const choice = chunkJson.choices?.[0];
              if (choice?.finish_reason) {
                finalFinishReason = choice.finish_reason;
              }

              const delta = choice?.delta;
              if (delta) {
                let thinkingDelta: string | undefined;
                if (typeof delta.reasoning === "string" && delta.reasoning) thinkingDelta = delta.reasoning;
                else if (typeof delta.reasoning_content === "string" && delta.reasoning_content) thinkingDelta = delta.reasoning_content;
                else if (typeof delta.reasoning_text === "string" && delta.reasoning_text) thinkingDelta = delta.reasoning_text;
                else if (typeof (delta as any).thinking === "string" && (delta as any).thinking) thinkingDelta = (delta as any).thinking;
                else if (typeof (delta as any).thought === "string" && (delta as any).thought) thinkingDelta = (delta as any).thought;
                else if (typeof (delta as any).thinking_content === "string" && (delta as any).thinking_content) thinkingDelta = (delta as any).thinking_content;
                else if (Array.isArray((delta as any).reasoning_details)) {
                  const parts = (delta as any).reasoning_details.map((r: any) => r.text || r.content || r.data || "").filter(Boolean);
                  if (parts.length) thinkingDelta = parts.join("");
                }

                if (thinkingDelta) {
                  if (reasoningSwitchedToContent) {
                    accumulatedText += thinkingDelta;
                    eventStream.push({
                      type: "text_delta",
                      delta: thinkingDelta,
                      partialText: accumulatedText,
                    });
                  } else {
                    const window = rollingReasoningTail + thinkingDelta;
                    const thinkCloseMatch = window.match(/<\/(?:think|thought)>/i);

                    if (thinkCloseMatch && thinkCloseMatch.index !== undefined) {
                      const closeIndex = thinkCloseMatch.index;
                      const closeEnd = closeIndex + thinkCloseMatch[0].length;
                      const tailLen = rollingReasoningTail.length;

                      const deltaBeforeTag = thinkingDelta.slice(0, Math.max(0, closeIndex - tailLen));
                      if (deltaBeforeTag) {
                        accumulatedThinking += deltaBeforeTag;
                        eventStream.push({
                          type: "thinking_delta",
                          thinkingDelta: deltaBeforeTag,
                          partialThinking: accumulatedThinking,
                        });
                      }

                      reasoningSwitchedToContent = true;

                      const deltaAfterTag = thinkingDelta.slice(Math.max(0, closeEnd - tailLen));
                      if (deltaAfterTag) {
                        accumulatedText += deltaAfterTag;
                        eventStream.push({
                          type: "text_delta",
                          delta: deltaAfterTag,
                          partialText: accumulatedText,
                        });
                      }
                    } else if (
                      accumulatedText.length === 0 &&
                      ((accumulatedThinking.length === 0 && thinkingDelta.trimStart().match(/^(?:#{1,4}\s+|\*\*(?:Final Answer|Conclusion|Executive Summary|Executive Report|Report|Summary)\*\*)/i)) ||
                        window.match(/(\n\s*(?:#{1,4}\s+|\*\*(?:Final Answer|Conclusion|Executive Summary|Executive Report|Report|Summary)\*\*))/i))
                    ) {
                      const headerMatch = window.match(/(\n\s*(?:#{1,4}\s+|\*\*(?:Final Answer|Conclusion|Executive Summary|Executive Report|Report|Summary)\*\*))/i);
                      if (headerMatch && headerMatch.index !== undefined) {
                        const matchStart = headerMatch.index;
                        const firstSymbol = headerMatch[0].search(/[#*]/);
                        const contentStartIndexInWindow = matchStart + (firstSymbol >= 0 ? firstSymbol : 0);
                        const tailLen = rollingReasoningTail.length;

                        const splitBeforeInDelta = Math.min(thinkingDelta.length, Math.max(0, matchStart - tailLen));
                        const splitAfterInDelta = Math.min(thinkingDelta.length, Math.max(0, contentStartIndexInWindow - tailLen));

                        const before = thinkingDelta.slice(0, splitBeforeInDelta);
                        const after = thinkingDelta.slice(splitAfterInDelta);

                        if (before) {
                          accumulatedThinking += before;
                          eventStream.push({
                            type: "thinking_delta",
                            thinkingDelta: before,
                            partialThinking: accumulatedThinking,
                          });
                        }
                        reasoningSwitchedToContent = true;
                        if (after) {
                          accumulatedText += after;
                          eventStream.push({
                            type: "text_delta",
                            delta: after,
                            partialText: accumulatedText,
                          });
                        }
                      } else {
                        reasoningSwitchedToContent = true;
                        accumulatedText += thinkingDelta;
                        eventStream.push({
                          type: "text_delta",
                          delta: thinkingDelta,
                          partialText: accumulatedText,
                        });
                      }
                    } else {
                      accumulatedThinking += thinkingDelta;
                      eventStream.push({
                        type: "thinking_delta",
                        thinkingDelta,
                        partialThinking: accumulatedThinking,
                      });
                      rollingReasoningTail = (rollingReasoningTail + thinkingDelta).slice(-64);
                    }
                  }
                }

                if (delta.content) {
                  let textChunk = delta.content;
                  if (!inContentThinking && textChunk.includes("<think>")) {
                    const [before, after] = textChunk.split("<think>");
                    if (before) {
                      accumulatedText += before;
                      eventStream.push({ type: "text_delta", delta: before, partialText: accumulatedText });
                    }
                    inContentThinking = true;
                    textChunk = after || "";
                  }
                  if (inContentThinking) {
                    if (textChunk.includes("</think>")) {
                      const [thought, after] = textChunk.split("</think>");
                      if (thought) {
                        accumulatedThinking += thought;
                        eventStream.push({ type: "thinking_delta", thinkingDelta: thought, partialThinking: accumulatedThinking });
                      }
                      inContentThinking = false;
                      if (after) {
                        accumulatedText += after;
                        eventStream.push({ type: "text_delta", delta: after, partialText: accumulatedText });
                      }
                    } else if (textChunk) {
                      accumulatedThinking += textChunk;
                      eventStream.push({ type: "thinking_delta", thinkingDelta: textChunk, partialThinking: accumulatedThinking });
                    }
                  } else if (textChunk) {
                    accumulatedText += textChunk;
                    eventStream.push({
                      type: "text_delta",
                      delta: textChunk,
                      partialText: accumulatedText,
                    });
                  }
                }

                if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallsMap.has(idx)) {
                      toolCallsMap.set(idx, {
                        id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
                        name: tc.function?.name || "",
                        args: tc.function?.arguments || "",
                      });
                    } else {
                      const entry = toolCallsMap.get(idx)!;
                      if (tc.id) entry.id = tc.id;
                      if (tc.function?.name && !entry.name) entry.name = tc.function.name;
                      else if (tc.function?.name && entry.name !== tc.function.name) {
                        if (tc.function.name.length < entry.name.length) {
                          // ignore duplicate
                        } else if (!entry.name.includes(tc.function.name)) {
                          entry.name += tc.function.name;
                        }
                      }
                      if (tc.function?.arguments) entry.args += tc.function.arguments;
                    }
                  }
                }
              }
            } catch {
              // Ignore partial JSON parse errors
            }
          }
        }

        for (const msg of parser.flush()) {
          if (!msg.data || msg.data === "[DONE]") continue;
          try {
            const chunkJson = JSON.parse(msg.data);
            if (chunkJson.usage) {
              finalUsage = this.extractUsage(chunkJson.usage);
            }
          } catch {}
        }

        const toolCalls: ToolCallRecord[] = [];
        for (const entry of toolCallsMap.values()) {
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(entry.args);
          } catch {
            parsedArgs = { raw: entry.args };
          }
          const record: ToolCallRecord = {
            id: entry.id,
            name: entry.name,
            arguments: parsedArgs,
            rawArguments: entry.args,
          };
          toolCalls.push(record);
          eventStream.push({
            type: "tool_call_complete",
            toolCall: record,
          });
        }

        const { AgentResponse } = await import("../types/response.ts");
        let finalText = accumulatedText;
        let finalThinking = accumulatedThinking.length > 0 ? accumulatedThinking : undefined;
        if (!finalText && toolCalls.length === 0 && accumulatedThinking) {
          if (accumulatedThinking.includes("</think>")) {
            const parts = accumulatedThinking.split(/<\/(?:think|thought)>/i);
            finalThinking = parts[0]!.replace(/<(?:think|thought)>/i, "").trim() || undefined;
            finalText = parts.slice(1).join("").trim();
          } else {
            finalText = accumulatedThinking;
            finalThinking = undefined;
          }
        }
        const finalAgentResponse = new AgentResponse({
          text: finalText,
          thinking: finalThinking,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: finalUsage,
          responseId: finalResponseId,
          finishReason: finalFinishReason,
          durationMs: Date.now() - startTime,
          model: modelId,
          provider: this.id,
          raw,
        });

        eventStream.push({
          type: "done",
          delta: "",
          usage: finalUsage,
          finishReason: finalFinishReason,
          responseId: finalResponseId,
        });

        eventStream.end(finalAgentResponse);
      } catch (err: any) {
        eventStream.fail(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return eventStream;
  }
}
