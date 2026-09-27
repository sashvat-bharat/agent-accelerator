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
 * Out of scope (never sent): background, conversation, previous_response_id
 * chaining, include, metadata, temperature/top_p, max_output_tokens,
 * truncation, safety_identifier, prompt_cache_options explicit breakpoints,
 * text.format structured output, built-in/MCP tools. Those remain
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
import type { ProviderContext, ContentPart } from "../types/message.ts";
import type { StandardToolDeclaration, ToolCallRecord } from "../types/tool.ts";
import type { TokenUsage } from "../types/core.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { SSEParser } from "../streaming/sse-parser.ts";
import { AgentResponse } from "../types/response.ts";
import { getApiKey, getEnv } from "../utils/env.ts";
import { buildSessionHeaders } from "../utils/headers.ts";
import { clampCacheKey } from "../utils/cache.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import { safeStringify } from "../utils/serialization.ts";
import { toConciseProviderError, assertModalitiesSupported, assertNoVideoPartsOnResponses } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { createGenericModelSpec } from "../models/catalog.ts";
import { getModelFromCatalog, getModelsForProvider } from "../models/catalog.ts";
import {
  mapThinkingLevelToOpenAI,
  mapServiceTierToOpenAI,
  applyCacheForOpenAI,
  mapToolChoiceToOpenAI,
  noteProviderTurn,
  parseStreamedToolArguments,
} from "../providers.ts";

// ---------------------------------------------------------------------------
// Responses wire shapes (most-important subset)
// ---------------------------------------------------------------------------

type ResponseContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string }
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
  store?: boolean;
  stream?: boolean;
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
  summary?: string[];
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
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Internal headers that must never leak onto native REST requests. */
const INTERNAL_HEADERS = new Set([
  "x-thought-signature-map",
  "x-cached-content-id",
  "x-multimodal-user-content",
]);

// ---------------------------------------------------------------------------
// Request building (canonical -> Responses)
// ---------------------------------------------------------------------------

