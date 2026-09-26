/**
 * Generic OpenAI-compatible Chat Completions provider
 * (`POST {baseUrl}/chat/completions`, streaming on the same endpoint).
 *
 * Serves EVERY custom prefix (`groq/…`, `ollama/…`, `cerebras/…`, …) with one
 * strict-subset implementation of the OpenAI Chat Completions wire — no SDK
 * transport anywhere in this file.
 *
 * All endpoint-specific HTTP, headers, auth, request construction,
 * response/SSE parsing, and wire transformations live HERE — never in the
 * canonical layer (`src/providers.ts`).
 *
 * Strictness contract (differs from the old lenient passthrough on purpose):
 * - Requests carry ONLY standard Chat Completions fields (`model`, `messages`,
 *   `tools`, `tool_choice`, `stream`). No `reasoning`, `service_tier`,
 *   `session_id`, `prompt_cache_key`, or other extras: strict endpoints
 *   (groq, ollama, …) fail unknown body properties, so anything unsupported
 *   is warn+drop, never sent.
 * - `text`, `image_url`, and `input_audio` parts are sent; `video`/`file`
 *   parts fail fast with a one-line error naming the remedy (files point at
 *   `convertDocumentToMarkdown`). The old transport let these through to
 *   confusing provider 400s.
 * - Prior-turn reasoning is NOT resent (chat history is messages + tool calls
 *   only), except echoed Gemini thought signatures (see below).
 * - Gemini models served through OpenAI-compatible endpoints keep working:
 *   `extra_content.google.thought_signature` on tool calls is captured into
 *   the canonical `thoughtSignature` and echoed back verbatim on the next
 *   turn (otherwise the endpoint 400s on missing signatures). Echoes happen
 *   ONLY when a previous turn produced a signature — other endpoints never
 *   see the field.
 *
 * Notes:
 * - STATELESS per request: every turn sends the full canonical `messages`
 *   array explicitly. Session affinity is headers-only best effort
 *   (`x-session-id`); bodies carry no affinity key.
 * - IDs are provider-generated and echoed verbatim (`tool_call_id`). The
 *   `call_${random}` fallback in parsers is a local canonical correlation id
 *   only; it is never sent.
 * - Local endpoints (localhost / loopback / RFC-1918 / *.local) may omit the
 *   API key (no `Authorization` header is sent then). Any other endpoint
 *   without a key fails fast instead of sending a dummy bearer into a 401.
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
import type { TokenUsage, ThinkingConfig } from "../types/core.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { SSEParser } from "../streaming/sse-parser.ts";
import { AgentResponse } from "../types/response.ts";
import { getApiKey, getEnv } from "../utils/env.ts";
import { buildSessionHeaders } from "../utils/headers.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import { safeStringify } from "../utils/serialization.ts";
import { toConciseProviderError, assertModalitiesSupported } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { getModelFromCatalog, createGenericModelSpec } from "../models/catalog.ts";
import {
  applyCacheForCustom,
  mapToolChoiceToOpenAI,
  emitProviderWarning,
  noteProviderTurn,
  parseStreamedToolArguments,
} from "../providers.ts";

// ---------------------------------------------------------------------------
// Chat Completions wire shapes (strict standard subset)
// ---------------------------------------------------------------------------

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } }
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
        extra_content?: { google?: { thought_signature?: string } };
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
      extra_content?: { google?: { thought_signature?: string } };
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
  error?: { message?: string; code?: string | number };
}

interface ChatResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
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
  error?: { message?: string; code?: string | number };
  [k: string]: unknown;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Headers that must never leak onto native REST requests. */
const INTERNAL_HEADERS = new Set([
  "x-thought-signature-map",
  "x-cached-content-id",
  "x-multimodal-user-content",
]);

// ---------------------------------------------------------------------------
// Request building (canonical -> Chat Completions)
// ---------------------------------------------------------------------------

