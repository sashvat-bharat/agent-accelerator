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
export type { EditableAgentConfig } from "./types/agent.ts";
export { tool } from "./tools/tool.ts";
export type { CreateToolOptions } from "./tools/tool.ts";

export { toolContent } from "./tools/tool-content.ts";
export { DEFAULT_PROMPTS } from "./prompts/prompts.ts";
export type { PromptName, PromptOverrides } from "./prompts/prompts.ts";
export type { ToolContent, ToolContentPart } from "./tools/tool-content.ts";

export { RemoteFetchError } from "./utils/safe-io.ts";

// Multi-Agent Delegation & Tools
export {
  buildAgentTools,
  agentToTool,
} from "./agent/delegation.ts";
export type { AgentAsToolTarget, SubAgentTrace } from "./agent/delegation.ts";
export type { WorkerRegistry, WorkerSpec, WorkerInfo, WorkerReply, WorkerCallOptions } from "./agent/workers.ts";

// Scheduled actions: dynamic sub-agents that run later and save their answer to a file (use `agent.scheduled`)
export type { ScheduledActions } from "./scheduler/scheduler.ts";
export { getDatetimeTool } from "./scheduler/tool.ts";
export { setHome, resolveHome } from "./utils/home.ts";
export { getConcurrencyStatus } from "./agent/governor.ts";
export { setModels, listModels, setModel, setSubAgentModel } from "./config/models.ts";
export type { ModelList, ModelOption } from "./config/models.ts";
export { setConfigs, getConfigs, setConfig } from "./config/settings.ts";
export type { SettingKey, SettingsJson } from "./config/settings.ts";
export type { GovernorLimits } from "./agent/governor.ts";
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
  createGenericModelSpec,
  type CatalogStatus,
  type RefreshCatalogOptions,
} from "./models/catalog.ts";

export { listImageModels, getImageModel } from "./models/image-models.ts";
export { generateImage } from "./image/generate.ts";
export { imageTool } from "./image/tool.ts";
export type { ImageToolOptions, ImageToolOption } from "./image/tool.ts";
export { ImageResult, GeneratedImage } from "./image/result.ts";
export type {
  ImageOptions,
  ImageEditOptions,
  ImageInput,
  ImageResolution,
  ImageFormat,
} from "./types/image.ts";
export type { ImageModelInfo } from "./models/image-models.ts";
export type { CatalogProvider } from "./models/catalog-shards.ts";
export { listEmbeddingModels, getEmbeddingModel } from "./models/embedding-models.ts";
export type { EmbeddingModelInfo } from "./models/embedding-models.ts";
export { refreshOpenRouterEmbeddingModels } from "./models/openrouter-embeddings.ts";
export type { RefreshOpenRouterEmbeddingsOptions } from "./models/openrouter-embeddings.ts";
export { generateEmbedding } from "./embedding/generate.ts";
export { cosineSimilarity } from "./embedding/similarity.ts";
export { EmbeddingResult } from "./embedding/result.ts";
export { EMBEDDING_TASKS } from "./types/embedding.ts";
export type {
  EmbeddingOptions,
  EmbeddingItem,
  EmbeddingPart,
  EmbeddingTask,
  EmbeddingPartData,
} from "./types/embedding.ts";
export { listDecisionModels, getDecisionModel } from "./models/decision-models.ts";
export type { DecisionModelInfo } from "./models/decision-models.ts";
export { refreshOpenRouterDecisionModels } from "./models/openrouter-decisions.ts";
export type { RefreshOpenRouterDecisionsOptions } from "./models/openrouter-decisions.ts";
export { generateDecision } from "./decision/generate.ts";
export { DecisionResult } from "./decision/result.ts";
export { DECISION_QUESTION_TYPES } from "./types/decision.ts";
export type {
  DecisionOptions,
  DecisionInput,
  DecisionPart,
  DecisionJsonPart,
  DecisionInstructions,
  DecisionQuestion,
  DecisionQuestionType,
  DecisionAnswer,
} from "./types/decision.ts";
export { listVideoModels, getVideoModel } from "./models/video-models.ts";
export type { VideoModelInfo } from "./models/video-models.ts";
export { refreshOpenRouterVideoModels } from "./models/openrouter-videos.ts";
export type { RefreshOpenRouterVideosOptions } from "./models/openrouter-videos.ts";
export { generateVideo } from "./video/generate.ts";
export { resumeVideo } from "./video/resume.ts";
export { VideoResult, GeneratedVideo } from "./video/result.ts";
export type {
  VideoOptions,
  VideoInput,
  VideoProgress,
  VideoEditOptions,
  ResumeVideoOptions,
} from "./types/video.ts";

export { withRetries, isTransientError } from "./utils/retry.ts";

// Native provider implementations.

// Canonical provider contract (provider-agnostic) + native adapters.

export { modelSupportsStructuredOutput } from "./models/catalog.ts";

// Streaming & Events
export { AssistantMessageEventStream } from "./streaming/event-stream.ts";

// Responses
export { AgentResponse } from "./types/response.ts";

// Testing: a scripted model (no network, no cost) for testing your own agents
export { fauxProvider } from "./testing/faux.ts";
export type {
  FauxProvider,
  FauxProviderOptions,
  FauxReply,
  FauxRequest,
  FauxStep,
  FauxToolCall,
} from "./testing/faux.ts";

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
  ModelNotAllowedError,
  SettingNotEditableError,
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
  findLatestSessionDir,
  sessionDirFor,
} from "./session/store.ts";
export type { UsageReport, UsageLine, UsageTotals, AgentUsage, WorkerUsage, CostSource } from "./session/usage.ts";
export type {
  SessionLimits,
  PersistedAgentSession,
  SessionTotals,
  LoadedSessionDir,
} from "./session/store.ts";

// Utilities
export { createSessionId } from "./utils/session.ts";
export { setAttribution } from "./utils/headers.ts";
export type { AttributionConfig } from "./utils/headers.ts";
export { normalizeMediaInput, inferMimeType, sniffMimeType } from "./utils/media.ts";

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
  MediaResolution,
  VideoProcessing,
} from "./types/message.ts";

export type {
  ToolDefinition,
  ToolExecuteFn,
  ToolExecutionContext,
  ToolCallRecord,
  ToolResultRecord,
  ToolEmitFn,
} from "./types/tool.ts";

export type {
  ModelSpec,
  ModelCapabilities,
  Provider,
  ProviderId,
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
  SubAgentSpec,
  MidSessionConfig,
  MidSessionMode,
  WhenBusyMode,
  ModelRef,
  ThinkingOption,
  StructuredOutputOption,
  RetryPolicyConfig,
  ToolChoiceOption,
  Budget,
  BudgetState,
  SubAgentRunIds,
  InterruptedRun,
} from "./types/agent.ts";

// Minimalist core: harness modules (RLM/RSI, OTel, CLI doctor,
// context-ops, run-tree/record, session-store, legacy wire types) live in userland.
