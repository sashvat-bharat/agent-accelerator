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
 *   `tools`, `tool_choice`, `stream`, plus `max_tokens`/
 *   `stop`/`seed` when explicitly set). No `reasoning`, `service_tier`,
 *   `session_id`, `prompt_cache_key`, or other extras: strict endpoints
 *   (groq, ollama, …) fail unknown body properties, so anything unsupported
 *   is warn+drop, never sent.
 * - `text`, `image_url`, and `input_audio` parts are sent; `video`/`file`
 *   parts fail fast with a one-line error naming the remedy. The old transport
 *   let these through to confusing provider 400s.
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
import { AgentResponse } from "../types/response.ts";
import { getApiKey, getEnv } from "../utils/env.ts";
import { buildSessionHeaders, setHeaderCaseInsensitive, shouldEchoSignature } from "../utils/headers.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import { safeStringify } from "../utils/serialization.ts";
import { toConciseProviderError, assertModalitiesSupported } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { ConfigError, ValidationError } from "../types/errors.ts";
import {
  parseArguments,
  normalizeThinkingParts,
  newToolCallId,
  redactedHeaders,
  readErrorPayload,
  incompleteStreamError,
  hasUnfinishedToolCall,
  linkStreamAbort,
  withAbortTimer,
  readSseData,
  incompleteStreamCheck,
  failStream,
  toolArgumentsJson,
  toolTurnFinishReason,
  combinedSignal,
  timeoutFor,
  hasAuthHeader,
  clampToolCallId,
  openStreamResponse,
  retryOptionsFrom,
  headersToRecord,
  parseRetryAfterMs,
} from "./shared.ts";
import { getModelFromCatalog, createGenericModelSpec, modelSupportsStructuredOutput } from "../models/catalog.ts";
import {
  resolveCache,
  mapToolChoiceToOpenAI,
  emitProviderWarning,
  noteProviderTurn,
  parseStreamedToolArguments,
  selectRawArguments,
  mapOutputToCompatChat,
  mapGenerationParamsToChat,
  normalizeStructuredOutput,
  augmentSystemPromptWithStructuredOutput,
  warnIgnoredMediaResolution,
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
  response_format?: { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict: boolean; description?: string } };
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

// ---------------------------------------------------------------------------
// Request building (canonical -> Chat Completions)
// ---------------------------------------------------------------------------

