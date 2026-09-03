import { BaseProvider } from "../base.ts";
import { OPENAI_MODELS } from "./models.ts";
import type {
  ProviderId,
  ModelSpec,
  ProviderRequestOptions,
  ProviderGenerateResult,
  ProviderRawData,
} from "../../types/model.ts";
import type { ProviderContext, ContentPart } from "../../types/message.ts";
import type { ToolCallRecord } from "../../types/tool.ts";
import type { TokenUsage } from "../../types/core.ts";
import { AssistantMessageEventStream } from "../../streaming/event-stream.ts";
import { SSEParser } from "../../streaming/sse-parser.ts";
import { getApiKey, getEnv } from "../../utils/env.ts";
import { normalizeMediaInput } from "../../utils/media.ts";
import { buildSessionHeaders } from "../../utils/headers.ts";
import { clampCacheKey } from "../../utils/cache.ts";

// Gemini-via-OpenAI-compat thought signatures (https://ai.google.dev/gemini-api/docs/thought-signatures).
// Google's OpenAI endpoint returns the signature at
// `tool_calls[].extra_content.google.thought_signature` and REQUIRES it echoed
// back verbatim on the next turn's assistant `tool_calls`, otherwise Turn 2+ with
// tools fails with 400 `Function call is missing a thought_signature`.
function extractGoogleThoughtSignature(obj: any): string | undefined {
  const sig = obj?.extra_content?.google?.thought_signature;
  return typeof sig === "string" && sig.length > 0 ? sig : undefined;
}

export class OpenAIProvider extends BaseProvider {
  readonly id: ProviderId = "openai";
  readonly name: string = "OpenAI";
  readonly models = OPENAI_MODELS;

  protected defaultBaseUrl = "https://api.openai.com/v1";

  protected resolveBaseUrl(modelId?: string, explicit?: string): string {
    if (explicit) return explicit;
    const envUrl = getEnv("OPENAI_BASE_URL") || getEnv("OPENAI_API_BASE");
    if (envUrl) return envUrl;
    return this.defaultBaseUrl;
  }

  protected resolveApiKey(explicit?: string, env?: Record<string, string>): string | undefined {
    if (explicit) return explicit;
    if (env) {
      if (env["OPENAI_BASE_API_KEY"]) return env["OPENAI_BASE_API_KEY"];
      if (env["OPENAI_API_KEY"]) return env["OPENAI_API_KEY"];
    }
    return getEnv("OPENAI_BASE_API_KEY") || getEnv("OPENAI_API_KEY") || getApiKey(this.id, explicit, env);
  }

