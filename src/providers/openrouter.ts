/**
 * OpenRouter Chat Completions provider (`POST {baseUrl}/chat/completions`).
 *
 * All OpenRouter-specific HTTP, endpoints, headers, auth, request
 * construction, response/SSE parsing, and wire transformations live HERE —
 * never in the canonical layer (`src/providers.ts`).
 *
 * Wire contract: `references/testings/openrouter/CONTRACT.md` (docs + live
 * captures on `stealth/space-bunny-alpha`, 2026-09-24). Capability matrix:
 * `references/testings/openrouter/CAPABILITY-MATRIX.md`.
 *
 * This is the STABLE transport. The beta Responses skin
 * was removed from core: no video shape,
 * lossy error codes, beta event-vocabulary drift.
 *
 * Notes:
 * - EVERY request streams, `generate()` included (it collects its own `stream()`): OpenRouter only cancels a request that
 *   streams ("Stream cancellation" in its docs), so a plain non-streaming request could not be stopped by an interrupt.
 * - STATELESS per request: every turn sends the full canonical `messages`
 *   array explicitly. Completions defines no `store`/`previous_response_id`/
 *   `conversation`/`prompt_cache_key`/`session_id` body primitives, so none
 *   are ever sent; affinity is headers-only best effort (`x-session-id`).
 * - IDs are provider-generated (`gen-…` generations, `call_…`/uuid tool ids)
 *   and echoed verbatim (`tool_call_id`). The `call_${random}` fallback in
 *   parsers is a local canonical correlation id only; it is never sent.
 * - Prior-turn reasoning is NOT resent (chat history is messages + tool
 *   calls only). This matches the Responses adapter behavior and avoids 400s
 *   on strict routes; documented in the capability matrix.
 */
import type {
  Provider,
  ProviderId,
  ModelSpec,
  ProviderRequestOptions,
  ProviderGenerateResult,
  ProviderRawData,
} from "../types/model.ts";
import type { ProviderContext, ContentPart } from "../types/message.ts";
import type { StandardToolDeclaration, ToolCallRecord } from "../types/tool.ts";
import type { TokenUsage } from "../types/core.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { SSEParser } from "../streaming/sse-parser.ts";
import { AgentResponse } from "../types/response.ts";
import { getApiKey, getEnv } from "../utils/env.ts";
import { buildSessionHeaders, setHeaderCaseInsensitive } from "../utils/headers.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import { safeStringify } from "../utils/serialization.ts";
import { toConciseProviderError, assertModalitiesSupported } from "../utils/errors.ts";
import { isAbortError } from "../types/errors.ts";
import {
  newToolCallId,
  redactedHeaders,
  readErrorPayload,
  incompleteStreamError,
  hasUnfinishedToolCall,
  combinedSignal,
  timeoutFor,
  hasAuthHeader,
  clampToolCallId,
  openStreamResponse,
  retryOptionsFrom,
  headersToRecord,
  parseRetryAfterMs,
} from "./shared.ts";
import { createGenericModelSpec } from "../models/catalog.ts";
import { getModelFromCatalog, getModelsForProvider, modelSupportsStructuredOutput } from "../models/catalog.ts";
import {
  mapThinkingLevelToOpenRouterChat,
  mapServiceTierToOpenRouter,
  resolveCache,
  mapToolChoiceToOpenRouterChat,
  noteProviderTurn,
  parseStreamedToolArguments,
  selectRawArguments,
  mapOutputToOpenRouterChat,
  mapGenerationParamsToChat,
  normalizeStructuredOutput,
  augmentSystemPromptWithStructuredOutput,
  emitProviderWarning,
  warnIgnoredMediaResolution,
} from "../providers.ts";

// ---------------------------------------------------------------------------
// Chat Completions wire shapes (most-important subset)
// ---------------------------------------------------------------------------

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } }
  | { type: "file"; file: { filename?: string; file_data?: string; file_url?: string } }
  | { type: string; [k: string]: unknown };

type ChatMessage =
  | { role: "system" | "user"; content: string | ChatContentPart[]; name?: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
      name?: string;
    }
  | { role: "tool"; content: string; tool_call_id: string; name?: string }
  | { type: string; [k: string]: unknown };

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | { type: "function"; function: { name: string } };
  reasoning?: { effort: string };
  service_tier?: string;
  session_id?: string;
  cache_control?: { type: "ephemeral"; ttl: "5m" | "1h" };
  response_format?: { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict: boolean; description?: string } };
  stream?: boolean;
  [k: string]: unknown;
}

