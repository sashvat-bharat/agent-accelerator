import type { AssistantMessageEventStream as AssistantMessageEventStreamT } from "./streaming/event-stream.ts";
import type { AgentResponse as AgentResponseT } from "./types/response.ts";

// Public barrel: the one entry point of the package (`main`/`module`/`types`). `run()` is the canonical way to run an
// agent and `stream()` the canonical way to iterate events; `ask()` and `run(..., { stream: true })` remain as shorthands.

/** The `AssistantMessageEventStream` returned by `stream()`/`run(stream:true)`, typed with its terminal `result()` and `cancel()`. */
export type Run = AssistantMessageEventStreamT & {
  result: () => Promise<AgentResponseT>;
  cancel: (reason?: unknown) => void;
};

// Core Agent & Tool Classes
export { Agent, SubAgentModelError } from "./agent/agent.ts";
/**
 * @deprecated Compat alias: prefer composing a plain `Agent` and exposing it
 * via `agentToTool()`/`buildAgentTools()` (or `subagents: [...]`). `SubAgent`
 * stays for compat and receives no new features.
 */
export { SubAgent, agentFromEnv } from "./agent/subagent.ts";
export type { SubAgentConfig } from "./agent/subagent.ts";
export type { EditableAgentConfig } from "./types/agent.ts";
export {
  tool,
  toStandardToolDeclarations,
  assertValidToolName,
  TOOL_NAME_PATTERN,
  normalizeThinkingV2,
  resolveWhenBusy,
  normalizeMaxAttempts,
} from "./tools/tool.ts";
export type { CreateToolOptions } from "./tools/tool.ts";
export { zodToJsonSchema, cleanJsonSchema } from "./tools/schema.ts";
export { toolContent } from "./tools/tool-content.ts";
export { DEFAULT_PROMPTS } from "./prompts/prompts.ts";
export type { PromptName, PromptOverrides } from "./prompts/prompts.ts";
export type { ToolContent, ToolContentPart } from "./tools/tool-content.ts";
/**
 * @deprecated Internal executor surface. Prefer `Agent` runs; for direct
 * execution import from the future `/internal` entry.
 */
export { executeToolCalls } from "./tools/executor.ts";

export {
  assertPathAllowed,
  enforceFileAccess,
  fetchRemoteBytes,
  isPrivateAddress,
  RemoteFetchError,
  MAX_REMOTE_FETCH_BYTES,
} from "./utils/safe-io.ts";

// Multi-Agent Delegation & Tools
export {
  buildAgentTools,
  agentToTool,
  createChildSessionId,
  createFixedChildSessionId,
  isSessionDescendant,
  checkBudget,
  chargeBudgetUsage,
  reserveSpawn,
} from "./agent/delegation.ts";
export type { AgentAsToolTarget, SubAgentTrace } from "./agent/delegation.ts";
export type { WorkerRegistry, WorkerSpec, WorkerInfo, WorkerReply, WorkerCallOptions } from "./agent/workers.ts";

// Scheduled actions: dynamic sub-agents that run later and save their answer to a file (use `agent.scheduled`)
export type { ScheduledActions } from "./scheduler/scheduler.ts";
export { getDatetimeTool } from "./scheduler/tool.ts";
export { setHome, resolveHome } from "./utils/home.ts";
export { configure } from "./agent/defaults.ts";
export type { AgentDefaults } from "./agent/defaults.ts";
export type {
  ScheduledActionInput,
  ScheduledActionPatch,
  ScheduledActionRecord,
  ScheduledDelivery,
  ScheduledState,
  ScheduledRunStatus,
  ScheduleSpec,
  DeleteResult,
} from "./types/scheduler.ts";

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
  registerModel,
  clearCustomModels,
  getModelSource,
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
export { resolveEffectiveThinking } from "./agent/options.ts";
export { withRetries, isTransientError } from "./utils/retry.ts";
export { toConciseProviderError, assertModalitiesSupported, assertNoVideoPartsOnResponses } from "./utils/errors.ts";
// Native provider implementations.
export {
  OpenAICompatibleChatProvider,
  createOpenAICompatibleProvider,
  createCustomProvider,
  CustomProvider,
} from "./providers/openai-compat.ts";
export type { CustomProviderOptions } from "./providers/openai-compat.ts";

