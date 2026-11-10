/**
 * OpenRouter Chat Completions provider (`POST {baseUrl}/chat/completions`).
 *
 * All OpenRouter-specific HTTP, endpoints, headers, auth, request
 * construction, response/SSE parsing, and wire transformations live HERE —
 * never in the canonical layer (`src/providers.ts`).
 *
 * Wire contract: `references/testings/openrouter/CONTRACT.md` (docs + live
 * captures, 2026-09-24). Capability matrix:
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
 *   array explicitly. Completions has no `store`/`previous_response_id`/
 *   `conversation`/`prompt_cache_key`, so none are ever sent. Session affinity is
 *   the documented top-level body `session_id` (the sticky-routing key, which wins
 *   over the header) plus the `x-session-id` / `x-client-request-id` headers.
 * - IDs are provider-generated (`gen-…` generations, `call_…`/uuid tool ids)
 *   and echoed verbatim (`tool_call_id`). The `call_${random}` fallback in
 *   parsers is a local canonical correlation id only; it is never sent.
 * - Prior-turn reasoning is resent as `reasoning_details` exactly as returned (kept on the assistant message as
 *   `providerSteps`), which tool turns need (reasoning-tokens.md, "Preserving Reasoning"). Plain `reasoning` text alone is
 *   never resent. Parsed-PDF `file` annotations ride the same way and go back as `annotations`, so the router does not parse
 *   the same PDF again (pdf-inputs.md, "Skip Parsing Costs").
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
import { AgentResponse } from "../types/response.ts";
import { getApiKey, getEnv } from "../utils/env.ts";
import { buildSessionHeaders, setHeaderCaseInsensitive } from "../utils/headers.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import { safeStringify } from "../utils/serialization.ts";
import { toConciseProviderError, assertModalitiesSupported } from "../utils/errors.ts";
import { ConfigError, isAbortError } from "../types/errors.ts";
import {
  newToolCallId,
  redactedHeaders,
  readErrorPayload,
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
  warnIgnoredVideoProcessing,
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
      reasoning_details?: unknown[];
      annotations?: unknown[];
      name?: string;
    }
  | { role: "tool"; content: string; tool_call_id: string; name?: string }
  | { type: string; [k: string]: unknown };

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | { type: "function"; function: { name: string } };
  reasoning?: { effort?: string; exclude?: boolean };
  provider?: Record<string, unknown>;
  parallel_tool_calls?: boolean;
  user?: string;
  service_tier?: string;
  session_id?: string;
  cache_control?: { type: "ephemeral"; ttl: "5m" | "1h" };
  response_format?: {
    type: "json_schema";
    json_schema: { name: string; schema: Record<string, unknown>; strict: boolean; description?: string };
  };
  stream?: boolean;
  [k: string]: unknown;
}

/** The usage block of a Chat Completions chunk (the last chunk of a stream carries it, with OpenRouter's `cost`). */
interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    audio_tokens?: number;
    video_tokens?: number;
  };
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number; image_tokens?: number };
  cost?: number;
  [k: string]: unknown;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

// ---------------------------------------------------------------------------
// Request building (canonical -> Chat Completions)
// ---------------------------------------------------------------------------