/** The usage block of a Chat Completions chunk (the last chunk of a stream carries it, with OpenRouter's `cost`). */
interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  cost?: number;
  [k: string]: unknown;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

// ---------------------------------------------------------------------------
// Request building (canonical -> Chat Completions)
// ---------------------------------------------------------------------------

function resolveBaseUrl(options?: ProviderRequestOptions): string {
  return (
    options?.baseUrl ||
    options?.env?.["OPENROUTER_BASE_URL"] ||
    getEnv("OPENROUTER_BASE_URL") ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

function resolveApiKey(options?: ProviderRequestOptions): string | undefined {
  const key = getApiKey("openrouter", options?.apiKey, options?.env);
  if (key) return key;
  if (hasAuthHeader(options?.headers)) return "unused";
  return undefined;
}

/**
 * Strips ONLY the `openrouter/` prefix. Scoped ids (`scope/model:variant`)
 * and bare ids pass through untouched — the router resolves them.
 */
function cleanModelId(model: string | ModelSpec): string {
  const rawId = typeof model === "string" ? model : model.id;
  return rawId.replace(/^openrouter\//i, "");
}

// The HTTP status of an error chunk inside a stream (the HTTP status itself is 200): its numeric `code`, else the status of its retryable `error_type` (errors-and-debugging.md, "Typed Error Codes"); in: the chunk's error, out: streamInto, where it makes the error retryable.
const RETRYABLE_ERROR_TYPE_STATUS: Record<string, number> = { rate_limit_exceeded: 429, provider_overloaded: 503, provider_unavailable: 502, timeout: 504, server: 500 };
function midStreamStatus(code: unknown, errorType: unknown): number | undefined {
  if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) return code;
  return typeof errorType === "string" ? RETRYABLE_ERROR_TYPE_STATUS[errorType] : undefined;
}

function toOpenRouterTools(tools?: StandardToolDeclaration[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.parameters || { type: "object", properties: {} }) as Record<string, unknown>,
      ...(t.strict !== undefined ? { strict: t.strict } : {}),
    },
  }));
}

// The `input_audio.format` for a MIME type: Chat Completions takes any format string the provider supports (audio.md: wav, mp3, aiff, aac, ogg, flac, m4a, pcm16 ...), so the real format is sent, never a guess; in: an audio part's MIME type, out: contentPartsToBlocks.
const AUDIO_FORMAT: Record<string, string> = { wav: "wav", wave: "wav", mpeg: "mp3", mp3: "mp3", mp4: "m4a", m4a: "m4a", aac: "aac", ogg: "ogg", flac: "flac", aiff: "aiff" };
function audioFormatFor(mimeType?: string): string {
  const subtype = (mimeType || "").toLowerCase().split(";")[0]!.split("/")[1]?.replace(/^x-/, "") ?? "";
  return AUDIO_FORMAT[subtype] ?? (subtype || "mp3");
}

// `ImagePart.resolution` as OpenRouter's `image_url.detail` (api-ref ChatContentImage: auto, low, high, original; `original` is downgraded to `high` where unsupported); videos have no such field; in: an image part, out: contentPartsToBlocks.
const IMAGE_DETAIL: Record<string, "low" | "auto" | "high" | "original"> = { low: "low", medium: "auto", high: "high", ultra_high: "original" };

