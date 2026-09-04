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
import { getModelsForProvider } from "../models/catalog.ts";

// ============================================================================
// Google AI Studio Provider Types
// ============================================================================

export type GoogleThinkingLevel = "OFF" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export interface GoogleThinkingConfig {
  thinkingLevel?: GoogleThinkingLevel;
  includeThoughts?: boolean;
}

export type GoogleFunctionCallingMode = "AUTO" | "NONE" | "ANY";

export interface GoogleFunctionCallingConfig {
  mode: GoogleFunctionCallingMode;
  allowedFunctionNames?: string[];
}

export interface GoogleToolConfig {
  functionCallingConfig?: GoogleFunctionCallingConfig;
}

export interface GoogleFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  parametersJsonSchema?: Record<string, unknown>;
}

export interface GoogleTool {
  functionDeclarations: GoogleFunctionDeclaration[];
}

export interface GoogleBlob {
  mimeType: string;
  data: string;
}

export interface GooglePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: GoogleBlob;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    id?: string;
  };
}

export interface GoogleContent {
  role: "user" | "model";
  parts: GooglePart[];
}

export interface GoogleSystemInstruction {
  parts: Array<{ text: string }>;
}

export interface GoogleGenerationConfig {
  thinkingConfig?: GoogleThinkingConfig;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  candidateCount?: number;
  stopSequences?: string[];
}

export interface GoogleGenerateContentRequest {
  contents: GoogleContent[];
  systemInstruction?: GoogleSystemInstruction;
  tools?: GoogleTool[];
  toolConfig?: GoogleToolConfig;
  cachedContent?: string;
  generationConfig?: GoogleGenerationConfig;
}

export interface GoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GoogleCandidate {
  content?: {
    parts?: GooglePart[];
    role?: string;
  };
  finishReason?: string;
  index?: number;
  safetyRatings?: unknown[];
}

export interface GoogleGenerateContentResponse {
  candidates?: GoogleCandidate[];
  usageMetadata?: GoogleUsageMetadata;
  responseId?: string;
  modelVersion?: string;
}

export interface CreateExplicitCacheOptions {
  model: string;
  systemInstruction?: string;
  contents?: Array<{
    role?: string;
    parts: Array<Record<string, unknown>>;
  }>;
  tools?: Array<Record<string, unknown>>;
  toolConfig?: Record<string, unknown>;
  displayName?: string;
  ttlSeconds?: number;
  /** ISO string or Date for explicit expireTime (overrides ttl) */
  expireTime?: string | Date;
  apiKey?: string;
  baseUrl?: string;
}

export interface CachedContentMetadata {
  name: string; // cachedContents/...
  displayName?: string;
  model: string;
  createTime: string;
  updateTime: string;
  expireTime: string;
  usageMetadata?: {
    totalTokenCount?: number;
  };
}

// ============================================================================
// Google Thought Signatures & Schema Sanitization Helpers
// ============================================================================

const base64SigPattern = /^[A-Za-z0-9+/]+={0,2}$/;

export function isValidThoughtSignature(sig?: string): boolean {
  if (!sig) return false;
  if (sig.length % 4 !== 0) return false;
  return base64SigPattern.test(sig);
}

export function retainThoughtSignature(existing?: string, incoming?: string): string | undefined {
  if (typeof incoming === "string" && incoming.length > 0) return incoming;
  return existing;
}

/**
 * Google uses OpenAPI 3.0 Schema and strictly rejects JSON Schema keywords
 * such as $schema, $defs, definitions, and additionalProperties.
 */