// Env-variable prefix of a custom provider (`my-llm` becomes `MY_LLM`); in: key and URL lookups, out: the prefix.
function envPrefixOf(prefix: string): string {
  return prefix.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

// Endpoint from the option, the provider's configuration or {PREFIX}_BASE_URL; throws ConfigError when none (never another vendor's URL); in: each request, out: the base URL.
function resolveBaseUrl(
  prefix: string,
  configuredBaseUrl: string | undefined,
  options?: ProviderRequestOptions
): string {
  const envPrefix = envPrefixOf(prefix);
  const resolved =
    options?.baseUrl ||
    configuredBaseUrl ||
    options?.env?.[`${envPrefix}_BASE_URL`] ||
    options?.env?.[`${envPrefix}_BASEURL`] ||
    options?.env?.[`${envPrefix}_API_BASE`] ||
    getEnv(`${envPrefix}_BASE_URL`) ||
    getEnv(`${envPrefix}_BASEURL`) ||
    getEnv(`${envPrefix}_API_BASE`);
  // Never fall back to another vendor's cloud: a custom prefix's API key
  // must only ever travel to the endpoint the developer named.
  if (!resolved) {
    throw new ConfigError(
      `[Agent Accelerator] Missing base URL for "${prefix}". Set ${envPrefix}_BASE_URL (or pass baseUrl); custom endpoints never default to api.openai.com.`
    );
  }
  return resolved.replace(/\/+$/, "");
}

// Key from the option, the provider's configuration or {PREFIX}_API_KEY, or `unused` when custom headers carry the auth; in: each request, out: the key or undefined.
function resolveApiKey(
  prefix: string,
  configuredApiKey: string | undefined,
  options?: ProviderRequestOptions
): string | undefined {
  const clean = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.trim().replace(/^["']|["']$/g, "").trim();
    return t || undefined;
  };
  const envPrefix = envPrefixOf(prefix);
  const key = (
    clean(options?.apiKey) ||
    clean(configuredApiKey) ||
    clean(options?.env?.[`${envPrefix}_API_KEY`]) ||
    clean(options?.env?.[`${envPrefix}_BASE_API_KEY`]) ||
    getApiKey(prefix, undefined, options?.env) ||
    undefined
  );
  if (key) return key;
  if (hasAuthHeader(options?.headers)) return "unused";
  return undefined;
}

/** Local endpoints (loopback / LAN / *.local) may omit the API key. Literal IPs only; hostnames like 10.evil.com are not local. */
function isLocalEndpoint(baseUrl: string): boolean {
  try {
    let host = new URL(baseUrl).hostname.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "0:0:0:0:0:0:0:1" ||
      host.endsWith(".local")
    ) {
      return true;
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const parts = host.split(".").map(Number);
      const [a, b] = parts as number[];
      if (a === 10) return true;
      if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 127) return true;
      return false;
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

// Canonical tool declarations as Chat Completions function tools; in: options.tools, out: request `tools`.
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

// `wav` or `mp3`, the only formats Chat audio input takes here; in: contentPartsToBlocks, out: input_audio.format.
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
      : `[${prefix}/${modelId}] unsupported file input (generic OpenAI-compatible endpoints carry text/image/audio only). Use a file-capable model (e.g. google/gemini-*) or convert the document to text before sending it.`;
  throw new ValidationError(message, { provider: prefix, model: modelId });
}

// Text, image (link or data URL) and audio parts as Chat content blocks; in: a user message's parts, out: fullHistoryMessages.
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

// A tool result as the text of a tool message; in: fullHistoryMessages, out: a string.
function resultToOutput(result: unknown): string {
  if (typeof result === "string") return result;
  return safeStringify(result);
}

/**
 * Builds the FULL explicit history as Chat Completions `messages` (stateless
 * transport: every turn carries everything). Prior-turn reasoning is NOT
 * resent — except echoed Gemini thought signatures, which strict
 * OpenAI-compatible endpoints require on tool calls they generated.
 *
 * Signatures are namespaced — only echo when the stored provider is
 * `google` (or untagged legacy). Signatures minted by other providers never
 * leak onto this transport.
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
  let lastRole: string | null = "system";
  for (const m of context.messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
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
            id: clampToolCallId(part.callId || part.id),
            type: "function",
            function: { name: part.name, arguments: toolArgumentsJson(part.arguments) },
          };
          // Echo provider-issued thought signatures verbatim so endpoints
          // that minted them (Gemini behind a compat proxy) keep working.
          // Only present when a previous turn captured one — other endpoints
          // never see this field. Echo only google/untagged signatures.
          const storedProvider = (part as { thoughtSignatureProvider?: unknown }).thoughtSignatureProvider;
          if (part.thoughtSignature && shouldEchoSignature(storedProvider, "google")) {
            call.extra_content = { google: { thought_signature: part.thoughtSignature } };
          }
          calls.push(call);
        } else if (part.type === "text" && part.text) {
          texts.push(part.text);
        }
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

// Chat usage as TokenUsage, clamping cache reads to input; in: a reply or the last stream chunk, out: TokenUsage.
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
  // `cost` is an OpenRouter extension. A generic endpoint that sends it may use 0 for "not computed", so only a positive value counts as known (OpenRouter's adapter accepts an explicit 0).
  if (typeof raw?.cost === "number" && raw.cost > 0) {
    usage.cost = { totalCost: raw.cost };
  }
  return usage;
}

// The Gemini thought signature a proxy put on a tool call, if any; in: parseResponse, out: a string or undefined.
function extractSignature(rawTc: {
  extra_content?: { google?: { thought_signature?: string } };
}): string | undefined {
  const sig = rawTc?.extra_content?.google?.thought_signature;
  return typeof sig === "string" && sig ? sig : undefined;
}

/** Tags a captured compat signature with its issuing provider (`google`). */
function withCompatSignature(sig: string | undefined): { thoughtSignature?: string; thoughtSignatureProvider?: string } {
  if (!sig) return {};
  return { thoughtSignature: sig, thoughtSignatureProvider: "google" };
}

// Throws a concise error for an HTTP 200 reply that carries only `error`; in: parseResponse, out: a thrown error.
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

// Turns a Chat Completions JSON reply into text, thinking, tool calls and usage; in: generate, out: ProviderGenerateResult.
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
  // Refusal content surfaces as text with a `refusal` finish reason.
  const refusal = typeof message?.refusal === "string" && message.refusal ? message.refusal : "";
  const text = typeof message?.content === "string" && message.content ? message.content : refusal;
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
      id: tc.id && !tc.id.includes("|") && tc.id.length <= 40 ? tc.id : clampToolCallId(tc.id || newToolCallId()),
      name: tc.function?.name || "unknown",
      arguments: args,
      rawArguments:
        typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {}),
      ...withCompatSignature(sig),
    } as ToolCallRecord);
  }

  const wireReason = choice?.finish_reason ?? undefined;
  const finishReason = toolCalls.length > 0 ? "tool_calls" : refusal ? "refusal" : wireReason || "stop";
  return {
    text,
    thinking: normalizeThinkingParts(thinkingParts),
    thoughtSignature: toolCalls.map((c) => c.thoughtSignature).find(Boolean),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: mapUsage(response.usage),
    finishReason,
    responseId: response.id,
    model: modelId,
    provider: prefix as ProviderId,
    raw,
    durationMs,
  };
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
  /** Default baseUrl when no env is set. There is no implicit default: without one the request fails fast. */
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

  // The catalog spec of a model, else a permissive generic one; in: the registry, out: a ModelSpec.
  getModel(modelId: string): ModelSpec | undefined {
    const clean = cleanModelId(this.prefix, modelId);
    return (
      getModelFromCatalog(this.id, modelId) ||
      getModelFromCatalog(this.id, clean) ||
      this.models.find((m) => m.id === modelId || m.id === clean) ||
      createGenericModelSpec(this.id, clean)
    );
  }

  // This provider's endpoint for one request; in: generate/stream, out: resolveBaseUrl.
  private baseUrl(options?: ProviderRequestOptions): string {
    return resolveBaseUrl(this.prefix, this.configuredBaseUrl, options);
  }

  // This provider's key for one request; in: requireApiKey, out: resolveApiKey.
  private apiKey(options?: ProviderRequestOptions): string | undefined {
    return resolveApiKey(this.prefix, this.configuredApiKey, options);
  }

  // The key, where a missing one only throws for non-local endpoints (loopback and LAN may omit it); in: generate/stream, out: the key or undefined.
  private requireApiKey(baseUrl: string, options?: ProviderRequestOptions): string | undefined {
    const key = this.apiKey(options);
    if (!key && !isLocalEndpoint(baseUrl)) {
      throw new ConfigError(
        `[Agent Accelerator] Missing API key for "${this.prefix}". Set ${envPrefixOf(this.prefix)}_API_KEY or pass apiKey. (Local endpoints may omit the key.)`
      );
    }
    return key;
  }

  // Builds the Chat request (messages, tools, tool_choice, generation controls, response_format, stream usage) and warns+drops what a strict endpoint cannot take; in: generate/stream, out: the body.
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
    // Strict endpoints reject unknown body fields: implicit caching only.
    resolveCache(this.prefix, options?.cache, ["implicit"], `${this.prefix}/${modelId}`);
    warnIgnoredMediaResolution(this.prefix, context.messages, `${this.prefix}/${modelId}`);

    // Structured outputs: native `response_format` when supported, else
    // emulated via system prompt (strict endpoints would 400 on json_schema
    // for catalog `structured_output: false` models).
    let effectiveContext = context;
    let outputEmulated = false;
    let outputSpec: import("../types/model.ts").StructuredOutputSpec | undefined;
    try {
      outputSpec = normalizeStructuredOutput(options?.output ?? (options as { outputSchema?: unknown })?.outputSchema);
    } catch {
      outputSpec = undefined;
    }
    if (outputSpec && !modelSupportsStructuredOutput(this.prefix, modelId)) {
      outputEmulated = true;
      effectiveContext = {
        ...context,
        systemPrompt: augmentSystemPromptWithStructuredOutput(context.systemPrompt, outputSpec),
      };
      emitProviderWarning({
        provider: this.prefix,
        capability: "structured output",
        requested: `${outputSpec.name} (${this.prefix}/${modelId})`,
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
    const compatTools = toCompatTools(tools);
    if (compatTools) body.tools = compatTools;
    // Standard Chat Completions generation fields, only when the caller set them.
    Object.assign(body, mapGenerationParamsToChat(options, this.prefix, `${this.prefix}/${modelId}`));
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
    // Structured outputs use the standard Chat Completions `response_format`
    // (safe on strict endpoints). Skipped when emulated (instruction already
    // in messages). No reasoning / service_tier / session /
    // cache body primitives: strict endpoints reject unknown properties.
    // Affinity stays headers-only.
    if (outputSpec && !outputEmulated) {
      try {
        const mapped = mapOutputToCompatChat(outputSpec);
        if (mapped) body.response_format = mapped.response_format;
      } catch {
        // why: invalid output shapes fail fast at Agent construction/loop validation.
      }
    }
    // Request usage on streams where supported so terminal accounting
    // arrives on the final chunk. Strict servers that reject unknown fields
    // opt out via `COMPAT_NO_STREAM_OPTIONS=1`; an explicit per-call
    // `(options as any).streamOptions === false` also skips it.
    if (stream) {
      const noStreamOptions =
        (options as { streamOptions?: unknown } | undefined)?.streamOptions === false ||
        getEnv("COMPAT_NO_STREAM_OPTIONS") === "1" ||
        (options?.env?.["COMPAT_NO_STREAM_OPTIONS"] === "1");
      if (!noStreamOptions) {
        (body as unknown as Record<string, unknown>)["stream_options"] = { include_usage: true };
      }
    }
    return body;
  }

  // Fetch options with session-affinity headers (unless opted out), JSON content type and the Bearer key; in: doFetch and stream, out: RequestInit.
  private requestInit(
    body: ChatRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string | undefined,
    sessionId: string | undefined,
    signal?: AbortSignal
  ): RequestInit {
    const headers: Record<string, string> = buildSessionHeaders(
      this.prefix,
      options?.headers,
      sessionId
    );
    // Strict-endpoint opt-out (pi sendSessionAffinityHeaders pattern):
    // `COMPAT_NO_SESSION_HEADERS=1` or per-call `sendSessionHeaders:false`
    // drops affinity headers that trigger CORS preflights / strict 400s.
    // Body `session_id` is already omitted on compat (headers-only affinity).
    try {
      const noAffinity =
        (options as { sendSessionHeaders?: unknown } | undefined)?.sendSessionHeaders === false ||
        getEnv("COMPAT_NO_SESSION_HEADERS") === "1" ||
        options?.env?.["COMPAT_NO_SESSION_HEADERS"] === "1";
      if (noAffinity) {
        for (const k of Object.keys(headers)) {
          const lower = k.toLowerCase();
          if (lower === "x-session-id" || lower === "x-client-request-id" || lower === "session_id") {
            delete headers[k];
          }
        }
      }
    } catch {}
    setHeaderCaseInsensitive(headers, "Content-Type", "application/json");
    if (apiKey && apiKey !== "unused") setHeaderCaseInsensitive(headers, "Authorization", `Bearer ${apiKey}`);
    return { method: "POST", headers, body: JSON.stringify(body), signal };
  }

  // One HTTP call under the request timeout, returning status, headers and body text; in: generate, out: the raw reply.
  private async doFetch(
    url: string,
    body: ChatRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string | undefined,
    sessionId: string | undefined,
    signal?: AbortSignal
  ): Promise<{ status: number; statusText: string; headers: Record<string, string>; text: string }> {
    const { signal: effective, cleanup } = combinedSignal(signal, timeoutFor(options as { timeoutMs?: number } | undefined));
    try {
      const res = await (options?.fetch ?? fetch)(url, this.requestInit(body, options, apiKey, sessionId, effective));
      const text = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: res.status, statusText: res.statusText, headers, text };
    } finally {
      cleanup();
    }
  }

  // Throws a concise provider error (status, code, Retry-After, key hint) for a non-2xx reply; in: generate and stream, out: nothing or a thrown error.
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
        ? ` Check ${envPrefixOf(this.prefix)}_API_KEY (no quotes/spaces, correct provider) and that the key is loaded (bun --env-file=.env.local).`
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
    throw toConciseProviderError(err, this.prefix, modelId);
  }

  // Non-streaming turn as one retried JSON request; in: runAgentLoop, out: ProviderGenerateResult.
  async generate(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): Promise<ProviderGenerateResult> {
    const startTime = Date.now();
    const clean = cleanModelId(this.prefix, model);
    // Fail fast before any network call when the catalog knows the model
    // lacks the requested modality. Unknown models skip the guard; the
    // endpoint verdict surfaces concisely. Cheap local checks run first.
    assertModalitiesSupported(context, this.prefix, clean);
    assertNoVideoOrFileParts(context, this.prefix, clean);
    const baseUrl = this.baseUrl(options);
    const apiKey = this.requireApiKey(baseUrl, options);
    const url = `${baseUrl}/chat/completions`;
    const sessionId = options?.sessionId;
    const tools = options?.tools as StandardToolDeclaration[] | undefined;
    const body = await this.buildBody(clean, context, options, tools, false);

    const auditRaw: Record<string, string> = {
      ...buildSessionHeaders(this.prefix, options?.headers, sessionId),
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: "[REDACTED]" } : {}),
    };
    const rawRequest = {
      url,
      method: "POST",
      headers: redactedHeaders(auditRaw),
      body,
    };

    const doCall = async (): Promise<ProviderGenerateResult> => {
      const res = await this.doFetch(url, body, options, apiKey, sessionId, options?.signal);
      this.throwIfError(res.status, url, res.text, clean, res.headers);
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
        ...retryOptionsFrom(options),
        signal: options?.signal,
        label: { providerId: this.prefix, modelId: clean },
      });
    } catch (err) {
      if (err instanceof Error && (err as { name?: string }).name === "AbortError") throw err;
      throw err;
    }
  }

  // Streaming turn over SSE: assembles text, reasoning, tool calls and usage, retrying only before the first byte; in: streamAgentLoop, out: an AssistantMessageEventStream.
  stream(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): AssistantMessageEventStream {
    const eventStream = new AssistantMessageEventStream();
    const startTime = Date.now();
    const prefix = this.prefix;
    const clean = cleanModelId(this.prefix, model);

    const { linked, release } = linkStreamAbort(eventStream, options?.signal);

    (async () => {
      try {
        assertModalitiesSupported(context, prefix, clean);
        assertNoVideoOrFileParts(context, prefix, clean);
        const baseUrl = this.baseUrl(options);
        const apiKey = this.requireApiKey(baseUrl, options);
        const url = `${baseUrl}/chat/completions`;
        const sessionId = options?.sessionId;
        const tools = options?.tools as StandardToolDeclaration[] | undefined;
        const body = await this.buildBody(clean, context, options, tools, true);

        const streamAuditRaw: Record<string, string> = {
          ...buildSessionHeaders(prefix, options?.headers, sessionId),
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: "[REDACTED]" } : {}),
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
          fetchOnce: () => withAbortTimer(linked, streamTimeoutMs, () => (options?.fetch ?? fetch)(url, this.requestInit(body, options, apiKey, sessionId, linked.signal))),
          onHttpError: (r, text) => this.throwIfError(r.status, url, text, clean, headersToRecord(r.headers)),
          noBodyError: () => toConciseProviderError(new Error("OpenAI-compatible streaming response had no body"), prefix, clean),
          retry: retryOptionsFrom(options),
          signal: linked.signal,
          label: { providerId: prefix, modelId: clean },
        });
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });
        const responseMeta: Record<string, unknown> & { status: number; statusText: string; headers: Record<string, string> } = { status: res.status, statusText: res.statusText, headers: responseHeaders };
        eventStream.push({ type: "start", raw: { request: rawRequest } } as never);

        let text = "";
        let thinking = "";
        // Tool calls keyed by choice index: { id, name, startArgs, deltaArgs }.
        const calls = new Map<number, { id: string; name: string; startArgs: string; deltaArgs: string }>();
        let lastToolIndex = 0;
        const signatures = new Map<number, string>();
        let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        let finishReason = "stop";
        let sawFinishReason = false;
        let sawUsage = false;
        let refusalSeen = false;
        let badFrames = 0;
        let framesSeen = 0;
        let responseId: string | undefined;
        let completedBody: unknown = undefined;
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
          // Refusal deltas surface as text with a `refusal` finish.
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
            sawFinishReason = true;
          }
          const chunkUsage = msg["usage"] as ChatResponse["usage"] | undefined;
          if (chunkUsage) {
            usage = mapUsage(chunkUsage);
            sawUsage = true;
            completedBody = completedBody ?? msg;
            eventStream.push({ type: "usage", usage });
          }
        };

        await readSseData(res.body!, linked, eventStream, handleMessage); // openStreamResponse guarantees a body

        const toolCalls: ToolCallRecord[] = [];
        for (const [index, c] of calls) {
          const args = parseStreamedToolArguments(c.startArgs, c.deltaArgs);
          const sig = signatures.get(index);
          const record: ToolCallRecord = {
            id: c.id && !c.id.includes("|") && c.id.length <= 40 ? c.id : clampToolCallId(c.id || newToolCallId()),
            name: c.name,
            arguments: args,
            rawArguments: selectRawArguments(c.startArgs, c.deltaArgs),
            ...withCompatSignature(sig),
          } as ToolCallRecord;
          toolCalls.push(record);
          eventStream.push({ type: "tool_call_complete", toolCall: record });
        }

        // Did the stream really end? Read before the tool-call and refusal overrides below, which also set sawFinishReason.
        const hasTerminal = completedBody !== undefined || sawFinishReason || sawUsage;
        noteProviderTurn(sessionId, prefix);
        if (toolCalls.length > 0) {
          finishReason = toolTurnFinishReason(finishReason, toolCalls);
          sawFinishReason = true;
        } else if (refusalSeen) {
          finishReason = "refusal";
          sawFinishReason = true;
        }

        // Terminal-state guard — fail `incomplete_stream` (retryable)
        // instead of resolving empty success. Skipped for non-SSE payloads
        // (JSON mocks) where no SSE frames were ever seen.
        const cleanThinking = thinking.replace(/\n{3,}/g, "\n\n").trim();
        const incomplete = incompleteStreamCheck({
          provider: prefix,
          modelId: clean,
          hasTerminal,
          empty: !text && !cleanThinking && toolCalls.length === 0,
          unfinishedCall: hasUnfinishedToolCall(calls.values(), toolCalls),
          responseHeaders,
          framesSeen,
          badFrames,
        });
        if (incomplete) {
          eventStream.fail(incomplete);
          return;
        }
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
          raw: {
            request: rawRequest,
            response: { ...responseMeta, body: completedBody, badFrames } as unknown as ProviderRawData["response"],
          },
          durationMs: Date.now() - startTime,
        });
        eventStream.push({ type: "done", delta: "", usage, finishReason, responseId });
        eventStream.end(finalResponse);
      } catch (err: unknown) {
        failStream(eventStream, linked, err);
      } finally {
        release();
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
