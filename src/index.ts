import { z } from "zod";

// Core Agent & Tool Classes
export { Agent, SubAgentModelError } from "./agent/agent.ts";
export { SubAgent } from "./agent/subagent.ts";
export type { SubAgentConfig } from "./agent/subagent.ts";
export { tool, toStandardToolDeclarations } from "./tools/tool.ts";
export type { CreateToolOptions } from "./tools/tool.ts";
export { zodToJsonSchema, cleanJsonSchema } from "./tools/schema.ts";
export { executeToolCalls } from "./tools/executor.ts";

// Client-side document conversion (optional anydoc peer — see utils/documents.ts)
export {
  convertDocumentToMarkdown,
  convertDocumentInput,
  convert_document_to_markdown,
  isAnydocAvailable,
  resolveDocumentFormat,
  truncateMarkdown,
  buildDocumentXml,
  modelSupportsFileInput,
  preprocessFilePartsForBypass,
  DocumentConversionError,
  DEFAULT_DOCUMENT_MAX_CHARS,
  MAX_DOCUMENT_FETCH_BYTES,
} from "./utils/documents.ts";
export type { ConvertDocumentOptions, ConvertedDocument } from "./utils/documents.ts";

// Multi-Agent Delegation & Tools
export {
  buildAgentTools,
  agentToTool,
  createSubagentSpawnTool,
} from "./agent/delegation.ts";
export type { DynamicSubagentTask, AgentAsToolTarget } from "./agent/delegation.ts";

// Providers & Registry — unified multi-provider layer, all native REST
export {
  getProvider,
  resolveModel,
  ModelProvider,
  ensureCustomProvider,
  normalizeProviderPrefix,
} from "./providers/registry.ts";
export type {
  ModelProviderInstance,
  ModelProviderConfig,
} from "./providers/registry.ts";
export {
  getModelFromCatalog,
  getModelThinkingInfo,
  validateModelThinking,
  getModelsForProvider,
  ThinkingLevelError,
  refreshModelCatalog,
  ensureModelCatalogFresh,
  getCatalogStatus,
  setCatalogTTL,
  getCatalogTTL,
  getCacheDir,
  getCacheFilePath,
  isValidCatalogPayload,
  createGenericModelSpec,
  DEFAULT_CATALOG_TTL_MS,
  type CatalogStatus,
  type RefreshCatalogOptions,
} from "./models/catalog.ts";
export { resolveEffectiveThinking } from "./agent/agent.ts";
export { withRetries, isTransientError } from "./utils/retry.ts";
export { toConciseProviderError, assertModalitiesSupported, assertNoVideoPartsOnResponses } from "./utils/errors.ts";
// Native provider implementations. `openrouter-responses.ts` (discontinued
// beta-Responses transport) stays importable directly but is wired nowhere.
export {
  OpenAICompatibleChatProvider,
  OpenAICompatibleChatProvider as OpenAICompatibleProvider,
  createOpenAICompatibleProvider,
  createCustomProvider,
  CustomProvider,
} from "./providers/openai-compat.ts";
export type { CustomProviderOptions } from "./providers/openai-compat.ts";

// Canonical provider contract (provider-agnostic) + native adapters.
export {
  GoogleInteractionsProvider,
  GoogleInteractionsProvider as GoogleAIStudioProvider,
  clearInteractionChains,
} from "./providers/google.ts";
export {
  OpenRouterChatCompletionsProvider,
  OpenRouterChatCompletionsProvider as OpenRouterProvider,
} from "./providers/openrouter.ts";
// Discontinued beta-Responses transport, retained frozen as migration
// evidence (importable via `./providers/openrouter-responses.ts`, not wired
// anywhere): OpenRouterResponsesProvider.
export {
  OpenAIResponsesProvider,
  OpenAIResponsesProvider as OpenAIProvider,
} from "./providers/openai.ts";
export {
  emitProviderWarning,
  clearEmittedWarnings,
  noteProviderTurn,
  lastProviderFor,
  isMixedProviderSession,
  clearSessionRouting,
  mapThinkingLevelToGoogle,
  mapServiceTierToGoogle,
  applyCacheForGoogle,
  mapThinkingLevelToOpenRouter,
  mapServiceTierToOpenRouter,
  applyCacheForOpenRouter,
  mapToolChoiceToOpenRouter,
  mapThinkingLevelToOpenRouterChat,
  mapToolChoiceToOpenRouterChat,
  mapThinkingLevelToOpenAI,
  mapServiceTierToOpenAI,
  applyCacheForOpenAI,
  applyCacheForCustom,
  mapToolChoiceToOpenAI,
  normalizeToolChoice,
  parseStreamedToolArguments,
} from "./providers.ts";
export type {
  ProviderCapabilityStatus,
  CanonicalToolChoiceMode,
  OpenRouterToolChoice,
  OpenRouterChatToolChoice,
  OpenAIToolChoice,
} from "./providers.ts";

export {
  GOOGLE_MODELS,
  OPENAI_MODELS,
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
export { toJsonSafe, safeStringify, escapeXml } from "./utils/serialization.ts";

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

 // Provider wire payload types (back-compat inspection of raw requests/responses,
// e.g. `res.raw.request.body as OpenAIChatCompletionRequest`).
// NOTE: wire `OpenAIToolChoice` intentionally omitted — it duplicates the
// canonical `OpenAIToolChoice` exported above (same shape); use that one.
export type {
  GoogleThinkingLevel,
  GoogleThinkingConfig,
  GoogleFunctionCallingMode,
  GoogleFunctionCallingConfig,
  GoogleToolConfig,
  GoogleFunctionDeclaration,
  GoogleTool,
  GoogleBlob,
  GooglePart,
  GoogleContent,
  GoogleGenerationConfig,
  GoogleCandidate,
  GoogleUsageMetadata,
  GoogleGenerateContentRequest,
  GoogleGenerateContentResponse,
  OpenRouterProviderRouting,
  OpenRouterReasoning,
  OpenRouterParameters,
  OpenRouterUsage,
  OpenRouterChatRequest,
  OpenRouterResponse,
  OpenAIMessageRole,
  OpenAIReasoningEffort,
  OpenAIServiceTier,
  OpenAITextPart,
  OpenAIImageUrlPart,
  OpenAIInputAudioPart,
  OpenAIVideoUrlPart,
  OpenAIContentPart,
  OpenAIToolCall,
  OpenAIMessage,
  OpenAITool,
  OpenAIUsage,
  OpenAIChoice,
  OpenAIDelta,
  OpenAIChunkChoice,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionChunk,
} from "./types/provider-payloads.ts";
