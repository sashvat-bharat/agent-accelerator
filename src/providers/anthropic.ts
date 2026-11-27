/**
 * Anthropic Messages API provider (`POST {baseUrl}/messages`, streaming on the same endpoint).
 *
 * All Anthropic-specific HTTP, headers, auth, request construction, response/SSE parsing and wire transformations live HERE,
 * never in the canonical layer (`src/providers.ts`).
 *
 * Wire contract: `references/documentations/anthropic/` (create-a-message, streaming-messages, tool-use, tools-define,
 * steering-thinking, structure-outputs, prompt-caching, vision, pdf-support, errors, rate-limits), API version 2026-10-21.
 * Implemented: text, system, full-history multi-turn, streaming, client tools (+parallel, strict), tool results, adaptive
 * thinking + effort with exact replay of thinking blocks, structured output (`output_config.format`), image and PDF/text
 * documents, automatic prompt caching (5m/1h), service tier, usage, finish reasons, abort, errors.
 *
 * Out of scope (never sent): server tools (web search/fetch, code execution), the Batches and Files APIs, citations, MCP,
 * `temperature`/`top_p`/`top_k` (a 400 on every model under 2026-10-21), prefill, `anthropic-beta` features.
 *
 * Notes:
 * - STATELESS: every turn sends the full canonical history. Anthropic caches by prefix, so `instructions`, the tool order and
 *   the earlier messages must stay byte-stable; the top-level `cache_control` puts the breakpoint on the last block.
 * - Anthropic's `input_tokens` EXCLUDES cache reads and writes. `mapUsage` adds them back so cache tokens stay a SUBSET of
 *   `inputTokens`, like every other adapter.
 * - Tool-use ids (`toolu_...`) are provider-generated and echoed verbatim; ids from other providers are made safe for
 *   `^[a-zA-Z0-9_-]+$` consistently on the call and on its result.
 * - Thinking blocks (and `redacted_thinking`) of the CURRENT tool loop are stored as `providerSteps` and replayed unmodified
 *   (a modified block is a 400); those of finished turns are not resent (the API strips them anyway).
 */
import type {
  Provider,
  ProviderId,
  ModelSpec,
  ProviderRequestOptions,
  ProviderGenerateResult,
  ProviderRawData,
  StructuredOutputSpec,
} from "../types/model.ts";
import type { ProviderContext, ContentPart, Message } from "../types/message.ts";
import { CHAT_REPLY_LIMIT, readTextCapped } from "../utils/body.ts";
import type { StandardToolDeclaration, ToolCallRecord } from "../types/tool.ts";
import { TRUNCATED_ARGS_KEY } from "../types/tool.ts";
import type { TokenUsage } from "../types/core.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentResponse } from "../types/response.ts";
import { buildSessionHeaders, setHeaderCaseInsensitive } from "../utils/headers.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import type { MediaDownload } from "../utils/media.ts";
import { toConciseProviderError } from "../utils/errors.ts";
import { assertModalitiesSupported } from "./modalities.ts";
import { badReplyError, messageReplyProblem } from "./reply-guard.ts";
import { ConfigError, ValidationError } from "../types/errors.ts";
import { withRetries } from "../utils/retry.ts";
import {
  newToolCallId,
  redactedHeaders,
  readErrorPayload,
  hasUnfinishedToolCall,
  linkStreamAbort,
  withAbortTimer,
  readSseData,
  incompleteStreamCheck,
  endWithPlainReply,
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
  normalizeThinkingParts,
} from "./shared.ts";
import { getModelFromCatalog, getModelsForProvider, createGenericModelSpec } from "../models/catalog.ts";
import { modelSupportsStructuredOutput } from "../models/catalog.ts";
import {
  anthropicSchema,
  mapThinkingLevelToAnthropic,
  mapServiceTierToAnthropic,
  mapToolChoiceToAnthropic,
  mapOutputToAnthropic,
  resolveCache,
  noteProviderTurn,
  parseStreamedToolArguments,
  selectRawArguments,
  normalizeStructuredOutput,
  augmentSystemPromptWithStructuredOutput,
  emitProviderWarning,
  warnIgnoredMediaResolution,
  warnIgnoredVideoProcessing,
  warnIgnoredToolMedia,
} from "../providers.ts";

// ---------------------------------------------------------------------------
// Wire constants (provider-specific numbers live here, named)
// ---------------------------------------------------------------------------

