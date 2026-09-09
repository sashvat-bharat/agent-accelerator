import type {
  LanguageModelV4Prompt,
  LanguageModelV4FunctionTool,
  LanguageModelV4FinishReason,
} from "@ai-sdk/provider";
import type { ProviderContext, ContentPart, Message } from "../types/message.ts";
import type { StandardToolDeclaration, ToolCallRecord } from "../types/tool.ts";
import type { ProviderGenerateResult, ProviderRequestOptions } from "../types/model.ts";
import type { TokenUsage } from "../types/core.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import { base64ToBytes } from "../utils/base64.ts";
import { safeStringify } from "../utils/serialization.ts";
import { stripSchemaForGoogle } from "../tools/schema.ts";

/**
 * Converts Agent Accelerator tools to Vercel AI SDK tools format.
 */
export function toAiSdkTools(
  tools?: StandardToolDeclaration[],
  providerId?: string
): LanguageModelV4FunctionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const norm = providerId?.toLowerCase().trim();

  return tools.map((t) => {
    const raw = (t.parameters || { type: "object", properties: {} }) as Record<string, unknown>;
    const inputSchema = norm === "google" || norm === "gemini" ? (stripSchemaForGoogle(raw) as any) : (raw as any);
    return {
      type: "function",
      name: t.name,
      description: t.description,
      inputSchema,
      ...(t.strict !== undefined ? { strict: t.strict } : {}),
    };
  });
}

function guessFilename(input: unknown, mimeType: string): string | undefined {
  if (typeof input !== "string" || input.startsWith("data:") || input.startsWith("http")) return undefined;
  const base = input.split(/[\\/]/).pop()?.split("?")[0]?.trim();
  if (base && base.includes(".")) return base;
  const ext = mimeType.split("/")[1]?.split(";")[0]?.trim();
  return ext ? `file.${ext}` : undefined;
}

/**
 * Converts Agent Accelerator ProviderContext to Vercel AI SDK LanguageModelV4Prompt.
 */
export async function toAiSdkPrompt(
  context: ProviderContext
): Promise<LanguageModelV4Prompt> {
  const prompt: LanguageModelV4Prompt = [];

  if (context.systemPrompt) {
    prompt.push({
      role: "system",
      content: context.systemPrompt,
    });
  }

  for (const msg of context.messages) {
    if (typeof msg.content === "string") {
      if (msg.role === "system") {
        prompt.push({ role: "system", content: msg.content });
      } else if (msg.role === "assistant") {
        prompt.push({
          role: "assistant",
          content: [{ type: "text", text: msg.content }],
        });
      } else if (msg.role === "tool") {
        prompt.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: (msg as any).tool_call_id || (msg as any).id || "call_0",
              toolName: (msg as any).name || "unknown",
              output: { type: "text", value: msg.content },
            },
          ],
        });
      } else {
        prompt.push({
          role: "user",
          content: [{ type: "text", text: msg.content }],
        });
      }
    } else if (Array.isArray(msg.content)) {
      if (msg.role === "assistant") {
        const assistantParts: Array<any> = [];
        for (const part of msg.content) {
          if (part.type === "text" && part.text) {
            assistantParts.push({ type: "text", text: part.text });
          } else if (part.type === "thinking" && part.thinking) {
            assistantParts.push({ type: "reasoning", text: part.thinking });
          } else if (part.type === "tool_call") {
            assistantParts.push({
              type: "tool-call",
              toolCallId: part.id,
              toolName: part.name,
              input: part.arguments || {},
              providerMetadata: part.thoughtSignature
                ? { google: { thoughtSignature: part.thoughtSignature } }
                : undefined,
            });
          }
        }
        if (assistantParts.length > 0) {
          prompt.push({ role: "assistant", content: assistantParts });
        }
      } else if (msg.role === "tool") {
        const toolParts: Array<any> = [];
        for (const part of msg.content) {
          if (part.type === "tool_result") {
            toolParts.push({
              type: "tool-result",
              toolCallId: part.id,
              toolName: part.name,
              output: {
                type: "text",
                value: typeof part.result === "string" ? part.result : safeStringify(part.result),
              },
              isError: part.isError,
            });
          }
        }
        if (toolParts.length > 0) {
          prompt.push({ role: "tool", content: toolParts });
        }
      } else {
        const userParts: Array<any> = [];
        for (const part of msg.content) {
          if (part.type === "text" && part.text) {
            userParts.push({ type: "text", text: part.text });
          } else if (
            part.type === "image" ||
            part.type === "audio" ||
            part.type === "video" ||
            part.type === "file"
          ) {
            // Vercel V4 has no `image` part: every media part is a `file` part
            // with a tagged data payload. Images use image/* media types so all
            // providers route them to their native image input.
            const raw = (part as any).image ?? (part as any).audio ?? (part as any).video ?? (part as any).file;
            const norm = await normalizeMediaInput(raw, (part as any).mimeType);
            const bytes = base64ToBytes(norm.base64Data);
            const filename =
              (part as any).filename ?? guessFilename(raw, norm.mimeType);
            userParts.push({
              type: "file",
              mediaType: norm.mimeType,
              data: { type: "data", data: bytes },
              ...(filename ? { filename } : {}),
            });
          }
        }
        if (userParts.length > 0) {
          prompt.push({ role: "user", content: userParts });
        }
      }
    }
  }

  return prompt;
}