// Maps canonical text and media parts to Chat Completions content blocks; in: a user message's parts, out: fullHistoryMessages.
async function contentPartsToBlocks(parts: ContentPart[]): Promise<ChatContentPart[]> {
  const blocks: ChatContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const raw = (part as { image?: unknown }).image;
      // Remote URLs pass through (router downloads; `image_download_failed`
      // surfaces if unreachable). Inline only local/base64/binary.
      const detail = IMAGE_DETAIL[(part as { resolution?: string }).resolution ?? ""];
      if (typeof raw === "string" && (raw.startsWith("http://") || raw.startsWith("https://"))) {
        blocks.push({ type: "image_url", image_url: { url: raw, ...(detail ? { detail } : {}) } });
        continue;
      }
      const norm = await normalizeMediaInput(
        raw as string | Uint8Array | ArrayBuffer,
        (part as { mimeType?: string }).mimeType
      );
      blocks.push({ type: "image_url", image_url: { url: norm.dataUrl, ...(detail ? { detail } : {}) } });
    } else if (part.type === "video") {
      const raw = (part as { video?: unknown }).video;
      // `video_url` is the completions video shape (live: shape accepted,
      // 402 billing gate without funded balance). Never download videos —
      // always pass the URL through; inline bytes as a data URL.
      if (typeof raw === "string" && (raw.startsWith("http://") || raw.startsWith("https://"))) {
        blocks.push({ type: "video_url", video_url: { url: raw } });
        continue;
      }
      const norm = await normalizeMediaInput(
        raw as string | Uint8Array | ArrayBuffer,
        (part as { mimeType?: string }).mimeType
      );
      // video-inputs.md names the QuickTime type `video/mov`.
      const url = norm.mimeType === "video/quicktime" ? `data:video/mov;base64,${norm.base64Data}` : norm.dataUrl;
      blocks.push({ type: "video_url", video_url: { url } });
    } else if (part.type === "audio") {
      const raw = (part as { audio?: unknown }).audio;
      const mimeType = (part as { mimeType?: string }).mimeType;
      // OpenAI chat audio shape (router parsed it live; capability routing
      // decides per model). Always inline — `input_audio` carries data only.
      const norm = await normalizeMediaInput(
        raw as string | Uint8Array | ArrayBuffer,
        mimeType
      );
      blocks.push({
        type: "input_audio",
        input_audio: { data: norm.base64Data, format: audioFormatFor(norm.mimeType) },
      });
    } else if (part.type === "file") {
      const raw = (part as { file?: unknown }).file;
      const filename = (part as { filename?: string }).filename;
      // `file_data` takes a public URL or a base64 data URL (api-ref ChatContentFile; a `file_url` field does not exist).
      const fileData =
        typeof raw === "string" && (raw.startsWith("http://") || raw.startsWith("https://"))
          ? raw
          : (await normalizeMediaInput(raw as string | Uint8Array | ArrayBuffer, (part as { mimeType?: string }).mimeType)).dataUrl;
      blocks.push({
        type: "file",
        file: { ...(typeof filename === "string" && filename ? { filename } : {}), file_data: fileData },
      });
    }
  }
  return blocks;
}

function resultToOutput(result: unknown): string {
  if (typeof result === "string") return result;
  return safeStringify(result);
}

/**
 * Builds the FULL explicit history as Chat Completions `messages`.
 * Stateless transport: no chaining primitives exist here, so every turn
 * carries everything. Assistant items carry no provider `id`/`status`
 * requirements (unlike the discontinued Responses skin).
 */
async function fullHistoryMessages(context: ProviderContext): Promise<ChatMessage[]> {
  // Map assistant tool_call ids so tool results pair even though the
  // executor keys results by the call id.
  const pairing = new Map<string, string>();
  // Queues of assistant call ids per tool name, consumed in order when a tool
  // message carries a plain string (no part id to pair with).
  const idsByName = new Map<string, string[]>();
  for (const m of context.messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "tool_call") {
          pairing.set(part.id, part.callId || part.id);
          const queue = idsByName.get(part.name) ?? [];
          queue.push(part.callId || part.id);
          idsByName.set(part.name, queue);
        }
      }
    }
  }

  const messages: ChatMessage[] = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  let lastRole: string | null = "system";
  for (const m of context.messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      // Strict routes reject `user` directly after `tool`: bridge with a
      // synthetic assistant turn (pi api/openai-completions.ts:1233).
      if (lastRole === "tool") {
        messages.push({ role: "assistant", content: "I have processed the tool results." });
      }
      if (typeof m.content === "string") {
        if (m.content) { messages.push({ role: "user", content: m.content }); lastRole = "user"; }
      } else {
        const blocks = await contentPartsToBlocks(m.content);
        if (blocks.length > 0) { messages.push({ role: "user", content: blocks }); lastRole = "user"; }
      }
    } else if (m.role === "assistant") {
      if (typeof m.content === "string") {
        if (m.content) {
          messages.push({ role: "assistant", content: m.content });
        }
        continue;
      }
      const texts: string[] = [];
      const calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
      for (const part of m.content) {
        if (part.type === "tool_call") {
          calls.push({
            id: clampToolCallId(part.callId || part.id),
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.arguments || {}) },
          });
        } else if (part.type === "text" && part.text) {
          texts.push(part.text);
        }
        // Prior-turn reasoning is NOT resent: chat history is messages +
        // tool calls only (documented decision; avoids strict-route 400s).
      }
      // Skip empty assistant turns (no text + no tool calls): strict
      // routes reject them, and they carry no signal (pi drop rule).
      if (texts.length === 0 && calls.length === 0) continue;
      messages.push({
        role: "assistant",
        content: texts.length > 0 ? texts.join("\n") : null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      lastRole = "assistant";
    } else if (m.role === "tool") {
      if (typeof m.content === "string") {
        const queue = (m.name && idsByName.get(m.name)) || [];
        messages.push({
          role: "tool",
          tool_call_id: clampToolCallId(queue.shift() || newToolCallId()),
          content: m.content,
          name: m.name,
        });
        lastRole = "tool";
        continue;
      }
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content) {
        if (part.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: clampToolCallId(pairing.get(part.id) || part.id),
            content: resultToOutput(part.result),
            name: part.name,
          });
          lastRole = "tool";
        }
      }
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Response mapping (Chat Completions -> canonical)
// ---------------------------------------------------------------------------