// Canonical provider contract (provider-agnostic) + native adapters.
export {
  GoogleInteractionsProvider,
  clearInteractionChains,
} from "./providers/google.ts";
export { OpenRouterChatCompletionsProvider } from "./providers/openrouter.ts";
export { OpenAIResponsesProvider } from "./providers/openai.ts";
/**
 * @deprecated Internal provider mappers/routing helpers. Prefer the
 * provider-agnostic registry (`resolveModel`/`getProvider`); direct mapper
 * use moves to the future `/internal` entry.
 */
export {
  emitProviderWarning,
  clearEmittedWarnings,
  noteProviderTurn,
  lastProviderFor,
  isMixedProviderSession,
  clearSessionRouting,
  mapThinkingLevelToGoogle,
  mapServiceTierToGoogle,
  mapServiceTierToOpenRouter,
  mapThinkingLevelToOpenRouterChat,
  mapToolChoiceToOpenRouterChat,
  mapThinkingLevelToOpenAI,
  mapServiceTierToOpenAI,
  resolveCache,
  mapToolChoiceToOpenAI,
  normalizeToolChoice,
  parseStreamedToolArguments,
  selectRawArguments,
  normalizeStructuredOutput,
  extractOutputValidator,
  parseStructuredOutput,
  mapOutputToOpenAI,
  mapOutputToGoogle,
  mapOutputToOpenRouterChat,
  mapOutputToCompatChat,
  buildStructuredOutputInstruction,
  augmentSystemPromptWithStructuredOutput,
} from "./providers.ts";
export type {
  ProviderCapabilityStatus,
  CanonicalToolChoiceMode,
  OpenRouterChatToolChoice,
  OpenAIToolChoice,
  ChatCompletionsResponseFormat,
} from "./providers.ts";

export {
  GOOGLE_MODELS,
  OPENAI_MODELS,
  OPENROUTER_MODELS,
  modelSupportsStructuredOutput,
} from "./models/catalog.ts";
export {
  hasAuthHeader,
  clampToolCallId,
  hasTruncatedToolArguments,
  shortHashId,
} from "./providers/shared.ts";

export {
  isValidThoughtSignature,
  retainThoughtSignature,
  extractGoogleThoughtSignature,
} from "./utils/thought-signature.ts";

export { stripSchemaForGoogle } from "./tools/schema.ts";

export { clampCacheKey } from "./utils/cache.ts";

// Streaming & Events
export { AssistantMessageEventStream } from "./streaming/event-stream.ts";
export type { SteerEntry } from "./agent/loop.ts";

// Responses
export { AgentResponse } from "./types/response.ts";

// Core error taxonomy (core surface)
export {
  AgentAccelError,
  ConfigError,
  ProviderError,
  TimeoutError,
  BudgetExceededError,
  ToolError,
  ValidationError,
  SessionLoadError,
  SecurityPolicyError,
  isAbortError,
  formatErrorPlain,
} from "./types/errors.ts";
export type { AgentAccelErrorCode, AgentAccelErrorContext } from "./types/errors.ts";
// Normalized run limits (sub-agents inherit unless overridden)
export type { AgentRunLimits } from "./agent/options.ts";

// Telemetry bus: warnings, anomalies and per-turn thinking traces (attach with `telemetryBus.onEvent`)
export { telemetryBus } from "./telemetry.ts";
export type { TelemetryEvent, TelemetryListener } from "./telemetry.ts";

