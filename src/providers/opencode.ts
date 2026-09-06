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
import { getApiKey, getEnv } from "../utils/env.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import { buildSessionHeaders } from "../utils/headers.ts";
import { applyAnthropicCacheControl, clampCacheKey, getPromptCacheRetention } from "../utils/cache.ts";
import { getModelsForProvider } from "../models/catalog.ts";

// ============================================================================
// OpenCode Provider Types (Chat & Responses API)
// ============================================================================

export type OpenCodePromptCacheRetention = "5m" | "1h" | "12h";

export interface OpenCodeCacheControl {
  type: "ephemeral";
}

export type OpenCodeReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface OpenCodeChatRequest {
  model: string;
  messages: any[];
  tools?: any[];
  tool_choice?: any;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  prompt_cache_key?: string;
  prompt_cache_retention?: OpenCodePromptCacheRetention;
  reasoning_effort?: OpenCodeReasoningEffort;
  thinking?: {
    type: "enabled" | "disabled";
  };
}

export interface OpenCodeResponsesInputItem {
  type?: string;
  role?: string;
  content?: any;
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  text?: string;
  status?: string;
}

export interface OpenCodeResponsesRequest {
  model: string;
  input: OpenCodeResponsesInputItem[];
  stream?: boolean;
  store?: boolean;
  tools?: any[];
  tool_choice?: any;
  prompt_cache_key?: string;
  prompt_cache_retention?: OpenCodePromptCacheRetention;
  prompt_cache_options?: { mode: string };
  reasoning?: {
    effort?: OpenCodeReasoningEffort;
    enabled?: boolean;
    summary?: string;
  };
  include?: string[];
  service_tier?: string;
}

export interface OpenCodeUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  input_token_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  cached_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  reasoning_tokens?: number;
  reasoningTokens?: number;
  total_cost?: number;
  cost?: {
    totalCost?: number;
  };
}

export interface OpenCodeChatResponse {
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
  usage?: OpenCodeUsage;
}

export interface OpenCodeResponsesOutputItem {
  type: string;
  content?: Array<{
    type: string;
    text?: string;
  }>;
  name?: string;
  call_id?: string;
  id?: string;
  arguments?: string;
  text?: string;
}

export interface OpenCodeResponsesResponse {
  id: string;
  status: string;
  output?: OpenCodeResponsesOutputItem[] | string;
  usage?: OpenCodeUsage;
}

// ============================================================================
// OpenCode Models Fallback & Catalog dynamic view
// ============================================================================

const FALLBACK_MODELS: ModelSpec[] = [
  {
    id: "gpt-5.4",
    provider: "opencode",
    name: "GPT-5.4 (Zen)",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    limit: { context: 1048576, output: 65536 },
    cost: { input: 1.0, output: 5.0, cache_read: 0.1 },
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: {
      supportsThinking: true,
      supportsThinkingLevel: true,
      supportsImplicitCaching: true,
      supportsExplicitCaching: true,
      supportsLongCacheRetention: true,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text", "image"],
    },
    pricing: { inputPerMillion: 1.0, outputPerMillion: 5.0, cacheReadPerMillion: 0.1 },
  },
  {
    id: "muse-4.5",
    provider: "opencode",
    name: "Muse 4.5",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    limit: { context: 1048576, output: 65536 },
    cost: { input: 0.5, output: 2.0, cache_read: 0.05 },
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: {
      supportsThinking: true,
      supportsThinkingLevel: true,
      supportsImplicitCaching: true,
      supportsExplicitCaching: true,
      supportsLongCacheRetention: true,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text", "image"],
    },
    pricing: { inputPerMillion: 0.5, outputPerMillion: 2.0, cacheReadPerMillion: 0.05 },
  },
];

const dynamicOpenCodeModels = getModelsForProvider("opencode");
export const OPENCODE_MODELS: ModelSpec[] =
  dynamicOpenCodeModels.length > 2 ? dynamicOpenCodeModels : FALLBACK_MODELS;

// ============================================================================
// OpenCode Provider Implementation
// ============================================================================

export class OpenCodeProvider extends BaseProvider {
  readonly id: ProviderId = "opencode";
  readonly name = "OpenCode";
  readonly models = OPENCODE_MODELS;

  private defaultBaseUrl = "https://opencode.ai/zen/v1";
  private goBaseUrl = "https://opencode.ai/zen/go/v1";

