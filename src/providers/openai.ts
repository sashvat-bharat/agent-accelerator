/**
 * OpenAI Responses API provider (`POST {baseUrl}/responses`).
 *
 * All OpenAI-specific HTTP, endpoints, headers, auth, request
 * construction, response/SSE parsing, and wire transformations live HERE —
 * never in the canonical layer (`src/providers.ts`).
 *
 * Wire contract: `references/documentations/openai-doc/responses/create.md`
 * (plus `retrieve.md` for the response envelope). Only the most-important
 * subset is implemented: text, instructions, full-history multi-turn,
 * streaming, function tools (+parallel), image/audio/file input, reasoning
 * effort, service_tier flex/priority, prompt_cache_key affinity, usage,
 * finish reasons, switching, abort, errors.
 *
 * Also implemented: `text.format` structured output, `max_output_tokens`.
 *
 * Out of scope (never sent): background, conversation, previous_response_id
 * chaining, include, metadata, truncation, safety_identifier,
 * prompt_cache_options explicit breakpoints, built-in/MCP tools. Those remain
 * UNSUPPORTED and are handled via warn+drop in the canonical layer where
 * applicable.
 *
 * Notes:
 * - STATELESS by design (like the OpenRouter adapter): every turn sends the
 *   full canonical history explicitly with `store:false`. `previous_response_id`,
 *   `background`, and `conversation` are never sent so Google↔OpenAI↔OpenRouter
 *   switching never depends on server state.
 * - IDs are provider-generated (`resp_…`, `msg_…`, `fc_…` + `call_…`,
 *   `rs_…`) and echoed verbatim (`call_id` in `function_call_output`). The
 *   `call_${random}` fallback in parsers is a local canonical correlation id
 *   only (used when the wire omits both ids); it is never sent to the provider.
 * - Assistant history items omit provider `id`/`status` (same proof as
 *   OpenRouter: full-history sends without them complete successfully).
 */
import type {
  Provider,
  ProviderId,
  ModelSpec,
  ProviderRequestOptions,
  ProviderGenerateResult,
  ProviderRawData,
} from "../types/model.ts";
import type { ProviderContext, ContentPart, ProviderSteps } from "../types/message.ts";
import { beforeFirst } from "../utils/text.ts";
import { CHAT_REPLY_LIMIT, readTextCapped } from "../utils/body.ts";
import type { StandardToolDeclaration, ToolCallRecord } from "../types/tool.ts";
import type { TokenUsage } from "../types/core.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentResponse } from "../types/response.ts";
import { buildSessionHeaders, setHeaderCaseInsensitive } from "../utils/headers.ts";
import { clampCacheKey } from "../utils/cache.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import { toConciseProviderError } from "../utils/errors.ts";
import { assertModalitiesSupported, assertNoVideoPartsOnResponses } from "./modalities.ts";
import { badReplyError, carriesError, responsesReplyProblem } from "./reply-guard.ts";
import { ConfigError } from "../types/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { openaiGenerateImage } from "./openai-image.ts";
import { openaiEmbed } from "./openai-embedding.ts";
import { openaiDecide } from "./openai-decision.ts";
import type { ProviderDecisionRequest, ProviderDecisionResult } from "../types/decision.ts";
import type { ProviderEmbeddingRequest, ProviderEmbeddingResult } from "../types/embedding.ts";
import type { ProviderImageRequest, ProviderImageResult } from "../types/image.ts";
import {
  parseArguments,
  normalizeThinkingParts,
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
  openStreamResponse,
  retryOptionsFrom,
  headersToRecord,
  parseRetryAfterMs,
  resolveProviderApiKey,
  resolveProviderBaseUrl,
  stripModelScope,
  resultToOutput,
  hasTruncatedToolArguments,
  shortHashId,
} from "./shared.ts";
import { createGenericModelSpec } from "../models/catalog.ts";
import { getModelFromCatalog, getModelsForProvider, modelSupportsStructuredOutput } from "../models/catalog.ts";
import {
  mapThinkingLevelToOpenAI,
  mapServiceTierToOpenAI,
  resolveCache,
  mapToolChoiceToOpenAI,
  noteProviderTurn,
  parseStreamedToolArguments,
  selectRawArguments,
  mapOutputToOpenAI,
  mapGenerationParamsToOpenAI,
  normalizeStructuredOutput,
  augmentSystemPromptWithStructuredOutput,
  emitProviderWarning,
  warnIgnoredMediaResolution,
  warnIgnoredVideoProcessing,
  warnIgnoredToolMedia,
} from "../providers.ts";

// ---------------------------------------------------------------------------
// Responses wire shapes (most-important subset)
// ---------------------------------------------------------------------------

type ResponseContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "auto" | "high" | "original" }
  | { type: "input_file"; file_url: string; filename?: string }
  | { type: "output_text"; text: string; annotations?: unknown[] }
  | { type: "reasoning_text"; text: string }
  | { type: string; [k: string]: unknown };

type ResponseInputItem =
  | { type: "message"; role: "user" | "assistant" | "system" | "developer"; content: ResponseContentPart[] }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: string; [k: string]: unknown };

interface ResponsesRequestBody {
  model: string;
  input: ResponseInputItem[];
  instructions?: string;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | { type: "function"; name: string };
  reasoning?: { effort: string };
  service_tier?: string;
  prompt_cache_key?: string;
  include?: string[];
  prompt_cache_options?: { ttl: "30m" | "12h" };
  store?: boolean;
  stream?: boolean;
  text?: {
    format: {
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
      strict: boolean;
      description?: string;
    };
  };
  [k: string]: unknown;
}

