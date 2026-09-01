import type { ProviderId, ModelSpec } from "./model.ts";
import type { ToolDefinition } from "./tool.ts";
import type {
  ThinkingLevel,
  CacheConfig,
  ServiceTier,
} from "./core.ts";
import type { Skill } from "./skill.ts";
import type { ModelProviderInstance } from "../providers/registry.ts";
import type { Agent } from "../agent/agent.ts";

export interface AgentConfig {
  name?: string;
  description?: string;
  instructions?: string;
  model?: string | ModelSpec | ModelProviderInstance;
  SubAgentModel?: string | ModelSpec | ModelProviderInstance;
  apiKey?: string;
  baseUrl?: string;
  tools?: Record<string, ToolDefinition> | ToolDefinition[];
  functions?: ((...args: any[]) => any)[];
  skills?: Skill[];
  CustomAgents?: (Agent | { name: string; description: string; agent: Agent })[];
  ThinkingLevel?: ThinkingLevel;
  cache?: CacheConfig;
  ServiceTier?: ServiceTier;
  sessionId?: string;
  headers?: Record<string, string>;
  maxTurns?: number;
  EnableSubagents?: boolean;
}

export interface AgentRunOptions {
  stream?: boolean;
  signal?: AbortSignal;
  sessionId?: string;
  additionalContext?: string;
  headers?: Record<string, string>;
  /** Called for each text delta as it streams (only when stream:true). */
  onDelta?: (delta: string, event: import("./response.ts").StreamEvent) => void;
  /** Called for each thinking/reasoning delta (only when stream:true). */
  onThinkingDelta?: (delta: string, event: import("./response.ts").StreamEvent) => void;
  /** Called for every stream event (text_delta, thinking_delta, tool_call_complete, subagent_complete, etc.). */
  onEvent?: (event: import("./response.ts").StreamEvent) => void;
  /** When true, wraps reasoning stream as <think>\n...\n</think>\n\n — no manual isThinking needed. */
  wrapThinking?: boolean;
}
