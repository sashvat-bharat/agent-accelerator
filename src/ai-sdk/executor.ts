import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ProviderContext } from "../types/message.ts";
import type { ProviderRequestOptions, ProviderGenerateResult } from "../types/model.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentResponse } from "../types/response.ts";
import type { ToolCallRecord } from "../types/tool.ts";
import {
  toAiSdkPrompt,
  toAiSdkTools,
  fromAiSdkGenerateResult,
  extractAiSdkUsage,
} from "./converters.ts";
import { streamThoughtSignatures } from "./provider.ts";
import { buildAiSdkCallOptions, withAiSdkRetries } from "./options.ts";
import { assertModalitiesSupported } from "./errors.ts";

export interface ExecuteAiSdkOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function extractContextThoughtSignatures(context: ProviderContext): Record<string, string> {
  const map: Record<string, string> = {};
  for (const msg of context.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "tool_call" && (part as any).thoughtSignature) {
          map[part.id] = (part as any).thoughtSignature;
          map["default"] = (part as any).thoughtSignature;
        }
      }
    }
  }
  return map;
}

function toProviderRawData(request?: any, response?: any): any {
  return {
    request: {
      url: request?.url || "",
      method: request?.method || "POST",
      headers: request?.headers || {},
      body: request?.body,
    },
    response: response
      ? {
          status: response.status || 200,
          statusText: response.statusText || "OK",
          headers: response.headers || {},
          body: response.body,
        }
      : undefined,
  };
}

/**
 * Executes a generate call using Vercel AI SDK's LanguageModelV4.
 */
export async function executeAiSdkGenerate(
  model: LanguageModelV4,
  providerId: string,
  modelId: string,
  context: ProviderContext,
  options?: ProviderRequestOptions
): Promise<ProviderGenerateResult> {
  const startTime = Date.now();
  assertModalitiesSupported(context, providerId, modelId);
  const prompt = await toAiSdkPrompt(context);
  const tools = toAiSdkTools(options?.tools as any, providerId);
  const callOptions = buildAiSdkCallOptions(providerId, options);

  const sigMap = extractContextThoughtSignatures(context);

  const effectiveHeaders: Record<string, string> = {
    ...(callOptions.headers || {}),
    ...(Object.keys(sigMap).length > 0 ? { "x-thought-signature-map": JSON.stringify(sigMap) } : {}),
    ...(options?.cache?.cachedContentId ? { "x-cached-content-id": options.cache.cachedContentId } : {}),
  };

  const aiResult = await withAiSdkRetries(
    () =>
      model.doGenerate({
        prompt,
        tools: tools && tools.length > 0 ? tools : undefined,
        headers: effectiveHeaders,
        abortSignal: callOptions.abortSignal,
        reasoning: callOptions.reasoning as never,
        toolChoice: callOptions.toolChoice as never,
        providerOptions: callOptions.providerOptions as never,
      }),
    { maxRetries: options?.maxRetries, maxRetryDelayMs: options?.maxRetryDelayMs, signal: options?.signal, label: { providerId, modelId } }
  );

  return fromAiSdkGenerateResult(
    aiResult,
    providerId,
    modelId,
    Date.now() - startTime
  );
}

/**
 * Executes a streaming call using Vercel AI SDK's LanguageModelV4.
 */