  private resolveBaseUrl(modelId: string, explicit?: string): string {
    if (explicit) return explicit;
    const envUrl = getEnv("OPENCODE_BASE_URL");
    if (envUrl) return envUrl;
    if (modelId.includes("go") || modelId.startsWith("opencode-go")) return this.goBaseUrl;
    return this.defaultBaseUrl;
  }

  private cleanModelId(model: string | ModelSpec): string {
    const rawId = typeof model === "string" ? model : model.id;
    return rawId.replace(/^(opencode-zen\/|opencode-go\/|opencode\/)/, "");
  }

  private isResponsesModel(model: string | ModelSpec): boolean {
    const rawId = typeof model === "string" ? model : (model as any).id;
    const apiFromSpec = typeof model === "object" && (model as any).api ? (model as any).api : undefined;
    if (apiFromSpec === "openai-responses") return true;
    const clean = this.cleanModelId(rawId);
    const spec = this.getModel(clean) ?? this.getModel(rawId);
    if (spec?.api === "openai-responses" || (spec?.raw as any)?.provider?.api === "openai-responses") return true;
    if (spec?.family?.startsWith("muse") || clean.includes("muse-") || clean.includes("muse_") || clean.startsWith("muse")) return true;
    if (clean.includes("responses")) return true;
    return false;
  }