  protected cleanModelId(model: string | ModelSpec): string {
    const rawId = typeof model === "string" ? model : model.id;
    return rawId.replace(/^(openai|models?)\//, "");
  }

  protected async convertContentPart(part: ContentPart): Promise<Record<string, unknown>> {
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
        let format = norm.mimeType.split("/")[1] || "wav";
        if (format === "x-wav") format = "wav";
        if (format === "mpeg") format = "mp3";
        return {
          type: "input_audio",
          input_audio: { data: norm.base64Data, format },
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

  protected async buildPayload(
    modelId: string,
    context: ProviderContext,
    options?: ProviderRequestOptions,
    stream = false
  ): Promise<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];

    // System message
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
          ...((msg as any).tool_call_id ? { tool_call_id: (msg as any).tool_call_id } : {}),
        });
      } else if (Array.isArray(msg.content)) {
        const toolCalls: any[] = [];
        const contentParts: any[] = [];
        const toolResults: any[] = [];
        let assistantThinking: string | undefined;

        for (const part of msg.content) {
          if (part.type === "tool_call") {
            const entry: Record<string, unknown> = {
              id: part.id,
              type: "function",
              function: {
                name: part.name,
                arguments: typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.arguments || {}),
              },
            };
            // Replay Gemini thought signature verbatim (required for Turn 2+ tool use).
            const sig = (part as { thoughtSignature?: unknown }).thoughtSignature;
            if (typeof sig === "string" && sig.length > 0) {
              entry.extra_content = { google: { thought_signature: sig } };
            }
            toolCalls.push(entry);
          } else if (part.type === "tool_result") {
            toolResults.push(part);
          } else if (part.type === "thinking") {
            assistantThinking = part.thinking;
          } else {
            contentParts.push(await this.convertContentPart(part));
          }
        }

        if (msg.role === "assistant") {
          const textPart = contentParts.find((p) => p.type === "text");
          const assistantMsg: Record<string, unknown> = {
            role: "assistant",
            content: textPart ? (textPart.text as string) : (contentParts.length > 0 ? contentParts : ""),
          };
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls;
          }
          if (assistantThinking) {
            assistantMsg.reasoning_content = assistantThinking;
          }
          messages.push(assistantMsg);
        } else if (msg.role === "tool" || toolResults.length > 0) {
          for (const tr of toolResults) {
            messages.push({
              role: "tool",
              tool_call_id: tr.id,
              content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
            });
          }
        } else {
          messages.push({
            role: msg.role,
            content: contentParts.length === 1 && contentParts[0].type === "text"
              ? contentParts[0].text
              : contentParts,
            ...(msg.name ? { name: msg.name } : {}),
          });
        }
      }
    }

    const payload: Record<string, unknown> = {
      model: modelId,
      messages,
      stream,
    };

    if (stream) {
      payload.stream_options = { include_usage: true };
    }

    // Tools
    if (options?.tools && options.tools.length > 0) {
      payload.tools = options.tools.map((t: any) => ({
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

    // Thinking / Reasoning effort
    const thinkingLevel = options?.thinking?.level;
    const isThinkingDisabled = options?.thinking?.enabled === false || thinkingLevel === "none";

    if (!isThinkingDisabled && thinkingLevel) {
      payload.reasoning_effort = thinkingLevel;
      if (options?.thinking?.budgetTokens && options.thinking.budgetTokens > 0) {
        payload.max_completion_tokens = options.thinking.budgetTokens;
      }
    }

    // Service Tier
    if (options?.serviceTier) {
      payload.service_tier = options.serviceTier;
    }

    // Google OpenAI-compat explicit cache support (per openai-documentation.md)
    if (options?.cache?.cachedContentId) {
      payload.extra_body = {
        google: {
          cached_content: options.cache.cachedContentId,
        },
      };
    }
    if ((options as any)?.extra_body) {
      payload.extra_body = {
        ...((payload.extra_body as any) || {}),
        ...(options as any).extra_body,
      };
    }

    return payload;
  }

  protected extractUsage(usageData?: any): TokenUsage {
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
    const apiKey = this.resolveApiKey(options?.apiKey, options?.env);

    if (!apiKey) {
      throw new Error("OpenAI API key is missing. Set OPENAI_BASE_API_KEY or OPENAI_API_KEY, or pass apiKey in options.");
    }

    const baseUrl = this.resolveBaseUrl(modelId, options?.baseUrl);
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
      throw new Error(`OpenAI API error (${response.status} ${response.statusText}): ${t}`);
    }

    raw.response = {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseJson,
    };

    if (!response.ok) {
      throw new Error(
        `OpenAI API error (${response.status} ${response.statusText}): ${JSON.stringify(responseJson)}`
      );
    }

    const choice = responseJson.choices?.[0];
    const message = choice?.message;
    const text = message?.content || "";

    // Universal reasoning / thinking extraction (OpenAI o1/o3, DeepSeek, Groq, Ollama, vLLM, etc.)
    let thinking: string | undefined;
    if (typeof message?.reasoning === "string" && message.reasoning) thinking = message.reasoning;
    else if (typeof message?.reasoning_content === "string" && message.reasoning_content) thinking = message.reasoning_content;
    else if (typeof message?.reasoning_text === "string" && message.reasoning_text) thinking = message.reasoning_text;
    else if (typeof (message as any)?.thinking === "string" && (message as any).thinking) thinking = (message as any).thinking;
    else if (typeof (message as any)?.thought === "string" && (message as any).thought) thinking = (message as any).thought;

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
          ...(extractGoogleThoughtSignature(tc)
            ? { thoughtSignature: extractGoogleThoughtSignature(tc) }
            : {}),
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
        const apiKey = this.resolveApiKey(options?.apiKey, options?.env);
        if (!apiKey) {
          throw new Error("OpenAI API key is missing. Set OPENAI_BASE_API_KEY or OPENAI_API_KEY, or pass apiKey in options.");
        }

        const baseUrl = this.resolveBaseUrl(modelId, options?.baseUrl);
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
          throw new Error(`OpenAI stream error (${response.status} ${response.statusText}): ${errBody}`);
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
        const toolCallsMap: Map<number, { id: string; name: string; args: string; thoughtSignature?: string }> = new Map();
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
                // Universal reasoning / thinking delta
                let thinkingDelta: string | undefined;
                if (typeof delta.reasoning === "string" && delta.reasoning) thinkingDelta = delta.reasoning;
                else if (typeof delta.reasoning_content === "string" && delta.reasoning_content) thinkingDelta = delta.reasoning_content;
                else if (typeof delta.reasoning_text === "string" && delta.reasoning_text) thinkingDelta = delta.reasoning_text;
                else if (typeof (delta as any).thinking === "string" && (delta as any).thinking) thinkingDelta = (delta as any).thinking;
                else if (typeof (delta as any).thought === "string" && (delta as any).thought) thinkingDelta = (delta as any).thought;

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

                // Tool calls delta (retain Gemini thought_signature when present)
                if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const sig = extractGoogleThoughtSignature(tc);
                    if (!toolCallsMap.has(idx)) {
                      toolCallsMap.set(idx, {
                        id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
                        name: tc.function?.name || "",
                        args: tc.function?.arguments || "",
                        ...(sig ? { thoughtSignature: sig } : {}),
                      });
                    } else {
                      const entry = toolCallsMap.get(idx)!;
                      if (tc.id) entry.id = tc.id;
                      if (tc.function?.name && !entry.name) entry.name = tc.function.name;
                      if (tc.function?.arguments) entry.args += tc.function.arguments;
                      if (sig && !entry.thoughtSignature) entry.thoughtSignature = sig;
                    }
                  }
                }
              }
            } catch {}
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

        const finalToolCalls: ToolCallRecord[] = [];
        for (const entry of toolCallsMap.values()) {
          let parsedArgs = {};
          try {
            parsedArgs = entry.args ? JSON.parse(entry.args) : {};
          } catch {
            parsedArgs = { raw: entry.args };
          }
          const record: ToolCallRecord = {
            id: entry.id,
            name: entry.name,
            arguments: parsedArgs,
            rawArguments: entry.args,
            ...(entry.thoughtSignature ? { thoughtSignature: entry.thoughtSignature } : {}),
          };
          finalToolCalls.push(record);
          eventStream.push({
            type: "tool_call_complete",
            toolCall: record,
          });
        }

        const { AgentResponse } = await import("../../types/response.ts");
        const finalAgentResponse = new AgentResponse({
          text: accumulatedText,
          thinking: accumulatedThinking.length > 0 ? accumulatedThinking : undefined,
          toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
          usage: finalUsage,
          finishReason: finalFinishReason,
          responseId: finalResponseId,
          model: modelId,
          provider: this.id,
          raw,
          durationMs: Date.now() - startTime,
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
