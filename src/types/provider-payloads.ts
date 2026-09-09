/**
 * Provider wire payload and schema types for complete backwards compatibility.
 * All providers use Vercel AI SDK under the hood, but these types allow existing
 * applications and tests to type-check requests and responses seamlessly.
 */

// ============================================================================
// Google AI Studio Payload Types
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
}

export interface GoogleTool {
  functionDeclarations?: GoogleFunctionDeclaration[];
}

export interface GoogleBlob {
  mimeType: string;
  data: string; // base64
}

export interface GooglePart {
  text?: string;
  inlineData?: GoogleBlob;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
    thoughtSignature?: string;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    id?: string;
  };
  thought?: boolean;
  thoughtSignature?: string;
}

export interface GoogleContent {
  role: "user" | "model" | "function";
  parts: GooglePart[];
}

export interface GoogleGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  candidateCount?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  responseMimeType?: string;
  thinkingConfig?: GoogleThinkingConfig;
}

export interface GoogleCandidate {
  content?: GoogleContent;
  finishReason?: string;
  index?: number;
  safetyRatings?: Array<Record<string, unknown>>;
  groundingMetadata?: Record<string, unknown>;
}

export interface GoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface GoogleGenerateContentRequest {
  contents: GoogleContent[];
  systemInstruction?: GoogleContent | { parts: GooglePart[] };
  tools?: GoogleTool[];
  toolConfig?: GoogleToolConfig;
  generationConfig?: GoogleGenerationConfig;
  cachedContent?: string;
}

export interface GoogleGenerateContentResponse {
  candidates?: GoogleCandidate[];
  usageMetadata?: GoogleUsageMetadata;
  modelVersion?: string;
}

// ============================================================================
// OpenCode Payload Types
// ============================================================================

export type OpenCodeReasoningEffort = "low" | "medium" | "high";
export type OpenCodePromptCacheRetention = "none" | "1h" | "24h";

export interface OpenCodeCacheControl {
  type: "ephemeral";
  ttl?: "1h";
}

export interface OpenCodeUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_read?: number;
    cache_creation?: number;
  };
}

export interface OpenCodeChatRequest {
  model: string;
  messages: any[];
  tools?: any[];
  tool_choice?: any;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  reasoning_effort?: OpenCodeReasoningEffort;
  prompt_cache_retention?: OpenCodePromptCacheRetention;
  session_id?: string;
}

export interface OpenCodeChatResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: any;
    delta?: any;
    finish_reason?: string;
  }>;
  usage?: OpenCodeUsage;
}

export interface OpenCodeResponsesInputItem {
  role: string;
  content: any;
  cache_control?: OpenCodeCacheControl;
}

export interface OpenCodeResponsesOutputItem {
  id?: string;
  type?: string;
  status?: string;
  content?: any;
  name?: string;
  call_id?: string;
  arguments?: string;
}

export interface OpenCodeResponsesRequest {
  model: string;
  input: OpenCodeResponsesInputItem[];
  tools?: any[];
  parameters?: Record<string, unknown>;
  session_id?: string;
}

export interface OpenCodeResponsesResponse {
  id?: string;
  output?: OpenCodeResponsesOutputItem[];
  usage?: OpenCodeUsage;
}

// ============================================================================
// OpenRouter Payload Types
// ============================================================================

export interface OpenRouterProviderRouting {
  order?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
  ignore?: string[];
  quantizations?: string[];
}

export interface OpenRouterReasoning {
  effort?: "high" | "medium" | "low";
  max_tokens?: number;
  exclude?: boolean;
}

export interface OpenRouterParameters {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  seed?: number;
  stop?: string | string[];
  repetition_penalty?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  reasoning?: OpenRouterReasoning;
  provider?: OpenRouterProviderRouting;
  transforms?: string[];
  models?: string[];
  route?: "fallback";
}

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  total_cost?: number;
}

export interface OpenRouterChatRequest {
  model: string;
  messages: any[];
  tools?: any[];
  tool_choice?: any;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  seed?: number;
  stop?: string | string[];
  reasoning?: OpenRouterReasoning;
  provider?: OpenRouterProviderRouting;
  transforms?: string[];
  models?: string[];
  route?: "fallback";
}

export interface OpenRouterResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: any;
    delta?: any;
    finish_reason?: string;
  }>;
  usage?: OpenRouterUsage;
}

// ============================================================================
// OpenAI Payload Types
// ============================================================================

export type OpenAIMessageRole = "system" | "user" | "assistant" | "tool";
export type OpenAIReasoningEffort = "low" | "medium" | "high";
export type OpenAIServiceTier = "auto" | "default";

export interface OpenAITextPart {
  type: "text";
  text: string;
}

export interface OpenAIImageUrlPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export interface OpenAIInputAudioPart {
  type: "input_audio";
  input_audio: {
    data: string;
    format: "wav" | "mp3";
  };
}

export interface OpenAIVideoUrlPart {
  type: "video_url";
  video_url: {
    url: string;
  };
}

export type OpenAIContentPart =
  | OpenAITextPart
  | OpenAIImageUrlPart
  | OpenAIInputAudioPart
  | OpenAIVideoUrlPart;

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
}

export interface OpenAIMessage {
  role: OpenAIMessageRole;
  content: string | OpenAIContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  reasoning_content?: string;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type OpenAIToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface OpenAIChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    reasoning_content?: string;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: {
      name?: string;
      arguments?: string;
    };
    extra_content?: {
      google?: {
        thought_signature?: string;
      };
    };
  }>;
}

export interface OpenAIChunkChoice {
  index: number;
  delta: OpenAIDelta;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  reasoning_effort?: OpenAIReasoningEffort;
  service_tier?: OpenAIServiceTier;
  response_format?: { type: "text" | "json_object" };
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
  service_tier?: string;
  system_fingerprint?: string;
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChunkChoice[];
  usage?: OpenAIUsage;
  system_fingerprint?: string;
}
