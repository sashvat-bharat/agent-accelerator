import { BaseProvider } from "../base.ts";
import { GOOGLE_MODELS } from "./models.ts";
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
import { createExplicitCache } from "./cache.ts";

// Helpers inspired by agent-accel google-shared.ts (SDK-light)
const base64SigPattern = /^[A-Za-z0-9+/]+={0,2}$/;
function isValidThoughtSignature(sig?: string): boolean {
  if (!sig) return false;
  if (sig.length % 4 !== 0) return false;
  return base64SigPattern.test(sig);
}
function retainThoughtSignature(existing?: string, incoming?: string): string | undefined {
  if (typeof incoming === "string" && incoming.length > 0) return incoming;
  return existing;
}

export class GoogleAIStudioProvider extends BaseProvider {
  readonly id: ProviderId = "google";
  readonly name = "Google AI Studio";
  readonly models = GOOGLE_MODELS;

  private defaultBaseUrl = "https://generativelanguage.googleapis.com/v1beta";

  private cleanModelId(model: string | ModelSpec): string {
    const rawId = typeof model === "string" ? model : model.id;
    return rawId.replace(/^(google\/|models\/)/, "");
  }

  private async convertContentPart(part: ContentPart): Promise<Record<string, unknown> | null> {
    switch (part.type) {
      case "text":
        if (!part.text && !part.thoughtSignature) return null;
        // Validate signature (keep only valid base64)
        const sig = part.thoughtSignature && isValidThoughtSignature(part.thoughtSignature) ? part.thoughtSignature : undefined;
        if (part.text) {
          return { text: part.text, ...(sig ? { thoughtSignature: sig } : {}) };
        }
        return sig ? { thoughtSignature: sig } : null;
      case "thinking":
        if (!part.thinking && !part.thoughtSignature) return null;
        const tSig = part.thoughtSignature && isValidThoughtSignature(part.thoughtSignature) ? part.thoughtSignature : undefined;
        return {
          thought: true,
          ...(part.thinking ? { text: part.thinking } : {}),
          ...(tSig ? { thoughtSignature: tSig } : {}),
        };
      case "image": {
        const norm = await normalizeMediaInput(part.image, part.mimeType);
        return {
          inlineData: {
            mimeType: norm.mimeType,
            data: norm.base64Data,
          },
        };
      }
      case "audio": {
        const norm = await normalizeMediaInput(part.audio, part.mimeType);
        return {
          inlineData: {
            mimeType: norm.mimeType,
            data: norm.base64Data,
          },
        };
      }
      case "video": {
        const norm = await normalizeMediaInput(part.video, part.mimeType);
        return {
          inlineData: {
            mimeType: norm.mimeType,
            data: norm.base64Data,
          },
        };
      }
      case "tool_call": {
        const ts = part.thoughtSignature && isValidThoughtSignature(part.thoughtSignature) ? part.thoughtSignature : undefined;
        return {
          functionCall: {
            name: part.name,
            args: part.arguments || {},
            ...(part.id ? { id: part.id } : {}),
          },
          ...(ts ? { thoughtSignature: ts } : {}),
        };
      }
      case "tool_result": {
        // Handle image tool results: if result contains image data URL, extract
        // For now, handle string output; multimodal handled in convertMessages not here.
        // Keep SDK-light: just text output
        return {
          functionResponse: {
            name: part.name,
            response: part.isError
              ? { error: typeof part.result === "string" ? part.result : JSON.stringify(part.result) }
              : { output: typeof part.result === "string" ? part.result : (typeof part.result === "object" && part.result !== null ? part.result : String(part.result)) },
            ...(part.id ? { id: part.id } : {}),
          },
        };
      }
      default:
        return null;
    }
  }