/** The API version header value (docs: api-overview, migration to 2026-10-21). Callers may override it with a `headers` entry. */
const ANTHROPIC_VERSION = "2026-10-21";
/** `max_tokens` is required: the catalog's output limit, capped here because large non-streaming requests risk idle-connection drops (docs: streaming-messages). */
const MAX_TOKENS_CAP = 64_000;
/** `max_tokens` for a model the catalog does not know. */
const MAX_TOKENS_UNKNOWN_MODEL = 32_000;
/** Image media types the API accepts (docs: vision). */
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** Models that reject `tool_choice` any/tool with a 400 (docs: tool-use, create-a-message). */
const NO_FORCED_TOOL_USE = new Set([
  "claude-fable-5-2",
  "claude-mythos-5-2",
  "claude-fable-5-1",
  "claude-mythos-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
]);
/** The "thinking off" request value of the models that allow one (docs: steering-thinking matrix); every other 5.x model always thinks. */
const THINKING_OFF: Record<string, { type: "disabled" | "between_tools" }> = {
  "claude-sonnet-5-5": { type: "between_tools" },
  "claude-haiku-5-5": { type: "disabled" },
  "claude-opus-5": { type: "disabled" },
  "claude-sonnet-5": { type: "disabled" },
};
/** Mid-stream `error.type` to the HTTP status it stands for, so `withRetries` and the run retry classify it (docs: errors). */
const ERROR_TYPE_STATUS: Record<string, number> = {
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

// ---------------------------------------------------------------------------
// Wire shapes (subset)
// ---------------------------------------------------------------------------

type CacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

type RequestBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: Record<string, unknown> }
  | { type: "document"; source: Record<string, unknown>; title?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content?: string; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: RequestBlock[];
}

interface MessagesRequestBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  stream?: boolean;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: Record<string, unknown>;
  thinking?: Record<string, unknown>;
  output_config?: { effort?: string; format?: Record<string, unknown> };
  service_tier?: string;
  cache_control?: CacheControl;
}

interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number | null } | null;
  [k: string]: unknown;
}

interface ResponseBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [k: string]: unknown;
}

interface MessageObject {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  content?: ResponseBlock[];
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: AnthropicUsage;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Request building (canonical -> Messages)
// ---------------------------------------------------------------------------

// The anthropic base URL of this request; in: each request, out: the shared resolver.
function resolveBaseUrl(options?: ProviderRequestOptions): string {
  return resolveProviderBaseUrl("anthropic", options);
}

// The anthropic key of this request; in: each request, out: the shared resolver.
function resolveApiKey(options?: ProviderRequestOptions): string | undefined {
  return resolveProviderApiKey("anthropic", options);
}

// The model id without its provider scope; in: each request, out: the bare id.
function cleanModelId(model: string | ModelSpec): string {
  return stripModelScope(model, /^anthropic\//i);
}

// Canonical tool declarations as Anthropic client tools (strict ones get the supported schema subset); in: options.tools, out: request `tools`.
function toAnthropicTools(tools?: StandardToolDeclaration[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => {
    const params = (t.parameters || { type: "object", properties: {} }) as Record<string, unknown>;
    return {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      input_schema: t.strict === true ? anthropicSchema(params) : params,
      ...(t.strict !== undefined ? { strict: t.strict } : {}),
    };
  });
}

// An id the API accepts (`^[a-zA-Z0-9_-]+$`, at most 64), the same for a call and its result; in: the history builder, out: the id.
function safeToolId(id: string): string {
  const first = String(id ?? "").split("|")[0] ?? "";
  const clean = first.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return clean || "toolu_unknown";
}

// One-line "why" for a part the Anthropic wire cannot carry; in: the media converter, out: a ValidationError.
function unsupportedInput(what: string, modelId: string, remedy: string): ValidationError {
  return new ValidationError(`[anthropic/${modelId}] unsupported ${what}. ${remedy}`, {
    provider: "anthropic",
    model: modelId,
  });
}

// Text and media parts as Anthropic text, image and document blocks; web links go as url sources, the rest is inlined as base64; in: a user message's parts, out: the message content.
async function contentPartsToBlocks(
  parts: ContentPart[],
  modelId: string,
  download?: MediaDownload
): Promise<RequestBlock[]> {
  const blocks: RequestBlock[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "audio" || part.type === "video") {
      throw unsupportedInput(
        `${part.type} input`,
        modelId,
        "Claude takes text, images and PDF/text documents: transcribe or sample the media first."
      );
    } else if (part.type === "image") {
      const raw = part.image;
      if (typeof raw === "string" && /^https?:\/\//i.test(raw)) {
        blocks.push({ type: "image", source: { type: "url", url: raw } });
        continue;
      }
      const norm = await normalizeMediaInput(raw, part.mimeType, download);
      if (!IMAGE_MEDIA_TYPES.has(norm.mimeType)) {
        throw unsupportedInput(`image type ${norm.mimeType}`, modelId, "Use JPEG, PNG, GIF or WebP.");
      }
      blocks.push({ type: "image", source: { type: "base64", media_type: norm.mimeType, data: norm.base64Data } });
    } else if (part.type === "file") {
      const raw = part.file;
      const title = part.filename ? { title: part.filename.slice(0, 500) } : {};
      const isUrl = typeof raw === "string" && /^https?:\/\//i.test(raw);
      if (isUrl && (part.mimeType === "application/pdf" || /\.pdf(\?|#|$)/i.test(raw))) {
        blocks.push({ type: "document", source: { type: "url", url: raw }, ...title });
        continue;
      }
      const norm = await normalizeMediaInput(raw, part.mimeType, download);
      if (norm.mimeType === "application/pdf") {
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: norm.base64Data },
          ...title,
        });
      } else if (norm.mimeType === "text/plain") {
        const data = new TextDecoder().decode(Uint8Array.from(atob(norm.base64Data), (c) => c.charCodeAt(0)));
        blocks.push({ type: "document", source: { type: "text", media_type: "text/plain", data }, ...title });
      } else {
        throw unsupportedInput(
          `file type ${norm.mimeType}`,
          modelId,
          "Documents must be PDF or plain text: convert the file first."
        );
      }
    }
  }
  return blocks;
}