export function executeAiSdkStream(
  model: LanguageModelV4,
  providerId: string,
  modelId: string,
  context: ProviderContext,
  options?: ProviderRequestOptions
): AssistantMessageEventStream {
  const eventStream = new AssistantMessageEventStream();
  const startTime = Date.now();

  // Cancellation: Vercel AI SDK supports AbortSignal on doStream for all our
  // providers (OpenAI / Google / OpenAI-compatible all abort the HTTP fetch).
  // Merge the user signal + stream.cancel() into one linked controller so both
  // `controller.abort()` and `break` / `stream.cancel()` stop the request.
  const linked = new AbortController();
  const forwardUserAbort = () => {
    try { linked.abort((options?.signal as any)?.reason); } catch { try { linked.abort(); } catch {} }
  };
  if (options?.signal?.aborted) forwardUserAbort();
  else options?.signal?.addEventListener("abort", forwardUserAbort, { once: true });
  const removeStreamCancel = eventStream.onCancel(() => {
    try { linked.abort(); } catch {}
  });

  (async () => {
    let reader: { cancel(): unknown; releaseLock(): void; read(): Promise<{ done: boolean; value: any }> } | null = null;
    const cancelReader = () => {
      try { reader?.cancel(); } catch {}
    };
    linked.signal.addEventListener("abort", cancelReader, { once: true });
    try {
      assertModalitiesSupported(context, providerId, modelId);
      const prompt = await toAiSdkPrompt(context);
      const tools = toAiSdkTools(options?.tools as any, providerId);
      const callOptions = buildAiSdkCallOptions(providerId, { ...options, signal: linked.signal });

      const sigMap = extractContextThoughtSignatures(context);
      const effectiveHeaders = {
        ...(callOptions.headers || {}),
        ...(Object.keys(sigMap).length > 0 ? { "x-thought-signature-map": JSON.stringify(sigMap) } : {}),
        ...(options?.cache?.cachedContentId ? { "x-cached-content-id": options.cache.cachedContentId } : {}),
      };

      const aiStreamResult = await withAiSdkRetries(
        () =>
          model.doStream({
            prompt,
            tools: tools && tools.length > 0 ? tools : undefined,
            headers: effectiveHeaders,
            abortSignal: callOptions.abortSignal,
            reasoning: callOptions.reasoning as never,
            toolChoice: callOptions.toolChoice as never,
            providerOptions: callOptions.providerOptions as never,
          }),
        { maxRetries: options?.maxRetries, maxRetryDelayMs: options?.maxRetryDelayMs, signal: options?.signal, label: { providerId, modelId } }
      );

      const raw = toProviderRawData(aiStreamResult.request, aiStreamResult.response);
      eventStream.push({
        type: "start",
        raw,
      });

      let accumulatedText = "";
      let accumulatedThinking = "";
      let reasoningSwitchedToContent = false;
      let rollingReasoningTail = "";
      let inContentThinking = false;
      const toolCalls: ToolCallRecord[] = [];
      let finalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let finalFinishReason = "stop";
      let finalResponseId: string | undefined;
      let finalThoughtSignature: string | undefined;

      reader = aiStreamResult.stream.getReader();
      if (linked.signal.aborted || eventStream.isCancelled()) {
        try { await reader.cancel(); } catch {}
        throw Object.assign(new Error("Stream aborted"), { name: "AbortError" });
      }

      while (true) {
        if (linked.signal.aborted || eventStream.isCancelled()) {
          try { await reader.cancel(); } catch {}
          throw Object.assign(new Error("Stream aborted"), { name: "AbortError" });
        }
        const { done, value } = await reader.read();
        if (done) break;

        switch (value.type) {
          case "response-metadata": {
            if (value.id) finalResponseId = value.id;
            break;
          }

          case "reasoning-delta": {
            const delta = value.delta;
            if (delta) {
              if (reasoningSwitchedToContent) {
                accumulatedText += delta;
                eventStream.push({
                  type: "text_delta",
                  delta,
                  partialText: accumulatedText,
                });
              } else {
                const window = rollingReasoningTail + delta;
                const thinkCloseMatch = window.match(/<\/(?:think|thought)>/i);

                if (thinkCloseMatch && thinkCloseMatch.index !== undefined) {
                  const closeIndex = thinkCloseMatch.index;
                  const closeEnd = closeIndex + thinkCloseMatch[0].length;
                  const tailLen = rollingReasoningTail.length;

                  const deltaBeforeTag = delta.slice(0, Math.max(0, closeIndex - tailLen));
                  if (deltaBeforeTag) {
                    accumulatedThinking += deltaBeforeTag;
                    eventStream.push({
                      type: "thinking_delta",
                      thinkingDelta: deltaBeforeTag,
                      partialThinking: accumulatedThinking,
                    });
                  }

                  reasoningSwitchedToContent = true;

                  const deltaAfterTag = delta.slice(Math.max(0, closeEnd - tailLen));
                  if (deltaAfterTag) {
                    accumulatedText += deltaAfterTag;
                    eventStream.push({
                      type: "text_delta",
                      delta: deltaAfterTag,
                      partialText: accumulatedText,
                    });
                  }
                } else if (
                  accumulatedText.length === 0 &&
                  ((accumulatedThinking.length === 0 && delta.trimStart().match(/^(?:#{1,4}\s+|\*\*(?:Final Answer|Conclusion|Executive Summary|Executive Report|Report|Summary)\*\*)/i)) ||
                    window.match(/(\n\s*(?:#{1,4}\s+|\*\*(?:Final Answer|Conclusion|Executive Summary|Executive Report|Report|Summary)\*\*))/i))
                ) {
                  const headerMatch = window.match(/(\n\s*(?:#{1,4}\s+|\*\*(?:Final Answer|Conclusion|Executive Summary|Executive Report|Report|Summary)\*\*))/i);
                  if (headerMatch && headerMatch.index !== undefined) {
                    const matchStart = headerMatch.index;
                    const firstSymbol = headerMatch[0].search(/[#*]/);
                    const contentStartIndexInWindow = matchStart + (firstSymbol >= 0 ? firstSymbol : 0);
                    const tailLen = rollingReasoningTail.length;

                    const splitBeforeInDelta = Math.min(delta.length, Math.max(0, matchStart - tailLen));
                    const splitAfterInDelta = Math.min(delta.length, Math.max(0, contentStartIndexInWindow - tailLen));

                    const before = delta.slice(0, splitBeforeInDelta);
                    const after = delta.slice(splitAfterInDelta);

                    if (before) {
                      accumulatedThinking += before;
                      eventStream.push({
                        type: "thinking_delta",
                        thinkingDelta: before,
                        partialThinking: accumulatedThinking,
                      });
                    }
                    reasoningSwitchedToContent = true;
                    if (after) {
                      accumulatedText += after;
                      eventStream.push({
                        type: "text_delta",
                        delta: after,
                        partialText: accumulatedText,
                      });
                    }
                  } else {
                    reasoningSwitchedToContent = true;
                    accumulatedText += delta;
                    eventStream.push({
                      type: "text_delta",
                      delta,
                      partialText: accumulatedText,
                    });
                  }
                } else {
                  accumulatedThinking += delta;
                  eventStream.push({
                    type: "thinking_delta",
                    thinkingDelta: delta,
                    partialThinking: accumulatedThinking,
                  });
                  rollingReasoningTail = (rollingReasoningTail + delta).slice(-64);
                }
              }
            }
            break;
          }

          case "text-delta": {
            let textChunk = value.delta;
            if (!inContentThinking && textChunk.includes("<think>")) {
              const [before, after] = textChunk.split("<think>");
              if (before) {
                accumulatedText += before;
                eventStream.push({ type: "text_delta", delta: before, partialText: accumulatedText });
              }
              inContentThinking = true;
              textChunk = after || "";
            }
            if (inContentThinking) {
              if (textChunk.includes("</think>")) {
                const [thought, after] = textChunk.split("</think>");
                if (thought) {
                  accumulatedThinking += thought;
                  eventStream.push({ type: "thinking_delta", thinkingDelta: thought, partialThinking: accumulatedThinking });
                }
                inContentThinking = false;
                if (after) {
                  accumulatedText += after;
                  eventStream.push({ type: "text_delta", delta: after, partialText: accumulatedText });
                }
              } else if (textChunk) {
                accumulatedThinking += textChunk;
                eventStream.push({ type: "thinking_delta", thinkingDelta: textChunk, partialThinking: accumulatedThinking });
              }
            } else if (textChunk) {
              accumulatedText += textChunk;
              eventStream.push({
                type: "text_delta",
                delta: textChunk,
                partialText: accumulatedText,
              });
            }
            break;
          }

          case "tool-call": {
            let args: Record<string, unknown> = {};
            if (typeof value.input === "string") {
              try {
                args = JSON.parse(value.input);
              } catch {
                args = { raw: value.input };
              }
            } else if (typeof value.input === "object" && value.input !== null) {
              args = value.input as Record<string, unknown>;
            }

            let sig =
              (value as any).providerMetadata?.google?.thoughtSignature ||
              (value as any).providerMetadata?.custom?.thoughtSignature;
            if (!sig) {
              sig =
                streamThoughtSignatures.get(value.toolCallId) ||
                streamThoughtSignatures.get("latest");
            }

            const record: ToolCallRecord = {
              id: value.toolCallId,
              name: value.toolName,
              arguments: args,
              rawArguments: typeof value.input === "string" ? value.input : JSON.stringify(value.input || {}),
              thoughtSignature: typeof sig === "string" ? sig : undefined,
            };

            toolCalls.push(record);
            if (sig && !finalThoughtSignature) finalThoughtSignature = sig;

            eventStream.push({
              type: "tool_call_complete",
              toolCall: record,
            });
            break;
          }

          case "finish": {
            if (value.finishReason) {
              finalFinishReason =
                typeof value.finishReason === "object"
                  ? value.finishReason.raw || value.finishReason.unified || "stop"
                  : String(value.finishReason);
            }
            if (value.usage) {
              finalUsage = extractAiSdkUsage(value.usage);
              eventStream.push({ type: "usage", usage: finalUsage });
            }
            break;
          }

          case "error": {
            throw value.error;
          }
        }
      }

      if (linked.signal.aborted || eventStream.isCancelled()) {
        throw Object.assign(new Error("Stream aborted"), { name: "AbortError" });
      }

      let finalText = accumulatedText;
      let finalThinking = accumulatedThinking.length > 0 ? accumulatedThinking : undefined;
      if (!finalText && toolCalls.length === 0 && accumulatedThinking) {
        if (accumulatedThinking.includes("</think>")) {
          const parts = accumulatedThinking.split(/<\/(?:think|thought)>/i);
          finalThinking = parts[0]!.replace(/<(?:think|thought)>/i, "").trim() || undefined;
          finalText = parts.slice(1).join("").trim();
        } else {
          finalText = accumulatedThinking;
          finalThinking = undefined;
        }
      }

      const finalAgentResponse = new AgentResponse({
        text: finalText,
        thinking: finalThinking,
        thoughtSignature: finalThoughtSignature,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: finalUsage,
        finishReason: finalFinishReason,
        responseId: finalResponseId,
        model: modelId,
        provider: providerId as any,
        raw: toProviderRawData(aiStreamResult.request, aiStreamResult.response),
        durationMs: Date.now() - startTime,
      });

      eventStream.push({
        type: "done",
        delta: "",
        usage: finalUsage,
        finishReason: finalFinishReason,
        responseId: finalResponseId,
      });

      eventStream.end(finalAgentResponse);
    } catch (err: any) {
      const raw = err instanceof Error ? err : new Error(String(err));
      const isAbort =
        linked.signal.aborted ||
        eventStream.isCancelled() ||
        (raw as any)?.name === "AbortError" ||
        /abort|cancell?ed/i.test(String((raw as any)?.message ?? raw));
      const finalErr = isAbort
        ? Object.assign(raw.name === "AbortError" ? raw : new Error("Stream aborted"), { name: "AbortError" })
        : raw;
      eventStream.fail(finalErr);
    } finally {
      try { reader?.releaseLock(); } catch {}
      try { options?.signal?.removeEventListener("abort", forwardUserAbort); } catch {}
      try { linked.signal.removeEventListener("abort", cancelReader); } catch {}
      try { removeStreamCancel(); } catch {}
    }
  })();

  return eventStream;
}
