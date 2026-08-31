import { BaseProvider } from "../base.ts";
import { OPENROUTER_MODELS } from "./models.ts";
import type {
  ProviderId,
  ModelSpec,
  ProviderRequestOptions,
  ProviderGenerateResult,
  ProviderRawData,
} from "../../types/model.ts";
import type { ProviderContext, Message, ContentPart } from "../../types/message.ts";
import type { ToolCallRecord } from "../../types/tool.ts";
import type { TokenUsage } from "../../types/core.ts";
import { AssistantMessageEventStream } from "../../streaming/event-stream.ts";
import { SSEParser } from "../../streaming/sse-parser.ts";
import { getApiKey } from "../../utils/env.ts";
import { normalizeMediaInput } from "../../utils/media.ts";
import { buildSessionHeaders } from "../../utils/headers.ts";
import { applyAnthropicCacheControl, clampCacheKey, getPromptCacheRetention } from "../../utils/cache.ts";

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
  ): Promise<Record<string, unknown>> {
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
          } else if (part.type !== "thinking") {
            const converted = await this.convertContentPart(part);
            if (converted) {
              contentParts.push(converted);
            }
          }
        }

        if (contentParts.length > 0 || toolCalls.length > 0) {
          messages.push({
            role: msg.role,
            content: contentParts.length === 1 && contentParts[0].type === "text" ? contentParts[0].text : (contentParts.length > 0 ? contentParts : undefined),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
      }
    }

    const payload: Record<string, unknown> = {
      model: modelId,
      messages,
      stream,
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

    // Battle-tested cache: 80-90% hit — first turn marks system+tools+first user, helper handles 4-cap + prompt key
    const retention = options?.cache?.retention;
    const modelSpecForCache = this.getModel(modelId);
    applyAnthropicCacheControl(messages, payload.tools as any, retention, modelSpecForCache);
    const sessionId = options?.sessionId || options?.cache?.sessionId;
    if (sessionId && retention) {
      const ck = clampCacheKey(sessionId);
      if (ck) {
        (payload as any).prompt_cache_key = ck;
        const pcr = getPromptCacheRetention(retention, modelSpecForCache?.capabilities.supportsLongCacheRetention ?? true);
        if (pcr) (payload as any).prompt_cache_retention = pcr;
      }
    }

    // Reasoning / Thinking support
    if (options?.thinking?.enabled !== false && options?.thinking?.level && options.thinking.level !== "none") {
      const level = options.thinking.level;
      const effort =
        level === "minimal" || level === "low"
          ? "low"
          : level === "medium" || level === "dynamic"
          ? "medium"
          : "high";
      payload.reasoning = {
        effort,
      };
    }

    // ServiceTier — bloatfree DX6: only flex|priority (standard is default)
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

  private extractUsage(usageData?: any): TokenUsage {
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

    const headers = buildSessionHeaders(this.id, options?.cache, {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...options?.headers,
    }, options?.sessionId);

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
    const thinking =
      message?.reasoning ||
      message?.reasoning_content ||
      message?.reasoning_text ||
      undefined;

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

    return {
      text,
      thinking,
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

        const headers = buildSessionHeaders(this.id, options?.cache, {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...options?.headers,
        }, options?.sessionId);

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
                // Thinking / Reasoning delta
                const thinkingDelta =
                  delta.reasoning || delta.reasoning_content || delta.reasoning_text;
                if (thinkingDelta) {
                  accumulatedThinking += thinkingDelta;
                  eventStream.push({
                    type: "thinking_delta",
                    thinkingDelta,
                    partialThinking: accumulatedThinking,
                  });
                }

                // Text delta
                if (delta.content) {
                  accumulatedText += delta.content;
                  eventStream.push({
                    type: "text_delta",
                    delta: delta.content,
                    partialText: accumulatedText,
                  });
                }

                // Tool calls delta (S3 fix: don't duplicate name)
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
                        // Some providers send incremental name chunks — append only if incremental
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

        // Flush remaining buffer
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

        const { AgentResponse } = await import("../../types/response.ts");
        const finalAgentResponse = new AgentResponse({
          text: accumulatedText,
          thinking: accumulatedThinking.length > 0 ? accumulatedThinking : undefined,
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
