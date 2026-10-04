import type { TokenUsage } from "./core.ts";
import type { ToolCallRecord, ToolResultRecord } from "./tool.ts";
import type { ProviderRawData, ProviderId } from "./model.ts";

/** One logged step inside a sub-agent worker run (surfaced via `agent.track(id)`). */
export interface SubAgentStep {
  turn: number;
  type: "assistant" | "tool_call" | "tool_result";
  name?: string;
  text?: string;
  thinking?: string;
  isError?: boolean;
  timestamp: number;
  /** True while the worker is still streaming this step; finalized on turn end. */
  partial?: boolean;
}

/** Per-worker result and usage metadata attached to an AgentResponse. */
export interface SubAgentExecutionMetadata {
  name: string;
  role?: string;
  task: string;
  model: string;
  provider: ProviderId | string;
  durationMs: number;
  usage: TokenUsage;
  turns: number;
  finishReason?: string;
  responseId?: string;
  text: string;
  thinking?: string;
  toolCalls?: ToolCallRecord[];
  raw?: ProviderRawData;
  isError?: boolean;
  error?: string;
  /** Stable display id: `SUBAGENT-NAME-{TrackingID}` (32-char hex, see `createTrackingId`). */
  trackingId?: string;
  /** Provider session id used by this worker (≤64 chars, affinity-safe). */
  sessionId?: string;
  /** Parent session this worker was spawned from. */
  parentSessionId?: string;
  /** Ordered step log for this worker (also persisted in the session file). */
  steps?: SubAgentStep[];
}

/** Canonical finish reasons surfaced on AgentResponse (provider-agnostic).
 * Vendors use varied strings (`end_turn`, `stop_sequence`, `max_tokens`,
 * `tool_use`, ...); adapters map them to these values and preserve the
 * original in `rawFinishReason`. Unknown non-empty reasons map to `"error"`.
 * The `(string & {})` extension keeps vendor passthrough assignable at
 * provider call sites that forward raw strings (normalize with
 * `normalizeFinishReason` to canonicalize). */
export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "refusal"
  | "max_turns"
  | "error"
  | (string & {});

/** Maps a vendor finish reason to canonical FinishReason + raw passthrough.
 * Known aliases collapse to the canonical set; empty/undefined stays
 * undefined; any other non-empty string maps to `"error"` with the original
 * preserved in `rawFinishReason` (Q-04). */
export function normalizeFinishReason(raw?: string): {
  finishReason?: FinishReason;
  rawFinishReason?: string;
} {
  if (raw === undefined || raw === null || raw === "") return {};
  const r = String(raw);
  const lower = r.toLowerCase();
  const map: Record<string, FinishReason> = {
    stop: "stop",
    end_turn: "stop",
    stop_sequence: "stop",
    completed: "stop",
    complete: "stop",
    done: "stop",
    tool_calls: "tool_calls",
    tool_use: "tool_calls",
    function_call: "tool_calls",
    tool_call: "tool_calls",
    length: "length",
    max_tokens: "length",
    max_turns: "max_turns",
    content_filter: "content_filter",
    refusal: "refusal",
    refused: "refusal",
    error: "error",
    failed: "error",
    cancelled: "error",
    canceled: "error",
  };
  const mapped = map[lower] ?? map[r];
  if (mapped) return r === mapped ? { finishReason: mapped } : { finishReason: mapped, rawFinishReason: r };
  return { finishReason: "error", rawFinishReason: r };
}

/** JSON representation returned by AgentResponse.toJSON(). */
export interface AgentResponseJSON {
  text: string;
  thinking?: string;
  thoughtSignature?: string;
  toolCalls?: ToolCallRecord[];
  toolResults?: ToolResultRecord[];
  subagents?: SubAgentExecutionMetadata[];
  usage: TokenUsage;
  responseId?: string;
  model: string;
  provider: ProviderId | string;
  finishReason?: FinishReason;
  /** Original vendor finish string when it differs from canonical `finishReason` (Q-04). */
  rawFinishReason?: string;
  durationMs: number;
  raw: ProviderRawData;
  turns: number;
}

/** Normalized final result returned by every Agent run. */
export class AgentResponse {
  readonly text: string;
  readonly thinking?: string;
  readonly thoughtSignature?: string;
  readonly toolCalls: ToolCallRecord[];
  readonly toolResults: ToolResultRecord[];
  readonly subagents: SubAgentExecutionMetadata[];
  readonly usage: TokenUsage;
  readonly responseId?: string;
  readonly model: string;
  readonly provider: ProviderId | string;
  readonly finishReason?: FinishReason;
  /** Original vendor finish string when it differs from canonical `finishReason` (Q-04). */
  readonly rawFinishReason?: string;
  readonly durationMs: number;
  readonly raw: ProviderRawData;
  readonly turns: number;

  /**
   * Constructs a normalized response. Agent runs create this automatically;
   * construct one directly when adapting a custom provider integration.
   *
   * @param data Response text, model metadata, usage, timing, and optional
   * tool/sub-agent records.
   */
  constructor(data: {
    text: string;
    thinking?: string;
    thoughtSignature?: string;
    toolCalls?: ToolCallRecord[];
    toolResults?: ToolResultRecord[];
    subagents?: SubAgentExecutionMetadata[];
    usage: TokenUsage;
    responseId?: string;
    model: string;
    provider: ProviderId | string;
    finishReason?: FinishReason;
    rawFinishReason?: string;
    durationMs: number;
    raw: ProviderRawData;
    turns?: number;
  }) {
    this.text = data.text;
    this.thinking = data.thinking;
    this.thoughtSignature = data.thoughtSignature;
    this.toolCalls = data.toolCalls ?? [];
    this.toolResults = data.toolResults ?? [];
    this.subagents = data.subagents ?? [];
    this.usage = data.usage;
    this.responseId = data.responseId;
    this.model = data.model;
    this.provider = data.provider;
    this.finishReason = data.finishReason;
    this.rawFinishReason = data.rawFinishReason;
    this.durationMs = data.durationMs;
    this.raw = data.raw;
    this.turns = data.turns ?? 1;
  }

