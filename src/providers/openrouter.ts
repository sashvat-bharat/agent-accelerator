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
 * (`src/providers/openrouter-responses.ts`) is discontinued: no video shape,
 * lossy error codes, beta event-vocabulary drift.
 *
 * Notes:
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
import { buildSessionHeaders } from "../utils/headers.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import { safeStringify } from "../utils/serialization.ts";
import { toConciseProviderError, assertModalitiesSupported } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { createGenericModelSpec } from "../models/catalog.ts";
import { getModelFromCatalog, getModelsForProvider } from "../models/catalog.ts";
import {
  mapThinkingLevelToOpenRouterChat,
  mapServiceTierToOpenRouter,
  applyCacheForOpenRouter,
  mapToolChoiceToOpenRouterChat,
  noteProviderTurn,
  parseStreamedToolArguments,
} from "../providers.ts";

// ---------------------------------------------------------------------------
// Chat Completions wire shapes (most-important subset)
// ---------------------------------------------------------------------------

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
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
  plugins?: Array<{ id: string }>;
  stream?: boolean;
  [k: string]: unknown;
}

interface ChatChoice {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      index?: number;
      function?: { name?: string; arguments?: string };
    }>;
    reasoning?: string | null;
    reasoning_details?: Array<{ type?: string; text?: string }>;
    refusal?: string | null;
  };
  delta?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
    reasoning_content?: string;
    reasoning?: string;
    reasoning_details?: Array<{ type?: string; text?: string }>;
    refusal?: string | null;
  };
  finish_reason?: string | null;
  native_finish_reason?: string | null;
  error?: { message?: string; code?: string | number };
}

interface ChatResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  provider?: string;
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    cost?: number;
    [k: string]: unknown;
  };
  error?: {
    message?: string;
    code?: string | number;
    metadata?: { error_type?: string; provider_code?: string | number; [k: string]: unknown };
  };
  [k: string]: unknown;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Internal headers that must never leak onto native REST requests. */
const INTERNAL_HEADERS = new Set([
  "x-thought-signature-map",
  "x-cached-content-id",
  "x-multimodal-user-content",
]);

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
  return options?.apiKey || getApiKey("openrouter", undefined, options?.env);
}

/**
 * Strips ONLY the `openrouter/` prefix. Scoped ids (`scope/model:variant`)
 * and bare ids pass through untouched — the router resolves them.
 */
function cleanModelId(model: string | ModelSpec): string {
  const rawId = typeof model === "string" ? model : model.id;
  return rawId.replace(/^openrouter\//i, "");
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

function audioFormatFor(mimeType?: string): string {
  const mime = (mimeType || "").toLowerCase();
  if (mime.includes("wav")) return "wav";
  return "mp3";
}

async function contentPartsToBlocks(parts: ContentPart[]): Promise<{
  blocks: ChatContentPart[];
  fileUrls: string[];
  hasFiles: boolean;
}> {
  const blocks: ChatContentPart[] = [];
  const fileUrls: string[] = [];
  let hasFiles = false;
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const raw = (part as { image?: unknown }).image;
      // Remote URLs pass through (router downloads; `image_download_failed`
      // surfaces if unreachable). Inline only local/base64/binary.
      if (typeof raw === "string" && (raw.startsWith("http://") || raw.startsWith("https://"))) {
        blocks.push({ type: "image_url", image_url: { url: raw } });
        continue;
      }
      const norm = await normalizeMediaInput(
        raw as string | Uint8Array | ArrayBuffer,
        (part as { mimeType?: string }).mimeType
      );
      blocks.push({ type: "image_url", image_url: { url: norm.dataUrl } });
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
      blocks.push({ type: "video_url", video_url: { url: norm.dataUrl } });
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
      hasFiles = true;
      const raw = (part as { file?: unknown }).file;
      const filename = (part as { filename?: string }).filename;
      if (typeof raw === "string" && (raw.startsWith("http://") || raw.startsWith("https://"))) {
        // Bare `{type:file}` parts are ignored by the route (observed live),
        // so the URL must ALSO ride in text for the file-parser plugin (see
        // fullHistoryMessages). Still sent forward-compat.
        fileUrls.push(raw);
        blocks.push({
          type: "file",
          file: {
            ...(typeof filename === "string" && filename ? { filename } : {}),
            file_url: raw,
          },
        });
        continue;
      }
      const norm = await normalizeMediaInput(
        raw as string | Uint8Array | ArrayBuffer,
        (part as { mimeType?: string }).mimeType
      );
      blocks.push({
        type: "file",
        file: {
          ...(typeof filename === "string" && filename ? { filename } : {}),
          file_data: norm.dataUrl,
        },
      });
    }
  }
  return { blocks, fileUrls, hasFiles };
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
 *
 * File handling: remote file URLs must be visible in text for the
 * `file-parser` plugin (bare `{type:file}` parts are ignored by the route),
 * so each remote file URL is appended as its own text part.
 */
async function fullHistoryMessages(context: ProviderContext): Promise<{
  messages: ChatMessage[];
  hasFiles: boolean;
}> {
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
  let hasFiles = false;
  for (const m of context.messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      if (typeof m.content === "string") {
        if (m.content) messages.push({ role: "user", content: m.content });
      } else {
        const { blocks, fileUrls, hasFiles: hf } = await contentPartsToBlocks(m.content);
        if (hf) hasFiles = true;
        // Surface remote file URLs in text for the file-parser plugin.
        for (const url of fileUrls) {
          blocks.push({ type: "text", text: url });
        }
        if (blocks.length > 0) messages.push({ role: "user", content: blocks });
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
            id: part.callId || part.id,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.arguments || {}) },
          });
        } else if (part.type === "text" && part.text) {
          texts.push(part.text);
        }
        // Prior-turn reasoning is NOT resent: chat history is messages +
        // tool calls only (documented decision; avoids strict-route 400s).
      }
      messages.push({
        role: "assistant",
        content: texts.length > 0 ? texts.join("\n") : null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    } else if (m.role === "tool") {
      if (typeof m.content === "string") {
        const queue = (m.name && idsByName.get(m.name)) || [];
        messages.push({
          role: "tool",
          tool_call_id: queue.shift() || "call_0",
          content: m.content,
          name: m.name,
        });
        continue;
      }
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content) {
        if (part.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: pairing.get(part.id) || part.id,
            content: resultToOutput(part.result),
            name: part.name,
          });
        }
      }
    }
  }
  return { messages, hasFiles };
}