// Session persistence & telemetry (conversation history + cost rollup)
export {
  SessionTelemetry,
  loadSessionFile,
  saveSessionFile,
  loadSessionDir,
  saveSessionDir,
  writeFileAtomic,
  findLatestSessionDir,
  sessionDirFor,
  extractMediaToDir,
  resolveMediaPaths,
  buildSessionData,
  serializeSession,
  deserializeSession,
  inspectSessionPayload,
  findInvalidMessage,
  getSessionContextWindow,
  computeSessionTurnCost,
  formatSessionTokens,
  formatSessionCost,
  formatSessionBanner,
  emptyTotals,
} from "./session/store.ts";
export type { UsageReport, UsageLine, UsageTotals, AgentUsage, WorkerUsage, CostSource } from "./session/usage.ts";
export type {
  SessionLimits,
  SessionPayloadStatus,
  PersistedAgentSession,
  SessionTotals,
  SessionAgentLike,
  LoadedSessionDir,
  PersistedSubAgentTrace,
  SessionRunMark,
  SessionRunEnd,
  SessionPending,
  SessionPendingPrompt,
  SessionToolRecord,
} from "./session/store.ts";

// Utilities
/**
 * @deprecated Session-routing internals. Prefer agent-level `sessionId`;
 * direct use moves to the future `/internal` entry.
 */
export {
  createSessionId,
  hashSessionPart,
  createTrackingId,
  nowMs,
  newRunId,
  newTurnId,
  previewPrompt,
  parseModelRef,
} from "./utils/session.ts";
export type { ParsedModelRef } from "./utils/session.ts";
/**
 * @deprecated Raw env access. Prefer explicit `Agent` config (which wins over
 * env) and `Agent.fromEnv()`/`agentFromEnv()`; direct use moves to the future
 * `/internal` entry.
 */
export { getApiKey, getEnv } from "./utils/env.ts";
export { buildSessionHeaders, setAttribution, getAttribution } from "./utils/headers.ts";
export type { AttributionConfig } from "./utils/headers.ts";
export { normalizeMediaInput, inferMimeType, sniffMimeType } from "./utils/media.ts";
export { base64ToBytes, bytesToBase64 } from "./utils/base64.ts";
export { toJsonSafe, safeStringify, escapeXml } from "./utils/serialization.ts";

export { CACHE_OPTIONS } from "./types/core.ts";

// TypeScript Type Exports
export type {
  ThinkingLevel,
  ThinkingConfig,
  CacheOption,
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
  ProviderSteps,
  MediaResolution,
  VideoProcessing,
} from "./types/message.ts";

export type {
  ToolDefinition,
  ToolExecuteFn,
  ToolExecutionContext,
  ToolCallRecord,
  ToolResultRecord,
  StandardToolDeclaration,
  ToolLogger,
  ToolEmitFn,
} from "./types/tool.ts";

export type {
  ModelSpec,
  ModelCapabilities,
  Provider,
  ProviderId,
  ProviderRequestOptions,
  ProviderGenerateResult,
  ProviderRawData,
  StructuredOutputSpec,
} from "./types/model.ts";

export type {
  AgentResponseJSON,
  SubAgentExecutionMetadata,
  SubAgentStep,
  StreamEvent,
  StreamEventType,
} from "./types/response.ts";

export type {
  AgentConfig,
  AgentRunOptions,
  AgentTurnEvent,
  DynamicSubagentsConfig,
  MidSessionConfig,
  MidSessionMode,
  WhenBusyMode,
  ModelRef,
  ThinkingOption,
  StructuredOutputOption,
  RetryPolicyConfig,
  AgentLogger,
  ToolChoiceOption,
  Budget,
  BudgetState,
  SubAgentRunIds,
  InterruptedRun,
} from "./types/agent.ts";

// Minimalist core: harness modules (RLM/RSI, OTel, testing, CLI doctor, hooks,
// context-ops, run-tree/record, session-store, legacy wire types) live in userland.