// Endpoint from the option, OPENROUTER_BASE_URL, else openrouter.ai; in: each request, out: the base URL without a trailing slash.
function resolveBaseUrl(options?: ProviderRequestOptions): string {
  return (
    options?.baseUrl ||
    options?.env?.["OPENROUTER_BASE_URL"] ||
    getEnv("OPENROUTER_BASE_URL") ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

// Key from the option or env, or `unused` when custom headers carry the auth; in: each request, out: the key or undefined.
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
const RETRYABLE_ERROR_TYPE_STATUS: Record<string, number> = {
  rate_limit_exceeded: 429,
  provider_overloaded: 503,
  provider_unavailable: 502,
  timeout: 504,
  server: 500,
};
// HTTP-like status of an error chunk inside a stream, or undefined when unknown; in: streamInto's error branch, out: the status that makes the error retryable.
function midStreamStatus(code: unknown, errorType: unknown): number | undefined {
  if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) return code;
  return typeof errorType === "string" ? RETRYABLE_ERROR_TYPE_STATUS[errorType] : undefined;
}

// OpenRouter options that come from env vars, never from AgentConfig (provider routing, `parallel_tool_calls`, `reasoning.exclude`, `user`). A per-Agent `env` wins over the process env; nothing is sent when no variable is set; a bad value is a ConfigError before any network call. NOT supported on purpose (the owner does not want them for now): `reasoning.max_tokens` and `trace`; in: buildBody, out: the extra body fields.
const ROUTING_LISTS = { OPENROUTER_ORDER: "order", OPENROUTER_ONLY: "only", OPENROUTER_IGNORE: "ignore" } as const;
const ROUTING_FLAGS = {
  OPENROUTER_ALLOW_FALLBACKS: "allow_fallbacks",
  OPENROUTER_REQUIRE_PARAMETERS: "require_parameters",
  OPENROUTER_ZDR: "zdr",
} as const;
function openRouterEnvOptions(options?: ProviderRequestOptions): {
  provider?: Record<string, unknown>;
  parallel_tool_calls?: boolean;
  reasoning_exclude?: boolean;
  user?: string;
} {
  const read = (name: string): string | undefined => {
    const own = options?.env?.[name]?.trim();
    return own ? own : getEnv(name);
  };
  const bad = (name: string, value: string, expected: string): never => {
    throw new ConfigError(`[Agent Accelerator] Invalid ${name} ${JSON.stringify(value)}: expected ${expected}.`);
  };
  const flag = (name: string): boolean | undefined => {
    const v = read(name);
    if (v === undefined) return undefined;
    const t = v.toLowerCase();
    if (t === "true" || t === "1") return true;
    if (t === "false" || t === "0") return false;
    return bad(name, v, "true or false");
  };
  const provider: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(ROUTING_LISTS)) {
    const v = read(name);
    if (v === undefined) continue;
    const list = v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (list.length === 0) bad(name, v, "a comma-separated list of provider slugs");
    provider[field] = list;
  }
  for (const [name, field] of Object.entries(ROUTING_FLAGS)) {
    const v = flag(name);
    if (v !== undefined) provider[field] = v;
  }
  const collection = read("OPENROUTER_DATA_COLLECTION");
  if (collection !== undefined) {
    if (collection !== "allow" && collection !== "deny") bad("OPENROUTER_DATA_COLLECTION", collection, "allow or deny");
    provider["data_collection"] = collection;
  }
  const sort = read("OPENROUTER_SORT");
  if (sort !== undefined) {
    if (sort !== "price" && sort !== "throughput" && sort !== "latency")
      bad("OPENROUTER_SORT", sort, "price, throughput or latency");
    provider["sort"] = sort;
  }
  const parallel = flag("OPENROUTER_PARALLEL_TOOL_CALLS");
  const exclude = flag("OPENROUTER_REASONING_EXCLUDE");
  const user = read("OPENROUTER_USER");
  return {
    ...(Object.keys(provider).length > 0 ? { provider } : {}),
    ...(parallel !== undefined ? { parallel_tool_calls: parallel } : {}),
    ...(exclude !== undefined ? { reasoning_exclude: exclude } : {}),
    ...(user ? { user } : {}),
  };
}

// Canonical tool declarations as Chat Completions function tools; in: options.tools, out: request `tools`.
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
const AUDIO_FORMAT: Record<string, string> = {
  wav: "wav",
  wave: "wav",
  mpeg: "mp3",
  mp3: "mp3",
  mp4: "m4a",
  m4a: "m4a",
  aac: "aac",
  ogg: "ogg",
  flac: "flac",
  aiff: "aiff",
};
// The `input_audio.format` for an audio MIME type (see AUDIO_FORMAT above); in: contentPartsToBlocks, out: the format string.
function audioFormatFor(mimeType?: string): string {
  const subtype = (mimeType || "").toLowerCase().split(";")[0]!.split("/")[1]?.replace(/^x-/, "") ?? "";
  return AUDIO_FORMAT[subtype] ?? (subtype || "mp3");
}