  /** Returns the final assistant text. */
  toString(): string {
    return this.text;
  }

  /** Returns a JSON-safe representation including usage, tools, and raw wire data. */
  toJSON(): AgentResponseJSON {
    return {
      text: this.text,
      thinking: this.thinking,
      thoughtSignature: this.thoughtSignature,
      toolCalls: this.toolCalls.length > 0 ? this.toolCalls : undefined,
      toolResults: this.toolResults.length > 0 ? this.toolResults : undefined,
      subagents: this.subagents.length > 0 ? this.subagents : undefined,
      usage: this.usage,
      responseId: this.responseId,
      model: this.model,
      provider: this.provider,
      finishReason: this.finishReason,
      rawFinishReason: this.rawFinishReason,
      durationMs: this.durationMs,
      raw: this.raw,
      turns: this.turns,
    };
  }
}

/** Event names emitted by AssistantMessageEventStream. */
export type StreamEventType =
  | "start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "thinking_start"
  | "thinking_delta"
  | "thinking_end"
  | "tool_call_start"
  | "tool_call_delta"
  | "tool_call_complete"
  | "tool_result"
  | "tool_start"
  | "tool_end"
  | "subagent_complete"
  | "subagent_delta"
  | "steer_injected"
  | "queued"
  | "usage"
  | "done"
  | "error";

/** Payload for one streaming text, thinking, tool, usage, or lifecycle event. */
export interface StreamEvent {
  type: StreamEventType;
  /** Schema version for typed consumers (Q-40). Currently always 1 when present. */
  schemaVersion?: 1;
  delta?: string;
  thinkingDelta?: string;
  toolCall?: ToolCallRecord;
  toolResult?: ToolResultRecord;
  /** Batch tool calls for `tool_start` events (Q-40). */
  toolCalls?: ToolCallRecord[];
  /** Batch tool results for `tool_end` events (Q-40). */
  toolResults?: ToolResultRecord[];
  subagent?: SubAgentExecutionMetadata;
  /** Tracking id of the worker emitting a `subagent_delta` event. */
  subagentTrackingId?: string;
  /** Steered prompt text injected via `steer()` (`steer_injected` events). */
  injectedPrompt?: string;
  /** Queued prompt text accepted as a next-turn follow-up (`queued` events). */
  queuedPrompt?: string;
  /** Pending queue length at the time of a `queued`/`steer_injected` event. */
  queueLength?: number;
  usage?: TokenUsage;
  responseId?: string;
  /** Canonical finish reason when known; vendor strings pass through as-is
   * for provider compat (normalize with `normalizeFinishReason`). */
  finishReason?: string;
  /** Original vendor finish string when it differs from canonical (Q-04). */
  rawFinishReason?: string;
  error?: Error | unknown;
  partialText?: string;
  partialThinking?: string;
  raw?: ProviderRawData;
}

/** Typed (discriminated) stream event schema, version 1 (Q-40).
 * `StreamEvent` stays the permissive compat shape; use this union when you
 * want exhaustive switching (e.g. `tool_start`/`tool_end` lifecycle). */
export type StreamEventV2 =
  | { schemaVersion: 1; type: "start"; responseId?: string }
  | { schemaVersion: 1; type: "text_start"; responseId?: string }
  | { schemaVersion: 1; type: "text_delta"; delta: string; partialText?: string }
  | { schemaVersion: 1; type: "text_end"; partialText?: string }
  | { schemaVersion: 1; type: "thinking_start"; responseId?: string }
  | { schemaVersion: 1; type: "thinking_delta"; thinkingDelta: string; partialThinking?: string }
  | { schemaVersion: 1; type: "thinking_end"; partialThinking?: string }
  | { schemaVersion: 1; type: "tool_call_start"; toolCall: ToolCallRecord }
  | { schemaVersion: 1; type: "tool_call_delta"; toolCall: ToolCallRecord; delta?: string }
  | { schemaVersion: 1; type: "tool_call_complete"; toolCall: ToolCallRecord }
  | { schemaVersion: 1; type: "tool_result"; toolResult: ToolResultRecord }
  | { schemaVersion: 1; type: "tool_start"; toolCalls: ToolCallRecord[] }
  | { schemaVersion: 1; type: "tool_end"; toolResults: ToolResultRecord[] }
  | { schemaVersion: 1; type: "subagent_complete"; subagent: SubAgentExecutionMetadata }
  | {
      schemaVersion: 1;
      type: "subagent_delta";
      subagentTrackingId: string;
      delta?: string;
      thinkingDelta?: string;
      partialText?: string;
      partialThinking?: string;
    }
  | { schemaVersion: 1; type: "steer_injected"; injectedPrompt: string; queueLength?: number }
  | { schemaVersion: 1; type: "queued"; queuedPrompt: string; queueLength?: number }
  | { schemaVersion: 1; type: "usage"; usage: TokenUsage }
  | {
      schemaVersion: 1;
      type: "done";
      delta?: string;
      usage?: TokenUsage;
      finishReason?: FinishReason | string;
      rawFinishReason?: string;
      responseId?: string;
    }
  | { schemaVersion: 1; type: "error"; error: Error | unknown };