export function stripSchemaForGoogle(schema: any): any {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    if (Array.isArray(schema)) return schema.map(stripSchemaForGoogle);
    return schema;
  }
  const { $schema, $defs, definitions, additionalProperties, ...rest } = schema as any;
  const out: any = { ...rest };
  if (out.properties && typeof out.properties === "object") {
    const cleaned: any = {};
    for (const [k, v] of Object.entries(out.properties)) {
      cleaned[k] = stripSchemaForGoogle(v);
    }
    out.properties = cleaned;
  }
  if (out.items) out.items = stripSchemaForGoogle(out.items);
  if (out.anyOf) out.anyOf = (out.anyOf as any[]).map(stripSchemaForGoogle);
  if (out.oneOf) out.oneOf = (out.oneOf as any[]).map(stripSchemaForGoogle);
  if (out.allOf) out.allOf = (out.allOf as any[]).map(stripSchemaForGoogle);
  return out;
}

// ============================================================================
// Explicit Context Caching (Google cachedContents API)
// ============================================================================

/**
 * Creates an explicit cached content object using Google Gemini's cachedContents API.
 * REST: POST https://generativelanguage.googleapis.com/v1beta/cachedContents?key=...
 * Docs: gemini-documentation/context-caching.md
 */
export async function createExplicitCache(
  options: CreateExplicitCacheOptions
): Promise<CachedContentMetadata> {
  const apiKey = getApiKey("google", options.apiKey);
  if (!apiKey) {
    throw new Error("API key is required to create explicit cache (GEMINI_API_KEY)");
  }

  const baseUrl = options.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const ttl = options.expireTime
    ? undefined
    : options.ttlSeconds
      ? `${options.ttlSeconds}s`
      : "3600s";

  let modelName = options.model;
  if (!modelName.startsWith("models/")) {
    modelName = `models/${modelName.replace(/^google\//, "")}`;
  }

  const payload: Record<string, unknown> = {
    model: modelName,
    contents: options.contents ?? [],
    ...(ttl ? { ttl } : {}),
    ...(options.expireTime
      ? { expireTime: options.expireTime instanceof Date ? options.expireTime.toISOString() : options.expireTime }
      : {}),
  };

  if (options.displayName) {
    payload.displayName = options.displayName;
    (payload as any).display_name = options.displayName;
  }

  if (options.systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: options.systemInstruction }],
    };
    (payload as any).system_instruction = payload.systemInstruction;
  }

  if (options.tools && options.tools.length > 0) {
    payload.tools = options.tools;
  }

  if (options.toolConfig) {
    payload.toolConfig = options.toolConfig;
    (payload as any).tool_config = options.toolConfig;
  }

  const url = `${baseUrl}/cachedContents?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to create explicit cache (${response.status} ${response.statusText}): ${errorBody}`
    );
  }

  return (await response.json()) as CachedContentMetadata;
}

// ============================================================================
// Google Models Fallback & Catalog dynamic view
// ============================================================================

const FALLBACK_MODELS: ModelSpec[] = [
  {
    id: "gemini-3.5-flash-lite",
    provider: "google",
    name: "Gemini 3.5 Flash Lite",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    limit: { context: 1048576, output: 65536 },
    cost: { input: 0.075, output: 0.3, cache_read: 0.01875 },
    modalities: { input: ["text", "image", "audio", "video"], output: ["text"] },
    capabilities: {
      supportsThinking: true,
      supportsThinkingLevel: true,
      supportsImplicitCaching: true,
      supportsExplicitCaching: true,
      supportsLongCacheRetention: true,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text", "image", "audio", "video"],
    },
    pricing: { inputPerMillion: 0.075, outputPerMillion: 0.3, cacheReadPerMillion: 0.01875 },
  },
  {
    id: "gemini-3.7-flash",
    provider: "google",
    name: "Gemini 3.7 Flash",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    limit: { context: 1048576, output: 65536 },
    cost: { input: 0.1, output: 0.4, cache_read: 0.025 },
    modalities: { input: ["text", "image", "audio", "video"], output: ["text"] },
    capabilities: {
      supportsThinking: true,
      supportsThinkingLevel: true,
      supportsImplicitCaching: true,
      supportsExplicitCaching: true,
      supportsLongCacheRetention: true,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text", "image", "audio", "video"],
    },
    pricing: { inputPerMillion: 0.1, outputPerMillion: 0.4, cacheReadPerMillion: 0.025 },
  },
];

