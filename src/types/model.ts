import type { ThinkingConfig, CacheConfig, ServiceTier, TokenUsage } from "./core.ts";
import type { ProviderContext, Message, ContentPart } from "./message.ts";
import type { StandardToolDeclaration, ToolCallRecord } from "./tool.ts";
import type { AssistantMessageEventStream } from "../streaming/event-stream.ts";

// ---------------------------------------------------------------------------
// Provider identity — battle-tested: matches models.dev provider keys
// Known first-class: google | opencode | openrouter, plus aliases. Allow string for future.
// ---------------------------------------------------------------------------
export type ProviderId = "google" | "opencode" | "opencode-zen" | "opencode-go" | "openrouter" | (string & {});

// ---------------------------------------------------------------------------
// Raw models.dev shapes — battle-tested, 1:1 with https://models.dev/api.json
// ---------------------------------------------------------------------------
export interface ModelLimit {
  /** Total context window (input + output). Canonical field: limit.context */
  context: number;
  /** Max output tokens. Canonical: limit.output */
  output: number;
  /** Optional extra limits (e.g. input) */
  input?: number;
  [k: string]: unknown;
}

export interface ModelCost {
  input?: number; // $ per 1M input tokens
  output?: number; // $ per 1M output tokens
  cache_read?: number;
  cache_write?: number;
  // provider-specific: input_audio, etc.
  input_audio?: number;
  // tiered pricing when context > threshold
  tiers?: Array<{
    tier: { type: string; size: number };
    input: number;
    output: number;
    cache_read?: number;
  }>;
  context_over_200k?: { input: number; output: number; cache_read: number };
  [k: string]: unknown;
}

export interface ModelModalities {
  input: Array<"text" | "image" | "audio" | "video" | "pdf">;
  output: Array<"text" | "image" | "audio" | "video">;
}

export type ReasoningOption =
  | { type: "toggle" }
  | { type: "effort"; values: string[] }
  | { type: "budget_tokens"; min: number; max: number };

export interface RawModelData {
  id: string;
  name: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: ReasoningOption[];
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  status?: string;
  open_weights?: boolean;
  modalities?: ModelModalities;
  limit?: ModelLimit;
  cost?: ModelCost;
  provider?: { npm?: string; api?: string };
  api?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Capabilities — normalized, battle-tested from raw flags
// ---------------------------------------------------------------------------
export interface ModelCapabilities {
  supportsThinking?: boolean;
  supportsThinkingBudget?: boolean;
  supportsThinkingLevel?: boolean;
  supportsImplicitCaching?: boolean;
  supportsExplicitCaching?: boolean;
  supportsLongCacheRetention?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsStreaming?: boolean;
  modalities?: ("text" | "image" | "audio" | "video" | "pdf")[];
  // derived
  supportsReasoningToggle?: boolean;
  supportsReasoningEffort?: boolean;
}

// ---------------------------------------------------------------------------
// Pricing — normalized per-1M
// ---------------------------------------------------------------------------
export interface ModelPricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  inputAudioPerMillion?: number;
}

// ---------------------------------------------------------------------------
// ModelSpec — battle-tested, single source from models.dev
// Keep legacy aliases contextWindow/maxOutputTokens for BC, plus full raw.
// ---------------------------------------------------------------------------
export interface ModelSpec {
  id: string;
  provider: ProviderId;
  name: string;
  description?: string;
  family?: string;
  api?: string; // pi-style: openai-completions | openai-responses | anthropic-messages | google-generative-ai etc.
  /** @deprecated alias for limit.context */
  contextWindow: number;
  /** @deprecated alias for limit.output */
  maxOutputTokens: number;
  // Full battle-tested fields (optional for BC with stale per-provider files, required when from catalog)
  limit?: ModelLimit;
  cost?: ModelCost;
  modalities?: ModelModalities;
  reasoning?: boolean;
  reasoning_options?: ReasoningOption[];
  tool_call?: boolean;
  attachment?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  capabilities: ModelCapabilities;
  pricing?: ModelPricing;
  compat?: Record<string, unknown>;
  // raw passthrough for advanced checks
  raw?: RawModelData;
}

// ---------------------------------------------------------------------------
// Provider plumbing — unchanged API
// ---------------------------------------------------------------------------
export interface ProviderRequestOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  thinking?: ThinkingConfig;
  cache?: CacheConfig;
  serviceTier?: ServiceTier;
  tools?: StandardToolDeclaration[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  signal?: AbortSignal;
  sessionId?: string;
  env?: Record<string, string>;
  maxRetries?: number;
  maxRetryDelayMs?: number;
}

export interface ProviderRawData {
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
  };
}

export interface ProviderGenerateResult {
  text: string;
  thinking?: string;
  thoughtSignature?: string;
  toolCalls?: ToolCallRecord[];
  usage: TokenUsage;
  finishReason?: string;
  responseId?: string;
  model: string;
  provider: ProviderId;
  raw: ProviderRawData;
  durationMs: number;
}

export interface Provider {
  id: ProviderId;
  name: string;
  models: ModelSpec[];
  getModel(modelId: string): ModelSpec | undefined;
  generate(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): Promise<ProviderGenerateResult>;
  stream(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): AssistantMessageEventStream;
  countTokens(
    model: string | ModelSpec,
    context: ProviderContext
  ): Promise<number>;
}
