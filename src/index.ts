import { z } from "zod";

// Core Agent & Tool Classes
export { Agent } from "./agent/agent.ts";
export { tool, toStandardToolDeclarations } from "./tools/tool.ts";
export { zodToJsonSchema, cleanJsonSchema } from "./tools/schema.ts";
export { executeToolCalls } from "./tools/executor.ts";

export { defineSkill } from "./skills/skill.ts";
export { loadSkill } from "./skills/loader.ts";
export { Skill } from "./types/skill.ts";

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
} from "./models/catalog.ts";
export { BaseProvider } from "./providers/base.ts";
export { GoogleAIStudioProvider } from "./providers/google/index.ts";
export { OpenCodeProvider } from "./providers/opencode/index.ts";
export { OpenRouterProvider } from "./providers/openrouter/index.ts";
export { OpenAIProvider } from "./providers/openai/index.ts";
export {
  OpenAICompatibleProvider,
  createOpenAICompatibleProvider,
  createCustomProvider,
  CustomProvider,
  createGenericModelSpec,
} from "./providers/custom/index.ts";
export type { CustomProviderOptions } from "./providers/custom/index.ts";
export { GOOGLE_MODELS } from "./providers/google/models.ts";
export { OPENCODE_MODELS } from "./providers/opencode/models.ts";
export { OPENROUTER_MODELS } from "./providers/openrouter/models.ts";
export { OPENAI_MODELS } from "./providers/openai/models.ts";

// Caching & Token Counting (Google explicit: REST cachedContents per gemini-documentation/context-caching.md)
export {
  createExplicitCache,
} from "./providers/google/cache.ts";
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
  SkillDefinition,
  SkillMetadata,
} from "./types/skill.ts";

export type {
  ModelProviderInstance,
  ModelProviderConfig,
} from "./providers/registry.ts";
