import { z } from "zod";

// Core Agent & Tool Classes
export { Agent, SubAgentModelError } from "./agent/agent.ts";
export { SubAgent } from "./agent/subagent.ts";
export type { SubAgentConfig } from "./agent/subagent.ts";
export { tool, toStandardToolDeclarations } from "./tools/tool.ts";
export type { CreateToolOptions } from "./tools/tool.ts";
export { zodToJsonSchema, cleanJsonSchema } from "./tools/schema.ts";
export { executeToolCalls } from "./tools/executor.ts";

// Multi-Agent Delegation & Tools
export {
  buildAgentTools,
  createSubagentSpawnTool,
} from "./agent/delegation.ts";
export type { DynamicSubagentTask } from "./agent/delegation.ts";

// Providers & Registry — unified multi-provider layer powered by Vercel AI SDK
export {
  getProvider,
  resolveModel,
  ModelProvider,
  ensureCustomProvider,
  normalizeProviderPrefix,
} from "./ai-sdk/registry.ts";
export {
  getModelFromCatalog,
  getModelThinkingInfo,
  validateModelThinking,
  getModelsForProvider,
  ThinkingLevelError,
} from "./models/catalog.ts";
export { AiSdkBaseProvider as BaseProvider } from "./ai-sdk/model-provider.ts";
export {
  mapThinkingToReasoning,
  resolveEffectiveThinking,
  mapToolChoice,
  mapThinkingToProviderOptions,
  mapServiceTierToProviderOptions,
  mapCacheToProviderOptions,
  buildAiSdkCallOptions,
  withAiSdkRetries,
  isTransientAiSdkError,
} from "./ai-sdk/options.ts";
export { toConciseProviderError, assertModalitiesSupported } from "./ai-sdk/errors.ts";

// Provider Implementations powered by Vercel AI SDK
export {
  GoogleAIStudioProvider,
  GoogleAiSdkProvider,
  OpenCodeProvider,
  OpenCodeAiSdkProvider,
  OpenRouterProvider,
  OpenRouterAiSdkProvider,
  OpenAIProvider,
  OpenAiAiSdkProvider,
  OpenAICompatibleProvider,
  CustomAiSdkProvider,
  AiSdkBaseProvider,
  createOpenAICompatibleProvider,
  createCustomProvider,
  CustomProvider,
  createGenericModelSpec,
} from "./ai-sdk/model-provider.ts";
export type { CustomProviderOptions } from "./ai-sdk/model-provider.ts";

export {
  GOOGLE_MODELS,
  OPENAI_MODELS,
  OPENCODE_MODELS,
  OPENROUTER_MODELS,
} from "./models/catalog.ts";

export {
  isValidThoughtSignature,
  retainThoughtSignature,
  extractGoogleThoughtSignature,
} from "./utils/thought-signature.ts";

export { stripSchemaForGoogle } from "./tools/schema.ts";

export {
  createExplicitCache,
  retentionToTtlSeconds,
  getPromptCacheRetention,
  clampCacheKey,
} from "./utils/cache.ts";
export type {
  CreateExplicitCacheOptions,
  CachedContentMetadata,
} from "./utils/cache.ts";


export {
  countTokens,
  estimateTokensFromText,
  estimateTokensFromMessage,
  estimateTokensFromPart,
} from "./tokens/counter.ts";

// Streaming & Events
export { AssistantMessageEventStream } from "./streaming/event-stream.ts";
export { SSEParser } from "./streaming/sse-parser.ts";

// Responses
export { AgentResponse } from "./types/response.ts";

// Utilities
export { createSessionId } from "./utils/session.ts";
export { getApiKey, getEnv } from "./utils/env.ts";
export { buildSessionHeaders } from "./utils/headers.ts";
export { normalizeMediaInput, inferMimeType } from "./utils/media.ts";
export { base64ToBytes, bytesToBase64 } from "./utils/base64.ts";
export { toJsonSafe, safeStringify } from "./utils/serialization.ts";

// Re-export Zod
export { z };

// TypeScript Type Exports
export type {
  ThinkingLevel,
  ThinkingConfig,
  CacheRetention,
  CacheConfig,
  ServiceTier,
  TokenUsage,
} from "./types/core.ts";

export type {
  Message,
  MessageRole,
  ContentPart,
  TextPart,
  ImagePart,
  AudioPart,
  VideoPart,
  FilePart,
  ToolCallPart,
  ToolResultPart,
  ThinkingPart,
  ProviderContext,
} from "./types/message.ts";

export type {
  ToolDefinition,
  ToolExecuteFn,
  ToolExecutionContext,
  ToolCallRecord,
  ToolResultRecord,
  StandardToolDeclaration,
} from "./types/tool.ts";

export type {
  ModelSpec,
  ModelCapabilities,
  Provider,
  ProviderId,
  ProviderRequestOptions,
  ProviderGenerateResult,
  ProviderRawData,
} from "./types/model.ts";

export type {
  AgentResponseJSON,
  SubAgentExecutionMetadata,
  StreamEvent,
  StreamEventType,
} from "./types/response.ts";

export type {
  AgentConfig,
  AgentRunOptions,
  DynamicSubagentsConfig,
} from "./types/agent.ts";

export type {
  ModelProviderInstance,
  ModelProviderConfig,
} from "./ai-sdk/registry.ts";