function resolveBaseUrl(options?: ProviderRequestOptions): string {
  return (
    options?.baseUrl ||
    options?.env?.["OPENAI_BASE_URL"] ||
    options?.env?.["OPENAI_API_BASE"] ||
    getEnv("OPENAI_BASE_URL") ||
    getEnv("OPENAI_API_BASE") ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

function resolveApiKey(options?: ProviderRequestOptions): string | undefined {
  return options?.apiKey || getApiKey("openai", undefined, options?.env);
}

/** Strips ONLY the `openai/` prefix. Bare ids pass through untouched. */
function cleanModelId(model: string | ModelSpec): string {
  const rawId = typeof model === "string" ? model : model.id;
  return rawId.replace(/^openai\//i, "");
}

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

async function contentPartsToBlocks(parts: ContentPart[]): Promise<ResponseContentPart[]> {
  const blocks: ResponseContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "input_text", text: part.text });
    } else if (
      part.type === "image" ||
      part.type === "audio" ||
      part.type === "video" ||
      part.type === "file"
    ) {
      const raw = (part as { image?: unknown; audio?: unknown; video?: unknown; file?: unknown }).image ??
        (part as { audio?: unknown }).audio ??
        (part as { video?: unknown }).video ??
        (part as { file?: unknown }).file;
      // Remote http(s) URLs pass through directly (docs example:
      // `file_url: "https://...pdf"`). Fetch-and-inline would base64-blowup
      // (11MB mp3 → 11,926,995 chars > 1,048,576 `file_url` limit) and break
      // PDFs with "Failed to download file." Let OpenAI fetch instead.
      if (typeof raw === "string" && (raw.startsWith("http://") || raw.startsWith("https://"))) {
        if (part.type === "image") {
          blocks.push({ type: "input_image", image_url: raw });
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
        blocks.push({ type: "input_image", image_url: norm.dataUrl });
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

function resultToOutput(result: unknown): string {
  if (typeof result === "string") return result;
  return safeStringify(result);
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

  const items: ResponseInputItem[] = [];
  for (const m of context.messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      if (typeof m.content === "string") {
        if (m.content) items.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content }] });
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
          items.push({
            type: "function_call",
            id: part.id,
            call_id: part.callId || part.id,
            name: part.name,
            arguments: JSON.stringify(part.arguments || {}),
          });
        } else if (part.type === "text" && part.text) {
          texts.push(part.text);
        }
        // Prior-turn reasoning is NOT resent: reasoning items require
        // provider-minted ids that canonical history does not retain.
      }
      if (texts.length > 0) {
        items.push({ type: "message", role: "assistant", content: texts.map((t) => ({ type: "output_text", text: t })) });
      }
    } else if (m.role === "tool") {
      if (typeof m.content === "string") {
        const queue = (m.name && idsByName.get(m.name)) || [];
        items.push({
          type: "function_call_output",
          call_id: queue.shift() || "call_0",
          output: m.content,
        });
        continue;
      }
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content) {
        if (part.type === "tool_result") {
          items.push({
            type: "function_call_output",
            call_id: pairing.get(part.id) || part.id,
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

function mapUsage(raw?: ResponsesObject["usage"]): TokenUsage {
  const input = raw?.input_tokens ?? 0;
  const output = raw?.output_tokens ?? 0;
  // Canonical invariant: cache hits are a SUBSET of input.
  const cached = Math.min(raw?.input_tokens_details?.cached_tokens ?? 0, input);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: raw?.total_tokens ?? input + output,
    cachedTokens: cached,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    thinkingTokens: raw?.output_tokens_details?.reasoning_tokens ?? 0,
  };
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

function parseResponse(
  response: ResponsesObject,
  modelId: string,
  durationMs: number,
  raw: ProviderRawData
): ProviderGenerateResult {
  if (response.status === "failed") {
    const message =
      response.error && typeof response.error.message === "string" && response.error.message
        ? response.error.message
        : "OpenAI response failed";
    const failure: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
    if (response.error?.code !== undefined) failure["code"] = response.error.code;
    if (typeof response.error?.type === "string") failure["errorType"] = response.error.type;
    throw toConciseProviderError(failure, "openai", modelId);
  }

  let text = "";
  const thinkingParts: string[] = [];
  const toolCalls: ToolCallRecord[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const block of item.content ?? []) {
        if (block.type === "output_text" && block.text) text += block.text;
      }
    } else if (item.type === "reasoning") {
      for (const block of item.content ?? []) {
        if ((block.type === "reasoning_text" || block.type === "text") && block.text) {
          thinkingParts.push(block.text);
        }
      }
      for (const s of item.summary ?? []) {
        if (typeof s === "string" && s) thinkingParts.push(s);
      }
    } else if (item.type === "function_call") {
      const args = parseArguments(item.arguments);
      toolCalls.push({
        id: item.id || item.call_id || `call_${Math.random().toString(36).slice(2, 9)}`,
        callId: item.call_id,
        name: item.name || "unknown",
        arguments: args,
        rawArguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      });
    }
  }

  return {
    text,
    // Trim/collapse reasoning assembly (provider summaries can trail with
    // blank lines). Prior-turn reasoning is never resent by this adapter, so
    // this is fully cache-safe.
    thinking: normalizeThinkingParts(thinkingParts),
    thoughtSignature: undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: mapUsage(response.usage),
    finishReason: toolCalls.length > 0 ? "tool_calls" : response.status === "incomplete" ? "length" : "stop",
    responseId: response.id,
    model: modelId,
    provider: "openai",
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
    const err = (first as { error?: { message?: string; code?: string | number; type?: string } })?.error;
    if (err && typeof err.message === "string") {
      return {
        message: err.message,
        code: err.code,
        ...(typeof err.type === "string" ? { errorType: err.type } : {}),
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
  ): Promise<ResponsesRequestBody> {
    const { effort } = mapThinkingLevelToOpenAI(options?.thinking?.level);
    const serviceTier = mapServiceTierToOpenAI(options?.serviceTier);
    applyCacheForOpenAI(options?.cache, `openai/${modelId}`);

    const body: ResponsesRequestBody = {
      model: modelId,
      input: await fullHistoryInput(context),
      // Stateless by design: the server defaults store:true, so opt out
      // explicitly. Full history is always sent, so no chaining is needed
      // and provider switching stays trivial.
      store: false,
      ...(stream ? { stream: true } : {}),
    };
    if (context.systemPrompt) body.instructions = context.systemPrompt;
    const aiTools = toOpenAITools(tools);
    if (aiTools) body.tools = aiTools;
    const toolChoice = mapToolChoiceToOpenAI(
      options?.toolChoice as "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined
    );
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    if (effort) body.reasoning = { effort };
    if (serviceTier) body.service_tier = serviceTier;
    // Cache affinity: prompt_cache_key replaces the legacy `user` field.
    // (prompt_cache_options explicit breakpoints are out of scope.)
    // OpenAI enforces max 64 chars — clamp defensively so child session ids
    // (`parent-sub-tag-rand`) and user-supplied long ids never 400. Headers
    // are clamped the same way via buildSessionHeaders, keeping affinity
    // consistent.
    if (sessionId) {
      const cacheKey = clampCacheKey(sessionId);
      if (cacheKey) body.prompt_cache_key = cacheKey;
    }
    // Stateless API use: previous_response_id / background / conversation are
    // NEVER sent (server state would break provider-agnostic switching).
    return body;
  }

  private requestInit(
    body: ResponsesRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    sessionId: string | undefined,
    signal?: AbortSignal
  ): RequestInit {
    const headers: Record<string, string> = buildSessionHeaders(
      "openai",
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
    body: ResponsesRequestBody,
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
    throw toConciseProviderError(err, "openai", modelId);
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
    const sessionId = options?.sessionId || options?.cache?.sessionId;
    const tools = options?.tools as StandardToolDeclaration[] | undefined;
    const body = await this.buildBody(clean, context, options, sessionId, tools, false);

    // Audit trail: record the actual wire headers (session affinity included),
    // redacted. Previously only Content-Type + custom headers were stored,
    // hiding the x-session-id affinity actually sent.
    const auditHeadersRaw: Record<string, string> = {
      ...buildSessionHeaders("openai", options?.cache, options?.headers, sessionId),
      "Content-Type": "application/json",
      Authorization: "[REDACTED]",
    };
    for (const k of Object.keys(auditHeadersRaw)) {
      if (INTERNAL_HEADERS.has(k.toLowerCase())) delete auditHeadersRaw[k];
    }
    const auditHeaders = redactedHeaders(auditHeadersRaw);
    const rawRequest = {
      url,
      method: "POST",
      headers: auditHeaders,
      body,
    };

    const doCall = async (): Promise<ProviderGenerateResult> => {
      const res = await this.doFetch(url, body, options, apiKey, sessionId, options?.signal);
      this.throwIfError(res.status, url, res.text, clean);
      let response: ResponsesObject;
      try {
        response = JSON.parse(res.text) as ResponsesObject;
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
      // Stateless turns never establish chains, but the session store still
      // records the turn so other providers' switch detection keeps working.
      noteProviderTurn(sessionId, "openai");
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
        label: { providerId: "openai", modelId: clean },
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
            "[Agent Accelerator] Missing OpenAI API key. Set OPENAI_API_KEY (or OPENAI_BASE_API_KEY) or pass apiKey."
          );
        }
        assertModalitiesSupported(context, "openai", clean);
    assertNoVideoPartsOnResponses(context, "openai", clean);
        const baseUrl = resolveBaseUrl(options);
        const url = `${baseUrl}/responses`;
        const sessionId = options?.sessionId || options?.cache?.sessionId;
        const tools = options?.tools as StandardToolDeclaration[] | undefined;
        const body = await this.buildBody(clean, context, options, sessionId, tools, true);

        const streamAuditRaw: Record<string, string> = {
          ...buildSessionHeaders("openai", options?.cache, options?.headers, sessionId),
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
          throw toConciseProviderError(new Error("OpenAI streaming response had no body"), "openai", clean);
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
        // Tool calls keyed by output_index: { itemId, callId, name, startArgs, deltaArgs }.
        const calls = new Map<number, { itemId: string; callId: string; name: string; startArgs: string; deltaArgs: string }>();
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
          const type = msg["type"] as string;
          if (!type) return;
          if (type === "error") {
            const errObj = (msg["error"] as { message?: string; code?: string | number; type?: string }) ?? {};
            const message =
              typeof errObj.message === "string" && errObj.message ? errObj.message : "OpenAI streaming error";
            const failure: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
            if (errObj.code !== undefined) failure["code"] = errObj.code;
            if (typeof errObj.type === "string") failure["errorType"] = errObj.type;
            failure["url"] = url;
            throw toConciseProviderError(failure, "openai", clean);
          }
          if (type === "response.created" || type === "response.in_progress") {
            const response = (msg["response"] as { id?: string }) ?? {};
            if (response.id) responseId = response.id;
          } else if (type === "response.output_text.delta" && typeof msg["delta"] === "string") {
            text += msg["delta"] as string;
            eventStream.push({ type: "text_delta", delta: msg["delta"] as string, partialText: text });
          } else if (
            (type === "response.reasoning_text.delta" || type === "response.reasoning.delta") &&
            typeof msg["delta"] === "string"
          ) {
            thinking += msg["delta"] as string;
            eventStream.push({ type: "thinking_delta", thinkingDelta: msg["delta"] as string, partialThinking: thinking });
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
          } else if (type === "response.completed" || type === "response.failed" || type === "response.done") {
            const response = (msg["response"] as ResponsesObject) ?? {};
            completedBody = msg["response"];
            if (response.id) responseId = response.id;
            if (response.usage) usage = mapUsage(response.usage);
            if (type === "response.failed" || response.status === "failed") {
              const message =
                (response.error && typeof response.error.message === "string" && response.error.message) ||
                "OpenAI response failed";
              const failure: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
              if (response.error?.code !== undefined) failure["code"] = response.error.code;
              if (typeof response.error?.type === "string") failure["errorType"] = response.error.type;
              throw toConciseProviderError(failure, "openai", clean);
            }
            // Non-streaming maps `incomplete` → `length` (max tokens). Streaming
            // must do the same — otherwise truncated turns misreport `stop`.
            if (response.status === "incomplete") finishReason = "length";
            // Merge any full tool items delivered at completion (authoritative
            // when present) so nothing depends solely on delta assembly.
            for (const item of response.output ?? []) {
              if (item.type !== "function_call") continue;
              const key = [...calls.entries()].find(
                ([, c]) => (c.itemId && c.itemId === item.id) || (c.callId && c.callId === item.call_id)
              )?.[0];
              if (key !== undefined && typeof item.arguments === "string") {
                const entry = calls.get(key)!;
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
                if (typeof s === "string" && s) parts.push(s);
              }
              for (const p of parts) {
                if (p && !thinking.includes(p)) {
                  thinking += (thinking ? "\n" : "") + p;
                }
              }
            }
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
            id: c.itemId || c.callId || `call_${Math.random().toString(36).slice(2, 9)}`,
            callId: c.callId || undefined,
            name: c.name,
            arguments: args,
            rawArguments: c.startArgs + c.deltaArgs,
          };
          toolCalls.push(record);
          eventStream.push({ type: "tool_call_complete", toolCall: record });
        }

        noteProviderTurn(sessionId, "openai");
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
          provider: "openai",
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