/**
 * Extracts normalized TokenUsage from Vercel AI SDK usage structure.
 */
export function extractAiSdkUsage(rawUsage?: any): TokenUsage {
  if (!rawUsage) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const input =
    rawUsage.inputTokens?.total ??
    rawUsage.prompt_tokens ??
    rawUsage.input_tokens ??
    0;

  const output =
    rawUsage.outputTokens?.total ??
    rawUsage.completion_tokens ??
    rawUsage.output_tokens ??
    0;

  const total =
    rawUsage.total_tokens ??
    rawUsage.totalTokens ??
    input + output;

  const cached =
    rawUsage.inputTokens?.cacheRead ??
    rawUsage.prompt_tokens_details?.cached_tokens ??
    rawUsage.cached_tokens ??
    0;

  const cacheWrite =
    rawUsage.inputTokens?.cacheWrite ??
    rawUsage.prompt_tokens_details?.cache_write_tokens ??
    rawUsage.cache_write_tokens ??
    0;

  const thinking =
    rawUsage.outputTokens?.reasoning ??
    rawUsage.completion_tokens_details?.reasoning_tokens ??
    rawUsage.reasoning_tokens ??
    0;

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cachedTokens: cached,
    cacheReadTokens: cached,
    cacheWriteTokens: cacheWrite,
    thinkingTokens: thinking,
  };
}

/**
 * Converts Vercel AI SDK doGenerate result into Agent Accelerator ProviderGenerateResult.
 */
export function fromAiSdkGenerateResult(
  aiResult: any,
  providerId: string,
  modelId: string,
  durationMs: number
): ProviderGenerateResult {
  let text = "";
  let thinking: string | undefined;
  let thoughtSignature: string | undefined;
  const toolCalls: ToolCallRecord[] = [];

  if (aiResult.content && Array.isArray(aiResult.content)) {
    for (const part of aiResult.content) {
      if (part.type === "text" && part.text) {
        text += part.text;
      } else if (part.type === "reasoning" && part.text) {
        thinking = (thinking ? thinking + "\n" : "") + part.text;
        const sig =
          part.providerMetadata?.google?.thoughtSignature ||
          part.providerMetadata?.custom?.thoughtSignature;
        if (sig && typeof sig === "string") {
          thoughtSignature = sig;
        }
      } else if (part.type === "tool-call") {
        let args: Record<string, unknown> = {};
        if (typeof part.input === "string") {
          try {
            args = JSON.parse(part.input);
          } catch {
            args = { raw: part.input };
          }
        } else if (typeof part.input === "object" && part.input !== null) {
          args = part.input as Record<string, unknown>;
        }

        const sig =
          part.providerMetadata?.google?.thoughtSignature ||
          part.providerMetadata?.custom?.thoughtSignature;

        toolCalls.push({
          id: part.toolCallId || `call_${Math.random().toString(36).slice(2, 9)}`,
          name: part.toolName,
          arguments: args,
          rawArguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input || {}),
          thoughtSignature: typeof sig === "string" ? sig : undefined,
        });

        if (sig && !thoughtSignature) {
          thoughtSignature = sig;
        }
      }
    }
  }

  // Fallback / extraction from raw response body if Vercel AI SDK parts omitted custom metadata
  const rawBody = aiResult.response?.body;
  if (rawBody && typeof rawBody === "object") {
    const rawChoice = rawBody.choices?.[0];
    const rawMsg = rawChoice?.message;
    if (!thinking && rawMsg?.reasoning_content) {
      thinking = rawMsg.reasoning_content;
    }
    if (rawMsg?.tool_calls && Array.isArray(rawMsg.tool_calls)) {
      for (let i = 0; i < rawMsg.tool_calls.length; i++) {
        const rawTc = rawMsg.tool_calls[i];
        const extraSig = rawTc?.extra_content?.google?.thought_signature;
        if (extraSig && toolCalls[i]) {
          toolCalls[i]!.thoughtSignature = extraSig;
          if (!thoughtSignature) thoughtSignature = extraSig;
        }
      }
    }
  }

  const usage = extractAiSdkUsage(aiResult.usage ?? rawBody?.usage);
  const finishReason =
    typeof aiResult.finishReason === "object" && aiResult.finishReason !== null
      ? aiResult.finishReason.raw || aiResult.finishReason.unified || "stop"
      : String(aiResult.finishReason || "stop");

  const responseId = aiResult.response?.id || rawBody?.id;

  return {
    text,
    thinking,
    thoughtSignature,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
    finishReason,
    responseId,
    model: modelId,
    provider: providerId as any,
    raw: {
      request: aiResult.request,
      response: aiResult.response,
    },
    durationMs,
  };
}
