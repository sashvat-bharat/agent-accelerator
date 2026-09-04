import { z } from "zod";

// Core Agent & Tool Classes
export { Agent, SubAgentModelError } from "./agent/agent.ts";
export { tool, toStandardToolDeclarations } from "./tools/tool.ts";
export { zodToJsonSchema, cleanJsonSchema } from "./tools/schema.ts";
export { executeToolCalls } from "./tools/executor.ts";

// Multi-Agent Orchestration
export {
  agentToTool,
  buildAgentTools,
  createSubagentSpawnTool,
} from "./agent/orchestrator.ts";
export type { DynamicSubagentTask } from "./agent/orchestrator.ts";

// Providers & Registry — unified multi-provider layer (OpenRouter-style, no 5% fee)
export {
  getProvider,
  resolveModel,
  ModelProvider,
  ensureCustomProvider,
  normalizeProviderPrefix,
} from "./providers/registry.ts";
export {
  getModelFromCatalog,
  getModelThinkingInfo,
  validateModelThinking,
  getModelsForProvider,
  ThinkingLevelError,
} from "./models/catalog.ts";
export { BaseProvider } from "./providers/base.ts";

// Provider Implementations & Models (Single ultra-clean modular files)
export {
  GoogleAIStudioProvider,
  GOOGLE_MODELS,
  createExplicitCache,
  isValidThoughtSignature,
  retainThoughtSignature,
  stripSchemaForGoogle,
} from "./providers/google.ts";
export type {
  GoogleGenerateContentRequest,
  GoogleGenerateContentResponse,
  GoogleContent,
  GooglePart,
  GoogleBlob,
  GoogleFunctionDeclaration,
  GoogleTool,
  GoogleToolConfig,
  GoogleThinkingConfig,
  GoogleThinkingLevel,
  GoogleGenerationConfig,
  GoogleCandidate,
  GoogleUsageMetadata,
  CreateExplicitCacheOptions,
  CachedContentMetadata,
} from "./providers/google.ts";

export {
  OpenCodeProvider,
  OPENCODE_MODELS,
} from "./providers/opencode.ts";
export type {
  OpenCodeChatRequest,
  OpenCodeResponsesRequest,
  OpenCodeResponsesInputItem,
  OpenCodeResponsesOutputItem,
  OpenCodeChatResponse,
  OpenCodeResponsesResponse,
  OpenCodeUsage,
  OpenCodePromptCacheRetention,
  OpenCodeReasoningEffort,
  OpenCodeCacheControl,
} from "./providers/opencode.ts";

export {
  OpenRouterProvider,
  OPENROUTER_MODELS,
} from "./providers/openrouter.ts";
export type {
  OpenRouterChatRequest,
  OpenRouterResponse,
  OpenRouterUsage,
  OpenRouterReasoning,
  OpenRouterParameters,
  OpenRouterProviderRouting,
} from "./providers/openrouter.ts";

export {
  OpenAIProvider,
  OPENAI_MODELS,
  extractGoogleThoughtSignature,
} from "./providers/openai.ts";
export type {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionChunk,
  OpenAIMessage,
  OpenAIMessageRole,
  OpenAIContentPart,
  OpenAITextPart,
  OpenAIImageUrlPart,
  OpenAIInputAudioPart,
  OpenAIVideoUrlPart,
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolChoice,
  OpenAIReasoningEffort,
  OpenAIServiceTier,
  OpenAIUsage,
  OpenAIChoice,
  OpenAIDelta,
  OpenAIChunkChoice,
} from "./providers/openai.ts";

export {
  OpenAICompatibleProvider,
  createOpenAICompatibleProvider,
  createCustomProvider,
  CustomProvider,
  createGenericModelSpec,
} from "./providers/custom.ts";
export type { CustomProviderOptions } from "./providers/custom.ts";
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
} from "./types/agent.ts";

export type {
  ModelProviderInstance,
  ModelProviderConfig,
} from "./providers/registry.ts";
