import type { Message, ContentPart } from "../types/message.ts";
import type { ToolCallRecord, ToolResultRecord } from "../types/tool.ts";

export class AgentContext {
  systemPrompt?: string;
  messages: Message[] = [];
  thoughtSignatures: string[] = [];
  cachedContentId?: string;

  constructor(systemPrompt?: string) {
    this.systemPrompt = systemPrompt;
  }

  addUserMessage(content: string | ContentPart[]): void {
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

    if (thinking) {
      parts.push({
        type: "thinking",
        thinking,
        thoughtSignature,
      });
    }

    if (text) {
      parts.push({
        type: "text",
        text,
      });
    }

    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        parts.push({
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          rawArguments: tc.rawArguments,
          thoughtSignature: tc.thoughtSignature || thoughtSignature,
        });
      }
    }

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
    for (const res of results) {
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
        // Fallback manual deep copy that preserves binary
        next.messages = this.messages.map((m) => ({
          ...m,
          content: typeof m.content === "string" ? m.content : (m.content as any[]).map((p: any) => ({ ...p })),
        }));
      }
    } catch {
      next.messages = JSON.parse(JSON.stringify(this.messages));
    }
    next.thoughtSignatures = [...this.thoughtSignatures];
    next.cachedContentId = this.cachedContentId;
    return next;
  }
}
