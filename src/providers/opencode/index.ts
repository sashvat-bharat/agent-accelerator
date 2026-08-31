import { BaseProvider } from "../base.ts";
import { OPENCODE_MODELS } from "./models.ts";
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
import { getApiKey, getEnv } from "../../utils/env.ts";
import { normalizeMediaInput } from "../../utils/media.ts";
import { buildSessionHeaders } from "../../utils/headers.ts";
import { applyAnthropicCacheControl, clampCacheKey, getPromptCacheRetention } from "../../utils/cache.ts";

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
    // U11: opencode-go models need go baseUrl
    if (modelId.includes("go") || modelId.startsWith("opencode-go")) return this.goBaseUrl;
    return this.defaultBaseUrl;
  }

  private cleanModelId(model: string | ModelSpec): string {
    const rawId = typeof model === "string" ? model : model.id;
    return rawId.replace(/^(opencode-zen\/|opencode-go\/|opencode\/)/, "");
  }

  private isResponsesModel(modelId: string): boolean {
    // Keep false for now — zen/v1 uses chat/completions for all models (scalable, generic).
    return false;
  }

  private buildResponsesPayload(
    modelId: string,
    context: ProviderContext,
    options?: ProviderRequestOptions,
    stream = false
  ): Record<string, unknown> {
    // Kept for future scalability if opencode adds responses models — currently not used, we stay on chat/completions for all
    const input: any[] = [];
    if (context.systemPrompt) {
      input.push({ role: "system", content: [{ type: "input_text", text: context.systemPrompt }] });
    }
    for (const msg of context.messages) {
      if (typeof msg.content === "string") {
        if (msg.role === "assistant") {
          input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: msg.content }] });
        } else {
          const role = msg.role === "tool" ? "user" : msg.role;
          input.push({ role, content: [{ type: "input_text", text: msg.content }] });
        }
      } else if (Array.isArray(msg.content)) {
        const textParts: any[] = (msg.content as any[]).filter((p: any) => p.type === "text" && p.text);
        const toolCalls: any[] = (msg.content as any[]).filter((p: any) => p.type === "tool_call");
        const toolResults: any[] = (msg.content as any[]).filter((p: any) => p.type === "tool_result");
        if (textParts.length > 0) {
          const combinedText = textParts.map((p: any) => p.text).join("\n");
          if (msg.role === "assistant") {
            input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: combinedText }] });
          } else {
            input.push({ role: msg.role as any, content: [{ type: "input_text", text: combinedText }] });
          }
        }
        for (const part of toolCalls as any[]) {
          input.push({
            type: "function_call",
            call_id: (part as any).id,
            name: (part as any).name,
            arguments: typeof (part as any).arguments === "string" ? (part as any).arguments : JSON.stringify((part as any).arguments),
          });
        }
        for (const part of toolResults as any[]) {
          input.push({
            type: "function_call_output",
            call_id: (part as any).id,
            output: typeof (part as any).result === "string" ? (part as any).result : JSON.stringify((part as any).result),
          });
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
      }));
      if (options.toolChoice) (payload as any).tool_choice = options.toolChoice;
    }
    // pi: prompt_cache_key + retention for openai-responses opencode
    const retention = options?.cache?.retention;
    const sessionId = options?.sessionId || options?.cache?.sessionId;
    if (sessionId && retention) {
      const clamp = (s: string) => Array.from(s).slice(0, 64).join("");
      (payload as any).prompt_cache_key = clamp(sessionId);
      if (retention === "long") (payload as any).prompt_cache_retention = "24h";
      else if (retention === "medium") (payload as any).prompt_cache_retention = "1h";
    }
    if (options?.thinking && (options.thinking as any).level && (options.thinking as any).level !== "none") {
      const lvl = (options.thinking as any).level;
      const effort = lvl === "minimal" ? "minimal" : lvl === "low" ? "low" : lvl === "medium" ? "medium" : lvl === "high" ? "high" : "xhigh";
      (payload as any).reasoning = { effort, summary: "auto" };
      (payload as any).include = ["reasoning.encrypted_content"];
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

    // Battle-tested cache: 80-90% hit — first turn already marks system+tools+first user, second turn reuses prefix
    const modelSpecForCache = this.getModel(modelId);
    const retention = options?.cache?.retention;
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

    // Thinking / reasoning format — generic via catalog (not per-model hardcoded)
    const modelSpecForThinking = this.getModel(modelId);
    const canThink = modelSpecForThinking ? modelSpecForThinking.capabilities.supportsThinking !== false : true;
    if (canThink && options?.thinking?.enabled !== false && options?.thinking?.level && options.thinking.level !== "none") {
      const level = options.thinking.level;
      const effort =
        level === "minimal" || level === "low"
          ? "low"
          : level === "medium" || level === "dynamic"
          ? "medium"
          : "high";
      // Generic: use reasoning_effort for all; catalog decides if toggle vs effort
      payload.reasoning_effort = effort;
      // For models whose catalog indicates toggle, also set thinking flag (generic fallback)
      const raw: any = (modelSpecForThinking as any)?.reasoning_options ?? [];
      const hasToggle = Array.isArray(raw) && raw.some((o: any) => o.type === "toggle");
      if (hasToggle) {
        payload.thinking = { type: "enabled" };
      }
    }

    // ServiceTier — bloatfree DX6: no temperature/topP/stopSequences (model defaults)
    // OpenCode tier routing (if needed, via provider order not yet exposed, keep placeholder)
    // No inference fields — standard is default

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
    const cacheWrite = usageData.prompt_tokens_details?.cache_write_tokens ?? usageData.cache_write_tokens ?? 0;
    const thinking =
      usageData.completion_tokens_details?.reasoning_tokens ??
      usageData.reasoning_tokens ??
      0;

    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
      cachedTokens: cached,
      cacheReadTokens: cached,
      cacheWriteTokens: cacheWrite,
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
      throw new Error("OpenCode API key is missing. Set OPENCODE_API_KEY or pass apiKey in options.");
    }

    const baseUrl = this.resolveBaseUrl(modelId, options?.baseUrl);
    const isResponses = this.isResponsesModel(modelId);
    const url = isResponses
      ? `${baseUrl.replace(/\/$/, "")}/responses`
      : `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    let payload: any = isResponses
      ? this.buildResponsesPayload(modelId, context, options, false)
      : await this.buildPayload(modelId, context, options, false);

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

    let response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: options?.signal,
    });

    // Generic 500 retry: strip thinking/cache which often cause 500 on unsupported models (not per-model)
    if (!response.ok && response.status === 500) {
      try {
        const retryOptions: any = { ...options, thinking: { enabled: false, level: "none" }, cache: undefined };
        const retryPayload = await this.buildPayload(modelId, context, retryOptions, false);
        payload = retryPayload;
        (raw.request as any).body = retryPayload;
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(retryPayload),
          signal: options?.signal,
        });
      } catch {}
    }

    let responseJson: any;
    try {
      responseJson = await response.json();
    } catch {
      const t = await response.text().catch(() => "");
      throw new Error(`OpenCode API error (${response.status} ${response.statusText}): ${t}`);
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
    let toolCalls: ToolCallRecord[] = [];
    let finishReason = "stop";
    let responseId = responseJson.id;
    let usage: any;

    // Handle both completions (choices) and responses (output) regardless of endpoint (robust)
    if (responseJson.output) {
      // openai-responses format: output: [{type:"message", content:[{type:"output_text", text:"..."}]}, {type:"function_call", ...}]
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
            try { args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments || {}; } catch { args = { raw: item.arguments }; }
            toolCalls.push({ id: item.call_id || item.id || `call_${Math.random().toString(36).slice(2, 9)}`, name: item.name || "", arguments: args, rawArguments: item.arguments });
          } else if (item.type === "reasoning" && item.text) {
            thinking = (thinking || "") + item.text;
          }
        }
      } else if (typeof output === "string") {
        text = output;
      }
      // responses usage is {input_tokens, output_tokens, total_tokens} or prompt_tokens/completion_tokens
      usage = this.extractUsage(responseJson.usage || { prompt_tokens: responseJson.usage?.input_tokens, completion_tokens: responseJson.usage?.output_tokens, total_tokens: responseJson.usage?.total_tokens });
      finishReason = responseJson.status === "completed" ? "stop" : responseJson.status || "stop";
    } else {
      const choice = responseJson.choices?.[0];
      const message = choice?.message;
      text = message?.content || "";
      thinking = message?.reasoning_content || message?.reasoning || message?.reasoning_text || undefined;
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
        const isResponsesStream = this.isResponsesModel(modelId);
        const url = isResponsesStream
          ? `${baseUrl.replace(/\/$/, "")}/responses`
          : `${baseUrl.replace(/\/$/, "")}/chat/completions`;
        let payload: any = isResponsesStream
          ? this.buildResponsesPayload(modelId, context, options, true)
          : await this.buildPayload(modelId, context, options, true);

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

        let response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: options?.signal,
        });

        // Generic 500 retry: strip thinking/cache
        if (!response.ok && response.status === 500) {
          try {
            const retryOptions: any = { ...options, thinking: { enabled: false, level: "none" }, cache: undefined };
            const retryPayload = await this.buildPayload(modelId, context, retryOptions, true);
            payload = retryPayload;
            (raw.request as any).body = retryPayload;
            response = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(retryPayload),
              signal: options?.signal,
            });
          } catch {}
        }

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`OpenCode stream error (${response.status} ${response.statusText}): ${errBody}`);
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

              // Handle openai-responses streaming — generic (pi uses response.output_text.delta etc.)
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
              if (chunkJson.type === "response.function_call") {
                continue;
              }
              if (chunkJson.type === "response.completed" || chunkJson.type === "response.done") {
                if (chunkJson.response?.id) finalResponseId = chunkJson.response.id;
                if (chunkJson.response?.usage) {
                  const usageData = chunkJson.response.usage.input_tokens !== undefined
                    ? { prompt_tokens: chunkJson.response.usage.input_tokens, completion_tokens: chunkJson.response.usage.output_tokens, total_tokens: chunkJson.response.usage.total_tokens }
                    : chunkJson.response.usage;
                  finalUsage = this.extractUsage(usageData);
                  eventStream.push({ type: "usage", usage: finalUsage });
                }
                // Fallback: if no deltas were streamed, extract from completed output (common for responses)
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
                // Handle both completions usage and responses usage shapes
                const usageData = chunkJson.usage.input_tokens !== undefined
                  ? { prompt_tokens: chunkJson.usage.input_tokens, completion_tokens: chunkJson.usage.output_tokens, total_tokens: chunkJson.usage.total_tokens }
                  : chunkJson.usage;
                finalUsage = this.extractUsage(usageData);
                eventStream.push({ type: "usage", usage: finalUsage });
              }

              const choice = chunkJson.choices?.[0];
              if (choice?.finish_reason) {
                finalFinishReason = choice.finish_reason;
              }

              const delta = choice?.delta;
              if (delta) {
                const thinkingDelta =
                  delta.reasoning_content || delta.reasoning || delta.reasoning_text;
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
                        // incremental chunk
                        entry.name += tc.function.name;
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
