import type { ProviderId, ModelSpec } from "./model.ts";
import type { ToolDefinition } from "./tool.ts";
import type {
  ThinkingLevel,
  CacheConfig,
  ServiceTier,
} from "./core.ts";
import type { ModelProviderInstance } from "../ai-sdk/registry.ts";
import type { Agent } from "../agent/agent.ts";

/** Configuration used to construct an {@link Agent}. */
export interface AgentConfig {
  /** Display name used in tool and sub-agent metadata. */
  name?: string;
  /** Human-readable description used when this agent is delegated to. */
  description?: string;
  /** Stable system instructions for the agent. */
  instructions?: string;
  /** Model string (`provider/model`), catalog spec, or ModelProvider helper result. */
  model?: string | ModelSpec | ModelProviderInstance;
  /** Developer-only model for dynamically spawned sub-agents. Never exposed to the Main Agent LLM. */
  subagentModel?: string | ModelSpec | ModelProviderInstance;
  /** Dynamic sub-agent spawning policy. `subagents` lists pre-defined workers; this enables LLM-spawned stateless workers. */
  dynamicSubagents?: DynamicSubagentsConfig;
  /** Per-agent API key override. */
  apiKey?: string;
  /** Per-agent provider base URL override. */
  baseUrl?: string;
  /** Tools exposed to the model, keyed by name or supplied as an array. */
  tools?: Record<string, ToolDefinition> | ToolDefinition[];
  /** Requested reasoning level, validated against the model catalog. */
  thinkingLevel?: ThinkingLevel;
  /** Prompt-cache retention and session-affinity settings. */
  cache?: CacheConfig;
  /** Provider service tier, when supported. */
  serviceTier?: ServiceTier;
  /** Stable conversation/cache session ID. */
  sessionId?: string;
  /** Headers merged into every provider request. */
  headers?: Record<string, string>;
  /** Maximum model/tool turns per run. Defaults to 10. */
  maxTurns?: number;
  /** Fixed worker agents exposed as delegation tools. */
  subagents?: (Agent | { name: string; description: string; agent: Agent })[];
  /** Clears conversation state before and after every run. */
  stateless?: boolean;
}

/** Developer-configured policy for LLM-spawned dynamic sub-agents. */
export interface DynamicSubagentsConfig {
  /** Enables the automatic `spawn_subagents` tool. Defaults to true when the object is present. */
  enabled?: boolean;
  /** Developer-only worker model override. Never choosable by the Main Agent LLM. Falls back to top-level `subagentModel`, then `SUB_AGENT_MODEL` env, then the parent model. */
  model?: string | ModelSpec | ModelProviderInstance;
  /** Max workers the Main Agent may spawn in a single `spawn_subagents` call. Extras are trimmed safely. Defaults to 4. */
  maxSpawn?: number;
  /** Fixed reasoning level for all dynamic workers. The Main Agent cannot override it. Falls back to the parent level when omitted. */
  thinkingLevel?: ThinkingLevel;
  /** Tool pool available to dynamic workers. Workers receive zero tools unless the Main Agent grants a per-task `tools` subset by name. */
  tools?: Record<string, ToolDefinition> | ToolDefinition[];
  /** Per-worker timeout in ms. `0` (default) = no limit. `-1` = the Main Agent sets a per-task `timeoutMs`. `>0` = fixed timeout for every worker. */
  timeout?: number;
}

/** Per-run overrides for {@link Agent.run}, {@link Agent.ask}, and {@link Agent.stream}. */
export interface AgentRunOptions {
  /** Per-run reasoning-level override, validated against the selected model. */
  thinkingLevel?: ThinkingLevel;
  /** Return a streaming object instead of waiting for a final response. */
  stream?: boolean;
  /** Cancels provider, tool, and sub-agent work. */
  signal?: AbortSignal;
  /** Overrides the agent session for this run. */
  sessionId?: string;
  /** Context added only to this user turn, preserving the stable system prompt. */
  additionalContext?: string;
  /** Headers merged for this run only. */
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