interface ResponsesOutputItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  status?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string; annotations?: unknown[] }>;
  summary?: Array<string | { type?: string; text?: string }>;
  encrypted_content?: string;
  output?: unknown;
  [k: string]: unknown;
}

interface ResponsesObject {
  id?: string;
  object?: string;
  created_at?: number;
  model?: string;
  status?: string;
  output?: ResponsesOutputItem[];
  error?: { message?: string; code?: string | number; type?: string; param?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Request building (canonical -> Responses)
// ---------------------------------------------------------------------------

// The openai base URL of this request; in: each request, out: the shared resolver.
function resolveBaseUrl(options?: ProviderRequestOptions): string {
  return resolveProviderBaseUrl("openai", options);
}

// The openai key of this request; in: each request, out: the shared resolver.
function resolveApiKey(options?: ProviderRequestOptions): string | undefined {
  return resolveProviderApiKey("openai", options);
}

/** Strips ONLY the `openai/` prefix. Bare ids pass through untouched. */
// The model id without its provider scope; in: each request, out: the bare id.
function cleanModelId(model: string | ModelSpec): string {
  return stripModelScope(model, /^openai\//i);
}

// True for GPT-5.6 and later (gpt-5.6-*, gpt-6*), which take `prompt_cache_options.ttl` (30m or 12h); older models take `prompt_cache_retention`; in: buildBody, out: which cache wire to use.
function usesCacheOptions(modelId: string): boolean {
  const m = /^gpt-(\d+)(?:\.(\d+))?/i.exec(modelId);
  if (!m) return false;
  const major = Number(m[1]);
  return major >= 6 || (major === 5 && Number(m[2] ?? 0) >= 6);
}

// Canonical tool declarations as Responses function tools; in: options.tools, out: request `tools`.
function toOpenAITools(tools?: StandardToolDeclaration[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: (t.parameters || { type: "object", properties: {} }) as Record<string, unknown>,
    ...(t.strict !== undefined ? { strict: t.strict } : {}),
  }));
}

// `ImagePart.resolution` as the Responses `input_image.detail` (low, high, auto, original); in: contentPartsToBlocks, out: the detail to send, or none.
const IMAGE_DETAIL = { low: "low", medium: "auto", high: "high", ultra_high: "original" } as const;

// The `detail` field of an image part, empty when it sets no resolution; in: contentPartsToBlocks, out: spread into the block.
function imageDetail(part: ContentPart): { detail?: (typeof IMAGE_DETAIL)[keyof typeof IMAGE_DETAIL] } {
  const resolution = part.type === "image" ? part.resolution : undefined;
  return resolution ? { detail: IMAGE_DETAIL[resolution] } : {};
}

// Text and media parts as input_text, input_image and input_file blocks; web links pass through, the rest is inlined as data URLs; in: a user message's parts, out: fullHistoryInput.
async function contentPartsToBlocks(parts: ContentPart[]): Promise<ResponseContentPart[]> {
  const blocks: ResponseContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "input_text", text: part.text });
    } else if (part.type === "image" || part.type === "audio" || part.type === "video" || part.type === "file") {
      const raw =
        (part as { image?: unknown; audio?: unknown; video?: unknown; file?: unknown }).image ??
        (part as { audio?: unknown }).audio ??
        (part as { video?: unknown }).video ??
        (part as { file?: unknown }).file;
      // Remote http(s) URLs pass through directly (docs example:
      // `file_url: "https://...pdf"`). Fetch-and-inline would base64-blowup
      // (11MB mp3 → 11,926,995 chars > 1,048,576 `file_url` limit) and break
      // PDFs with "Failed to download file." Let OpenAI fetch instead.
      if (typeof raw === "string" && (raw.startsWith("http://") || raw.startsWith("https://"))) {
        if (part.type === "image") {
          blocks.push({ type: "input_image", image_url: raw, ...imageDetail(part) });
        } else {
          const filename = (part as { filename?: string }).filename;
          blocks.push({
            type: "input_file",
            file_url: raw,
            ...(typeof filename === "string" && filename ? { filename } : {}),
          });
        }
        continue;
      }
      const norm = await normalizeMediaInput(
        raw as string | Uint8Array | ArrayBuffer,
        (part as { mimeType?: string }).mimeType
      );
      // `input_image` is the documented shape; documents/files ride the
      // parity `input_file` shape. Audio/video have no documented user-input
      // shape — they travel as `input_file` with mime intact and the OpenAI
      // verdict surfaces if rejected (catalog modality gate fails fast first).
      // `filename` is forwarded when the canonical part carries one (PDFs).
      if (part.type === "image") {
        blocks.push({ type: "input_image", image_url: norm.dataUrl, ...imageDetail(part) });
      } else {
        const filename = (part as { filename?: string }).filename;
        blocks.push({
          type: "input_file",
          file_url: norm.dataUrl,
          ...(typeof filename === "string" && filename ? { filename } : {}),
        });
      }
    }
  }
  return blocks;
}