function mapUsage(raw?: ChatUsage): TokenUsage {
  const input = raw?.prompt_tokens ?? 0;
  const output = raw?.completion_tokens ?? 0;
  // Canonical invariant: cache hits are a SUBSET of input (no turn may
  // report a >100% hit rate).
  const cached = Math.min(raw?.prompt_tokens_details?.cached_tokens ?? 0, input);
  const usage: TokenUsage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: raw?.total_tokens ?? input + output,
    cachedTokens: cached,
    cacheReadTokens: cached,
    cacheWriteTokens: raw?.prompt_tokens_details?.cache_write_tokens ?? 0,
    thinkingTokens: raw?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
  if (typeof raw?.cost === "number" && raw.cost >= 0) { // an explicit 0 (a free model, a response-cache hit) is a known cost, not a missing one
    usage.cost = { totalCost: raw.cost };
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * OpenRouter provider implemented directly on the Chat Completions REST API
 * (`POST {baseUrl}/chat/completions`, streaming on the same endpoint).
 */
export class OpenRouterChatCompletionsProvider implements Provider {
  readonly id: ProviderId = "openrouter";
  readonly name = "OpenRouter Chat Completions";

  /** Live catalog view: a constructor snapshot would go stale after refresh. */
  get models(): ModelSpec[] {
    return getModelsForProvider("openrouter");
  }

  getModel(modelId: string): ModelSpec | undefined {
    const clean = cleanModelId(modelId);
    return (
      getModelFromCatalog(this.id, modelId) ||
      getModelFromCatalog(this.id, clean) ||
      this.models.find((m) => m.id === modelId || m.id === clean) ||
      createGenericModelSpec(this.id, clean)
    );
  }

  private async buildBody(
    modelId: string,
    context: ProviderContext,
    options: ProviderRequestOptions | undefined,
    sessionId: string | undefined,
    tools: StandardToolDeclaration[] | undefined,
    stream: boolean
  ): Promise<ChatRequestBody> {
    const { effort } = mapThinkingLevelToOpenRouterChat(options?.thinking?.level);
    const serviceTier = mapServiceTierToOpenRouter(options?.serviceTier);
    // Anthropic models take a top-level `cache_control` TTL; every other route caches implicitly (docs: prompt-caching.md).
    const cache = resolveCache("openrouter", options?.cache, /^~?anthropic\//.test(modelId) ? ["implicit", "5m", "1h"] : ["implicit"], `openrouter/${modelId}`);
    warnIgnoredMediaResolution("openrouter", context.messages, `openrouter/${modelId}`, ["video"]);

    // Structured outputs: native `response_format` when supported, else
    // emulated via system-prompt instruction + client validation (catalog
    // `structured_output: false` models would 400 on the wire shape).
    let effectiveContext = context;
    let outputEmulated = false;
    let outputSpec: import("../types/model.ts").StructuredOutputSpec | undefined;
    try {
      outputSpec = normalizeStructuredOutput(options?.output ?? (options as { outputSchema?: unknown })?.outputSchema);
    } catch {
      // why: invalid output shapes fail fast at Agent construction/loop validation.
      outputSpec = undefined;
    }
    if (outputSpec && !modelSupportsStructuredOutput("openrouter", modelId)) {
      outputEmulated = true;
      effectiveContext = {
        ...context,
        systemPrompt: augmentSystemPromptWithStructuredOutput(context.systemPrompt, outputSpec),
      };
      emitProviderWarning({
        provider: "openrouter",
        capability: "structured output",
        requested: `${outputSpec.name} (openrouter/${modelId})`,
        reason: "the catalog reports structured_output: false for this model, so native response_format is unsupported.",
        fallback: "emulated JSON instruction + client validation (no response_format is sent)",
      });
    }
    const messages = await fullHistoryMessages(effectiveContext);
    const body: ChatRequestBody = {
      model: modelId,
      messages,
      ...(stream ? { stream: true } : {}),
    };
    const orTools = toOpenRouterTools(tools);
    if (orTools) body.tools = orTools;
    const toolChoice = mapToolChoiceToOpenRouterChat(
      options?.toolChoice as "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined
    );
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    if (effort) body.reasoning = { effort };
    if (serviceTier) body.service_tier = serviceTier;
    if (cache === "5m" || cache === "1h") body.cache_control = { type: "ephemeral", ttl: cache };
    // Documented Chat Completions generation controls (only those the caller set).
    Object.assign(body, mapGenerationParamsToChat(options, "openrouter", `openrouter/${modelId}`));
    // Structured outputs: Chat Completions `response_format{type:json_schema,json_schema}`.
    // Skipped when emulated (unsupported model): instruction already in messages.
    if (outputSpec && !outputEmulated) {
      try {
        const mapped = mapOutputToOpenRouterChat(outputSpec);
        if (mapped) body.response_format = mapped.response_format;
      } catch {
        // why: invalid output shapes fail fast at Agent construction/loop validation.
      }
    }
    // No store/previous_response_id/conversation: they do not exist
    // on this endpoint.
    // Session affinity: top-level `session_id` is the documented sticky-routing
    // key on Chat Completions (prompt-caching guide) and takes precedence over
    // the `x-session-id` header (still sent in requestInit as fallback). It is
    // constant per session so prefix-cache stability is untouched, and —
    // unlike headers — it survives browser CORS stripping.
    if (sessionId) body.session_id = sessionId;
    return body;
  }

  private requestInit(
    body: ChatRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    sessionId: string | undefined,
    signal?: AbortSignal
  ): RequestInit {
    // Attribution + session headers mirror the previous transport exactly
    // (HTTP-Referer / X-Title / x-session-id / x-client-request-id).
    const headers: Record<string, string> = buildSessionHeaders(
      "openrouter",
      options?.headers,
      sessionId
    );
    setHeaderCaseInsensitive(headers, "Content-Type", "application/json");
    if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "Authorization", `Bearer ${apiKey}`);
    return { method: "POST", headers, body: JSON.stringify(body), signal };
  }

  private throwIfError(
    status: number,
    url: string,
    bodyText: string,
    modelId: string,
    headers?: Record<string, string>
  ): void {
    if (status >= 200 && status < 300) return;
    const { message, code, errorType, raw } = readErrorPayload(bodyText);
    const hint =
      status === 401
        ? " Check OPENROUTER_API_KEY (no quotes/spaces, correct provider) and that the key is loaded (bun --env-file=.env.local)."
        : "";
    const fullMessage = `${message}${hint}`;
    const err: Record<string, unknown> & Error = new Error(fullMessage) as Record<string, unknown> & Error;
    (err as Record<string, unknown>)["statusCode"] = status;
    (err as Record<string, unknown>)["status"] = status;
    (err as Record<string, unknown>)["responseBody"] = bodyText.slice(0, 500);
    (err as Record<string, unknown>)["url"] = url.split("?")[0];
    (err as Record<string, unknown>)["data"] = { error: { message: fullMessage } };
    if (code !== undefined) (err as Record<string, unknown>)["code"] = code;
    if (errorType) (err as Record<string, unknown>)["errorType"] = errorType;
    if (raw) (err as Record<string, unknown>)["raw"] = raw;
    const retryAfterMs = parseRetryAfterMs(headers);
    if (retryAfterMs !== undefined) (err as Record<string, unknown>)["retryAfterMs"] = retryAfterMs;
    throw toConciseProviderError(err, "openrouter", modelId);
  }

  // OpenRouter can only cancel a request that streams ("Stream cancellation": for a non-streaming request the model keeps processing and you are billed in full), so even a plain generate is sent as a stream and collected here: an interrupt then closes the connection and stops processing and billing at the providers OpenRouter can cancel; in: the loop's non-streaming turn, out: the same ProviderGenerateResult a JSON reply gave.
  async generate(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): Promise<ProviderGenerateResult> {
    // The whole call stays bounded by `timeoutMs`; the stream's own timer only covers the wait for its first byte.
    const { signal, cleanup } = combinedSignal(options?.signal, timeoutFor(options as { timeoutMs?: number } | undefined));
    try {
      // Nobody reads the deltas here, so the stream keeps none (a burst of frames would overflow its buffer for nothing).
      const events = this.streamInto(new AssistantMessageEventStream({ buffer: false }), model, context, { ...options, signal });
      const res = await events.result();
      return {
        text: res.text,
        thinking: res.thinking,
        thoughtSignature: undefined,
        toolCalls: res.toolCalls.length > 0 ? res.toolCalls : undefined,
        usage: res.usage,
        finishReason: res.finishReason,
        responseId: res.responseId,
        model: res.model,
        provider: "openrouter",
        raw: res.raw,
        durationMs: res.durationMs,
      };
    } catch (err) {
      // A stream reports its own generic abort; the caller's reason (`interrupt(new Error("..."))`) is what the run should carry.
      const reason = options?.signal?.reason;
      if (options?.signal?.aborted && reason instanceof Error && isAbortError(err)) {
        throw Object.assign(new Error(reason.message), { name: "AbortError" });
      }
      throw err;
    } finally {
      cleanup();
    }
  }

  stream(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): AssistantMessageEventStream {
    return this.streamInto(new AssistantMessageEventStream(), model, context, options);
  }

  // Runs one streamed request, pushing its events into `eventStream`; in: stream() (a normal stream) and generate() (one that keeps no events), out: that same stream, finished with the AgentResponse.
  private streamInto(
    eventStream: AssistantMessageEventStream,
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): AssistantMessageEventStream {
    const startTime = Date.now();
    const clean = cleanModelId(model);

    const linked = new AbortController();
    const forwardUserAbort = () => {
      try {
        linked.abort((options?.signal as { reason?: unknown })?.reason);
      } catch {
        try {
          linked.abort();
        } catch {}
      }
    };
    if (options?.signal?.aborted) forwardUserAbort();
    else options?.signal?.addEventListener("abort", forwardUserAbort, { once: true });
    const removeStreamCancel = eventStream.onCancel(() => {
      try {
        linked.abort();
      } catch {}
    });

    (async () => {
      try {
        const apiKey = resolveApiKey(options);
        if (!apiKey) {
          throw new Error(
            "[Agent Accelerator] Missing OpenRouter API key. Set OPENROUTER_API_KEY or pass apiKey."
          );
        }
        assertModalitiesSupported(context, "openrouter", clean);
        const baseUrl = resolveBaseUrl(options);
        const url = `${baseUrl}/chat/completions`;
        const sessionId = options?.sessionId;
        const tools = options?.tools as StandardToolDeclaration[] | undefined;
        const body = await this.buildBody(clean, context, options, sessionId, tools, true);

        const streamAuditRaw: Record<string, string> = {
          ...buildSessionHeaders("openrouter", options?.headers, sessionId),
          "Content-Type": "application/json",
          Authorization: "[REDACTED]",
        };
        const rawRequest = {
          url,
          method: "POST",
          headers: redactedHeaders(streamAuditRaw),
          body,
        };

        const streamTimeoutMs = timeoutFor(options as { timeoutMs?: number } | undefined);
        // Transient failures (429/5xx/network) are retried here, before the
        // first byte; once the stream is live it is never retried.
        const res = await openStreamResponse({
          fetchOnce: async () => {
            const timer =
              streamTimeoutMs && streamTimeoutMs > 0
                ? setTimeout(() => {
                    try {
                      linked.abort();
                    } catch {}
                  }, streamTimeoutMs)
                : undefined;
            try {
              return await (options?.fetch ?? fetch)(url, this.requestInit(body, options, apiKey, sessionId, linked.signal));
            } finally {
              if (timer) clearTimeout(timer);
            }
          },
          onHttpError: (r, text) => this.throwIfError(r.status, url, text, clean, headersToRecord(r.headers)),
          noBodyError: () => toConciseProviderError(new Error("OpenRouter streaming response had no body"), "openrouter", clean),
          retry: retryOptionsFrom(options),
          signal: linked.signal,
          label: { providerId: "openrouter", modelId: clean },
        });
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });
        const responseMeta: Record<string, unknown> & { status: number; statusText: string; headers: Record<string, string> } = { status: res.status, statusText: res.statusText, headers: responseHeaders };
        eventStream.push({ type: "start", raw: { request: rawRequest } } as never);

        const parser = new SSEParser();
        const reader = res.body!.getReader(); // openStreamResponse guarantees a body
        const decoder = new TextDecoder();
        let text = "";
        let thinking = "";
        // Tool calls keyed by choice index: { id, name, startArgs, deltaArgs }.
        const calls = new Map<number, { id: string; name: string; startArgs: string; deltaArgs: string }>();
        // Index of the most recent tool-call delta: unindexed chunks continue
        // it (falling back to calls.size would fork a phantom call per chunk).
        let lastToolIndex = 0;
        let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        let finishReason = "stop";
        let sawFinishReason = false;
        let sawUsage = false;
        let refusalSeen = false;
        let badFrames = 0;
        let framesSeen = 0;
        let responseId: string | undefined;
        let completedBody: unknown = undefined;
        let aborted = false;
        linked.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            try {
              void reader.cancel().catch(() => {}); // an aborted body is already errored: its cancel() rejects, and nobody else listens
            } catch {}
          },
          { once: true }
        );

        const handleMessage = (data: string): void => {
          if (!data) return;
          if (data === "[DONE]") {
            sawFinishReason = sawFinishReason || completedBody !== undefined || sawUsage;
            return;
          }
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(data) as Record<string, unknown>;
            framesSeen += 1;
          } catch {
            badFrames += 1;
            return;
          }
          // Mid-stream provider error: top-level `error`, HTTP stays 200.
          // Must surface — resolving empty success hides it.
          const topError = msg["error"] as { message?: string; code?: string | number; metadata?: { error_type?: string } } | undefined;
          if (topError && typeof topError === "object") {
            const message =
              typeof topError.message === "string" && topError.message
                ? topError.message
                : "OpenRouter streaming error";
            const failure: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
            if (topError.code !== undefined) failure["code"] = topError.code;
            if (typeof topError.metadata?.error_type === "string") failure["errorType"] = topError.metadata.error_type;
            const status = midStreamStatus(topError.code, topError.metadata?.error_type);
            if (status !== undefined) failure["statusCode"] = status; // lets the retry logic and the message treat it like an HTTP error
            failure["url"] = url;
            throw toConciseProviderError(failure, "openrouter", clean);
          }
          if (typeof msg["id"] === "string" && !responseId) {
            responseId = msg["id"] as string;
          }
          const choice = (Array.isArray(msg["choices"]) ? (msg["choices"] as Record<string, unknown>[])[0] : undefined) ?? {};
          const delta = (choice["delta"] as Record<string, unknown>) ?? {};
          // Text delta (content-free accounting frames carry "" — ignored).
          // Q-23: refusal deltas surface as text with a `refusal` finish.
          const deltaRefusal = delta["refusal"];
          if (typeof deltaRefusal === "string" && deltaRefusal) {
            text += deltaRefusal;
            refusalSeen = true;
            eventStream.push({ type: "text_delta", delta: deltaRefusal, partialText: text });
          }
          if (typeof delta["content"] === "string" && delta["content"]) {
            text += delta["content"] as string;
            eventStream.push({ type: "text_delta", delta: delta["content"] as string, partialText: text });
          }
          // Thinking deltas: `reasoning_details[].text` duplicates `reasoning`
          // when both ride along — prefer details, else the plain field.
          const details = delta["reasoning_details"];
          if (Array.isArray(details)) {
            for (const block of details) {
              const t = (block as { text?: string })?.text;
              if (typeof t === "string" && t) {
                thinking += t;
                eventStream.push({ type: "thinking_delta", thinkingDelta: t, partialThinking: thinking });
              }
            }
          } else if (typeof delta["reasoning_content"] === "string" && delta["reasoning_content"]) {
            thinking += delta["reasoning_content"] as string;
            eventStream.push({
              type: "thinking_delta",
              thinkingDelta: delta["reasoning_content"] as string,
              partialThinking: thinking,
            });
          } else if (typeof delta["reasoning"] === "string" && delta["reasoning"]) {
            thinking += delta["reasoning"] as string;
            eventStream.push({
              type: "thinking_delta",
              thinkingDelta: delta["reasoning"] as string,
              partialThinking: thinking,
            });
          }
          // Tool-call deltas accumulate per choice index.
          const deltaCalls = delta["tool_calls"];
          if (Array.isArray(deltaCalls)) {
            for (const tc of deltaCalls) {
              const entry = tc as {
                index?: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              };
              const index = typeof entry.index === "number" ? (lastToolIndex = entry.index) : lastToolIndex;
              const existing = calls.get(index);
              if (existing) {
                if (entry.id) existing.id = entry.id;
                if (entry.function?.name) existing.name = entry.function.name;
                if (typeof entry.function?.arguments === "string") {
                  existing.deltaArgs += entry.function.arguments;
                }
              } else {
                calls.set(index, {
                  id: entry.id || "",
                  name: entry.function?.name || "unknown",
                  startArgs: "",
                  deltaArgs: typeof entry.function?.arguments === "string" ? entry.function.arguments : "",
                });
              }
            }
          }
          // Terminal accounting: finish_reason repeats on the usage chunk.
          if (typeof choice["finish_reason"] === "string" && choice["finish_reason"]) {
            const fr = choice["finish_reason"] as string;
            if (fr === "error") {
              const failure: Record<string, unknown> & Error = new Error(
                "OpenRouter stream terminated with finish_reason error"
              ) as Record<string, unknown> & Error;
              failure["url"] = url;
              throw toConciseProviderError(failure, "openrouter", clean);
            }
            finishReason = fr;
            sawFinishReason = true;
          }
          const chunkUsage = msg["usage"] as ChatUsage | undefined;
          if (chunkUsage) {
            usage = mapUsage(chunkUsage);
            sawUsage = true;
            completedBody = completedBody ?? msg;
            eventStream.push({ type: "usage", usage });
          }
        };

        while (true) {
          if (linked.signal.aborted || eventStream.isCancelled()) {
            try {
              await reader.cancel();
            } catch {}
            throw Object.assign(new Error("Stream aborted"), { name: "AbortError" });
          }
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const m of parser.feed(chunk)) handleMessage(m.data);
        }
        for (const m of parser.flush()) handleMessage(m.data);
        try {
          reader.releaseLock();
        } catch {}

        if (linked.signal.aborted || eventStream.isCancelled() || aborted) {
          throw Object.assign(new Error("Stream aborted"), { name: "AbortError" });
        }

        const toolCalls: ToolCallRecord[] = [];
        for (const c of calls.values()) {
          const args = parseStreamedToolArguments(c.startArgs, c.deltaArgs);
          const record: ToolCallRecord = {
            id: c.id && !c.id.includes("|") && c.id.length <= 40 ? c.id : clampToolCallId(c.id || newToolCallId()),
            name: c.name,
            arguments: args,
            rawArguments: selectRawArguments(c.startArgs, c.deltaArgs),
          };
          toolCalls.push(record);
          eventStream.push({ type: "tool_call_complete", toolCall: record });
        }

        // Did the stream really end? Read before the tool-call and refusal overrides below, which also set sawFinishReason.
        const hasTerminal = completedBody !== undefined || sawFinishReason || sawUsage;
        noteProviderTurn(sessionId, "openrouter");
        if (toolCalls.length > 0) {
          finishReason = "tool_calls";
          sawFinishReason = true;
        } else if (refusalSeen && finishReason !== "content_filter") {
          finishReason = "refusal";
          sawFinishReason = true;
        }

        // Q-23: terminal-state guard — fail `incomplete_stream` (retryable)
        // instead of resolving empty success. Skipped for non-SSE payloads
        // (JSON mocks) where no SSE frames were ever seen.
        const cleanThinkingEarly = thinking.replace(/\n{3,}/g, "\n\n").trim();
        const ctEntry = Object.entries(responseHeaders).find(([k]) => k.toLowerCase() === "content-type");
        const isSSEPayload =
          (typeof ctEntry?.[1] === "string" && ((ctEntry[1] as string).includes("event-stream") || (ctEntry[1] as string).startsWith("text/"))) ||
          framesSeen > 0 ||
          badFrames > 0;
        if (!hasTerminal && !text && !cleanThinkingEarly && toolCalls.length === 0 && isSSEPayload) {
          eventStream.fail(incompleteStreamError("openrouter", clean));
          return;
        }
        // Refuse unfinished tool calls whose args never parsed (output_item.done
        // never arrived): truncated `{raw}` must not reach the executor (pi
        // api/openai-responses-shared.ts:766 rule). Non-SSE mocks preserve legacy.
        if (!hasTerminal && hasUnfinishedToolCall(calls.values(), toolCalls) && isSSEPayload) {
          eventStream.fail(incompleteStreamError("openrouter", clean));
          return;
        }

        const cleanThinking = cleanThinkingEarly;
        const finalResponse = new AgentResponse({
          text,
          thinking: cleanThinking || undefined,
          thoughtSignature: undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage,
          finishReason,
          responseId,
          model: clean,
          provider: "openrouter",
          raw: {
            request: rawRequest,
            response: { ...responseMeta, body: completedBody, badFrames } as unknown as ProviderRawData["response"],
          },
          durationMs: Date.now() - startTime,
        });
        eventStream.push({ type: "done", delta: "", usage, finishReason, responseId });
        eventStream.end(finalResponse);
      } catch (err: unknown) {
        const raw = err instanceof Error ? err : new Error(String(err));
        const isAbort =
          linked.signal.aborted ||
          eventStream.isCancelled() ||
          (raw as { name?: string }).name === "AbortError";
        eventStream.fail(
          isAbort ? Object.assign(new Error("Stream aborted"), { name: "AbortError" }) : raw
        );
      } finally {
        try {
          options?.signal?.removeEventListener("abort", forwardUserAbort);
        } catch {}
        try {
          removeStreamCancel();
        } catch {}
      }
    })();

    return eventStream;
  }
}