// `ImagePart.resolution` as OpenRouter's `image_url.detail` (api-ref ChatContentImage: auto, low, high, original; `original` is downgraded to `high` where unsupported); videos have no such field; in: an image part, out: contentPartsToBlocks.
const IMAGE_DETAIL: Record<string, "low" | "auto" | "high" | "original"> = {
  low: "low",
  medium: "auto",
  high: "high",
  ultra_high: "original",
};

// True when a request's messages carry an image or video by web link (the router fetches those itself); in: the built messages, out: throwIfError's hint.
function hasRemoteMedia(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as ChatContentPart[]).some((p) => {
        const url =
          (p as { image_url?: { url?: string }; video_url?: { url?: string } }).image_url?.url ??
          (p as { video_url?: { url?: string } }).video_url?.url;
        return typeof url === "string" && /^https?:\/\//.test(url);
      })
  );
}

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
      const norm = await normalizeMediaInput(raw as string | Uint8Array | ArrayBuffer, mimeType);
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
          : (
              await normalizeMediaInput(
                raw as string | Uint8Array | ArrayBuffer,
                (part as { mimeType?: string }).mimeType
              )
            ).dataUrl;
      blocks.push({
        type: "file",
        file: { ...(typeof filename === "string" && filename ? { filename } : {}), file_data: fileData },
      });
    }
  }
  return blocks;
}

// Folds one streamed `reasoning_details` chunk into the turn's blocks: chunks with the same index (else id) are one block whose text, summary, data and signature are concatenated or filled in, in order; in: the stream handler, out: the blocks replayed on the next request.
function mergeReasoningDetails(blocks: Array<Record<string, unknown>>, chunk: unknown): void {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return;
  const c = chunk as Record<string, unknown>;
  const same = blocks.find((b) =>
    typeof c["index"] === "number" ? b["index"] === c["index"] : c["id"] != null && b["id"] === c["id"]
  );
  if (!same) {
    blocks.push({ ...c });
    return;
  }
  for (const [k, v] of Object.entries(c)) {
    if (v === null || v === undefined) continue;
    if ((k === "text" || k === "summary" || k === "data") && typeof v === "string" && typeof same[k] === "string")
      same[k] = (same[k] as string) + v;
    else same[k] = v;
  }
}

// Adds a streamed `file` annotation (a parsed PDF) once per `file.hash`; in: the stream handler, out: the annotations replayed on the next request.
function mergeAnnotation(blocks: Array<Record<string, unknown>>, chunk: unknown): void {
  if (!chunk || typeof chunk !== "object" || (chunk as { type?: unknown }).type !== "file") return;
  const hash = (chunk as { file?: { hash?: unknown } }).file?.hash;
  if (typeof hash === "string" && blocks.some((b) => (b as { file?: { hash?: unknown } }).file?.hash === hash)) return;
  blocks.push(chunk as Record<string, unknown>);
}

// The reasoning blocks and the parsed-PDF annotations of an assistant turn as OpenRouter returned them (both live in `providerSteps`, told apart by `type: "file"`); in: a stored assistant message, out: fullHistoryMessages.
function storedReplay(m: { providerSteps?: { provider: string; steps: unknown[] } }): {
  reasoning_details?: unknown[];
  annotations?: unknown[];
} {
  if (m.providerSteps?.provider !== "openrouter") return {};
  const isFile = (x: unknown): boolean => (x as { type?: unknown } | null)?.type === "file";
  const annotations = m.providerSteps.steps.filter(isFile);
  const details = m.providerSteps.steps.filter((x) => !isFile(x));
  return {
    ...(details.length > 0 ? { reasoning_details: details } : {}),
    ...(annotations.length > 0 ? { annotations } : {}),
  };
}