function envPrefixOf(prefix: string): string {
  return prefix.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function resolveBaseUrl(
  prefix: string,
  configuredBaseUrl: string | undefined,
  options?: ProviderRequestOptions
): string {
  const envPrefix = envPrefixOf(prefix);
  return (
    options?.baseUrl ||
    configuredBaseUrl ||
    options?.env?.[`${envPrefix}_BASE_URL`] ||
    options?.env?.[`${envPrefix}_BASEURL`] ||
    options?.env?.[`${envPrefix}_API_BASE`] ||
    getEnv(`${envPrefix}_BASE_URL`) ||
    getEnv(`${envPrefix}_BASEURL`) ||
    getEnv(`${envPrefix}_API_BASE`) ||
    getEnv("OPENAI_BASE_URL") ||
    getEnv("OPENAI_API_BASE") ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

function resolveApiKey(
  prefix: string,
  configuredApiKey: string | undefined,
  options?: ProviderRequestOptions
): string | undefined {
  const envPrefix = envPrefixOf(prefix);
  return (
    options?.apiKey ||
    configuredApiKey ||
    options?.env?.[`${envPrefix}_API_KEY`] ||
    options?.env?.[`${envPrefix}_BASE_API_KEY`] ||
    options?.env?.["OPENAI_BASE_API_KEY"] ||
    options?.env?.["OPENAI_API_KEY"] ||
    getEnv(`${envPrefix}_API_KEY`) ||
    getEnv(`${envPrefix}_BASE_API_KEY`) ||
    getEnv("OPENAI_BASE_API_KEY") ||
    getEnv("OPENAI_API_KEY") ||
    getApiKey(prefix, undefined, options?.env) ||
    undefined
  );
}

/** Local endpoints (loopback / LAN / *.local) may omit the API key. */
function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    ) {
      return true;
    }
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Strips ONLY the `{prefix}/` scope. Bare ids pass through untouched. */
function cleanModelId(prefix: string, model: string | ModelSpec): string {
  const rawId = typeof model === "string" ? model : model.id;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return rawId.replace(new RegExp(`^${escaped}/`, "i"), "");
}

function toCompatTools(tools?: StandardToolDeclaration[]): Array<Record<string, unknown>> | undefined {
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

/** Thinking levels have no portable wire shape on generic endpoints: warn once, send nothing. */
function warnThinkingDropped(prefix: string, thinking: ThinkingConfig | undefined, modelRef: string): void {
  if (!thinking) return;
  const level = thinking.level;
  if (!level || level === "dynamic") return; // server default either way
  emitProviderWarning({
    provider: prefix,
    capability: "thinking level",
    requested: `${level} (${modelRef})`,
    reason: "custom OpenAI-compatible endpoints define no portable reasoning control; levels vary by vendor and strict endpoints reject unknown fields.",
    fallback: "the server default (no reasoning payload is sent)",
  });
}

function audioFormatFor(mimeType?: string): string {
  const mime = (mimeType || "").toLowerCase();
  if (mime.includes("wav")) return "wav";
  return "mp3";
}

/**
 * Rejects `video`/`file` parts before any network call: the strict Chat
 * Completions subset has no shape for them, and a provider 400 would only say
 * so confusingly. Images and audio keep flowing natively.
 */
function assertNoVideoOrFileParts(
  context: ProviderContext,
  prefix: string,
  modelId: string
): void {
  let kind: "video" | "file" | undefined;
  for (const msg of context.messages) {
    if (!Array.isArray((msg as { content?: unknown }).content)) continue;
    for (const part of (msg as { content: Array<{ type?: unknown }> }).content) {
      if ((part as { type?: unknown }).type === "video") {
        kind = "video";
        break;
      }
      if ((part as { type?: unknown }).type === "file") {
        kind = "file";
        break;
      }
    }
    if (kind) break;
  }
  if (!kind) return;
  const message =
    kind === "video"
      ? `[${prefix}/${modelId}] unsupported video input (generic OpenAI-compatible endpoints carry text/image/audio only). Use a video-capable model (e.g. google/gemini-*) or drop the video part.`
      : `[${prefix}/${modelId}] unsupported file input (generic OpenAI-compatible endpoints carry text/image/audio only). Convert the document to Markdown with the convert_document_to_markdown tool (or Agent bypassInputFileModality) and send it as text instead.`;
  const err = new Error(message);
  err.name = "AgentAccelProviderError";
  Object.defineProperties(err, {
    provider: { value: prefix, enumerable: false },
    model: { value: modelId, enumerable: false },
  });
  throw err;
}

async function contentPartsToBlocks(parts: ContentPart[]): Promise<ChatContentPart[]> {
  const blocks: ChatContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const raw = (part as { image?: unknown }).image;
      if (typeof raw === "string" && (raw.startsWith("http://") || raw.startsWith("https://"))) {
        blocks.push({ type: "image_url", image_url: { url: raw } });
        continue;
      }
      const norm = await normalizeMediaInput(
        raw as string | Uint8Array | ArrayBuffer,
        (part as { mimeType?: string }).mimeType
      );
      blocks.push({ type: "image_url", image_url: { url: norm.dataUrl } });
    } else if (part.type === "audio") {
      const raw = (part as { audio?: unknown }).audio;
      const mimeType = (part as { mimeType?: string }).mimeType;
      // The OpenAI chat audio shape carries data only — always inline.
      const norm = await normalizeMediaInput(
        raw as string | Uint8Array | ArrayBuffer,
        mimeType
      );
      blocks.push({
        type: "input_audio",
        input_audio: { data: norm.base64Data, format: audioFormatFor(norm.mimeType) },
      });
    }
    // video/file never reach here: assertNoVideoOrFileParts runs first.
  }
  return blocks;
}

function resultToOutput(result: unknown): string {
  if (typeof result === "string") return result;
  return safeStringify(result);
}

/**
 * Builds the FULL explicit history as Chat Completions `messages` (stateless
 * transport: every turn carries everything). Prior-turn reasoning is NOT
 * resent — except echoed Gemini thought signatures, which strict
 * OpenAI-compatible endpoints require on tool calls they generated.
 */
async function fullHistoryMessages(context: ProviderContext): Promise<ChatMessage[]> {
  const pairing = new Map<string, string>();
  for (const m of context.messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "tool_call") {
          pairing.set(part.id, part.callId || part.id);
        }
      }
    }
  }

  const messages: ChatMessage[] = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const m of context.messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      if (typeof m.content === "string") {
        if (m.content) messages.push({ role: "user", content: m.content });
      } else {
        const blocks = await contentPartsToBlocks(m.content);
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
      const calls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
        extra_content?: { google: { thought_signature: string } };
      }> = [];
      for (const part of m.content) {
        if (part.type === "tool_call") {
          const call: {
            id: string;
            type: "function";
            function: { name: string; arguments: string };
            extra_content?: { google: { thought_signature: string } };
          } = {
            id: part.callId || part.id,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.arguments || {}) },
          };
          // Echo provider-issued thought signatures verbatim so endpoints
          // that minted them (Gemini behind a compat proxy) keep working.
          // Only present when a previous turn captured one — other endpoints
          // never see this field.
          if (part.thoughtSignature) {
            call.extra_content = { google: { thought_signature: part.thoughtSignature } };
          }
          calls.push(call);
        } else if (part.type === "text" && part.text) {
          texts.push(part.text);
        }
      }
      messages.push({
        role: "assistant",
        content: texts.length > 0 ? texts.join("\n") : null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    } else if (m.role === "tool") {
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
  return messages;
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

function extractSignature(rawTc: {
  extra_content?: { google?: { thought_signature?: string } };
}): string | undefined {
  const sig = rawTc?.extra_content?.google?.thought_signature;
  return typeof sig === "string" && sig ? sig : undefined;
}

function throwResponseError(
  response: ChatResponse,
  prefix: string,
  modelId: string
): void {
  const message =
    response.error && typeof response.error.message === "string" && response.error.message
      ? response.error.message
      : "OpenAI-compatible response failed";
  const failure: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
  if (response.error?.code !== undefined) failure["code"] = response.error.code;
  throw toConciseProviderError(failure, prefix, modelId);
}

function parseResponse(
  response: ChatResponse,
  prefix: string,
  modelId: string,
  durationMs: number,
  raw: ProviderRawData
): ProviderGenerateResult {
  // Provider-interrupted generations arrive as HTTP 200 carrying ONLY `error`
  // (no `choices`) — must check the body, not just the status.
  if (response.error) throwResponseError(response, prefix, modelId);

  const choice = response.choices?.[0];
  const message = choice?.message;
  const text = typeof message?.content === "string" ? message.content : "";
  // Thinking tolerance: plain `reasoning` plus per-block texts (deepseek-style
  // `reasoning_details`). Details win when both ride along; both are
  // display-only here — never resent.
  const thinkingParts: string[] = [];
  const detailTexts: string[] = [];
  for (const block of message?.reasoning_details ?? []) {
    if (block && typeof block.text === "string" && block.text) detailTexts.push(block.text);
  }
  if (detailTexts.length > 0) {
    thinkingParts.push(...detailTexts);
  } else if (typeof message?.reasoning === "string" && message.reasoning) {
    thinkingParts.push(message.reasoning);
  }
  const toolCalls: ToolCallRecord[] = [];
  for (const tc of message?.tool_calls ?? []) {
    const args = parseArguments(tc.function?.arguments);
    const sig = extractSignature(tc);
    toolCalls.push({
      id: tc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
      name: tc.function?.name || "unknown",
      arguments: args,
      rawArguments:
        typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {}),
      ...(sig ? { thoughtSignature: sig } : {}),
    });
  }

  const wireReason = choice?.finish_reason ?? undefined;
  return {
    text,
    thinking: normalizeThinkingParts(thinkingParts),
    thoughtSignature: toolCalls.map((c) => c.thoughtSignature).find(Boolean),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: mapUsage(response.usage),
    finishReason: toolCalls.length > 0 ? "tool_calls" : wireReason || "stop",
    responseId: response.id,
    model: modelId,
    provider: prefix as ProviderId,
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

function readErrorPayload(bodyText: string): { message: string; code?: string | number } {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const err = (first as { error?: { message?: string; code?: string | number } })?.error;
    if (err && typeof err.message === "string") {
      return { message: err.message, code: err.code };
    }
    return { message: bodyText.slice(0, 300) };
  } catch {
    return { message: bodyText.slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface CustomProviderOptions {
  /** Human label, defaults to `${prefix} (OpenAI-compatible)` */
  name?: string;
  /** Static baseUrl — overrides env. Env `{PREFIX}_BASE_URL` still wins at runtime if set. */
  baseUrl?: string;
  /** Static apiKey — overrides env. Explicit per-call `apiKey` still wins. */
  apiKey?: string;
  /** Default baseUrl when no env is set. Defaults to OpenAI cloud. */
  defaultBaseUrl?: string;
}

/**
 * Generic OpenAI-compatible provider implemented directly on the Chat
 * Completions REST API (`POST {baseUrl}/chat/completions`, streaming on the
 * same endpoint). One class serves every custom prefix.
 */
export class OpenAICompatibleChatProvider implements Provider {
  readonly id: ProviderId;
  readonly name: string;
  readonly models: ModelSpec[] = [];
  private readonly prefix: string;
  private readonly configuredBaseUrl?: string;
  private readonly configuredApiKey?: string;

  /**
   * Creates an OpenAI-compatible provider for any endpoint prefix.
   *
   * @param prefix Prefix used in model strings and environment variables,
   * such as `groq` for `groq/llama-3.3-70b-versatile`.
   * @param opts Optional endpoint, key, and display-name overrides.
   *
   * @example
   * ```ts
   * const groq = new OpenAICompatibleChatProvider("groq", {
   *   baseUrl: "https://api.groq.com/openai/v1",
   *   apiKey: process.env.GROQ_API_KEY,
   * });
   * ```
   */
  constructor(prefix: string, opts?: CustomProviderOptions) {
    const norm = prefix.trim().toLowerCase().replace(/\/.*$/, "");
    this.prefix = norm;
    this.id = norm as ProviderId;
    this.name = opts?.name ?? `${norm} (OpenAI-compatible)`;
    this.configuredBaseUrl = opts?.baseUrl ?? opts?.defaultBaseUrl;
    this.configuredApiKey = opts?.apiKey;
  }

  getModel(modelId: string): ModelSpec | undefined {
    const clean = cleanModelId(this.prefix, modelId);
    return (
      getModelFromCatalog(this.id, modelId) ||
      getModelFromCatalog(this.id, clean) ||
      this.models.find((m) => m.id === modelId || m.id === clean) ||
      createGenericModelSpec(this.id, clean)
    );
  }

  private baseUrl(options?: ProviderRequestOptions): string {
    return resolveBaseUrl(this.prefix, this.configuredBaseUrl, options);
  }

  private apiKey(options?: ProviderRequestOptions): string | undefined {
    return resolveApiKey(this.prefix, this.configuredApiKey, options);
  }

  private requireApiKey(baseUrl: string, options?: ProviderRequestOptions): string | undefined {
    const key = this.apiKey(options);
    if (!key && !isLocalEndpoint(baseUrl)) {
      throw new Error(
        `[Agent Accelerator] Missing API key for "${this.prefix}". Set ${envPrefixOf(this.prefix)}_API_KEY or pass apiKey. (Local endpoints may omit the key.)`
      );
    }
    return key;
  }

  private async buildBody(
    modelId: string,
    context: ProviderContext,
    options: ProviderRequestOptions | undefined,
    tools: StandardToolDeclaration[] | undefined,
    stream: boolean
  ): Promise<ChatRequestBody> {
    warnThinkingDropped(this.prefix, options?.thinking, `${this.prefix}/${modelId}`);
    if (options?.serviceTier) {
      emitProviderWarning({
        provider: this.prefix,
        capability: "service tier",
        requested: `${options.serviceTier} (${this.prefix}/${modelId})`,
        reason: "custom OpenAI-compatible endpoints define no service-tier primitive, and strict endpoints reject unknown body properties.",
        fallback: "standard routing (no service_tier payload is sent)",
      });
    }
    applyCacheForCustom(this.prefix, options?.cache, `${this.prefix}/${modelId}`);

    const messages = await fullHistoryMessages(context);
    const body: ChatRequestBody = {
      model: modelId,
      messages,
      ...(stream ? { stream: true } : {}),
    };
    const compatTools = toCompatTools(tools);
    if (compatTools) body.tools = compatTools;
    const toolChoice = mapToolChoiceToOpenAI(
      options?.toolChoice as "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined
    );
    if (toolChoice !== undefined) {
      // Chat Completions nests pinned names under `function`; the canonical
      // mapper emits the flat Responses shape, so normalize here.
      body.tool_choice =
        typeof toolChoice === "object" && "name" in toolChoice && !("function" in toolChoice)
          ? { type: "function", function: { name: (toolChoice as { name: string }).name } }
          : (toolChoice as ChatRequestBody["tool_choice"]);
    }
    // No reasoning / service_tier / session / cache body primitives: strict
    // endpoints reject unknown properties. Affinity is headers-only.
    return body;
  }

  private requestInit(
    body: ChatRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string | undefined,
    sessionId: string | undefined,
    signal?: AbortSignal
  ): RequestInit {
    const headers: Record<string, string> = buildSessionHeaders(
      this.prefix,
      options?.cache,
      options?.headers,
      sessionId
    );
    for (const [k, v] of Object.entries(headers)) {
      if (INTERNAL_HEADERS.has(k.toLowerCase())) delete headers[k];
    }
    headers["Content-Type"] = "application/json";
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    return { method: "POST", headers, body: JSON.stringify(body), signal };
  }

  private async doFetch(
    url: string,
    body: ChatRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string | undefined,
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
    const { message, code } = readErrorPayload(bodyText);
    const err: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
    (err as Record<string, unknown>)["statusCode"] = status;
    (err as Record<string, unknown>)["status"] = status;
    (err as Record<string, unknown>)["responseBody"] = bodyText.slice(0, 500);
    (err as Record<string, unknown>)["url"] = url.split("?")[0];
    if (code !== undefined) (err as Record<string, unknown>)["code"] = code;
    throw toConciseProviderError(err, this.prefix, modelId);
  }

  async generate(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): Promise<ProviderGenerateResult> {
    const startTime = Date.now();
    const clean = cleanModelId(this.prefix, model);
    const baseUrl = this.baseUrl(options);
    const apiKey = this.requireApiKey(baseUrl, options);
    // Fail fast before any network call when the catalog knows the model
    // lacks the requested modality. Unknown models skip the guard; the
    // endpoint verdict surfaces concisely.
    assertModalitiesSupported(context, this.prefix, clean);
    assertNoVideoOrFileParts(context, this.prefix, clean);
    const url = `${baseUrl}/chat/completions`;
    const sessionId = options?.sessionId || options?.cache?.sessionId;
    const tools = options?.tools as StandardToolDeclaration[] | undefined;
    const body = await this.buildBody(clean, context, options, tools, false);

    const auditRaw: Record<string, string> = {
      ...buildSessionHeaders(this.prefix, options?.cache, options?.headers, sessionId),
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: "[REDACTED]" } : {}),
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
          Object.assign(new Error("Invalid JSON response from OpenAI-compatible Chat Completions API"), {
            statusCode: res.status,
            responseBody: res.text.slice(0, 500),
            url,
          }),
          this.prefix,
          clean
        );
      }
      // Stateless turns never establish chains, but the session store still
      // records the turn so other providers' switch detection keeps working.
      noteProviderTurn(sessionId, this.prefix);
      return parseResponse(
        response,
        this.prefix,
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
        label: { providerId: this.prefix, modelId: clean },
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
    const prefix = this.prefix;
    const clean = cleanModelId(this.prefix, model);

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
        const baseUrl = this.baseUrl(options);
        const apiKey = this.requireApiKey(baseUrl, options);
        assertModalitiesSupported(context, prefix, clean);
        assertNoVideoOrFileParts(context, prefix, clean);
        const url = `${baseUrl}/chat/completions`;
        const sessionId = options?.sessionId || options?.cache?.sessionId;
        const tools = options?.tools as StandardToolDeclaration[] | undefined;
        const body = await this.buildBody(clean, context, options, tools, true);

        const streamAuditRaw: Record<string, string> = {
          ...buildSessionHeaders(prefix, options?.cache, options?.headers, sessionId),
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: "[REDACTED]" } : {}),
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
          throw toConciseProviderError(new Error("OpenAI-compatible streaming response had no body"), prefix, clean);
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
        let lastToolIndex = 0;
        const signatures = new Map<number, string>();
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
          const topError = msg["error"] as { message?: string; code?: string | number } | undefined;
          if (topError && typeof topError === "object") {
            const message =
              typeof topError.message === "string" && topError.message
                ? topError.message
                : "OpenAI-compatible streaming error";
            const failure: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
            if (topError.code !== undefined) failure["code"] = topError.code;
            failure["url"] = url;
            throw toConciseProviderError(failure, prefix, clean);
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
          // Tolerated reasoning deltas (deepseek-style): display-only, never resent.
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
          // Tool-call deltas accumulate per choice index (unindexed chunks
          // continue the last call; defaulting to calls.size would fork
          // phantom calls).
          const deltaCalls = delta["tool_calls"];
          if (Array.isArray(deltaCalls)) {
            for (const tc of deltaCalls) {
              const entry = tc as {
                index?: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
                extra_content?: { google?: { thought_signature?: string } };
              };
              const index = typeof entry.index === "number" ? (lastToolIndex = entry.index) : lastToolIndex;
              const sig = entry.extra_content?.google?.thought_signature;
              if (typeof sig === "string" && sig) signatures.set(index, sig);
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
                "OpenAI-compatible stream terminated with finish_reason error"
              ) as Record<string, unknown> & Error;
              failure["url"] = url;
              throw toConciseProviderError(failure, prefix, clean);
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
        for (const [index, c] of calls) {
          const args = parseStreamedToolArguments(c.startArgs, c.deltaArgs);
          const sig = signatures.get(index);
          const record: ToolCallRecord = {
            id: c.id || `call_${Math.random().toString(36).slice(2, 9)}`,
            name: c.name,
            arguments: args,
            rawArguments: c.startArgs + c.deltaArgs,
            ...(sig ? { thoughtSignature: sig } : {}),
          };
          toolCalls.push(record);
          eventStream.push({ type: "tool_call_complete", toolCall: record });
        }

        noteProviderTurn(sessionId, prefix);
        if (toolCalls.length > 0) finishReason = "tool_calls";

        const cleanThinking = thinking.replace(/\n{3,}/g, "\n\n").trim();
        const finalThoughtSignature = toolCalls.map((c) => c.thoughtSignature).find(Boolean);
        const finalResponse = new AgentResponse({
          text,
          thinking: cleanThinking || undefined,
          thoughtSignature: finalThoughtSignature,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage,
          finishReason,
          responseId,
          model: clean,
          provider: prefix as ProviderId,
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

/**
 * Creates a custom OpenAI-compatible provider backed by native REST.
 * @example `const provider = createOpenAICompatibleProvider("groq", { baseUrl: "https://api.groq.com/openai/v1" });`
 */
export function createOpenAICompatibleProvider(
  prefix: string,
  opts?: CustomProviderOptions
): OpenAICompatibleChatProvider {
  return new OpenAICompatibleChatProvider(prefix, opts);
}
/** Backward-compatible alias for {@link createOpenAICompatibleProvider}. @example `createCustomProvider("ollama")` */
export const createCustomProvider = createOpenAICompatibleProvider;
/** Backward-compatible class alias for {@link OpenAICompatibleChatProvider}. @example `new CustomProvider("ollama")` */
export const CustomProvider = OpenAICompatibleChatProvider;