  private async buildPayload(
    modelId: string,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): Promise<Record<string, unknown>> {
    const contents: Array<Record<string, unknown>> = [];

    for (const msg of context.messages) {
      const parts: Array<Record<string, unknown>> = [];

      if (typeof msg.content === "string") {
        if (msg.content) {
          parts.push({ text: msg.content });
        }
      } else if (Array.isArray(msg.content)) {
        // C10: parallelize media conversions instead of serial await
        const convertedParts = await Promise.all(msg.content.map((p) => this.convertContentPart(p)));
        for (const converted of convertedParts) {
          if (converted && Object.keys(converted).length > 0) {
            parts.push(converted);
          }
        }
      }

      // Preserve Gemini thought signature on message if present (validated)
      if (msg.thoughtSignature && isValidThoughtSignature(msg.thoughtSignature) && parts.length > 0 && !(parts[0] as any)?.thoughtSignature) {
        parts[0] = { ...(parts[0] as any), thoughtSignature: msg.thoughtSignature };
      }

      if (parts.length > 0) {
        if (msg.role === "tool") {
          const lastContent = contents[contents.length - 1];
          if (lastContent?.role === "user" && (lastContent.parts as any[])?.some((p: any) => p.functionResponse)) {
            (lastContent.parts as any[]).push(...parts);
          } else {
            contents.push({ role: "user", parts });
          }
        } else {
          const role = msg.role === "assistant" ? "model" : "user";
          contents.push({ role, parts });
        }
      }
    }

    const payload: Record<string, unknown> = {
      contents,
    };

    // System instruction
    if (context.systemPrompt) {
      payload.systemInstruction = {
        parts: [{ text: context.systemPrompt }],
      };
    }

    // Tools — Google uses OpenAPI 3.0 Schema, does NOT support additionalProperties/$schema (strip for Google only)
    if (options?.tools && options.tools.length > 0) {
      const stripForGoogle = (schema: any): any => {
        if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
          if (Array.isArray(schema)) return schema.map(stripForGoogle);
          return schema;
        }
        const { $schema, $defs, definitions, additionalProperties, ...rest } = schema as any;
        const out: any = { ...rest };
        if (out.properties && typeof out.properties === "object") {
          const cleaned: any = {};
          for (const [k, v] of Object.entries(out.properties)) cleaned[k] = stripForGoogle(v);
          out.properties = cleaned;
        }
        if (out.items) out.items = stripForGoogle(out.items);
        if (out.anyOf) out.anyOf = (out.anyOf as any[]).map(stripForGoogle);
        if (out.oneOf) out.oneOf = (out.oneOf as any[]).map(stripForGoogle);
        if (out.allOf) out.allOf = (out.allOf as any[]).map(stripForGoogle);
        return out;
      };
      // Agent-accel uses parametersJsonSchema for Google (full JSON schema), not parameters (OpenAPI) — keep stable for implicit cache
      payload.tools = [
        {
          functionDeclarations: options.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.parameters ? stripForGoogle(t.parameters) : { type: "object", properties: {} },
          })),
        },
      ];

      if (options.toolChoice) {
        if (typeof options.toolChoice === "string") {
          const modeMap: Record<string, string> = {
            auto: "AUTO",
            none: "NONE",
            required: "ANY",
          };
          payload.toolConfig = {
            functionCallingConfig: {
              mode: modeMap[options.toolChoice] || options.toolChoice,
            },
          };
        } else if (typeof options.toolChoice === "object" && (options.toolChoice as any).name) {
          payload.toolConfig = {
            functionCallingConfig: {
              mode: "ANY",
              allowedFunctionNames: [(options.toolChoice as any).name],
            },
          };
        }
      }
    }

    // Cache strategy: explicit iff user set cache.retention, else implicit (free, no storage cost)
    // This fixes downgrade: previously always implicit, now respects cache: {retention:"long"}
    let cachedContentId: string | undefined = (context as any).cachedContentId || context.cachedContentId || options?.cache?.cachedContentId;
    const wantsExplicit = !!options?.cache?.retention; // explicit only when retention is set
    if (wantsExplicit && !cachedContentId) {
      // Auto-create explicit cache for this session (once) — system+tools stable prefix
      try {
        const ttlSeconds = options?.cache?.ttlSeconds ?? (options?.cache?.retention === "short" ? 300 : options?.cache?.retention === "medium" ? 3600 : 43200);
        const apiKeyForCache = getApiKey(this.id, options?.apiKey, options?.env);
        if (apiKeyForCache && (context.systemPrompt || (payload.tools && (payload.tools as any[]).length > 0))) {
          const baseUrlForCache = options?.baseUrl || this.defaultBaseUrl;
          let modelName = modelId;
          if (!modelName.startsWith("models/")) modelName = `models/${modelName}`;
          // Build minimal cached content: system + tools (stable prefix). Contents empty — history will be sent via contents+cachedContent
          const cached = await createExplicitCache({
            model: modelName,
            systemInstruction: context.systemPrompt,
            contents: [],
            tools: payload.tools as any,
            toolConfig: payload.toolConfig as any,
            displayName: `accel-${(options?.cache?.sessionId || options?.sessionId || "").slice(0, 32)}`,
            ttlSeconds,
            apiKey: apiKeyForCache,
            baseUrl: baseUrlForCache,
          });
          cachedContentId = cached.name;
          (context as any).cachedContentId = cachedContentId;
          if (options?.cache) (options.cache as any).cachedContentId = cachedContentId;
        }
      } catch {
        // Fallback to implicit on failure
      }
    }
    if (cachedContentId) {
      payload.cachedContent = cachedContentId.startsWith("cachedContents/")
        ? cachedContentId
        : `cachedContents/${cachedContentId}`;
      delete payload.systemInstruction;
      delete payload.tools;
      delete payload.toolConfig;
    } else if (!wantsExplicit) {
      // Implicit: keep systemInstruction+tools stable for 2048/4096 prefix hit (no cachedContent)
    }

    // Generation Config & Thinking Config — bloatfree: no temperature/topP/topK/maxTokens/stopSequences (model defaults)
    const genConfig: Record<string, unknown> = {};

    // Thinking configuration — generic via catalog capabilities (no hardcoded model names)
    const modelSpecForThinking = this.getModel(modelId);
    const supportsLevel = !!modelSpecForThinking?.capabilities.supportsThinkingLevel;
    const supportsBudget = !!modelSpecForThinking?.capabilities.supportsThinkingBudget;
    // Level-based if catalog says so, otherwise fallback to budget (covers all providers generically)
    const isLevelBased = supportsLevel && !supportsBudget ? true : supportsLevel;
    // When catalog unavailable, use level for recent models generically (safe fallback)
    const isGemini3 = isLevelBased;
    const thinking = options?.thinking;

    const isExplicitlyDisabled =
      thinking?.enabled === false ||
      thinking?.level === "none" ||
      thinking?.budgetTokens === 0;

    if (!isExplicitlyDisabled && thinking) {
      if (isGemini3) {
        let levelStr = "LOW";
        if (thinking.level === "minimal") levelStr = "MINIMAL";
        else if (thinking.level === "medium") levelStr = "MEDIUM";
        else if (thinking.level === "high" || thinking.level === "xhigh") levelStr = "HIGH";
        else if (thinking.level === "low" || thinking.level === "dynamic") levelStr = "LOW";

        genConfig.thinkingConfig = {
          thinkingLevel: levelStr,
          includeThoughts: thinking.includeThoughts ?? true,
        };
      } else {
        // Gemini 2.5 uses thinkingBudget ONLY (never includeThoughts) — U10: map levels to token budgets (agent-accel thinkingBudgetForLevel)
        let budget = -1;
        if (thinking.budgetTokens !== undefined) {
          budget = thinking.budgetTokens;
        } else if (thinking.level) {
          const budgetMap: Record<string, number> = {
            none: 0,
            dynamic: -1,
            minimal: 1024,
            low: 4096,
            medium: 8192,
            high: 16384,
            xhigh: 24576,
          };
          budget = budgetMap[thinking.level] ?? -1;
        }
        genConfig.thinkingConfig = {
          thinkingBudget: budget,
        };
      }
    } else if (isExplicitlyDisabled) {
      // Only emit disabled config when explicitly requested (omit otherwise)
      if (!isGemini3) {
        genConfig.thinkingConfig = { thinkingBudget: 0 };
      } else {
        genConfig.thinkingConfig = { thinkingLevel: "MINIMAL" };
      }
    }

    if (Object.keys(genConfig).length > 0) {
      payload.generationConfig = genConfig;
    }

    return payload;
  }

  private extractUsage(usageMetadata?: any): TokenUsage {
    if (!usageMetadata) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
    const input = usageMetadata.promptTokenCount ?? 0;
    const output = usageMetadata.candidatesTokenCount ?? 0;
    const cached = usageMetadata.cachedContentTokenCount ?? 0;
    const thinking = usageMetadata.thoughtsTokenCount ?? 0;
    const total = usageMetadata.totalTokenCount ?? input + output;

    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
      cachedTokens: cached,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      thinkingTokens: thinking,
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
      throw new Error(
        `Google AI Studio API key is missing. Set GEMINI_API_KEY or pass apiKey in options.`
      );
    }

    const baseUrl = options?.baseUrl || this.defaultBaseUrl;
    const url = `${baseUrl}/models/${modelId}:generateContent?key=${apiKey}`;
    const payload = await this.buildPayload(modelId, context, options);

    // Use unified session header helper (reads both sessionId and cache.sessionId)
    const headers = buildSessionHeaders(this.id, options?.cache, {
      "Content-Type": "application/json",
      ...options?.headers,
    }, options?.sessionId);

    const raw: ProviderRawData = {
      request: {
        url: url.replace(apiKey, "[REDACTED]"),
        method: "POST",
        headers,
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
      const text = await response.text().catch(() => "");
      throw new Error(`Google AI Studio error (${response.status} ${response.statusText}): ${text}`);
    }
    raw.response = {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseJson,
    };

    if (!response.ok) {
      throw new Error(
        `Google AI Studio error (${response.status} ${response.statusText}): ${JSON.stringify(
          responseJson
        )}`
      );
    }

    const candidate = responseJson.candidates?.[0];
    let text = "";
    let thinking = "";
    let thoughtSignature: string | undefined;
    const toolCalls: ToolCallRecord[] = [];

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.thoughtSignature) {
          thoughtSignature = retainThoughtSignature(thoughtSignature, part.thoughtSignature);
        }

        // Generic thinking detection — any field any model may use
        const isThinking = Boolean(
          part.thought === true ||
            (typeof part.thought === "string" && part.thought) ||
            (part as any).thoughtText ||
            (part as any).thought_text ||
            (part as any).thinking === true ||
            typeof (part as any).thinking === "string" ||
            typeof (part as any).reasoning === "string" ||
            typeof (part as any).reasoning_content === "string" ||
            typeof (part as any).reasoning_text === "string" ||
            (part as any).thinking_content
        );
        const thoughtText =
          typeof part.thought === "string"
            ? part.thought
            : (part as any).thoughtText ||
                (part as any).thought_text ||
                (typeof (part as any).thinking === "string" ? (part as any).thinking : undefined) ||
                (typeof (part as any).reasoning === "string" ? (part as any).reasoning : undefined) ||
                (typeof (part as any).reasoning_content === "string" ? (part as any).reasoning_content : undefined) ||
                (typeof (part as any).reasoning_text === "string" ? (part as any).reasoning_text : undefined) ||
                (typeof (part as any).thinking_content === "string" ? (part as any).thinking_content : undefined) ||
                (isThinking ? part.text : undefined);

        if (isThinking && thoughtText) {
          thinking += thoughtText;
        } else if (part.text && !isThinking) {
          text += part.text;
        } else if (part.functionCall) {
          const callId = part.functionCall.id || `call_${Math.random().toString(36).slice(2, 9)}`;
          toolCalls.push({
            id: callId,
            name: part.functionCall.name,
            arguments: part.functionCall.args || {},
            thoughtSignature: part.thoughtSignature && isValidThoughtSignature(part.thoughtSignature) ? part.thoughtSignature : retainThoughtSignature(undefined, thoughtSignature),
          });
        }
      }
    }

    const usage = this.extractUsage(responseJson.usageMetadata);
    const finishReason = candidate?.finishReason || "STOP";
    const responseId = responseJson.responseId;

    const finalText = text || (toolCalls.length === 0 && thinking ? thinking : "");

    return {
      text: finalText,
      thinking: thinking.length > 0 ? thinking : undefined,
      thoughtSignature: thoughtSignature && isValidThoughtSignature(thoughtSignature) ? thoughtSignature : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      finishReason,
      responseId,
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
          throw new Error(
            `Google AI Studio API key is missing. Set GEMINI_API_KEY or pass apiKey in options.`
          );
        }

        const baseUrl = options?.baseUrl || this.defaultBaseUrl;
        const url = `${baseUrl}/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;
        const payload = await this.buildPayload(modelId, context, options);

        const headers = buildSessionHeaders(this.id, options?.cache, {
          "Content-Type": "application/json",
          ...options?.headers,
        }, options?.sessionId);

        const raw: ProviderRawData = {
          request: {
            url: url.replace(apiKey, "[REDACTED]"),
            method: "POST",
            headers,
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
          throw new Error(
            `Google AI Studio stream error (${response.status} ${response.statusText}): ${errBody}`
          );
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
        let finalThoughtSignature: string | undefined;
        const accumulatedToolCalls: ToolCallRecord[] = [];
        let finalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        let finalFinishReason = "STOP";
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
              if (chunkJson.responseId) {
                finalResponseId = chunkJson.responseId;
              }

              if (chunkJson.usageMetadata) {
                finalUsage = this.extractUsage(chunkJson.usageMetadata);
                eventStream.push({
                  type: "usage",
                  usage: finalUsage,
                });
              }

              const candidate = chunkJson.candidates?.[0];
              if (candidate?.finishReason) {
                finalFinishReason = candidate.finishReason;
              }

              if (candidate?.content?.parts) {
                for (const part of candidate.content.parts) {
                  if (part.thoughtSignature) {
                    finalThoughtSignature = retainThoughtSignature(finalThoughtSignature, part.thoughtSignature);
                  }

                  // Generic thinking detection — any field any model may use
                  const isThinking = Boolean(
                    part.thought === true ||
                      (typeof part.thought === "string" && part.thought) ||
                      (part as any).thoughtText ||
                      (part as any).thought_text ||
                      (part as any).thinking === true ||
                      typeof (part as any).thinking === "string" ||
                      typeof (part as any).reasoning === "string" ||
                      typeof (part as any).reasoning_content === "string" ||
                      typeof (part as any).reasoning_text === "string" ||
                      (part as any).thinking_content
                  );
                  const thoughtText =
                    typeof part.thought === "string"
                      ? part.thought
                      : (part as any).thoughtText ||
                          (part as any).thought_text ||
                          (typeof (part as any).thinking === "string" ? (part as any).thinking : undefined) ||
                          (typeof (part as any).reasoning === "string" ? (part as any).reasoning : undefined) ||
                          (typeof (part as any).reasoning_content === "string" ? (part as any).reasoning_content : undefined) ||
                          (typeof (part as any).reasoning_text === "string" ? (part as any).reasoning_text : undefined) ||
                          (typeof (part as any).thinking_content === "string" ? (part as any).thinking_content : undefined) ||
                          (isThinking ? part.text : undefined);

                  if (isThinking && thoughtText) {
                    accumulatedThinking += thoughtText;
                    eventStream.push({
                      type: "thinking_delta",
                      thinkingDelta: thoughtText,
                      partialThinking: accumulatedThinking,
                    });
                  } else if (part.text && !isThinking) {
                    accumulatedText += part.text;
                    eventStream.push({
                      type: "text_delta",
                      delta: part.text,
                      partialText: accumulatedText,
                    });
                  } else if (part.functionCall) {
                    const callId =
                      part.functionCall.id ||
                      `call_${Math.random().toString(36).slice(2, 9)}`;
                    const toolCall: ToolCallRecord = {
                      id: callId,
                      name: part.functionCall.name,
                      arguments: part.functionCall.args || {},
                      thoughtSignature: part.thoughtSignature && isValidThoughtSignature(part.thoughtSignature) ? part.thoughtSignature : finalThoughtSignature && isValidThoughtSignature(finalThoughtSignature) ? finalThoughtSignature : undefined,
                    };
                    accumulatedToolCalls.push(toolCall);
                    eventStream.push({
                      type: "tool_call_complete",
                      toolCall,
                    });
                  }
                }
              }
            } catch (err) {
              // Ignore partial JSON parse errors in SSE frames
            }
          }
        }

        // Flush remaining buffer
        for (const msg of parser.flush()) {
          if (!msg.data || msg.data === "[DONE]") continue;
          try {
            const chunkJson = JSON.parse(msg.data);
            if (chunkJson.usageMetadata) {
              finalUsage = this.extractUsage(chunkJson.usageMetadata);
            }
          } catch {}
        }

        const { AgentResponse } = await import("../../types/response.ts");
        const finalText = accumulatedText || (accumulatedToolCalls.length === 0 && accumulatedThinking ? accumulatedThinking : "");
        const finalAgentResponse = new AgentResponse({
          text: finalText,
          thinking: accumulatedThinking.length > 0 ? accumulatedThinking : undefined,
          thoughtSignature: finalThoughtSignature && isValidThoughtSignature(finalThoughtSignature) ? finalThoughtSignature : undefined,
          toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
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