// A tool result as the text of a tool message; in: fullHistoryMessages, out: a string.
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
        if (m.content) {
          messages.push({ role: "user", content: m.content });
          lastRole = "user";
        }
      } else {
        const blocks = await contentPartsToBlocks(m.content);
        if (blocks.length > 0) {
          messages.push({ role: "user", content: blocks });
          lastRole = "user";
        }
      }
    } else if (m.role === "assistant") {
      const replay = storedReplay(m);
      if (typeof m.content === "string") {
        if (m.content) {
          messages.push({ role: "assistant", content: m.content, ...replay });
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
            function: { name: part.name, arguments: toolArgumentsJson(part.arguments) },
          });
        } else if (part.type === "text" && part.text) {
          texts.push(part.text);
        }
        // Reasoning is not rebuilt from text: the stored `reasoning_details` blocks are replayed verbatim below.
      }
      // Skip empty assistant turns (no text + no tool calls): strict
      // routes reject them, and they carry no signal (pi drop rule).
      if (texts.length === 0 && calls.length === 0) continue;
      messages.push({
        role: "assistant",
        content: texts.length > 0 ? texts.join("\n") : null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
        ...replay,
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

// Chat usage as TokenUsage with cache reads clamped to input, cache writes, reasoning tokens and OpenRouter's reported cost (0 counts); in: the last stream chunk, out: TokenUsage.
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
  // Media tokens are listed only when the provider reported more than zero of them.
  const count = (n: unknown): number | undefined =>
    typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
  const inDet = {
    audioTokens: count(raw?.prompt_tokens_details?.audio_tokens),
    videoTokens: count(raw?.prompt_tokens_details?.video_tokens),
  };
  const outDet = {
    audioTokens: count(raw?.completion_tokens_details?.audio_tokens),
    imageTokens: count(raw?.completion_tokens_details?.image_tokens),
  };
  const keep = (d: Record<string, number | undefined>): Record<string, number> | undefined => {
    const kept = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) as Record<string, number>;
    return Object.keys(kept).length > 0 ? kept : undefined;
  };
  const inKept = keep(inDet);
  const outKept = keep(outDet);
  if (inKept) usage.inputDetails = inKept;
  if (outKept) usage.outputDetails = outKept;
  if (typeof raw?.cost === "number" && raw.cost >= 0) {
    // an explicit 0 (a free model, a response-cache hit) is a known cost, not a missing one
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

  // The catalog spec of a model, else a permissive generic one; in: the registry, out: a ModelSpec.
  getModel(modelId: string): ModelSpec | undefined {
    const clean = cleanModelId(modelId);
    return (
      getModelFromCatalog(this.id, modelId) ||
      getModelFromCatalog(this.id, clean) ||
      this.models.find((m) => m.id === modelId || m.id === clean) ||
      createGenericModelSpec(this.id, clean)
    );
  }

  // Builds the Chat request (messages, tools, tool_choice, reasoning, tier, cache_control, generation controls, response_format, session_id); in: streamInto, out: the body.
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
    const cache = resolveCache(
      "openrouter",
      options?.cache,
      /^~?anthropic\//.test(modelId) ? ["implicit", "5m", "1h"] : ["implicit"],
      `openrouter/${modelId}`
    );
    warnIgnoredMediaResolution("openrouter", context.messages, `openrouter/${modelId}`, ["video"]);
    warnIgnoredVideoProcessing("openrouter", context.messages, `openrouter/${modelId}`);

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
        reason:
          "the catalog reports structured_output: false for this model, so native response_format is unsupported.",
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
    const toolChoice = mapToolChoiceToOpenRouterChat(options?.toolChoice);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    const env = openRouterEnvOptions(options);
    if (effort || env.reasoning_exclude !== undefined)
      body.reasoning = {
        ...(effort ? { effort } : {}),
        ...(env.reasoning_exclude !== undefined ? { exclude: env.reasoning_exclude } : {}),
      };
    if (env.provider) body.provider = env.provider;
    if (env.parallel_tool_calls !== undefined && orTools) body.parallel_tool_calls = env.parallel_tool_calls;
    if (env.user) body.user = env.user;
    if (serviceTier) body.service_tier = serviceTier;
    if (cache === "5m" || cache === "1h") body.cache_control = { type: "ephemeral", ttl: cache };
    // Documented Chat Completions generation controls (only those the caller set).
    Object.assign(body, mapGenerationParamsToChat(options));
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

  // Fetch options with session and opt-in attribution headers, JSON content type and the Bearer key; in: streamInto, out: RequestInit.
  private requestInit(
    body: ChatRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    sessionId: string | undefined,
    signal?: AbortSignal
  ): RequestInit {
    // Attribution + session headers mirror the previous transport exactly
    // (HTTP-Referer / X-Title / x-session-id / x-client-request-id).
    const headers: Record<string, string> = buildSessionHeaders("openrouter", options?.headers, sessionId);
    setHeaderCaseInsensitive(headers, "Content-Type", "application/json");
    if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "Authorization", `Bearer ${apiKey}`);
    return { method: "POST", headers, body: JSON.stringify(body), signal };
  }

  // Throws a concise provider error (status, code, Retry-After, key and media-link hints) for a non-2xx reply, marking the in-flight-budget 402 retryable; in: streamInto, out: nothing or a thrown error.
  private throwIfError(
    status: number,
    url: string,
    bodyText: string,
    modelId: string,
    headers?: Record<string, string>,
    remoteMedia = false
  ): void {
    if (status >= 200 && status < 300) return;
    const { message, code, errorType, raw, limitSource } = readErrorPayload(bodyText);
    const hint =
      status === 401
        ? " Check OPENROUTER_API_KEY (no quotes/spaces, correct provider) and that the key is loaded (bun --env-file=.env.local)."
        : // A bad or unreachable image/video link comes back as the bare "Provider returned error" without saying which part failed.
          status === 400 && remoteMedia && message === "Provider returned error"
          ? " The request carries a remote image or video link: it may be unreachable or not accepted by this route. Try passing the file itself (a local path or bytes) instead."
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
    const concise = toConciseProviderError(err, "openrouter", modelId);
    // A 402 from the in-flight spending budget clears by itself once running requests settle (errors-and-debugging.md, Retry-After): retry it after the header's wait. A 402 for missing credits does not.
    if (status === 402 && limitSource === "openrouter_in_flight_budget") {
      (concise as unknown as Record<string, unknown>)["retryable"] = true;
      (concise as unknown as Record<string, unknown>)["transient"] = true;
    }
    throw concise;
  }

  // OpenRouter can only cancel a request that streams ("Stream cancellation": for a non-streaming request the model keeps processing and you are billed in full), so even a plain generate is sent as a stream and collected here: an interrupt then closes the connection and stops processing and billing at the providers OpenRouter can cancel; in: the loop's non-streaming turn, out: the same ProviderGenerateResult a JSON reply gave.
  async generate(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): Promise<ProviderGenerateResult> {
    // The whole call stays bounded by `timeoutMs`; the stream's own timer only covers the wait for its first byte.
    const { signal, cleanup } = combinedSignal(
      options?.signal,
      timeoutFor(options as { timeoutMs?: number } | undefined)
    );
    try {
      // Nobody reads the deltas here, so the stream keeps none (a burst of frames would overflow its buffer for nothing).
      const events = this.streamInto(new AssistantMessageEventStream({ buffer: false }), model, context, {
        ...options,
        signal,
      });
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
        providerSteps: res.providerSteps,
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

  // Streaming turn: a normal event stream from streamInto; in: streamAgentLoop, out: an AssistantMessageEventStream.
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

    const { linked, release } = linkStreamAbort(eventStream, options?.signal);

    (async () => {
      try {
        const apiKey = resolveApiKey(options);
        if (!apiKey) {
          throw new ConfigError(
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
          fetchOnce: () =>
            withAbortTimer(linked, streamTimeoutMs, () =>
              (options?.fetch ?? fetch)(url, this.requestInit(body, options, apiKey, sessionId, linked.signal))
            ),
          onHttpError: (r, text) =>
            this.throwIfError(r.status, url, text, clean, headersToRecord(r.headers), hasRemoteMedia(body.messages)),
          noBodyError: () =>
            toConciseProviderError(new Error("OpenRouter streaming response had no body"), "openrouter", clean),
          retry: retryOptionsFrom(options),
          signal: linked.signal,
          label: { providerId: "openrouter", modelId: clean },
        });
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          responseHeaders[k] = v;
        });
        const responseMeta: Record<string, unknown> & {
          status: number;
          statusText: string;
          headers: Record<string, string>;
        } = { status: res.status, statusText: res.statusText, headers: responseHeaders };
        eventStream.push({ type: "start", raw: { request: rawRequest } } as never);

        let text = "";
        let thinking = "";
        // Tool calls keyed by choice index: { id, name, startArgs, deltaArgs }.
        const calls = new Map<number, { id: string; name: string; startArgs: string; deltaArgs: string }>();
        // Index of the most recent tool-call delta: unindexed chunks continue
        // it (falling back to calls.size would fork a phantom call per chunk).
        let lastToolIndex = 0;
        // The turn's reasoning blocks exactly as returned, replayed on the next request (tool turns need them).
        const reasoningBlocks: Array<Record<string, unknown>> = [];
        // Parsed PDFs (`file` annotations) of the turn: sent back so OpenRouter does not parse the same file again.
        const annotationBlocks: Array<Record<string, unknown>> = [];
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
          const topError = msg["error"] as
            | { message?: string; code?: string | number; metadata?: { error_type?: string } }
            | undefined;
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
          const choice =
            (Array.isArray(msg["choices"]) ? (msg["choices"] as Record<string, unknown>[])[0] : undefined) ?? {};
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
          // Thinking deltas: `reasoning_details[].text` duplicates `reasoning`
          // when both ride along — prefer details, else the plain field.
          const details = delta["reasoning_details"];
          if (Array.isArray(details)) {
            for (const block of details) {
              mergeReasoningDetails(reasoningBlocks, block);
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
          if (Array.isArray(delta["annotations"]))
            for (const a of delta["annotations"]) mergeAnnotation(annotationBlocks, a);
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

        await readSseData(res.body!, linked, eventStream, handleMessage); // openStreamResponse guarantees a body

        const toolCalls: ToolCallRecord[] = [];
        for (const c of calls.values()) {
          const args = parseStreamedToolArguments(c.startArgs, c.deltaArgs);
          const record: ToolCallRecord = {
            id: clampToolCallId(c.id || newToolCallId()), // the id the history sends back, so the stored id and the wire id are one
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
          finishReason = toolTurnFinishReason(finishReason, toolCalls);
          sawFinishReason = true;
        } else if (refusalSeen && finishReason !== "content_filter") {
          finishReason = "refusal";
          sawFinishReason = true;
        }

        // Terminal-state guard — fail `incomplete_stream` (retryable)
        // instead of resolving empty success. Skipped for non-SSE payloads
        // (JSON mocks) where no SSE frames were ever seen.
        const cleanThinking = thinking.replace(/\n{3,}/g, "\n\n").trim();
        const incomplete = incompleteStreamCheck({
          provider: "openrouter",
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
          ...(reasoningBlocks.length + annotationBlocks.length > 0
            ? { providerSteps: { provider: "openrouter", steps: [...reasoningBlocks, ...annotationBlocks] } }
            : {}),
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