// Replays the raw blocks of one assistant turn unmodified (thinking signatures must match); in: Message.providerSteps, out: request blocks, or undefined when the message carries none of ours.
function replayBlocks(m: Message): RequestBlock[] | undefined {
  const steps = m.providerSteps;
  if (!steps || steps.provider !== "anthropic" || !Array.isArray(steps.steps)) return undefined;
  const out: RequestBlock[] = [];
  for (const raw of steps.steps) {
    const b = raw as ResponseBlock;
    // why: a thinking block is sent back exactly as the API gave it, including fields this SDK does not model.
    if (b.type === "thinking" || b.type === "redacted_thinking") out.push({ ...b } as unknown as RequestBlock);
    else if (b.type === "text" && b.text) out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use" && b.id && b.name) {
      out.push({ type: "tool_use", id: b.id, name: b.name, input: (b.input as Record<string, unknown>) ?? {} });
    }
  }
  return out.length > 0 ? out : undefined;
}

// Appends blocks to the last message when it has the same role, else starts a new one; tool_result blocks always lead a user message (API rule); in: fullHistoryMessages, out: the message list.
function pushBlocks(messages: AnthropicMessage[], role: "user" | "assistant", blocks: RequestBlock[]): void {
  if (blocks.length === 0) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    last.content.push(...blocks);
    if (role === "user")
      last.content.sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
  } else {
    messages.push({ role, content: [...blocks] });
  }
}

/**
 * Builds the FULL explicit history (stateless). Roles alternate (same-role neighbours are merged), tool results sit in a user
 * message ahead of any text, assistant turns of the current tool loop replay their stored thinking blocks, and every other
 * turn is rebuilt from the canonical text and tool calls (thinking of finished turns is never resent).
 */