// Makes an id safe for the Responses wire (allowed characters, at most 64, no trailing underscores); in: fullHistoryInput, out: the id.
function normalizeResponsesIdPart(part: string): string {
  const sanitized = String(part ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
  // A hard cut would give two long ids with the same first 64 characters the same id; a hash of the whole id keeps them apart.
  const truncated = sanitized.length > 64 ? `${sanitized.slice(0, 64 - 9)}_${shortHashId(String(part))}` : sanitized;
  return truncated.replace(/_+$/, "") || "fc_unknown";
}

// Gives a function-call item id the required `fc_` prefix; in: fullHistoryInput, out: the id.
function normalizeResponsesItemId(itemId: string): string {
  let norm = normalizeResponsesIdPart(itemId);
  if (!norm.startsWith("fc_")) {
    norm = normalizeResponsesIdPart(`fc_${norm}`);
  }
  return norm;
}

// The text of one reasoning summary entry: the API sends `{ type: "summary_text", text }`, older mocks a plain string; in: parseResponse and the stream, out: the text or "".
function summaryText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  const text = (entry as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

// The HTTP status a response error code stands for, so the retry layers classify it: a server error and a rate limit are transient, every other code (invalid prompt, policy ...) is not; in: the failed-response and error-event paths, out: failure.statusCode.
function errorCodeStatus(code: unknown): number | undefined {
  if (code === "server_error") return 500;
  if (code === "rate_limit_exceeded") return 429;
  return undefined;
}

// The error a failed or error-carrying reply stands for: the provider's message (or the error's own text), code and type, and the HTTP status the code maps to; in: parseResponse and the stream's final event, out: the thrown ProviderError.
function responseFailure(error: unknown, modelId: string): Error {
  const fields = (error !== null && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const own = typeof error === "string" ? error.trim() : fields["message"];
  const failure: Record<string, unknown> & Error = new Error(
    typeof own === "string" && own ? own : "OpenAI response failed"
  ) as Record<string, unknown> & Error;
  if (fields["code"] !== undefined) failure["code"] = fields["code"];
  if (typeof fields["type"] === "string") failure["errorType"] = fields["type"];
  const status = errorCodeStatus(fields["code"]);
  if (status !== undefined) failure["statusCode"] = status;
  return toConciseProviderError(failure, "openai", modelId);
}

// The output items of a turn worth replaying (reasoning, function calls, messages), kept exactly as received, only for a turn that has reasoning and no cut-off tool call (a cut call is replayed as `{}`, never verbatim); in: parseResponse and the stream, out: providerSteps.
function replayItems(
  output: ResponsesOutputItem[] | undefined,
  toolCalls: ToolCallRecord[]
): ProviderSteps | undefined {
  const keep = (output ?? []).filter(
    (i) => i.type === "reasoning" || i.type === "function_call" || i.type === "message"
  );
  if (!keep.some((i) => i.type === "reasoning") || toolCalls.some((c) => hasTruncatedToolArguments(c.arguments)))
    return undefined;
  return { provider: "openai", steps: keep };
}

/**
 * Builds the FULL explicit history (stateless — no server state, no
 * chaining). Assistant items intentionally carry no provider `id`/`status`:
 * minting ids client-side would violate the provider-generates-ids rule.
 *
 * Cache-prefix stability: ALWAYS the item-array form, even for a single
 * text-only turn (same rationale as the OpenRouter adapter).
 */
async function fullHistoryInput(context: ProviderContext): Promise<ResponseInputItem[]> {
  // Map assistant tool_call item ids to pairing ids (call_…) so
  // function_call_output items pair correctly even though the executor keys
  // results by the item id.
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

  // Assistant turns after the last user message (the current tool loop) replay the items the model returned, reasoning included.
  let lastUser = -1;
  context.messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  const items: ResponseInputItem[] = [];
  for (let i = 0; i < context.messages.length; i++) {
    const m = context.messages[i]!;
    if (m.role === "system") continue;
    if (m.role === "assistant" && i > lastUser && m.providerSteps?.provider === "openai") {
      for (const step of m.providerSteps.steps as ResponseInputItem[]) {
        // A result is sent with the normalized call id, so the call it answers carries the same one (a no-op for real `call_...` ids).
        items.push(
          step.type === "function_call"
            ? { ...step, call_id: normalizeResponsesIdPart(String((step as { call_id?: unknown }).call_id ?? "")) }
            : step
        );
      }
      continue;
    }
    if (m.role === "user") {
      if (typeof m.content === "string") {
        if (m.content)
          items.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content }] });
      } else {
        const blocks = await contentPartsToBlocks(m.content);
        if (blocks.length > 0) items.push({ type: "message", role: "user", content: blocks });
      }
    } else if (m.role === "assistant") {
      if (typeof m.content === "string") {
        if (m.content) {
          items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
        }
        continue;
      }
      const texts: string[] = [];
      for (const part of m.content) {
        if (part.type === "tool_call") {
          // Cross-provider pipe IDs (`callId|itemId`) are split and
          // normalized (64-char, `fc_` prefix) so replay never 400s.
          const rawId = String(part.id ?? "");
          const rawCallId = String(part.callId ?? part.id ?? "");
          let itemId = rawId;
          let callId = rawCallId;
          if (rawId.includes("|")) {
            const [c, i] = rawId.split("|");
            if (c) callId = c;
            if (i) itemId = i;
          }
          if (callId.includes("|")) {
            const [c] = callId.split("|");
            if (c) callId = c;
          }
          items.push({
            type: "function_call",
            id: normalizeResponsesItemId(itemId),
            call_id: normalizeResponsesIdPart(callId),
            name: part.name,
            arguments: toolArgumentsJson(part.arguments),
          });
        } else if (part.type === "text" && part.text) {
          texts.push(part.text);
        }
        // Reasoning of finished turns is not resent; the current tool loop replays its stored items above.
      }
      if (texts.length > 0) {
        items.push({
          type: "message",
          role: "assistant",
          content: texts.map((t) => ({ type: "output_text", text: t })),
        });
      }
    } else if (m.role === "tool") {
      if (typeof m.content === "string") {
        const queue = (m.name && idsByName.get(m.name)) || [];
        const rawPair = queue.shift() || newToolCallId();
        const rawCall = rawPair.includes("|") ? beforeFirst(rawPair, "|") : rawPair;
        items.push({
          type: "function_call_output",
          call_id: normalizeResponsesIdPart(rawCall),
          output: m.content,
        });
        continue;
      }
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content) {
        if (part.type === "tool_result") {
          const rawPair = pairing.get(part.id) || part.id;
          const rawCall = rawPair.includes("|") ? beforeFirst(rawPair, "|") : rawPair;
          items.push({
            type: "function_call_output",
            call_id: normalizeResponsesIdPart(rawCall),
            output: resultToOutput(part.result),
          });
        }
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Response mapping (Responses -> canonical)
// ---------------------------------------------------------------------------

// Responses usage as TokenUsage, clamping cache reads to input; in: a response or the completed event, out: TokenUsage.
function mapUsage(raw?: ResponsesObject["usage"]): TokenUsage {
  const input = raw?.input_tokens ?? 0;
  const output = raw?.output_tokens ?? 0;
  // Canonical invariant: cache hits are a SUBSET of input.
  const cached = Math.min(raw?.input_tokens_details?.cached_tokens ?? 0, input);
  // GPT-5.6 and later report the tokens written to the cache (billed at the cache-write rate, not on top of input): a subset of input like the reads.
  const written = Math.min(raw?.input_tokens_details?.cache_write_tokens ?? 0, Math.max(0, input - cached));
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: raw?.total_tokens ?? input + output,
    cachedTokens: cached,
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    thinkingTokens: raw?.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

// Turns a Responses object into text, reasoning, tool calls and usage, mapping refusals and incomplete to finish reasons and throwing on failed; in: generate, out: ProviderGenerateResult.
function parseResponse(
  response: ResponsesObject,
  modelId: string,
  durationMs: number,
  raw: ProviderRawData
): ProviderGenerateResult {
  if (response.status === "failed" || carriesError(response.error)) throw responseFailure(response.error, modelId);

  let text = "";
  let refusalText = "";
  const thinkingParts: string[] = [];
  const toolCalls: ToolCallRecord[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const block of item.content ?? []) {
        if (block.type === "output_text" && block.text) text += block.text;
        else if (block.type === "refusal" && block.text) {
          text += block.text;
          refusalText += block.text;
        }
      }
      const itemRefusal = (item as { refusal?: unknown }).refusal;
      if (typeof itemRefusal === "string" && itemRefusal) {
        text += itemRefusal;
        refusalText += itemRefusal;
      }
    } else if (item.type === "reasoning") {
      for (const block of item.content ?? []) {
        if ((block.type === "reasoning_text" || block.type === "text") && block.text) {
          thinkingParts.push(block.text);
        }
      }
      for (const s of item.summary ?? []) {
        const text = summaryText(s);
        if (text) thinkingParts.push(text);
      }
    } else if (item.type === "function_call") {
      const args = parseArguments(item.arguments);
      toolCalls.push({
        id: item.id || item.call_id || newToolCallId(),
        callId: item.call_id,
        name: item.name || "unknown",
        arguments: args,
        rawArguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      });
    }
  }

  // `incomplete` -> length (content-filter truncations surface as
  // refusal when refusal text is present).
  const incompleteReason = (response as { incomplete_details?: { reason?: string } }).incomplete_details?.reason;
  const finishReason =
    toolCalls.length > 0
      ? "tool_calls"
      : refusalText || incompleteReason === "content_filter"
        ? "refusal"
        : response.status === "incomplete"
          ? "length"
          : "stop";
  return {
    text,
    // Trim/collapse reasoning assembly (provider summaries can trail with
    // blank lines). Display-only: the replayed reasoning is the stored item, not this text.
    thinking: normalizeThinkingParts(thinkingParts),
    thoughtSignature: undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: mapUsage(response.usage),
    finishReason,
    responseId: response.id,
    model: modelId,
    provider: "openai",
    raw,
    durationMs,
    providerSteps: replayItems(response.output, toolCalls),
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * OpenAI provider implemented directly on the Responses REST API
 * (`POST {baseUrl}/responses`, streaming on the same endpoint).
 */
export class OpenAIResponsesProvider implements Provider {
  readonly id: ProviderId = "openai";
  readonly name = "OpenAI Responses";

  /** Live catalog view: a constructor snapshot would go stale after refresh. */
  get models(): ModelSpec[] {
    return getModelsForProvider("openai");
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

  // Builds the stateless Responses request (full history, store:false, tools, reasoning, tier, text.format, cache key and retention); in: generate/stream, out: the body.
  private async buildBody(
    modelId: string,
    context: ProviderContext,
    options: ProviderRequestOptions | undefined,
    sessionId: string | undefined,
    tools: StandardToolDeclaration[] | undefined,
    stream: boolean
  ): Promise<ResponsesRequestBody> {
    const { effort } = mapThinkingLevelToOpenAI(options?.thinking?.level);
    const serviceTier = mapServiceTierToOpenAI(options?.serviceTier);
    // GPT-5.6 and later: `30m` / `12h` set `prompt_cache_options.ttl`. Older models: `12h` maps to `prompt_cache_retention: "24h"`; everything else stays on implicit prompt_cache_key affinity.
    const cacheOptions = usesCacheOptions(modelId);
    const cache = resolveCache(
      "openai",
      options?.cache,
      cacheOptions ? ["implicit", "30m", "12h"] : ["implicit", "12h"],
      `openai/${modelId}`
    );
    warnIgnoredMediaResolution("openai", context.messages, `openai/${modelId}`, ["video"]);
    warnIgnoredVideoProcessing("openai", context.messages, `openai/${modelId}`);
    warnIgnoredToolMedia("openai", context.messages, `openai/${modelId}`);

    // Structured outputs: native `text.format` when supported, else emulated
    // via instructions (catalog `structured_output: false` would 400).
    let effectiveSystemPrompt = context.systemPrompt;
    let outputEmulated = false;
    let outputSpec: import("../types/model.ts").StructuredOutputSpec | undefined;
    try {
      outputSpec = normalizeStructuredOutput(options?.output);
    } catch {
      outputSpec = undefined;
    }
    if (outputSpec && !modelSupportsStructuredOutput("openai", modelId)) {
      outputEmulated = true;
      effectiveSystemPrompt = augmentSystemPromptWithStructuredOutput(
        context.systemPrompt,
        outputSpec,
        options?.prompts?.structuredOutput
      );
      emitProviderWarning({
        provider: "openai",
        capability: "structured output",
        requested: `${outputSpec.name} (openai/${modelId})`,
        reason: "the catalog reports structured_output: false for this model, so native text.format is unsupported.",
        fallback: "emulated JSON instruction + client validation (no text.format is sent)",
      });
    }

    const body: ResponsesRequestBody = {
      model: modelId,
      input: await fullHistoryInput({ ...context, systemPrompt: effectiveSystemPrompt }),
      // Stateless by design: the server defaults store:true, so opt out
      // explicitly. Full history is always sent, so no chaining is needed
      // and provider switching stays trivial.
      store: false,
      ...(stream ? { stream: true } : {}),
    };
    if (effectiveSystemPrompt) body.instructions = effectiveSystemPrompt;
    const aiTools = toOpenAITools(tools);
    if (aiTools) body.tools = aiTools;
    const toolChoice = mapToolChoiceToOpenAI(options?.toolChoice);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    if (effort) body.reasoning = { effort };
    if (serviceTier) body.service_tier = serviceTier;
    // Stateless reasoning models return encrypted reasoning items to replay on the next request (GPT-5.6 and later do it by default; older ones need this).
    if (getModelFromCatalog("openai", modelId)?.reasoning === true) body.include = ["reasoning.encrypted_content"];
    // max_output_tokens.
    Object.assign(body, mapGenerationParamsToOpenAI(options));
    // Structured outputs: Responses `text.format{type:json_schema,name,schema,strict}`.
    // Skipped when emulated (instruction already in `instructions`).
    if (outputSpec && !outputEmulated) {
      try {
        const mapped = mapOutputToOpenAI(outputSpec);
        if (mapped) body.text = { format: mapped.format };
      } catch {
        // why: invalid output shapes fail fast at Agent construction/loop validation.
      }
    }
    // Cache affinity: prompt_cache_key replaces the legacy `user` field.
    // OpenAI enforces max 64 chars — clamp defensively so child session ids
    // (`parent-sub-tag-rand`) and user-supplied long ids never 400. Headers
    // are clamped the same way via buildSessionHeaders, keeping affinity
    // consistent.
    if (sessionId) {
      const cacheKey = clampCacheKey(sessionId);
      if (cacheKey) body.prompt_cache_key = cacheKey;
    }
    // GPT-5.6 and later: the request-level minimum lifetime of every cache write (`prompt_cache_retention` is deprecated there).
    if (cacheOptions && (cache === "30m" || cache === "12h")) {
      body.prompt_cache_options = { ttl: cache };
    }
    // Long retention: `prompt_cache_retention: "24h"` when the catalog supports it.
    else if (cache === "12h") {
      let supportsLong = true;
      try {
        const spec = getModelFromCatalog("openai", modelId);
        if (spec && typeof spec.capabilities?.supportsLongCacheRetention === "boolean") {
          supportsLong = spec.capabilities.supportsLongCacheRetention;
        }
      } catch {
        // why: a catalog problem makes the model "unknown", and this call goes ahead.
      }
      if (supportsLong) {
        (body as Record<string, unknown>)["prompt_cache_retention"] = "24h";
      } else {
        emitProviderWarning({
          provider: "openai",
          capability: "cache",
          requested: `12h (openai/${modelId})`,
          reason: "the catalog reports no long-cache support for this model.",
          fallback: "default caching with prompt_cache_key affinity (no retention payload is sent)",
        });
      }
    }
    // Stateless API use: previous_response_id / background / conversation are
    // NEVER sent (server state would break provider-agnostic switching).
    return body;
  }

  // Fetch options with session-affinity headers, JSON content type and the Bearer key; in: doFetch and stream, out: RequestInit.
  private requestInit(
    body: ResponsesRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    sessionId: string | undefined,
    signal?: AbortSignal
  ): RequestInit {
    const headers: Record<string, string> = buildSessionHeaders("openai", options?.headers, sessionId);
    // Case-insensitive merge so a lowercase `authorization` custom header
    // never coexists with the canonical bearer. Proxy flows
    // (`apiKey === "unused"`) preserve custom auth instead of overwriting.
    setHeaderCaseInsensitive(headers, "Content-Type", "application/json");
    if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "Authorization", `Bearer ${apiKey}`);
    return { method: "POST", headers, body: JSON.stringify(body), signal };
  }

  // One HTTP call under the request timeout, returning status, headers and body text; in: generate, out: the raw reply.
  private async doFetch(
    url: string,
    body: ResponsesRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    sessionId: string | undefined,
    signal?: AbortSignal
  ): Promise<{ status: number; statusText: string; headers: Record<string, string>; text: string }> {
    const { signal: effective, cleanup } = combinedSignal(signal, timeoutFor(options));
    try {
      const res = await (options?.fetch ?? fetch)(url, this.requestInit(body, options, apiKey, sessionId, effective));
      const text = await readTextCapped(res, CHAT_REPLY_LIMIT);
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
        ? " Check OPENAI_API_KEY (no quotes/spaces, correct provider), the base_urls.openai setting, and that the key is loaded (bun --env-file=.env.local)."
        : "";
    const fullMessage = `${message}${hint}`;
    const err: Record<string, unknown> & Error = new Error(fullMessage) as Record<string, unknown> & Error;
    (err as Record<string, unknown>)["statusCode"] = status;
    (err as Record<string, unknown>)["status"] = status;
    (err as Record<string, unknown>)["responseBody"] = bodyText.slice(0, 500);
    (err as Record<string, unknown>)["url"] = url.split("?")[0];
    // Preserve hint through toConciseProviderError re-wrap (it prefers
    // data.error.message over responseBody).
    (err as Record<string, unknown>)["data"] = { error: { message: fullMessage } };
    if (code !== undefined) (err as Record<string, unknown>)["code"] = code;
    if (errorType) (err as Record<string, unknown>)["errorType"] = errorType;
    if (raw) (err as Record<string, unknown>)["raw"] = raw;
    const retryAfterMs = parseRetryAfterMs(headers);
    if (retryAfterMs !== undefined) (err as Record<string, unknown>)["retryAfterMs"] = retryAfterMs;
    throw toConciseProviderError(err, "openai", modelId);
  }

  // Makes pictures with a gpt-image model (the Image API, see openai-image.ts); in: generateImage, out: the pictures and usage.
  generateImage(
    modelId: string,
    request: ProviderImageRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderImageResult> {
    return openaiGenerateImage(cleanModelId(modelId), request, options);
  }

  // Makes one vector per text with an OpenAI embedding model (the Embeddings API, see openai-embedding.ts); in: generateEmbedding, out: the vectors and usage.
  embed(
    modelId: string,
    request: ProviderEmbeddingRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderEmbeddingResult> {
    return openaiEmbed(cleanModelId(modelId), request, options);
  }

  // Answers the typed questions of a decision request with an OpenAI decision model (see openai-decision.ts); in: generateDecision, out: the answers and usage.
  decide(
    modelId: string,
    request: ProviderDecisionRequest,
    options?: ProviderRequestOptions
  ): Promise<ProviderDecisionResult> {
    return openaiDecide(cleanModelId(modelId), request, options);
  }

  // Non-streaming turn as one retried JSON request; in: runAgentLoop, out: ProviderGenerateResult.
  async generate(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): Promise<ProviderGenerateResult> {
    const startTime = Date.now();
    const clean = cleanModelId(model);
    const apiKey = resolveApiKey(options);
    if (!apiKey) {
      throw new ConfigError(
        "[Agent Accelerator] Missing OpenAI API key. Set OPENAI_API_KEY (or OPENAI_BASE_API_KEY) or pass apiKey."
      );
    }
    // Fail fast before any network call when the catalog knows the model
    // lacks the requested modality (e.g. gpt-5-nano is text+image only, so
    // audio/pdf/video get a one-line `unsupported X input` instead of a
    // confusing `file_url too long` / `Failed to download file.`).
    assertModalitiesSupported(context, "openai", clean);
    assertNoVideoPartsOnResponses(context, "openai", clean);
    const baseUrl = resolveBaseUrl(options);
    const url = `${baseUrl}/responses`;
    const sessionId = options?.sessionId;
    const tools = options?.tools as StandardToolDeclaration[] | undefined;
    const body = await this.buildBody(clean, context, options, sessionId, tools, false);

    // Audit trail: record the actual wire headers (session affinity included),
    // redacted. Previously only Content-Type + custom headers were stored,
    // hiding the x-session-id affinity actually sent.
    const auditHeadersRaw: Record<string, string> = {
      ...buildSessionHeaders("openai", options?.headers, sessionId),
      "Content-Type": "application/json",
      Authorization: "[REDACTED]",
    };
    const auditHeaders = redactedHeaders(auditHeadersRaw);
    const rawRequest = {
      url,
      method: "POST",
      headers: auditHeaders,
      body,
    };

    const doCall = async (): Promise<ProviderGenerateResult> => {
      const res = await this.doFetch(url, body, options, apiKey, sessionId, options?.signal);
      this.throwIfError(res.status, url, res.text, clean, res.headers);
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        throw toConciseProviderError(
          Object.assign(new Error("Invalid JSON response from OpenAI Responses API"), {
            statusCode: res.status,
            responseBody: res.text.slice(0, 500),
            url,
          }),
          "openai",
          clean
        );
      }
      const problem = responsesReplyProblem(parsed);
      if (problem) throw badReplyError("openai", clean, url, problem, res.text);
      const response = parsed as ResponsesObject; // checked by responsesReplyProblem above
      // Stateless turns never establish chains, but the session store still
      // records the turn so other providers' switch detection keeps working.
      noteProviderTurn(sessionId, "openai");
      return parseResponse(response, clean, Date.now() - startTime, {
        request: rawRequest,
        response: { status: res.status, statusText: res.statusText, headers: res.headers, body: response },
      });
    };

    try {
      return await withRetries(doCall, {
        ...retryOptionsFrom(options),
        signal: options?.signal,
        label: { providerId: "openai", modelId: clean },
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
    const clean = cleanModelId(model);

    const { linked, release } = linkStreamAbort(eventStream, options?.signal);

    (async () => {
      try {
        const apiKey = resolveApiKey(options);
        if (!apiKey) {
          throw new ConfigError(
            "[Agent Accelerator] Missing OpenAI API key. Set OPENAI_API_KEY (or OPENAI_BASE_API_KEY) or pass apiKey."
          );
        }
        assertModalitiesSupported(context, "openai", clean);
        assertNoVideoPartsOnResponses(context, "openai", clean);
        const baseUrl = resolveBaseUrl(options);
        const url = `${baseUrl}/responses`;
        const sessionId = options?.sessionId;
        const tools = options?.tools as StandardToolDeclaration[] | undefined;
        const body = await this.buildBody(clean, context, options, sessionId, tools, true);

        const streamAuditRaw: Record<string, string> = {
          ...buildSessionHeaders("openai", options?.headers, sessionId),
          "Content-Type": "application/json",
          Authorization: "[REDACTED]",
        };
        const rawRequest = {
          url,
          method: "POST",
          headers: redactedHeaders(streamAuditRaw),
          body,
        };

        // Optional per-call timeout races the linked abort signal.
        const streamTimeoutMs = timeoutFor(options);
        // Transient failures (429/5xx/network) are retried here, before the
        // first byte; once the stream is live it is never retried.
        const res = await openStreamResponse({
          fetchOnce: () =>
            withAbortTimer(linked, streamTimeoutMs, () =>
              (options?.fetch ?? fetch)(url, this.requestInit(body, options, apiKey, sessionId, linked.signal))
            ),
          onHttpError: (r, text) => this.throwIfError(r.status, url, text, clean, headersToRecord(r.headers)),
          noBodyError: () =>
            toConciseProviderError(new Error("OpenAI streaming response had no body"), "openai", clean),
          retry: retryOptionsFrom(options),
          signal: linked.signal,
          label: { providerId: "openai", modelId: clean },
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
        // Tool calls keyed by output_index: { itemId, callId, name, startArgs, deltaArgs }.
        const calls = new Map<
          number,
          { itemId: string; callId: string; name: string; startArgs: string; deltaArgs: string }
        >();
        let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        let finishReason = "stop";
        let sawFinishReason = false;
        let sawUsage = false;
        let refusalSeen = false;
        let badFrames = 0;
        let framesSeen = 0;
        let responseId: string | undefined;
        let completedBody: unknown = undefined;
        let completedOutput: ResponsesOutputItem[] | undefined;
        const handleMessage = (data: string): void => {
          if (!data || data === "[DONE]") {
            if (data === "[DONE]") sawFinishReason = sawFinishReason || completedBody !== undefined || sawUsage;
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
          const type = msg["type"] as string;
          if (!type) return;
          if (type === "error") {
            // The documented `error` event carries code and message at the top level; an `error` object inside it is tolerated too.
            const errObj = (msg["error"] ?? msg) as { message?: string; code?: string | number; type?: string };
            const message =
              typeof errObj.message === "string" && errObj.message ? errObj.message : "OpenAI streaming error";
            const failure: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
            if (errObj.code !== undefined) failure["code"] = errObj.code;
            if (typeof errObj.type === "string") failure["errorType"] = errObj.type;
            const status = errorCodeStatus(errObj.code);
            if (status !== undefined) failure["statusCode"] = status;
            failure["url"] = url;
            throw toConciseProviderError(failure, "openai", clean);
          }
          if (type === "response.created" || type === "response.in_progress") {
            const response = (msg["response"] as { id?: string }) ?? {};
            if (response.id) responseId = response.id;
          } else if (type === "response.output_text.delta" && typeof msg["delta"] === "string") {
            text += msg["delta"] as string;
            eventStream.push({ type: "text_delta", delta: msg["delta"] as string, partialText: text });
          } else if (type === "response.refusal.delta" || type === "response.output_refusal.delta") {
            // Refusal deltas carry the filter text; surface as text and
            // remember for a `refusal` finish reason.
            if (typeof msg["delta"] === "string" && msg["delta"]) {
              text += msg["delta"] as string;
              refusalSeen = true;
              eventStream.push({ type: "text_delta", delta: msg["delta"] as string, partialText: text });
            }
          } else if (
            (type === "response.reasoning_text.delta" || type === "response.reasoning.delta") &&
            typeof msg["delta"] === "string"
          ) {
            thinking += msg["delta"] as string;
            eventStream.push({
              type: "thinking_delta",
              thinkingDelta: msg["delta"] as string,
              partialThinking: thinking,
            });
          } else if (type === "response.reasoning_summary_text.delta" && typeof msg["delta"] === "string") {
            thinking += msg["delta"] as string;
            eventStream.push({
              type: "thinking_delta",
              thinkingDelta: msg["delta"] as string,
              partialThinking: thinking,
            });
          } else if (
            type === "response.reasoning_summary_part.added" &&
            Number(msg["summary_index"] ?? 0) > 0 &&
            thinking
          ) {
            // A new summary part starts a new paragraph.
            thinking += "\n\n";
            eventStream.push({ type: "thinking_delta", thinkingDelta: "\n\n", partialThinking: thinking });
          } else if (type === "response.output_item.added") {
            const index = (msg["output_index"] as number) ?? 0;
            const item = (msg["item"] as Record<string, unknown>) ?? {};
            if (item["type"] === "function_call") {
              const args = item["arguments"];
              calls.set(index, {
                itemId: (item["id"] as string) || "",
                callId: (item["call_id"] as string) || "",
                name: (item["name"] as string) || "unknown",
                startArgs: typeof args === "string" ? args : args ? JSON.stringify(args) : "",
                deltaArgs: "",
              });
            }
          } else if (type === "response.function_call_arguments.delta") {
            const index = (msg["output_index"] as number) ?? 0;
            const chunk = (msg["delta"] as string) ?? "";
            const entry = calls.get(index);
            if (entry && typeof chunk === "string") entry.deltaArgs += chunk;
          } else if (type === "response.function_call_arguments.done") {
            const index = (msg["output_index"] as number) ?? 0;
            const entry = calls.get(index);
            // The done event carries the COMPLETE arguments string — it wins
            // over accumulated deltas (same candidate strategy as elsewhere).
            if (entry && typeof msg["arguments"] === "string") {
              entry.startArgs = "";
              entry.deltaArgs = msg["arguments"] as string;
            }
          } else if (
            type === "response.completed" ||
            type === "response.failed" ||
            type === "response.incomplete" ||
            type === "response.done"
          ) {
            const response = (msg["response"] as ResponsesObject) ?? {};
            completedBody = msg["response"];
            completedOutput = response.output;
            if (response.id) responseId = response.id;
            if (response.usage) {
              usage = mapUsage(response.usage);
              sawUsage = true;
            }
            sawFinishReason = true;
            if (type === "response.failed" || response.status === "failed" || carriesError(response.error)) {
              throw responseFailure(response.error, clean);
            }
            // Non-streaming maps `incomplete` → `length` (max tokens). Streaming
            // must do the same — otherwise truncated turns misreport `stop`.
            // Content-filter incompletes surface as `refusal`.
            const incompleteReason = (response as { incomplete_details?: { reason?: string } }).incomplete_details
              ?.reason;
            if (response.status === "incomplete" || type === "response.incomplete") {
              finishReason = incompleteReason === "content_filter" ? "refusal" : "length";
              sawFinishReason = true;
            }
            // Merge any full tool items delivered at completion (authoritative
            // when present) so nothing depends solely on delta assembly.
            for (const item of response.output ?? []) {
              if (item.type !== "function_call") continue;
              const found = [...calls.values()].find(
                (c) => (c.itemId && c.itemId === item.id) || (c.callId && c.callId === item.call_id)
              );
              if (found && typeof item.arguments === "string") {
                const entry = found;
                entry.itemId = item.id || entry.itemId;
                entry.callId = item.call_id || entry.callId;
                entry.name = item.name || entry.name;
                entry.startArgs = "";
                entry.deltaArgs = item.arguments;
              }
            }
            // Merge completed reasoning (summary often arrives only here, with
            // no preceding `reasoning_text.delta`). Append only text not
            // already streamed to avoid doubling deltas + completed content.
            for (const item of response.output ?? []) {
              if (item.type !== "reasoning") continue;
              const parts: string[] = [];
              for (const block of item.content ?? []) {
                if ((block.type === "reasoning_text" || block.type === "text") && block.text) {
                  parts.push(block.text);
                }
              }
              for (const s of item.summary ?? []) {
                const text = summaryText(s);
                if (text) parts.push(text);
              }
              for (const p of parts) {
                if (p && !thinking.includes(p)) {
                  thinking += (thinking ? "\n" : "") + p;
                }
              }
            }
            // Merge completed refusal text (filter truncations often arrive only
            // here with no preceding refusal delta).
            for (const item of response.output ?? []) {
              if (item.type !== "message") continue;
              for (const block of item.content ?? []) {
                if (block.type === "refusal" && block.text) {
                  if (!text.includes(block.text)) text += block.text;
                  refusalSeen = true;
                }
              }
            }
            eventStream.push({ type: "usage", usage });
          }
        };

        await readSseData(res.body, linked, eventStream, handleMessage);

        const toolCalls: ToolCallRecord[] = [];
        for (const c of calls.values()) {
          const args = parseStreamedToolArguments(c.startArgs, c.deltaArgs);
          const record: ToolCallRecord = {
            id: c.itemId || c.callId || newToolCallId(),
            callId: c.callId || undefined,
            name: c.name,
            arguments: args,
            rawArguments: selectRawArguments(c.startArgs, c.deltaArgs),
          };
          toolCalls.push(record);
          eventStream.push({ type: "tool_call_complete", toolCall: record });
        }

        // Did the stream really end? Read before the tool-call and refusal overrides below, which also set sawFinishReason.
        const hasTerminal = completedBody !== undefined || sawFinishReason || sawUsage;
        noteProviderTurn(sessionId, "openai");
        if (toolCalls.length > 0) {
          finishReason = toolTurnFinishReason(finishReason, toolCalls);
          sawFinishReason = true;
        } else if (refusalSeen && finishReason !== "length") {
          finishReason = "refusal";
          sawFinishReason = true;
        }

        // Terminal-state guard. Loops ending with no completed body, no
        // finish_reason, and no usage while carrying no content must fail as
        // `incomplete_stream` (retryable) instead of resolving empty success.
        // Skipped for non-SSE payloads (e.g. JSON mocks in delegation tests)
        // where no SSE frames were ever seen — those preserve legacy empty
        // success rather than failing the caller on a mock artifact.
        const cleanThinking = thinking.replace(/\n{3,}/g, "\n\n").trim();
        const incomplete = incompleteStreamCheck({
          provider: "openai",
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
          provider: "openai",
          raw: {
            request: rawRequest,
            response: { ...responseMeta, body: completedBody, badFrames },
          },
          durationMs: Date.now() - startTime,
          providerSteps: replayItems(completedOutput, toolCalls),
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
