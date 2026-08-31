import type { TokenUsage } from "./core.ts";
import type { ToolCallRecord, ToolResultRecord } from "./tool.ts";
import type { ProviderRawData, ProviderId } from "./model.ts";

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
}

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
  finishReason?: string;
  durationMs: number;
  raw: ProviderRawData;
  turns: number;
}

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
  readonly finishReason?: string;
  readonly durationMs: number;
  readonly raw: ProviderRawData;
  readonly turns: number;

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
    finishReason?: string;
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
    this.durationMs = data.durationMs;
    this.raw = data.raw;
    this.turns = data.turns ?? 1;
  }

  toString(): string {
    return this.text;
  }

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
      durationMs: this.durationMs,
      raw: this.raw,
      turns: this.turns,
    };
  }
}

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
  | "subagent_complete"
  | "usage"
  | "done"
  | "error";

export interface StreamEvent {
  type: StreamEventType;
  delta?: string;
  thinkingDelta?: string;
  toolCall?: ToolCallRecord;
  toolResult?: ToolResultRecord;
  subagent?: SubAgentExecutionMetadata;
  usage?: TokenUsage;
  responseId?: string;
  finishReason?: string;
  error?: Error | unknown;
  partialText?: string;
  partialThinking?: string;
  raw?: ProviderRawData;
}