async function fullHistoryMessages(
  context: ProviderContext,
  modelId: string,
  download?: MediaDownload
): Promise<AnthropicMessage[]> {
  const idsByName = new Map<string, string[]>();
  for (const m of context.messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type !== "tool_call") continue;
        const queue = idsByName.get(part.name) ?? [];
        queue.push(part.callId || part.id);
        idsByName.set(part.name, queue);
      }
    }
  }
  const pairing = new Map<string, string>();
  for (const m of context.messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content) if (part.type === "tool_call") pairing.set(part.id, part.callId || part.id);
    }
  }
  let lastUser = -1;
  context.messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });

  const messages: AnthropicMessage[] = [];
  for (let i = 0; i < context.messages.length; i++) {
    const m = context.messages[i]!;
    if (m.role === "system") continue;
    if (m.role === "user") {
      const blocks: RequestBlock[] =
        typeof m.content === "string"
          ? m.content
            ? [{ type: "text", text: m.content }]
            : []
          : await contentPartsToBlocks(m.content, modelId, download);
      pushBlocks(messages, "user", blocks);
    } else if (m.role === "assistant") {
      const replay = i > lastUser ? replayBlocks(m) : undefined;
      if (replay) {
        pushBlocks(messages, "assistant", replay);
        continue;
      }
      if (typeof m.content === "string") {
        pushBlocks(messages, "assistant", m.content ? [{ type: "text", text: m.content }] : []);
        continue;
      }
      const blocks: RequestBlock[] = [];
      for (const part of m.content) {
        if (part.type === "text" && part.text) blocks.push({ type: "text", text: part.text });
        else if (part.type === "tool_call") {
          blocks.push({
            type: "tool_use",
            id: safeToolId(part.callId || part.id),
            name: part.name,
            input: JSON.parse(toolArgumentsJson(part.arguments)) as Record<string, unknown>,
          });
        }
        // Thinking parts are never rebuilt: a block without its signature is invalid.
      }
      pushBlocks(messages, "assistant", blocks);
    } else if (m.role === "tool") {
      const blocks: RequestBlock[] = [];
      if (typeof m.content === "string") {
        const queue = (m.name && idsByName.get(m.name)) || [];
        const id = queue.shift() || newToolCallId("toolu");
        blocks.push({ type: "tool_result", tool_use_id: safeToolId(id), ...(m.content ? { content: m.content } : {}) });
      } else {
        for (const part of m.content) {
          if (part.type !== "tool_result") continue;
          const content = resultToOutput(part.result);
          blocks.push({
            type: "tool_result",
            tool_use_id: safeToolId(pairing.get(part.id) || part.id),
            ...(content ? { content } : {}),
            ...(part.isError ? { is_error: true } : {}),
          });
        }
      }
      pushBlocks(messages, "user", blocks);
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Response mapping (Messages -> canonical)
// ---------------------------------------------------------------------------

// Messages usage as TokenUsage: cache reads and writes are separate buckets on the wire, so they are added to input to stay subsets of it; in: a response, message_start or the merged stream usage, out: TokenUsage.
function mapUsage(raw?: AnthropicUsage): TokenUsage {
  const fresh = raw?.input_tokens ?? 0;
  const read = raw?.cache_read_input_tokens ?? 0;
  const write = raw?.cache_creation_input_tokens ?? 0;
  const input = fresh + read + write;
  const output = raw?.output_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cachedTokens: read,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    thinkingTokens: Math.min(raw?.output_tokens_details?.thinking_tokens ?? 0, output),
  };
}

// Folds a (cumulative) usage update into the running one: a null or missing field keeps the earlier value; in: the stream's message_start and message_delta, out: the merged usage.
function mergeUsage(prev: AnthropicUsage, next: AnthropicUsage | undefined): AnthropicUsage {
  const merged: AnthropicUsage = { ...prev };
  for (const [k, v] of Object.entries(next ?? {})) if (v !== null && v !== undefined) merged[k] = v;
  return merged;
}

// The canonical finish reason of an Anthropic stop_reason; in: parse and stream, out: the loop's finish reason.
function mapStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "refusal";
    default:
      return "stop"; // end_turn, stop_sequence, pause_turn (server tools are never enabled), or an unknown value
  }
}

// The blocks worth replaying (text, tool_use, thinking, redacted_thinking) with null citations dropped; in: parse and stream, out: providerSteps, only when the turn has thinking.
function stepsOf(blocks: ResponseBlock[]): ProviderGenerateResult["providerSteps"] {
  const keep = blocks
    .filter((b) => ["text", "tool_use", "thinking", "redacted_thinking"].includes(b.type))
    .map((b) => {
      const { citations: _citations, ...rest } = b;
      return rest;
    });
  return keep.some((b) => b.type === "thinking" || b.type === "redacted_thinking")
    ? { provider: "anthropic", steps: keep }
    : undefined;
}

// A tool_use block as the canonical call record; in: parse, out: ToolCallRecord.
function toolCallOf(block: ResponseBlock): ToolCallRecord {
  const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
  return {
    id: block.id || newToolCallId("toolu"),
    name: block.name || "unknown",
    arguments: input,
    rawArguments: JSON.stringify(input),
  };
}

// Reads a whole Messages reply: parses the JSON, checks it (an error object or a reply that cannot be used throws), records the turn and maps it; in: generate, and a stream request answered in one piece, out: ProviderGenerateResult.
function readWholeReply(
  reply: { status: number; statusText: string; headers: Record<string, string>; text: string },
  modelId: string,
  sessionId: string | undefined,
  startTime: number,
  request: ProviderRawData["request"]
): ProviderGenerateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.text);
  } catch {
    throw toConciseProviderError(
      Object.assign(new Error("Invalid JSON response from Anthropic Messages API"), {
        statusCode: reply.status,
        responseBody: reply.text.slice(0, 500),
        url: request.url,
      }),
      "anthropic",
      modelId
    );
  }
  const problem = messageReplyProblem(parsed);
  if (problem) throw badReplyError("anthropic", modelId, request.url, problem, reply.text);
  const message = parsed as MessageObject; // checked by messageReplyProblem above
  noteProviderTurn(sessionId, "anthropic");
  return parseMessage(message, modelId, Date.now() - startTime, {
    request,
    response: { status: reply.status, statusText: reply.statusText, headers: reply.headers, body: message },
  });
}