// ---------------------------------------------------------------------------
// Response mapping (Chat Completions -> canonical)
// ---------------------------------------------------------------------------

function mapUsage(raw?: ChatResponse["usage"]): TokenUsage {
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
  if (typeof raw?.cost === "number" && raw.cost > 0) {
    usage.cost = { totalCost: raw.cost };
  }
  return usage;
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { raw };
  } catch {
    return { raw };
  }
}

/** Trims/collapses assembled thinking parts (no edge-tripling). */
function normalizeThinkingParts(parts: string[]): string | undefined {
  const cleaned = parts
    .map((p) => p.replace(/\n{3,}/g, "\n\n").trim())
    .filter((p) => p.length > 0);
  return cleaned.length > 0 ? cleaned.join("\n") : undefined;
}

function throwResponseError(response: ChatResponse, modelId: string): void {
  const message =
    response.error && typeof response.error.message === "string" && response.error.message
      ? response.error.message
      : "OpenRouter response failed";
  const failure: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
  if (response.error?.code !== undefined) failure["code"] = response.error.code;
  // Chat skin keeps the stable typed code INSIDE metadata (unlike Responses'
  // top-level `error_type`).
  const errorType = (response.error?.metadata as { error_type?: string } | undefined)?.error_type;
  if (typeof errorType === "string") failure["errorType"] = errorType;
  throw toConciseProviderError(failure, "openrouter", modelId);
}

function parseResponse(
  response: ChatResponse,
  modelId: string,
  durationMs: number,
  raw: ProviderRawData
): ProviderGenerateResult {
  // Provider-interrupted generations arrive as HTTP 200 carrying ONLY `error`
  // (no `choices`) — must check the body, not just the status.
  if (response.error) throwResponseError(response, modelId);

  const choice = response.choices?.[0];
  const message = choice?.message;
  const text = typeof message?.content === "string" ? message.content : "";
  // Thinking: `reasoning_details[].text` duplicates `message.reasoning` when
  // both ride along (observed live) — prefer details, else the plain field.
  const thinkingParts: string[] = [];
  const detailTexts: string[] = [];
  for (const block of message?.reasoning_details ?? []) {
    if (block?.type === "reasoning.text" && block.text) detailTexts.push(block.text);
  }
  if (detailTexts.length > 0) {
    thinkingParts.push(...detailTexts);
  } else if (typeof message?.reasoning === "string" && message.reasoning) {
    thinkingParts.push(message.reasoning);
  }
  const toolCalls: ToolCallRecord[] = [];
  for (const tc of message?.tool_calls ?? []) {
    const args = parseArguments(tc.function?.arguments);
    toolCalls.push({
      id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
      name: tc.function?.name || "unknown",
      arguments: args,
      rawArguments:
        typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {}),
    });
  }

  // Normalized finish reasons: tool_calls|stop|length|content_filter|error.
  const wireReason = choice?.finish_reason ?? undefined;
  return {
    text,
    thinking: normalizeThinkingParts(thinkingParts),
    thoughtSignature: undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: mapUsage(response.usage),
    finishReason:
      toolCalls.length > 0 ? "tool_calls" : wireReason || "stop",
    responseId: response.id,
    model: modelId,
    provider: "openrouter",
    raw,
    durationMs,
  };
}

function redactedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k.toLowerCase() === "authorization" ? "[REDACTED]" : v;
  }
  return out;
}

function readErrorPayload(bodyText: string): { message: string; code?: string | number; errorType?: string } {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const err = (first as { error?: { message?: string; code?: string | number; metadata?: { error_type?: string } } })?.error;
    if (err && typeof err.message === "string") {
      const errorType = (err as { metadata?: { error_type?: string } })?.metadata?.error_type;
      return {
        message: err.message,
        code: err.code,
        ...(typeof errorType === "string" ? { errorType } : {}),
      };
    }
    return { message: bodyText.slice(0, 300) };
  } catch {
    return { message: bodyText.slice(0, 300) };
  }
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
    applyCacheForOpenRouter(options?.cache, `openrouter/${modelId}`);

    const { messages, hasFiles } = await fullHistoryMessages(context);
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
    // PDF ingestion is a documented plugin, not a message shape: enable it
    // only when file parts are present (never by default).
    if (hasFiles) body.plugins = [{ id: "file-parser" }];
    // No temperature/top_p/max_tokens/stop/response_format/user/seed knobs
    // (no canonical options exist; omitting also keeps provider cache keys
    // stable). No store/previous_response_id/conversation: they do not exist
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
      options?.cache,
      options?.headers,
      sessionId
    );
    for (const [k, v] of Object.entries(headers)) {
      if (INTERNAL_HEADERS.has(k.toLowerCase())) delete headers[k];
    }
    headers["Content-Type"] = "application/json";
    headers["Authorization"] = `Bearer ${apiKey}`;
    return { method: "POST", headers, body: JSON.stringify(body), signal };
  }

  private async doFetch(
    url: string,
    body: ChatRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    sessionId: string | undefined,
    signal?: AbortSignal
  ): Promise<{ status: number; statusText: string; headers: Record<string, string>; text: string }> {
    const res = await fetch(url, this.requestInit(body, options, apiKey, sessionId, signal));
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, statusText: res.statusText, headers, text };
  }

  private throwIfError(
    status: number,
    url: string,
    bodyText: string,
    modelId: string
  ): void {
    if (status >= 200 && status < 300) return;
    const { message, code, errorType } = readErrorPayload(bodyText);
    const err: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
    (err as Record<string, unknown>)["statusCode"] = status;
    (err as Record<string, unknown>)["status"] = status;
    (err as Record<string, unknown>)["responseBody"] = bodyText.slice(0, 500);
    (err as Record<string, unknown>)["url"] = url.split("?")[0];
    if (code !== undefined) (err as Record<string, unknown>)["code"] = code;
    if (errorType) (err as Record<string, unknown>)["errorType"] = errorType;
    throw toConciseProviderError(err, "openrouter", modelId);
  }

  async generate(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): Promise<ProviderGenerateResult> {
    const startTime = Date.now();
    const clean = cleanModelId(model);
    const apiKey = resolveApiKey(options);
    if (!apiKey) {
      throw new Error(
        "[Agent Accelerator] Missing OpenRouter API key. Set OPENROUTER_API_KEY or pass apiKey."
      );
    }
    // Fail fast before any network call when the catalog knows the model
    // lacks the requested modality (clear one-liner instead of a confusing
    // router 404/400). Unknown models skip the guard; the router verdict
    // surfaces concisely.
    assertModalitiesSupported(context, "openrouter", clean);
    const baseUrl = resolveBaseUrl(options);
    const url = `${baseUrl}/chat/completions`;
    const sessionId = options?.sessionId || options?.cache?.sessionId;
    const tools = options?.tools as StandardToolDeclaration[] | undefined;
    const body = await this.buildBody(clean, context, options, sessionId, tools, false);

    // Audit trail: record the actual wire headers (attribution + session
    // affinity included), redacted.
    const auditRaw: Record<string, string> = {
      ...buildSessionHeaders("openrouter", options?.cache, options?.headers, sessionId),
      "Content-Type": "application/json",
      Authorization: "[REDACTED]",
    };
    for (const k of Object.keys(auditRaw)) {
      if (INTERNAL_HEADERS.has(k.toLowerCase())) delete auditRaw[k];
    }
    const rawRequest = {
      url,
      method: "POST",
      headers: redactedHeaders(auditRaw),
      body,
    };

    const doCall = async (): Promise<ProviderGenerateResult> => {
      const res = await this.doFetch(url, body, options, apiKey, sessionId, options?.signal);
      this.throwIfError(res.status, url, res.text, clean);
      let response: ChatResponse;
      try {
        response = JSON.parse(res.text) as ChatResponse;
      } catch {
        throw toConciseProviderError(
          Object.assign(new Error("Invalid JSON response from OpenRouter Chat Completions API"), {
            statusCode: res.status,
            responseBody: res.text.slice(0, 500),
            url,
          }),
          "openrouter",
          clean
        );
      }
      // Stateless turns never establish chains, but the session store still
      // records the turn so other providers' switch detection keeps working.
      noteProviderTurn(sessionId, "openrouter");
      return parseResponse(
        response,
        clean,
        Date.now() - startTime,
        { request: rawRequest, response: { status: res.status, statusText: res.statusText, headers: res.headers, body: response } }
      );
    };

    try {
      return await withRetries(doCall, {
        maxRetries: options?.maxRetries,
        maxRetryDelayMs: options?.maxRetryDelayMs,
        signal: options?.signal,
        label: { providerId: "openrouter", modelId: clean },
      });
    } catch (err) {
      if (err instanceof Error && (err as { name?: string }).name === "AbortError") throw err;
      throw err;
    }
  }

  stream(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): AssistantMessageEventStream {
    const eventStream = new AssistantMessageEventStream();
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
        const sessionId = options?.sessionId || options?.cache?.sessionId;
        const tools = options?.tools as StandardToolDeclaration[] | undefined;
        const body = await this.buildBody(clean, context, options, sessionId, tools, true);

        const streamAuditRaw: Record<string, string> = {
          ...buildSessionHeaders("openrouter", options?.cache, options?.headers, sessionId),
          "Content-Type": "application/json",
          Authorization: "[REDACTED]",
        };
        for (const k of Object.keys(streamAuditRaw)) {
          if (INTERNAL_HEADERS.has(k.toLowerCase())) delete streamAuditRaw[k];
        }
        const rawRequest = {
          url,
          method: "POST",
          headers: redactedHeaders(streamAuditRaw),
          body,
        };

        const res = await fetch(url, this.requestInit(body, options, apiKey, sessionId, linked.signal));
        if (!res.ok || !res.body) {
          const text = !res.ok ? await res.text().catch(() => "") : "";
          if (!res.ok) this.throwIfError(res.status, url, text, clean);
          throw toConciseProviderError(new Error("OpenRouter streaming response had no body"), "openrouter", clean);
        }
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });
        const responseMeta = { status: res.status, statusText: res.statusText, headers: responseHeaders };
        eventStream.push({ type: "start", raw: { request: rawRequest } } as never);

        const parser = new SSEParser();
        const reader = res.body.getReader();
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
        let responseId: string | undefined;
        let completedBody: unknown = undefined;
        let aborted = false;
        linked.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            try {
              void reader.cancel();
            } catch {}
          },
          { once: true }
        );

        const handleMessage = (data: string): void => {
          if (!data || data === "[DONE]") return;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(data) as Record<string, unknown>;
          } catch {
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
            failure["url"] = url;
            throw toConciseProviderError(failure, "openrouter", clean);
          }
          if (typeof msg["id"] === "string" && !responseId) {
            responseId = msg["id"] as string;
          }
          const choice = (Array.isArray(msg["choices"]) ? (msg["choices"] as Record<string, unknown>[])[0] : undefined) ?? {};
          const delta = (choice["delta"] as Record<string, unknown>) ?? {};
          // Text delta (content-free accounting frames carry "" — ignored).
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
          }
          const chunkUsage = msg["usage"] as ChatResponse["usage"] | undefined;
          if (chunkUsage) {
            usage = mapUsage(chunkUsage);
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
            id: c.id || `call_${Math.random().toString(36).slice(2, 9)}`,
            name: c.name,
            arguments: args,
            rawArguments: c.startArgs + c.deltaArgs,
          };
          toolCalls.push(record);
          eventStream.push({ type: "tool_call_complete", toolCall: record });
        }

        noteProviderTurn(sessionId, "openrouter");
        if (toolCalls.length > 0) finishReason = "tool_calls";

        const cleanThinking = thinking.replace(/\n{3,}/g, "\n\n").trim();
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
          raw: { request: rawRequest, response: { ...responseMeta, body: completedBody } },
          durationMs: Date.now() - startTime,
        });
        eventStream.push({ type: "done", delta: "", usage, finishReason, responseId });
        eventStream.end(finalResponse);
      } catch (err: unknown) {
        const raw = err instanceof Error ? err : new Error(String(err));
        const isAbort =
          linked.signal.aborted ||
          eventStream.isCancelled() ||
          (raw as { name?: string }).name === "AbortError" ||
          /abort|cancell?ed/i.test(String((raw as { message?: string }).message ?? raw));
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