const dynamicGoogleModels = getModelsForProvider("google").filter(
  (m) => !m.id.toLowerCase().includes("gemini-2") && !m.id.toLowerCase().includes("gemini-1")
);
export const GOOGLE_MODELS: ModelSpec[] =
  dynamicGoogleModels.length > 0 ? dynamicGoogleModels : FALLBACK_MODELS;

// ============================================================================
// Google AI Studio Provider Implementation
// ============================================================================

export class GoogleAIStudioProvider extends BaseProvider {
  readonly id: ProviderId = "google";
  readonly name = "Google AI Studio";
  readonly models = GOOGLE_MODELS;

  private defaultBaseUrl = "https://generativelanguage.googleapis.com/v1beta";

  private cleanModelId(model: string | ModelSpec): string {
    const rawId = typeof model === "string" ? model : model.id;
    const clean = rawId.replace(/^(google\/|models\/)/, "");
    if (clean.toLowerCase().includes("gemini-2") || clean.toLowerCase().includes("gemini-1")) {
      throw new Error(
        `Gemini 2.x and 1.x models are not supported by the Google Provider. ` +
        `Only Gemini 3.x series models are supported (e.g. 'gemini-3.5-flash-lite', 'gemini-3.7-flash').`
      );
    }
    return clean;
  }