// Turns a Messages object into text, thinking, tool calls and usage; in: generate, out: ProviderGenerateResult.
function parseMessage(
  message: MessageObject,
  modelId: string,
  durationMs: number,
  raw: ProviderRawData
): ProviderGenerateResult {
  const blocks = message.content ?? [];
  let text = "";
  const thinkingParts: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text) text += b.text;
    else if (b.type === "thinking" && b.thinking) thinkingParts.push(b.thinking);
    else if (b.type === "tool_use") toolCalls.push(toolCallOf(b));
  }
  // A reply that stopped on max_tokens may end inside its last tool_use block (docs: handling stop reasons): that call is
  // incomplete, so it is marked truncated and never executed.
  const last = toolCalls[toolCalls.length - 1];
  if (message.stop_reason === "max_tokens" && last)
    last.arguments = { [TRUNCATED_ARGS_KEY]: last.rawArguments ?? "{}" };
  const finishReason =
    toolCalls.length > 0
      ? toolTurnFinishReason(mapStopReason(message.stop_reason), toolCalls)
      : mapStopReason(message.stop_reason);
  return {
    text,
    thinking: normalizeThinkingParts(thinkingParts),
    thoughtSignature: undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: mapUsage(message.usage),
    finishReason,
    responseId: message.id,
    model: modelId,
    provider: "anthropic",
    raw,
    durationMs,
    providerSteps: stepsOf(blocks),
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Anthropic provider implemented directly on the Messages REST API. */
export class AnthropicMessagesProvider implements Provider {
  readonly id: ProviderId = "anthropic";
  readonly name = "Anthropic Messages";

  /** Live catalog view: a constructor snapshot would go stale after refresh. */
  get models(): ModelSpec[] {
    return getModelsForProvider("anthropic");
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

  // Builds the stateless Messages request (history, system, tools, thinking, effort, structured output, cache, tier); in: generate/stream, out: the body.
  private async buildBody(
    modelId: string,
    context: ProviderContext,
    options: ProviderRequestOptions | undefined,
    tools: StandardToolDeclaration[] | undefined,
    stream: boolean
  ): Promise<MessagesRequestBody> {
    const ref = `anthropic/${modelId}`;
    const { thinking, effort } = mapThinkingLevelToAnthropic(options?.thinking?.level, THINKING_OFF[modelId], ref);
    const serviceTier = mapServiceTierToAnthropic(options?.serviceTier);
    // `implicit` (and unset) is the automatic breakpoint: a top-level cache_control on the last cacheable block.
    const cache = resolveCache("anthropic", options?.cache, ["implicit", "5m", "1h"], ref);
    warnIgnoredMediaResolution("anthropic", context.messages, ref);
    warnIgnoredVideoProcessing("anthropic", context.messages, ref);
    warnIgnoredToolMedia("anthropic", context.messages, ref);

    let system = context.systemPrompt;
    let outputSpec: StructuredOutputSpec | undefined;
    try {
      outputSpec = normalizeStructuredOutput(options?.output);
    } catch {
      outputSpec = undefined; // an invalid output shape already failed at Agent construction
    }
    let outputEmulated = false;
    if (outputSpec && !modelSupportsStructuredOutput("anthropic", modelId)) {
      outputEmulated = true;
      system = augmentSystemPromptWithStructuredOutput(system, outputSpec, options?.prompts?.structuredOutput);
      emitProviderWarning({
        provider: "anthropic",
        capability: "structured output",
        requested: `${outputSpec.name} (${ref})`,
        reason:
          "the catalog reports structured_output: false for this model, so native output_config.format is unsupported.",
        fallback: "emulated JSON instruction + client validation (no output_config.format is sent)",
      });
    }

    const catalogSpec = getModelFromCatalog("anthropic", modelId);
    const maxTokens =
      typeof options?.maxOutputTokens === "number" && options.maxOutputTokens > 0
        ? Math.floor(options.maxOutputTokens)
        : Math.min(catalogSpec?.maxOutputTokens ?? MAX_TOKENS_UNKNOWN_MODEL, MAX_TOKENS_CAP);

    const body: MessagesRequestBody = {
      model: modelId,
      max_tokens: maxTokens,
      messages: await fullHistoryMessages(context, modelId, { signal: options?.signal, fetch: options?.fetch }),
      ...(stream ? { stream: true } : {}),
    };
    if (system) body.system = system;
    const aTools = toAnthropicTools(tools);
    if (aTools) {
      body.tools = aTools;
      const choice = mapToolChoiceToAnthropic(options?.toolChoice, !NO_FORCED_TOOL_USE.has(modelId), ref);
      if (choice) body.tool_choice = choice;
    }
    if (thinking) body.thinking = thinking;
    const format = outputSpec && !outputEmulated ? mapOutputToAnthropic(outputSpec) : undefined;
    if (effort || format)
      body.output_config = { ...(effort ? { effort } : {}), ...(format ? { format: format.format } : {}) };
    if (serviceTier) body.service_tier = serviceTier;
    body.cache_control =
      cache === "1h"
        ? { type: "ephemeral", ttl: "1h" }
        : cache === "5m"
          ? { type: "ephemeral", ttl: "5m" }
          : { type: "ephemeral" };
    return body;
  }

  // The request headers: User-Agent and caller headers, the API version, JSON content type and the key; in: doFetch and stream, out: header record.
  private headersFor(options: ProviderRequestOptions | undefined, apiKey: string): Record<string, string> {
    const headers = buildSessionHeaders("anthropic", options?.headers, undefined); // no affinity headers: Anthropic caches by prefix
    setHeaderCaseInsensitive(headers, "Content-Type", "application/json");
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "anthropic-version")) {
      headers["anthropic-version"] = ANTHROPIC_VERSION;
    }
    if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "x-api-key", apiKey);
    return headers;
  }

  // Fetch options for one POST; in: doFetch and stream, out: RequestInit.
  private requestInit(
    body: MessagesRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    signal?: AbortSignal
  ): RequestInit {
    return { method: "POST", headers: this.headersFor(options, apiKey), body: JSON.stringify(body), signal };
  }

  // One HTTP call under the request timeout, returning status, headers and body text; in: generate, out: the raw reply.
  private async doFetch(
    url: string,
    body: MessagesRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<{ status: number; statusText: string; headers: Record<string, string>; text: string }> {
    const { signal: effective, cleanup } = combinedSignal(signal, timeoutFor(options));
    try {
      const res = await (options?.fetch ?? fetch)(url, this.requestInit(body, options, apiKey, effective));
      const text = await readTextCapped(res, CHAT_REPLY_LIMIT);
      return { status: res.status, statusText: res.statusText, headers: headersToRecord(res.headers), text };
    } finally {
      cleanup();
    }
  }

  // Throws a concise provider error (status, error type, request id, Retry-After, key hint) for a non-2xx reply; the monthly spend-cap 429 is never retried and 529 overloaded always is; in: generate and stream, out: nothing or a thrown error.
  private throwIfError(
    status: number,
    url: string,
    bodyText: string,
    modelId: string,
    headers?: Record<string, string>
  ): void {
    if (status >= 200 && status < 300) return;
    const { message: rawMessage, errorType, raw } = readErrorPayload(bodyText);
    const message = rawMessage.replace(/\s+/g, " ").trim(); // a gateway's HTML page must not break the one-line rule
    let details: string | undefined;
    let bodyRequestId: string | undefined;
    try {
      const parsed = JSON.parse(bodyText) as { error?: { details?: { error_code?: unknown } }; request_id?: unknown };
      if (typeof parsed.error?.details?.error_code === "string") details = parsed.error.details.error_code;
      if (typeof parsed.request_id === "string") bodyRequestId = parsed.request_id;
    } catch {
      // a non-JSON body (a proxy or CDN page) keeps the 300-character slice readErrorPayload made
    }
    const requestId = bodyRequestId ?? headers?.["request-id"];
    const hint =
      status === 401
        ? " Check ANTHROPIC_API_KEY (no quotes/spaces, correct provider), the base_urls.anthropic setting, and that the key is loaded (bun --env-file=.env.local)."
        : "";
    const fullMessage = `${message}${hint}${requestId ? ` (request_id ${requestId})` : ""}`;
    const err: Record<string, unknown> & Error = new Error(fullMessage) as Record<string, unknown> & Error;
    err["statusCode"] = status;
    err["status"] = status;
    err["responseBody"] = bodyText.slice(0, 500);
    err["url"] = url.split("?")[0];
    err["data"] = { error: { message: fullMessage } };
    if (details) err["code"] = details;
    if (errorType) err["errorType"] = errorType;
    if (raw) err["raw"] = raw;
    if (requestId) err["requestId"] = requestId;
    if (details === "enforced_spend_limit_reached") err["transient"] = false;
    else if (status === 529) err["transient"] = true;
    const retryAfterMs = parseRetryAfterMs(headers);
    if (retryAfterMs !== undefined) err["retryAfterMs"] = retryAfterMs;
    throw toConciseProviderError(err, "anthropic", modelId);
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
      throw new ConfigError("[Agent Accelerator] Missing Anthropic API key. Set ANTHROPIC_API_KEY or pass apiKey.");
    }
    assertModalitiesSupported(context, "anthropic", clean);
    const url = `${resolveBaseUrl(options)}/messages`;
    const sessionId = options?.sessionId;
    const body = await this.buildBody(
      clean,
      context,
      options,
      options?.tools as StandardToolDeclaration[] | undefined,
      false
    );
    const rawRequest = {
      url,
      method: "POST",
      headers: redactedHeaders({ ...this.headersFor(options, "[REDACTED]") }),
      body,
    };

    const doCall = async (): Promise<ProviderGenerateResult> => {
      const res = await this.doFetch(url, body, options, apiKey, options?.signal);
      this.throwIfError(res.status, url, res.text, clean, res.headers);
      return readWholeReply(res, clean, sessionId, startTime, rawRequest);
    };

    return withRetries(doCall, {
      ...retryOptionsFrom(options),
      signal: options?.signal,
      label: { providerId: "anthropic", modelId: clean },
    });
  }

  // Streaming turn over SSE: assembles text, thinking, tool calls and usage, retrying only before the first byte; in: streamAgentLoop, out: an AssistantMessageEventStream.
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
          throw new ConfigError("[Agent Accelerator] Missing Anthropic API key. Set ANTHROPIC_API_KEY or pass apiKey.");
        }
        assertModalitiesSupported(context, "anthropic", clean);
        const url = `${resolveBaseUrl(options)}/messages`;
        const sessionId = options?.sessionId;
        const body = await this.buildBody(
          clean,
          context,
          options,
          options?.tools as StandardToolDeclaration[] | undefined,
          true
        );
        const rawRequest = {
          url,
          method: "POST",
          headers: redactedHeaders({ ...this.headersFor(options, "[REDACTED]") }),
          body,
        };

        const opened = await openStreamResponse({
          fetchOnce: () =>
            withAbortTimer(linked, timeoutFor(options), () =>
              (options?.fetch ?? fetch)(url, this.requestInit(body, options, apiKey, linked.signal))
            ),
          onHttpError: (r, text) => this.throwIfError(r.status, url, text, clean, headersToRecord(r.headers)),
          noBodyError: () =>
            toConciseProviderError(new Error("Anthropic streaming response had no body"), "anthropic", clean),
          readPlainReply: (r, text) =>
            readWholeReply(
              { status: r.status, statusText: r.statusText, headers: headersToRecord(r.headers), text },
              clean,
              sessionId,
              startTime,
              rawRequest
            ),
          retry: retryOptionsFrom(options),
          signal: linked.signal,
          label: { providerId: "anthropic", modelId: clean },
        });
        if ("plain" in opened) {
          eventStream.push({ type: "start", raw: { request: rawRequest } } as never);
          endWithPlainReply(eventStream, opened.plain);
          return;
        }
        const res = opened;
        const responseHeaders = headersToRecord(res.headers);
        eventStream.push({ type: "start", raw: { request: rawRequest } } as never);

        // Blocks by index, assembled from the deltas.
        interface Live {
          type: string;
          text: string;
          thinking: string;
          signature: string;
          data: string;
          id: string;
          name: string;
          json: string;
          done: boolean;
        }
        const live = new Map<number, Live>();
        let text = "";
        let thinking = "";
        let usage: AnthropicUsage = {};
        let stopReason: string | null | undefined;
        let stopSequence: string | null | undefined;
        let responseId: string | undefined;
        let sawStop = false;
        let badFrames = 0;

        const handleMessage = (data: string): void => {
          if (!data) return;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(data) as Record<string, unknown>;
          } catch {
            badFrames += 1;
            return;
          }
          const type = msg["type"];
          if (type === "message_start") {
            const m = (msg["message"] as MessageObject) ?? {};
            if (m.id) responseId = m.id;
            usage = mergeUsage(usage, m.usage);
          } else if (type === "content_block_start") {
            const index = Number(msg["index"] ?? 0);
            const b = (msg["content_block"] as ResponseBlock) ?? { type: "unknown" };
            live.set(index, {
              type: b.type,
              text: b.type === "text" ? (b.text ?? "") : "",
              thinking: b.type === "thinking" ? (b.thinking ?? "") : "",
              signature: b.type === "thinking" ? (b.signature ?? "") : "",
              data: b.type === "redacted_thinking" ? (b.data ?? "") : "",
              id: b.id ?? "",
              name: b.name ?? "",
              json: "",
              done: false,
            });
          } else if (type === "content_block_delta") {
            const entry = live.get(Number(msg["index"] ?? 0));
            const delta = (msg["delta"] as Record<string, unknown>) ?? {};
            if (!entry) return;
            if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
              entry.text += delta["text"];
              text += delta["text"];
              eventStream.push({ type: "text_delta", delta: delta["text"], partialText: text });
            } else if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
              entry.thinking += delta["thinking"];
              if (delta["thinking"]) {
                thinking += delta["thinking"];
                eventStream.push({
                  type: "thinking_delta",
                  thinkingDelta: delta["thinking"],
                  partialThinking: thinking,
                });
              }
            } else if (delta["type"] === "signature_delta" && typeof delta["signature"] === "string") {
              entry.signature = delta["signature"];
            } else if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
              entry.json += delta["partial_json"];
            }
            // citations_delta and unknown delta types are ignored (never requested / forward compatible)
          } else if (type === "content_block_stop") {
            const entry = live.get(Number(msg["index"] ?? 0));
            if (entry) entry.done = true;
          } else if (type === "message_delta") {
            const delta = (msg["delta"] as { stop_reason?: string | null; stop_sequence?: string | null }) ?? {};
            if (delta.stop_reason !== undefined) stopReason = delta.stop_reason;
            if (delta.stop_sequence !== undefined) stopSequence = delta.stop_sequence;
            usage = mergeUsage(usage, msg["usage"] as AnthropicUsage | undefined);
            eventStream.push({ type: "usage", usage: mapUsage(usage) });
          } else if (type === "message_stop") {
            sawStop = true;
          } else if (type === "error") {
            const errObj = (msg["error"] as { type?: string; message?: string }) ?? {};
            const message =
              typeof errObj.message === "string" && errObj.message ? errObj.message : "Anthropic streaming error";
            const failure: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
            if (typeof errObj.type === "string") {
              failure["errorType"] = errObj.type;
              const status = ERROR_TYPE_STATUS[errObj.type];
              if (status !== undefined) {
                failure["statusCode"] = status;
                failure["transient"] = true;
              }
            }
            failure["url"] = url;
            throw toConciseProviderError(failure, "anthropic", clean);
          }
          // ping and unknown event types are ignored
        };

        await readSseData(res.body, linked, eventStream, handleMessage);

        const ordered = [...live.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
        const toolCalls: ToolCallRecord[] = [];
        const calls: Array<{ startArgs: string; deltaArgs: string }> = [];
        const blocks: ResponseBlock[] = [];
        for (const e of ordered) {
          if (e.type === "text") blocks.push({ type: "text", text: e.text });
          else if (e.type === "thinking")
            blocks.push({ type: "thinking", thinking: e.thinking, signature: e.signature });
          else if (e.type === "redacted_thinking") blocks.push({ type: "redacted_thinking", data: e.data });
          else if (e.type === "tool_use") {
            const args = parseStreamedToolArguments("", e.json);
            const record: ToolCallRecord = {
              id: e.id || newToolCallId("toolu"),
              name: e.name || "unknown",
              arguments: args,
              rawArguments: selectRawArguments("", e.json),
            };
            toolCalls.push(record);
            calls.push({ startArgs: "", deltaArgs: e.done ? e.json || "{}" : e.json });
            eventStream.push({ type: "tool_call_complete", toolCall: record });
            const input = JSON.parse(toolArgumentsJson(args)) as Record<string, unknown>; // a cut call is replayed as {} (never executed)
            blocks.push({ type: "tool_use", id: record.id, name: record.name, input });
          }
        }

        const hasTerminal = sawStop || stopReason !== undefined;
        noteProviderTurn(sessionId, "anthropic");
        // Anthropic ends every message with message_stop (no [DONE]): a stream without it, or with a cut tool call, is incomplete.
        const incomplete = incompleteStreamCheck({
          provider: "anthropic",
          modelId: clean,
          hasTerminal,
          empty: !hasTerminal,
          unfinishedCall: hasUnfinishedToolCall(calls, toolCalls),
        });
        if (incomplete) {
          eventStream.fail(incomplete);
          return;
        }
        let finishReason = mapStopReason(stopReason);
        if (toolCalls.length > 0) finishReason = toolTurnFinishReason(finishReason, toolCalls);
        const mapped = mapUsage(usage);
        const completed: MessageObject = {
          id: responseId,
          type: "message",
          role: "assistant",
          model: clean,
          content: blocks,
          stop_reason: stopReason ?? null,
          stop_sequence: stopSequence ?? null,
          usage,
        };
        const cleanThinking = thinking.replace(/\n{3,}/g, "\n\n").trim();
        const finalResponse = new AgentResponse({
          text,
          thinking: cleanThinking || undefined,
          thoughtSignature: undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: mapped,
          finishReason,
          responseId,
          model: clean,
          provider: "anthropic",
          raw: {
            request: rawRequest,
            response: {
              status: res.status,
              statusText: res.statusText,
              headers: responseHeaders,
              body: completed,
              badFrames,
            },
          },
          durationMs: Date.now() - startTime,
          providerSteps: stepsOf(blocks),
        });
        eventStream.push({ type: "done", delta: "", usage: mapped, finishReason, responseId });
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