  private buildResponsesPayload(
    modelId: string,
    context: ProviderContext,
    options?: ProviderRequestOptions,
    stream = false
  ): Record<string, unknown> {
    const input: any[] = [];
    const modelSpecForCache = this.getModel(modelId);

    if (context.systemPrompt) {
      const isReasoning = modelSpecForCache?.reasoning || (options?.thinking?.enabled !== false && options?.thinking?.level !== "none");
      const role = isReasoning ? "developer" : "system";
      input.push({ role, content: context.systemPrompt });
    }

    for (const msg of context.messages) {
      if (typeof msg.content === "string") {
        if (msg.role === "assistant") {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: msg.content, annotations: [] }],
            status: "completed",
          });
        } else if (msg.role === "tool") {
          input.push({
            type: "function_call_output",
            call_id: (msg as any).tool_call_id || (msg as any).id || "call_0",
            output: msg.content,
          });
        } else {
          input.push({
            role: "user",
            content: [{ type: "input_text", text: msg.content }],
          });
        }
      } else if (Array.isArray(msg.content)) {
        const textParts: any[] = msg.content.filter((p: any) => p.type === "text" && p.text);
        const imageParts: any[] = msg.content.filter((p: any) => p.type === "image");
        const toolCalls: any[] = msg.content.filter((p: any) => p.type === "tool_call");
        const toolResults: any[] = msg.content.filter((p: any) => p.type === "tool_result");
        const thinkingParts: any[] = msg.content.filter((p: any) => p.type === "thinking" && p.thinking);

        if (msg.role === "assistant") {
          for (const tp of thinkingParts) {
            if (tp.thoughtSignature && tp.thoughtSignature.startsWith("{")) {
              try {
                input.push(JSON.parse(tp.thoughtSignature));
              } catch {
                input.push({ type: "reasoning", text: tp.thinking });
              }
            }
          }
          if (textParts.length > 0) {
            const combinedText = textParts.map((p: any) => p.text).join("\n");
            input.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: combinedText, annotations: [] }],
              status: "completed",
            });
          }
          for (const tc of toolCalls) {
            const [callId, itemId] = (tc.id || "").split("|");
            input.push({
              type: "function_call",
              id: itemId && itemId.startsWith("fc_") ? itemId : undefined,
              call_id: callId || tc.id,
              name: tc.name,
              arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}),
              status: "completed",
            });
          }
        } else if (msg.role === "tool" || toolResults.length > 0) {
          for (const tr of toolResults) {
            const [callId] = (tr.id || "").split("|");
            input.push({
              type: "function_call_output",
              call_id: callId || tr.id,
              output: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
            });
          }
        } else {
          const userContent: any[] = [];
          for (const tp of textParts) {
            userContent.push({ type: "input_text", text: tp.text });
          }
          for (const ip of imageParts) {
            userContent.push({
              type: "input_image",
              detail: "auto",
              image_url: typeof ip.image === "string" && ip.image.startsWith("data:") ? ip.image : (ip.dataUrl || ""),
            });
          }
          if (userContent.length > 0) {
            input.push({ role: "user", content: userContent });
          }
        }
      }
    }

    const payload: Record<string, unknown> = {
      model: modelId,
      input,
      stream,
      store: false,
    };

    if (options?.tools && options.tools.length > 0) {
      payload.tools = options.tools.map((t: any) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      }));
      if (options.toolChoice) payload.tool_choice = options.toolChoice;
    }

    const sessionId = options?.sessionId || options?.cache?.sessionId;
    const retention = options?.cache?.retention;
    const supportsLong = modelSpecForCache?.capabilities.supportsLongCacheRetention ?? true;

    if (sessionId && (retention as any) !== "none") {
      const ck = clampCacheKey(sessionId);
      if (ck) {
        payload.prompt_cache_key = ck;
        const pcr = getPromptCacheRetention(retention || "short", supportsLong);
        if (pcr) payload.prompt_cache_retention = pcr;
      }
    }

    if ((retention as any) === "none" && modelSpecForCache?.capabilities.supportsExplicitCaching) {
      payload.prompt_cache_options = { mode: "explicit" };
    }

    const canThink = modelSpecForCache ? modelSpecForCache.capabilities.supportsThinking !== false : true;
    const levelResp = options?.thinking?.level;
    const isDisabledResp = options?.thinking?.enabled === false || (levelResp as any) === "none";
    if (isDisabledResp) {
      payload.reasoning = { effort: "none" };
      return payload;
    } else if (canThink && levelResp) {
      const hasToggle = Array.isArray((modelSpecForCache as any)?.reasoning_options) && (modelSpecForCache as any).reasoning_options.some((o: any) => o.type === "toggle");
      const hasEffort = Array.isArray((modelSpecForCache as any)?.reasoning_options) && (modelSpecForCache as any).reasoning_options.some((o: any) => o.type === "effort");
      if (hasToggle && !hasEffort) {
        payload.reasoning = { enabled: true };
        payload.include = ["reasoning.encrypted_content"];
      } else {
        const effort = levelResp === "minimal" ? "minimal" : levelResp === "low" ? "low" : levelResp === "medium" ? "medium" : levelResp === "high" ? "high" : "xhigh";
        payload.reasoning = { effort, summary: "auto" };
        payload.include = ["reasoning.encrypted_content"];
      }
    }

    if (options?.serviceTier) {
      payload.service_tier = options.serviceTier === "flex" ? "flex" : options.serviceTier === "priority" ? "priority" : undefined;
    }
    return payload;
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

    const payload: Record<string, unknown> = {
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
    const modelSpecForCache = this.getModel(modelId);
    const retention = options?.cache?.retention;
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
        (payload as any).session_id = ck;
        (payload as any).prompt_cache_key = ck;
        if (retention && retention !== "implicit") {
          const pcr = getPromptCacheRetention(retention, modelSpecForCache?.capabilities.supportsLongCacheRetention ?? true);
          if (pcr) (payload as any).prompt_cache_retention = pcr;
        }
      }
    }

    // Thinking / reasoning
    const modelSpecForThinking = this.getModel(modelId);
    const level = options?.thinking?.level;
    const isDisabled = options?.thinking?.enabled === false || (level as any) === "none";
    if (isDisabled) {
      payload.reasoning_effort = "none";
      const raw: any = (modelSpecForThinking as any)?.reasoning_options ?? [];
      const hasToggle = Array.isArray(raw) && raw.some((o: any) => o.type === "toggle");
      if (hasToggle) {
        payload.thinking = { type: "disabled" };
      }
      return payload;
    } else if (level) {
      const canThink = modelSpecForThinking ? modelSpecForThinking.capabilities.supportsThinking !== false : true;
      if (!canThink) return payload;
      const effort =
        level === "minimal" || level === "low"
          ? "low"
          : level === "medium" || level === "dynamic"
          ? "medium"
          : "high";
      payload.reasoning_effort = effort;
      const raw: any = (modelSpecForThinking as any)?.reasoning_options ?? [];
      const hasToggle = Array.isArray(raw) && raw.some((o: any) => o.type === "toggle");
      if (hasToggle) {
        payload.thinking = { type: "enabled" };
      }
    }

    return payload;
  }

  private extractUsage(usageData?: any): TokenUsage {
    if (!usageData) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    }
    const input = usageData.prompt_tokens ?? usageData.input_tokens ?? usageData.promptTokens ?? 0;
    const output = usageData.completion_tokens ?? usageData.output_tokens ?? usageData.completionTokens ?? 0;
    const total = usageData.total_tokens ?? usageData.totalTokens ?? input + output;
    const cached =
      usageData.prompt_tokens_details?.cached_tokens ??
      usageData.input_tokens_details?.cached_tokens ??
      usageData.input_token_details?.cached_tokens ??
      usageData.cache_read_tokens ??
      usageData.cached_tokens ??
      usageData.cachedTokens ??
      0;
    const cacheWrite =
      usageData.prompt_tokens_details?.cache_write_tokens ??
      usageData.input_tokens_details?.cache_write_tokens ??
      usageData.input_token_details?.cache_write_tokens ??
      usageData.cache_write_tokens ??
      usageData.cacheWriteTokens ??
      0;
    const thinking =
      usageData.completion_tokens_details?.reasoning_tokens ??
      usageData.output_tokens_details?.reasoning_tokens ??
      usageData.reasoning_tokens ??
      usageData.reasoningTokens ??
      0;

    const cost = usageData.total_cost !== undefined ? { totalCost: usageData.total_cost } : usageData.cost;

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
      throw new Error("OpenCode API key is missing. Set OPENCODE_API_KEY or pass apiKey in options.");
    }

    const baseUrl = this.resolveBaseUrl(modelId, options?.baseUrl);
    let isResponses = this.isResponsesModel(model);
    let url = isResponses
      ? `${baseUrl.replace(/\/$/, "")}/responses`
      : `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    let payload: any = isResponses
      ? this.buildResponsesPayload(modelId, context, options, false)
      : await this.buildPayload(modelId, context, options, false);

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

    let response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: options?.signal,
    });

    // Retry on transient upstream errors
    if (!response.ok && [500, 502, 503, 529].includes(response.status)) {
      try {
        const retryOptions: any = { ...options, thinking: { enabled: false, level: "none" }, cache: undefined };
        const retryPayload = isResponses
          ? this.buildResponsesPayload(modelId, context, retryOptions, false)
          : await this.buildPayload(modelId, context, retryOptions, false);
        payload = retryPayload;
        (raw.request as any).body = retryPayload;
        if (response.status === 503) await new Promise((r) => setTimeout(r, 800));
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(retryPayload),
          signal: options?.signal,
        });
      } catch {}
    }

    if (!response.ok && [500, 503].includes(response.status)) {
      try {
        const altIsResponses = !isResponses;
        const altUrl = altIsResponses
          ? `${baseUrl.replace(/\/$/, "")}/responses`
          : `${baseUrl.replace(/\/$/, "")}/chat/completions`;
        const altOptions: any = { ...options, thinking: { enabled: false, level: "none" }, cache: undefined };
        const altPayload = altIsResponses
          ? this.buildResponsesPayload(modelId, context, altOptions, false)
          : await this.buildPayload(modelId, context, altOptions, false);
        const altRes = await fetch(altUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(altPayload),
          signal: options?.signal,
        });
        if (altRes.ok) {
          isResponses = altIsResponses;
          url = altUrl;
          payload = altPayload;
          (raw.request as any).url = altUrl;
          (raw.request as any).body = altPayload;
          response = altRes;
        }
      } catch {}
    }

    let responseJson: any;
    try {
      responseJson = await response.json();
    } catch {
      const t = await response.text().catch(() => "");
      const isUpstream = t.includes("Upstream") || t.includes("unavailable");
      const hint = isUpstream ? " — provider endpoint temporarily unavailable, try again or switch MODEL (e.g. openrouter/*)" : "";
      throw new Error(`OpenCode API error (${response.status} ${response.statusText}): ${t}${hint}`);
    }

    raw.response = {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseJson,
    };

    if (!response.ok) {
      throw new Error(
        `OpenCode API error (${response.status} ${response.statusText}): ${JSON.stringify(responseJson)}`
      );
    }

    let text = "";
    let thinking: string | undefined;
    const toolCalls: ToolCallRecord[] = [];
    let finishReason = "stop";
    let responseId = responseJson.id;
    let usage: any;

    if (responseJson.output) {
      const output = responseJson.output;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const c of item.content) {
              if (c.type === "output_text" && c.text) text += c.text;
              if (c.type === "reasoning" && c.text) thinking = (thinking || "") + c.text;
            }
          } else if (item.type === "function_call") {
            let args: any = {};
            try {
              args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments || {};
            } catch {
              args = { raw: item.arguments };
            }
            toolCalls.push({
              id: item.call_id || item.id || `call_${Math.random().toString(36).slice(2, 9)}`,
              name: item.name || "",
              arguments: args,
              rawArguments: item.arguments,
            });
          } else if (item.type === "reasoning" && item.text) {
            thinking = (thinking || "") + item.text;
          }
        }
      } else if (typeof output === "string") {
        text = output;
      }
      usage = this.extractUsage(responseJson.usage);
      finishReason = responseJson.status === "completed" ? "stop" : responseJson.status || "stop";
    } else {
      const choice = responseJson.choices?.[0];
      const message = choice?.message;
      text = message?.content || "";
      if (typeof message?.reasoning === "string" && message.reasoning) thinking = message.reasoning;
      else if (typeof message?.reasoning_content === "string" && message.reasoning_content) thinking = message.reasoning_content;
      else if (typeof message?.reasoning_text === "string" && message.reasoning_text) thinking = message.reasoning_text;
      else if (typeof (message as any)?.thinking === "string" && (message as any).thinking) thinking = (message as any).thinking;
      else if (typeof (message as any)?.thought === "string" && (message as any).thought) thinking = (message as any).thought;
      else if (Array.isArray((message as any)?.reasoning_details)) {
        const parts = (message as any).reasoning_details.map((r: any) => r.text || r.content || "").filter(Boolean);
        if (parts.length) thinking = parts.join("");
      }
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
      usage = this.extractUsage(responseJson.usage);
      finishReason = choice?.finish_reason || "stop";
      responseId = responseJson.id;
    }

    return {
      text,
      thinking: thinking || undefined,
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
          throw new Error("OpenCode API key is missing. Set OPENCODE_API_KEY or pass apiKey in options.");
        }

        const baseUrl = this.resolveBaseUrl(modelId, options?.baseUrl);
        let isResponsesStream = this.isResponsesModel(model);
        let url = isResponsesStream
          ? `${baseUrl.replace(/\/$/, "")}/responses`
          : `${baseUrl.replace(/\/$/, "")}/chat/completions`;
        let payload: any = isResponsesStream
          ? this.buildResponsesPayload(modelId, context, options, true)
          : await this.buildPayload(modelId, context, options, true);

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

        let response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: options?.signal,
        });

        if (!response.ok && [500, 502, 503, 529].includes(response.status)) {
          try {
            const retryOptions: any = { ...options, thinking: { enabled: false, level: "none" }, cache: undefined };
            const retryPayload = isResponsesStream
              ? this.buildResponsesPayload(modelId, context, retryOptions, true)
              : await this.buildPayload(modelId, context, retryOptions, true);
            payload = retryPayload;
            (raw.request as any).body = retryPayload;
            if (response.status === 503) await new Promise((r) => setTimeout(r, 800));
            response = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(retryPayload),
              signal: options?.signal,
            });
          } catch {}
        }

        if (!response.ok && [500, 503].includes(response.status)) {
          try {
            const altIsResponses = !isResponsesStream;
            const altUrl = altIsResponses
              ? `${baseUrl.replace(/\/$/, "")}/responses`
              : `${baseUrl.replace(/\/$/, "")}/chat/completions`;
            const altOptions: any = { ...options, thinking: { enabled: false, level: "none" }, cache: undefined };
            const altPayload = altIsResponses
              ? this.buildResponsesPayload(modelId, context, altOptions, true)
              : await this.buildPayload(modelId, context, altOptions, true);
            const altRes = await fetch(altUrl, {
              method: "POST",
              headers,
              body: JSON.stringify(altPayload),
              signal: options?.signal,
            });
            if (altRes.ok) {
              isResponsesStream = altIsResponses;
              url = altUrl;
              payload = altPayload;
              (raw.request as any).url = altUrl;
              (raw.request as any).body = altPayload;
              response = altRes;
            }
          } catch {}
        }

        if (!response.ok) {
          const errBody = await response.text();
          const isUpstream = errBody.includes("Upstream") || errBody.includes("unavailable");
          const hint = isUpstream ? " — provider endpoint is temporarily unavailable (upstream). Try again in a few seconds or switch MODEL (e.g. openrouter/*)" : "";
          throw new Error(`OpenCode stream error (${response.status} ${response.statusText}): ${errBody}${hint}`);
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

              if (chunkJson.type === "response.output_text.delta") {
                const textDelta = typeof chunkJson.delta === "string" ? chunkJson.delta : chunkJson.delta?.text || "";
                if (textDelta) {
                  accumulatedText += textDelta;
                  eventStream.push({ type: "text_delta", delta: textDelta, partialText: accumulatedText });
                }
                continue;
              }
              if (chunkJson.type === "response.reasoning.delta" || chunkJson.type === "response.reasoning_summary_text.delta" || chunkJson.type === "response.reasoning_text.delta") {
                const thinkDelta = typeof chunkJson.delta === "string" ? chunkJson.delta : chunkJson.delta?.text || chunkJson.delta || "";
                if (thinkDelta) {
                  accumulatedThinking += thinkDelta;
                  eventStream.push({ type: "thinking_delta", thinkingDelta: thinkDelta, partialThinking: accumulatedThinking });
                }
                continue;
              }
              if (chunkJson.type === "response.function_call_arguments.delta" && chunkJson.delta) {
                const idx = chunkJson.output_index ?? 0;
                if (!toolCallsMap.has(idx)) toolCallsMap.set(idx, { id: chunkJson.item_id || `call_${idx}`, name: "", args: "" });
                const entry = toolCallsMap.get(idx)!;
                const deltaStr = typeof chunkJson.delta === "string" ? chunkJson.delta : chunkJson.delta?.text || "";
                if (deltaStr) entry.args += deltaStr;
                continue;
              }
              if (chunkJson.type === "response.output_item.added" && chunkJson.item) {
                const item = chunkJson.item;
                if (item.type === "function_call" || item.type === "custom_tool_call") {
                  const idx = chunkJson.output_index ?? 0;
                  if (!toolCallsMap.has(idx)) {
                    toolCallsMap.set(idx, {
                      id: item.call_id || item.id || `call_${idx}`,
                      name: item.name || "",
                      args: item.arguments || item.input || "",
                    });
                  } else {
                    const entry = toolCallsMap.get(idx)!;
                    if (item.name && !entry.name) entry.name = item.name;
                    if (item.call_id) entry.id = item.call_id;
                  }
                }
                continue;
              }
              if (chunkJson.type === "response.completed" || chunkJson.type === "response.done") {
                if (chunkJson.response?.id) finalResponseId = chunkJson.response.id;
                if (chunkJson.response?.usage) {
                  finalUsage = this.extractUsage(chunkJson.response.usage);
                  eventStream.push({ type: "usage", usage: finalUsage });
                }
                if (!accumulatedText && chunkJson.response?.output && Array.isArray(chunkJson.response.output)) {
                  for (const item of chunkJson.response.output) {
                    if (item.type === "message" && Array.isArray(item.content)) {
                      for (const c of item.content) {
                        if (c.type === "output_text" && c.text) {
                          accumulatedText += c.text;
                          eventStream.push({ type: "text_delta", delta: c.text, partialText: accumulatedText });
                        }
                      }
                    }
                  }
                }
                if (chunkJson.response?.status === "completed") finalFinishReason = "stop";
                continue;
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
                  const parts = (delta as any).reasoning_details.map((r: any) => r.text || r.content || "").filter(Boolean);
                  if (parts.length) thinkingDelta = parts.join("");
                }
                if (thinkingDelta) {
                  accumulatedThinking += thinkingDelta;
                  eventStream.push({
                    type: "thinking_delta",
                    thinkingDelta,
                    partialThinking: accumulatedThinking,
                  });
                }

                if (delta.content) {
                  accumulatedText += delta.content;
                  eventStream.push({
                    type: "text_delta",
                    delta: delta.content,
                    partialText: accumulatedText,
                  });
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
                      else if (tc.function?.name && entry.name !== tc.function.name && !entry.name.includes(tc.function.name)) {
                        entry.name += tc.function.name;
                      }
                      if (tc.function?.arguments) entry.args += tc.function.arguments;
                    }
                  }
                }
              }
            } catch {}
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