  private async convertContentPart(part: ContentPart): Promise<GooglePart | null> {
    switch (part.type) {
      case "text": {
        if (!part.text && !part.thoughtSignature) return null;
        const sig = part.thoughtSignature && isValidThoughtSignature(part.thoughtSignature) ? part.thoughtSignature : undefined;
        if (part.text) {
          return { text: part.text, ...(sig ? { thoughtSignature: sig } : {}) };
        }
        return sig ? { thoughtSignature: sig } : null;
      }
      case "thinking": {
        if (!part.thinking && !part.thoughtSignature) return null;
        const tSig = part.thoughtSignature && isValidThoughtSignature(part.thoughtSignature) ? part.thoughtSignature : undefined;
        return {
          thought: true,
          ...(part.thinking ? { text: part.thinking } : {}),
          ...(tSig ? { thoughtSignature: tSig } : {}),
        };
      }
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
  ): Promise<GoogleGenerateContentRequest> {
    const contents: GoogleContent[] = [];

    for (const msg of context.messages) {
      const parts: GooglePart[] = [];

      if (typeof msg.content === "string") {
        if (msg.content) {
          parts.push({ text: msg.content });
        }
      } else if (Array.isArray(msg.content)) {
        const convertedParts = await Promise.all(msg.content.map((p) => this.convertContentPart(p)));
        for (const converted of convertedParts) {
          if (converted && Object.keys(converted).length > 0) {
            parts.push(converted);
          }
        }
      }

      if (msg.thoughtSignature && isValidThoughtSignature(msg.thoughtSignature) && parts.length > 0 && !parts[0]?.thoughtSignature) {
        parts[0] = { ...parts[0]!, thoughtSignature: msg.thoughtSignature };
      }

      if (parts.length > 0) {
        if (msg.role === "tool") {
          const lastContent = contents[contents.length - 1];
          if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
            lastContent.parts.push(...parts);
          } else {
            contents.push({ role: "user", parts });
          }
        } else {
          const role = msg.role === "assistant" ? "model" : "user";
          contents.push({ role, parts });
        }
      }
    }

    const payload: GoogleGenerateContentRequest = {
      contents,
    };

    // System instruction
    if (context.systemPrompt) {
      payload.systemInstruction = {
        parts: [{ text: context.systemPrompt }],
      };
    }

    // Tools — stripped for Google OpenAPI 3.0 schema compliance
    if (options?.tools && options.tools.length > 0) {
      payload.tools = [
        {
          functionDeclarations: options.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.parameters ? stripSchemaForGoogle(t.parameters) : { type: "object", properties: {} },
          })),
        },
      ];

      if (options.toolChoice) {
        if (typeof options.toolChoice === "string") {
          const modeMap: Record<string, GoogleFunctionCallingMode> = {
            auto: "AUTO",
            none: "NONE",
            required: "ANY",
          };
          payload.toolConfig = {
            functionCallingConfig: {
              mode: modeMap[options.toolChoice] || "AUTO",
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

    // Explicit cache handling: retention set or cachedContentId specified
    let cachedContentId: string | undefined =
      (context as any).cachedContentId || context.cachedContentId || options?.cache?.cachedContentId;
    const wantsExplicit = !!options?.cache?.retention;

    if (wantsExplicit && !cachedContentId) {
      try {
        const ttlSeconds = options?.cache?.ttlSeconds ??
          (options?.cache?.retention === "short" ? 300 : options?.cache?.retention === "medium" ? 3600 : 43200);
        const apiKeyForCache = getApiKey(this.id, options?.apiKey, options?.env);
        if (apiKeyForCache && (context.systemPrompt || (payload.tools && payload.tools.length > 0))) {
          const baseUrlForCache = options?.baseUrl || this.defaultBaseUrl;
          let modelName = modelId;
          if (!modelName.startsWith("models/")) modelName = `models/${modelName}`;

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
    }

    // Generation Config & Thinking Config (Gemini 3.x series uses thinkingLevel)
    const genConfig: GoogleGenerationConfig = {};
    const thinking = options?.thinking;

    const isExplicitlyDisabled =
      thinking?.enabled === false ||
      thinking?.level === "none";

    if (!isExplicitlyDisabled && thinking) {
      let levelStr: GoogleThinkingLevel = "LOW";
      if (thinking.level === "minimal") levelStr = "MINIMAL";
      else if (thinking.level === "medium") levelStr = "MEDIUM";
      else if (thinking.level === "high" || thinking.level === "xhigh") levelStr = "HIGH";
      else if (thinking.level === "low" || thinking.level === "dynamic") levelStr = "LOW";

      genConfig.thinkingConfig = {
        thinkingLevel: levelStr,
        includeThoughts: thinking.includeThoughts ?? true,
      };
    } else if (isExplicitlyDisabled) {
      genConfig.thinkingConfig = {
        thinkingLevel: "OFF",
      };
    }

    if (Object.keys(genConfig).length > 0) {
      payload.generationConfig = genConfig;
    }

    return payload;
  }

  private extractUsage(usageMetadata?: GoogleUsageMetadata): TokenUsage {
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

    const headers = buildSessionHeaders(
      this.id,
      options?.cache,
      {
        "Content-Type": "application/json",
        ...options?.headers,
      },
      options?.sessionId
    );

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
            thoughtSignature: part.thoughtSignature && isValidThoughtSignature(part.thoughtSignature)
              ? part.thoughtSignature
              : retainThoughtSignature(undefined, thoughtSignature),
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

        const headers = buildSessionHeaders(
          this.id,
          options?.cache,
          {
            "Content-Type": "application/json",
            ...options?.headers,
          },
          options?.sessionId
        );

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
                    const callId = part.functionCall.id || `call_${Math.random().toString(36).slice(2, 9)}`;
                    const toolCall: ToolCallRecord = {
                      id: callId,
                      name: part.functionCall.name,
                      arguments: part.functionCall.args || {},
                      thoughtSignature: part.thoughtSignature && isValidThoughtSignature(part.thoughtSignature)
                        ? part.thoughtSignature
                        : finalThoughtSignature && isValidThoughtSignature(finalThoughtSignature)
                        ? finalThoughtSignature
                        : undefined,
                    };
                    accumulatedToolCalls.push(toolCall);
                    eventStream.push({
                      type: "tool_call_complete",
                      toolCall,
                    });
                  }
                }
              }
            } catch {
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

        const { AgentResponse } = await import("../types/response.ts");
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
