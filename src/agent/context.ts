import type { Message, ContentPart } from "../types/message.ts";
import type { ToolCallRecord, ToolResultRecord } from "../types/tool.ts";
import { safeStringify } from "../utils/serialization.ts";

const USER_PART_TYPES = new Set(["text", "image", "audio", "video", "file"]);

function fail(message: string): never {
  throw new Error(`[Agent Accelerator] AgentContext: ${message}`);
}

/** Deep clone that preserves Uint8Array/ArrayBuffer media (structuredClone may be absent). */
function deepCloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  if (Array.isArray(value)) return value.map((v) => deepCloneValue(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepCloneValue(v);
    return out as T;
  }
  return value;
}

export class AgentContext {
  systemPrompt?: string;
  messages: Message[] = [];
  thoughtSignatures: string[] = [];
  cachedContentId?: string;

  constructor(systemPrompt?: string) {
    this.systemPrompt = systemPrompt;
  }

  addUserMessage(content: string | ContentPart[]): void {
    if (Array.isArray(content)) {
      if (content.length === 0) return;
      for (let i = 0; i < content.length; i++) {
        const part = content[i] as ContentPart;
        if (!part || typeof (part as { type?: unknown }).type !== "string") {
          fail(`user content[${i}] is not a valid content part (missing string "type").`);
        }
        if (!USER_PART_TYPES.has(part.type)) {
          fail(
            `user content[${i}] has type "${(part as { type?: unknown }).type}" which is not valid in a user message. ` +
              `Allowed: text, image, audio, video, file.`
          );
        }
      }
    } else if (typeof content !== "string") {
      fail(`user content must be a string or an array of content parts, received ${typeof content}.`);
    }
    this.messages.push({
      role: "user",
      content,
    });
  }

  addAssistantMessage(
    text: string,
    toolCalls?: ToolCallRecord[],
    thinking?: string,
    thoughtSignature?: string
  ): void {
    const parts: ContentPart[] = [];
    const hasToolCalls = Boolean(toolCalls && toolCalls.length > 0);

    const thinkingSig = !hasToolCalls && !text ? thoughtSignature : undefined;
    const textSig = !hasToolCalls ? thoughtSignature : undefined;

    if (thinking) {
      parts.push({
        type: "thinking",
        thinking,
        thoughtSignature: thinkingSig,
      });
    }

    if (text) {
      parts.push({
        type: "text",
        text,
        thoughtSignature: textSig,
      });
    }

    if (hasToolCalls && toolCalls) {
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]!;
        if (!tc.id || !tc.name) {
          fail(`assistant toolCalls[${i}] is missing ${!tc.id ? '"id"' : '"name"'}; every tool call needs both.`);
        }
        parts.push({
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          rawArguments: tc.rawArguments,
          thoughtSignature: tc.thoughtSignature || (!thinkingSig && !textSig ? thoughtSignature : undefined),
          callId: tc.callId,
        });
      }
    }

    // Never store a fully empty assistant turn: providers reject empty
    // assistant content and it carries no signal for the next turn.
    if (parts.length === 0 && !text) return;

    this.messages.push({
      role: "assistant",
      content: parts.length > 0 ? parts : text,
      thoughtSignature,
    });

    if (thoughtSignature) {
      this.thoughtSignatures.push(thoughtSignature);
    }
  }

  addToolResults(results: ToolResultRecord[]): void {
    if (!results || results.length === 0) return;
    for (let i = 0; i < results.length; i++) {
      const res = results[i]!;
      if (!res.id || !res.name) {
        fail(`toolResults[${i}] is missing ${!res.id ? '"id"' : '"name"'}; results must match a tool call.`);
      }
      this.messages.push({
        role: "tool",
        name: res.name,
        content: [
          {
            type: "tool_result",
            id: res.id,
            name: res.name,
            result: res.result,
            isError: res.isError,
          },
        ],
      });
    }
  }

  clone(): AgentContext {
    const next = new AgentContext(this.systemPrompt);
    // Preserve Uint8Array/ArrayBuffer media via structuredClone when available (M8 fix)
    try {
      if (typeof (globalThis as any).structuredClone === "function") {
        next.messages = (globalThis as any).structuredClone(this.messages);
      } else {
        next.messages = deepCloneValue(this.messages);
      }
    } catch {
      try {
        next.messages = deepCloneValue(this.messages);
      } catch {
        next.messages = JSON.parse(safeStringify(this.messages));
      }
    }
    next.thoughtSignatures = [...this.thoughtSignatures];
    next.cachedContentId = this.cachedContentId;
    return next;
  }
}
