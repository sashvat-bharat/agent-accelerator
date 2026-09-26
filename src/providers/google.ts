/**
 * Google Interactions API provider (`POST /v1beta/interactions`).
 *
 * All Google-specific HTTP, endpoints, headers, auth, request construction,
 * response/SSE parsing, and wire transformations live HERE — never in the
 * canonical layer (`src/providers.ts`).
 *
 * Wire contract: `references/testings/CONTRACT.md` (docs + raw captures).
 * Capability matrix: `references/testings/CAPABILITY-MATRIX.md`.
 *
 * Notes:
 * - Interaction/tool ids are provider-generated (`v1_...`/`call_...`) and
 *   echoed verbatim (`call_id` in `function_result` steps). The
 *   `call_${random}` fallback in parsers is a local canonical correlation id
 *   only (used when the wire omits an id); it is never sent to the provider.
 * - Stateful chaining via `previous_interaction_id` keyed by session; falls
 *   back to stateless full-history (`store: false`) when the session mixed
 *   providers, keeping the canonical conversation provider-agnostic.
 * - Unlike the legacy transport path, Gemini 2.x is NOT rejected here —
 *   the Interactions API documents 2.5 support; the catalog still governs
 *   thinking validation upstream.
 */
import type {
  Provider,
  ProviderId,
  ModelSpec,
  ProviderRequestOptions,
  ProviderGenerateResult,
  ProviderRawData,
} from "../types/model.ts";
import type { ProviderContext, Message, ContentPart } from "../types/message.ts";
import type { StandardToolDeclaration, ToolCallRecord } from "../types/tool.ts";
import type { TokenUsage } from "../types/core.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { SSEParser } from "../streaming/sse-parser.ts";
import { AgentResponse } from "../types/response.ts";
import { getApiKey, getEnv } from "../utils/env.ts";
import { normalizeMediaInput } from "../utils/media.ts";
import { safeStringify } from "../utils/serialization.ts";
import { stripSchemaForGoogle } from "../tools/schema.ts";
import { toConciseProviderError, assertModalitiesSupported } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { createGenericModelSpec } from "../models/catalog.ts";
import { getModelFromCatalog, getModelsForProvider } from "../models/catalog.ts";
import {
  mapThinkingLevelToGoogle,
  mapServiceTierToGoogle,
  applyCacheForGoogle,
  normalizeToolChoice,
  lastProviderFor,
  noteProviderTurn,
  parseStreamedToolArguments,
} from "../providers.ts";

// ---------------------------------------------------------------------------
// Interactions wire shapes (subset used by this adapter)
// ---------------------------------------------------------------------------

type InteractionContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mime_type: string; data?: string; uri?: string }
  | { type: "audio"; mime_type: string; data?: string; uri?: string }
  | { type: "video"; mime_type: string; data?: string; uri?: string }
  | { type: "document"; mime_type: string; data?: string; uri?: string };

type InteractionInputStep =
  | { type: "user_input"; content: string | InteractionContentBlock[] }
  | { type: "thought"; signature: string; summary?: Array<{ type: string; text?: string }> }
  | { type: "function_call"; id: string; name: string; arguments: Record<string, unknown> }
  | {
      type: "function_result";
      name: string;
      call_id: string;
      result: InteractionContentBlock[];
    }
  | { type: string; [k: string]: unknown };

interface InteractionRequestBody {
  model: string;
  input: string | InteractionContentBlock[] | InteractionInputStep[];
  system_instruction?: string;
  tools?: Array<Record<string, unknown>>;
  generation_config?: Record<string, unknown>;
  response_format?: Record<string, unknown>;
  service_tier?: string;
  store?: boolean;
  previous_interaction_id?: string;
  stream?: boolean;
}

interface InteractionStep {
  type: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  signature?: string;
  summary?: Array<{ type?: string; text?: string }>;
  content?: Array<{ type?: string; text?: string }>;
  call_id?: string;
}

interface InteractionObject {
  id?: string;
  object?: string;
  model?: string;
  status?: string;
  created?: string;
  updated?: string;
  service_tier?: string;
  steps?: InteractionStep[];
  usage?: {
    total_tokens?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_cached_tokens?: number;
    total_thought_tokens?: number;
    total_tool_use_tokens?: number;
    input_tokens_by_modality?: Array<{ modality?: string; tokens?: number }>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Internal headers that must never leak onto Google REST requests. */
const INTERNAL_HEADERS = new Set([
  "x-thought-signature-map",
  "x-cached-content-id",
  "x-multimodal-user-content",
]);

/** Per-session interaction chaining (provider-generated ids only). */
interface ChainEntry {
  interactionId: string;
  model: string;
}
const interactionChains = new Map<string, ChainEntry>();

function chainFor(sessionId: string | undefined): ChainEntry | undefined {
  if (!sessionId) return undefined;
  return interactionChains.get(sessionId);
}

function setChain(sessionId: string | undefined, entry: ChainEntry): void {
  if (!sessionId) return;
  interactionChains.set(sessionId, entry);
}

/** Clears chained interaction state (mainly for tests). */
export function clearInteractionChains(sessionId?: string): void {
  if (sessionId) interactionChains.delete(sessionId);
  else interactionChains.clear();
}

// ---------------------------------------------------------------------------
// Request building (canonical -> Interactions)
// ---------------------------------------------------------------------------

function resolveBaseUrl(options?: ProviderRequestOptions): string {
  return (
    options?.baseUrl ||
    options?.env?.["GOOGLE_BASE_URL"] ||
    getEnv("GOOGLE_BASE_URL") ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

function resolveApiKey(options?: ProviderRequestOptions): string | undefined {
  return options?.apiKey || getApiKey("google", undefined, options?.env);
}

function cleanModelId(model: string | ModelSpec): string {
  const rawId = typeof model === "string" ? model : model.id;
  return rawId.replace(/^(google\/|gemini\/|models\/)/i, "");
}

function toGoogleTools(tools?: StandardToolDeclaration[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: stripSchemaForGoogle(
      (t.parameters || { type: "object", properties: {} }) as Record<string, unknown>
    ),
  }));
}

function toGoogleToolChoice(
  choice: ProviderRequestOptions["toolChoice"],
  toolNames: string[]
): Record<string, unknown> | undefined {
  const norm = normalizeToolChoice(choice, toolNames);
  if (!norm) return undefined;
  if (norm.mode === "none") return { allowed_tools: { mode: "none" } };
  if (norm.tools && norm.tools.length > 0) {
    return { allowed_tools: { mode: norm.mode, tools: norm.tools } };
  }
  return { allowed_tools: { mode: norm.mode } };
}

function mediaBlockType(partType: string): "image" | "audio" | "video" | "document" {
  if (partType === "image" || partType === "audio" || partType === "video") return partType;
  // Canonical `file` parts are PDFs/documents. The guides reference document
  // processing with the same content-block pattern; the wire type is
  // `document`. If the server ever rejects it, the concise error surfaces it.
  return "document";
}

async function contentPartsToBlocks(parts: ContentPart[]): Promise<InteractionContentBlock[]> {
  const blocks: InteractionContentBlock[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text });
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
      const norm = await normalizeMediaInput(
        raw as string | Uint8Array | ArrayBuffer,
        (part as { mimeType?: string }).mimeType
      );
      blocks.push({
        type: mediaBlockType(part.type),
        mime_type: norm.mimeType,
        data: norm.base64Data,
      } as InteractionContentBlock);
    }
  }
  return blocks;
}

function resultToText(result: unknown): string {
  if (typeof result === "string") return result;
  return safeStringify(result);
}

/** Latest-turn input for stateful chaining (server already holds history). */
async function latestTurnInput(context: ProviderContext): Promise<string | InteractionContentBlock[] | InteractionInputStep[]> {
  const messages = context.messages;
  // Trailing tool messages -> function_result steps.
  const trailingTool: Message[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool") trailingTool.unshift(m);
    else break;
  }
  if (trailingTool.length > 0) {
    const steps: InteractionInputStep[] = [];
    for (const m of trailingTool) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content) {
        if (part.type === "tool_result") {
          steps.push({
            type: "function_result",
            name: part.name,
            call_id: part.id,
            result: [{ type: "text", text: resultToText(part.result) }],
          });
        }
      }
    }
    return steps;
  }
  const last = messages[messages.length - 1];
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  const blocks = await contentPartsToBlocks(last.content);
  if (blocks.length === 1 && blocks[0]!.type === "text") {
    return (blocks[0] as { type: "text"; text: string }).text;
  }
  return blocks;
}

/** Full-history Steps for stateless (provider-switch) turns. */
async function fullHistorySteps(context: ProviderContext): Promise<InteractionInputStep[]> {
  const steps: InteractionInputStep[] = [];
  for (const m of context.messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      if (typeof m.content === "string") {
        steps.push({ type: "user_input", content: [{ type: "text", text: m.content }] });
      } else {
        const blocks = await contentPartsToBlocks(m.content);
        if (blocks.length > 0) steps.push({ type: "user_input", content: blocks });
      }
    } else if (m.role === "assistant") {
      if (typeof m.content === "string") {
        if (m.content) {
          steps.push({
            type: "model_output",
            content: [{ type: "text", text: m.content }],
          } as InteractionInputStep);
        }
        continue;
      }
      const texts: string[] = [];
      for (const part of m.content) {
        if (part.type === "thinking" && part.thinking) {
          steps.push({
            type: "thought",
            signature: part.thoughtSignature || m.thoughtSignature || "",
            summary: [{ type: "text", text: part.thinking }],
          });
        } else if (part.type === "tool_call") {
          steps.push({
            type: "function_call",
            id: part.id,
            name: part.name,
            arguments: part.arguments || {},
          });
        } else if (part.type === "text" && part.text) {
          texts.push(part.text);
        }
      }
      if (texts.length > 0) {
        steps.push({
          type: "model_output",
          content: texts.map((t) => ({ type: "text", text: t })),
        } as InteractionInputStep);
      } else if (m.thoughtSignature && !steps.some((s) => s.type === "thought")) {
        // Preserve a signature-only thought so stateless chaining keeps
        // reasoning continuity even when no summary text was retained.
        steps.push({ type: "thought", signature: m.thoughtSignature });
      }
    } else if (m.role === "tool") {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content) {
        if (part.type === "tool_result") {
          steps.push({
            type: "function_result",
            name: part.name,
            call_id: part.id,
            result: [{ type: "text", text: resultToText(part.result) }],
          });
        }
      }
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Response mapping (Interactions -> canonical)
// ---------------------------------------------------------------------------

function mapUsage(raw?: InteractionObject["usage"]): TokenUsage {
  const input = raw?.total_input_tokens ?? 0;
  const output = raw?.total_output_tokens ?? 0;
  // Canonical invariant: cached hits are a SUBSET of input. Google usually
  // honors this, but long chained runs have been observed reporting
  // total_cached_tokens > total_input_tokens (which yields >100% hit rates
  // and negative non-cached costs downstream). Clamp at the boundary.
  const cached = Math.min(raw?.total_cached_tokens ?? 0, input);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: raw?.total_tokens ?? input + output,
    cachedTokens: cached,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    thinkingTokens: raw?.total_thought_tokens ?? 0,
  };
}

function mapFinishReason(status?: string): string {
  if (status === "requires_action") return "tool_calls";
  if (status === "incomplete") return "length";
  return "stop";
}

function parseInteraction(
  interaction: InteractionObject,
  modelId: string,
  durationMs: number,
  raw: ProviderRawData
): ProviderGenerateResult {
  let text = "";
  const thinkingParts: string[] = [];
  let thoughtSignature: string | undefined;
  const toolCalls: ToolCallRecord[] = [];

  for (const step of interaction.steps ?? []) {
    if (step.type === "thought") {
      if (step.signature && !thoughtSignature) thoughtSignature = step.signature;
      const summary = (step.summary ?? [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text as string)
        .join("");
      // Provider summaries routinely trail with blank lines (observed
      // `"...\n\n\n"`). Trim per-step and drop empties so joined thinking has
      // no edge-tripling. Stateful turns resend nothing (server holds
      // history), so this is cache-safe; stateless resends stay consistent.
      const cleanSummary = summary.replace(/\n{3,}/g, "\n\n").trim();
      if (cleanSummary) thinkingParts.push(cleanSummary);
    } else if (step.type === "model_output") {
      for (const block of step.content ?? []) {
        if (block.type === "text" && block.text) text += block.text;
      }
    } else if (step.type === "function_call") {
      const args =
        step.arguments && typeof step.arguments === "object" ? step.arguments : { raw: step.arguments };
      toolCalls.push({
        id: step.id || `call_${Math.random().toString(36).slice(2, 9)}`,
        name: step.name || "unknown",
        arguments: args as Record<string, unknown>,
        rawArguments: JSON.stringify(args),
      });
    }
  }

  return {
    text,
    thinking: thinkingParts.length > 0 ? thinkingParts.join("\n") : undefined,
    thoughtSignature,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: mapUsage(interaction.usage),
    finishReason: mapFinishReason(interaction.status),
    responseId: interaction.id,
    model: modelId,
    provider: "google",
    raw,
    durationMs,
  };
}

function redactedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k.toLowerCase() === "x-goog-api-key" ? "[REDACTED]" : v;
  }
  return out;
}

function readErrorPayload(bodyText: string): { message: string; code?: string | number } {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const err = (first as { error?: { message?: string; code?: string | number; status?: string } })?.error;
    if (err && typeof err.message === "string") {
      return { message: err.message, code: err.code ?? err.status };
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
 * Google provider implemented directly on the Interactions REST API
 * (`POST {baseUrl}/interactions`, streaming via `?alt=sse`).
 */
export class GoogleInteractionsProvider implements Provider {
  readonly id: ProviderId = "google";
  readonly name = "Google Interactions";

  /** Live catalog view: a constructor snapshot would go stale after refresh. */
  get models(): ModelSpec[] {
    return getModelsForProvider("google");
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

  private buildBody(
    modelId: string,
    context: ProviderContext,
    options: ProviderRequestOptions | undefined,
    sessionId: string | undefined,
    tools: StandardToolDeclaration[] | undefined,
    stream: boolean
  ): Promise<InteractionRequestBody> {
    return (async () => {
      const { thinkingLevel } = mapThinkingLevelToGoogle(options?.thinking?.level);
      const serviceTier = mapServiceTierToGoogle(options?.serviceTier);
      applyCacheForGoogle(options?.cache, `google/${modelId}`);

      const toolNames = (tools ?? []).map((t) => t.name);
      const toolChoice = toGoogleToolChoice(options?.toolChoice, toolNames);

      const generationConfig: Record<string, unknown> = {};
      if (thinkingLevel) generationConfig["thinking_level"] = thinkingLevel;
      // Summaries surface reasoning as `thought.summary` / deltas; without it
      // only signatures return and canonical `thinking` would always be empty.
      // Enabled whenever thinking is active — including the default/dynamic
      // case where no explicit level is sent — and off only when disabled.
      const thinkingActive =
        options?.thinking?.enabled !== false && (options?.thinking?.level ?? "dynamic") !== "none";
      if (thinkingActive) generationConfig["thinking_summaries"] = "auto";
      if (toolChoice) generationConfig["tool_choice"] = toolChoice;

      const body: InteractionRequestBody = {
        model: modelId,
        input: "",
        ...(stream ? { stream: true } : {}),
      };
      if (context.systemPrompt) body.system_instruction = context.systemPrompt;
      const googleTools = toGoogleTools(tools);
      if (googleTools) body.tools = googleTools;
      if (Object.keys(generationConfig).length > 0) body.generation_config = generationConfig;
      if (serviceTier) body.service_tier = serviceTier;

      const prevProvider = lastProviderFor(sessionId);
      const switched = !!prevProvider && prevProvider !== "google";
      const chain = chainFor(sessionId);
      // Interaction ids are model-scoped server-side: chaining a 2.5 id into
      // a 3.5 request 400s, so a same-provider model switch resumes stateless.
      const continuing = !!chain && !switched && chain.model === modelId && context.messages.length > 1;

      if (switched) {
        // Cross-provider turn: the Google server never saw the other
        // provider's turns, so send the full canonical history explicitly and
        // statelessly, then resume chaining fresh on the next turn.
        body.input = await fullHistorySteps(context);
        body.store = false;
      } else if (continuing) {
        body.input = await latestTurnInput(context);
        body.previous_interaction_id = chain!.interactionId;
      } else if (context.messages.length > 1) {
        // No chain but multi-message history (restored session after a
        // restart, or the turn right after a provider switch): send the full
        // history once with default store so the response establishes a fresh
        // chain and the next turn resumes stateful chaining.
        body.input = await fullHistorySteps(context);
      } else {
        body.input = await latestTurnInput(context);
      }
      return body;
    })();
  }

  private requestInit(
    body: InteractionRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    signal?: AbortSignal
  ): RequestInit {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    for (const [k, v] of Object.entries(options?.headers ?? {})) {
      if (!INTERNAL_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    headers["x-goog-api-key"] = apiKey;
    return { method: "POST", headers, body: JSON.stringify(body), signal };
  }

  private async doFetch(
    url: string,
    body: InteractionRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<{ status: number; statusText: string; headers: Record<string, string>; text: string }> {
    const res = await fetch(url, this.requestInit(body, options, apiKey, signal));
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, statusText: res.statusText, headers, text };
  }

  private throwIfError(
    status: number,
    statusText: string,
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
    throw toConciseProviderError(err, "google", modelId);
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
        "[Agent Accelerator] Missing Google API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) or pass apiKey."
      );
    }
    // Fail fast before any network call when the catalog knows the model
    // lacks the requested modality (clear one-liner instead of a provider 400).
    // Unknown models skip the guard; the provider verdict surfaces concisely.
    assertModalitiesSupported(context, "google", clean);
    const baseUrl = resolveBaseUrl(options);
    const url = `${baseUrl}/interactions`;
    const sessionId = options?.sessionId || options?.cache?.sessionId;
    const tools = options?.tools as StandardToolDeclaration[] | undefined;
    const body = await this.buildBody(clean, context, options, sessionId, tools, false);

    const rawRequest = {
      url,
      method: "POST",
      headers: redactedHeaders({
        "Content-Type": "application/json",
        ...Object.fromEntries(
          Object.entries(options?.headers ?? {}).filter(([k]) => !INTERNAL_HEADERS.has(k.toLowerCase()))
        ),
        "x-goog-api-key": "[REDACTED]",
      }),
      body,
    };

    const doCall = async (): Promise<ProviderGenerateResult> => {
      const res = await this.doFetch(url, body, options, apiKey, options?.signal);
      this.throwIfError(res.status, res.statusText, url, res.text, clean);
      let interaction: InteractionObject;
      try {
        interaction = JSON.parse(res.text) as InteractionObject;
      } catch {
        throw toConciseProviderError(
          Object.assign(new Error("Invalid JSON response from Google Interactions API"), {
            statusCode: res.status,
            responseBody: res.text.slice(0, 500),
            url,
          }),
          "google",
          clean
        );
      }
      if (interaction.id && sessionId && body.store !== false) {
        setChain(sessionId, { interactionId: interaction.id, model: clean });
      } else if (body.store === false && sessionId) {
        interactionChains.delete(sessionId);
      }
      noteProviderTurn(sessionId, "google");
      return parseInteraction(
        interaction,
        clean,
        Date.now() - startTime,
        { request: rawRequest, response: { status: res.status, statusText: res.statusText, headers: res.headers, body: interaction } }
      );
    };

    try {
      return await withRetries(doCall, {
        maxRetries: options?.maxRetries,
        maxRetryDelayMs: options?.maxRetryDelayMs,
        signal: options?.signal,
        label: { providerId: "google", modelId: clean },
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
            "[Agent Accelerator] Missing Google API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) or pass apiKey."
          );
        }
        assertModalitiesSupported(context, "google", clean);
        const baseUrl = resolveBaseUrl(options);
        const url = `${baseUrl}/interactions?alt=sse`;
        const sessionId = options?.sessionId || options?.cache?.sessionId;
        const tools = options?.tools as StandardToolDeclaration[] | undefined;
        const body = await this.buildBody(clean, context, options, sessionId, tools, true);

        // Audit trail mirrors generate (custom headers included); the
        // Interactions API sends no session-affinity headers (implicit
        // caching + chaining instead), so none are recorded here either.
        const rawRequest = {
          url: url.split("?")[0]!,
          method: "POST",
          headers: redactedHeaders({
            "Content-Type": "application/json",
            ...Object.fromEntries(
              Object.entries(options?.headers ?? {}).filter(([k]) => !INTERNAL_HEADERS.has(k.toLowerCase()))
            ),
            "x-goog-api-key": "[REDACTED]",
          }),
          body,
        };

        const res = await fetch(url, this.requestInit(body, options, apiKey, linked.signal));
        if (!res.ok || !res.body) {
          const text = !res.ok ? await res.text().catch(() => "") : "";
          if (!res.ok) this.throwIfError(res.status, res.statusText, url, text, clean);
          throw toConciseProviderError(new Error("Google streaming response had no body"), "google", clean);
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
        let signature: string | undefined;
        const calls = new Map<number, { id: string; name: string; startArgs: string; deltaArgs: string }>();
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

        const handleMessage = (event: string | undefined, data: string): void => {
          if (!data || data === "[DONE]") return;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(data) as Record<string, unknown>;
          } catch {
            return;
          }
          const type = (msg["event_type"] as string) || event;
          if (type === "error") {
            // SSE error event (e.g. rate_limit_exceeded mid-stream). Must
            // surface — silently ending with empty text + zero usage hides it.
            const errObj = (msg["error"] as { message?: string; code?: string | number }) ?? {};
            const message =
              typeof errObj.message === "string" && errObj.message ? errObj.message : "Google streaming error";
            const failure: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
            if (errObj.code !== undefined) failure["code"] = errObj.code;
            failure["url"] = url.split("?")[0];
            throw toConciseProviderError(failure, "google", clean);
          }
          if (type === "interaction.created") {
            const interaction = msg["interaction"] as { id?: string } | undefined;
            if (interaction?.id) responseId = interaction.id;
          } else if (type === "step.delta") {
            const index = (msg["index"] as number) ?? 0;
            const delta = (msg["delta"] as Record<string, unknown>) ?? {};
            const dType = delta["type"] as string;
            if (dType === "text" && typeof delta["text"] === "string") {
              text += delta["text"] as string;
              eventStream.push({ type: "text_delta", delta: delta["text"] as string, partialText: text });
            } else if (dType === "thought_summary") {
              const content = delta["content"] as { type?: string; text?: string } | undefined;
              const t = content?.text ?? (typeof delta["text"] === "string" ? (delta["text"] as string) : "");
              if (t) {
                thinking += t;
                eventStream.push({ type: "thinking_delta", thinkingDelta: t, partialThinking: thinking });
              }
            } else if (dType === "thought_signature" && typeof delta["signature"] === "string") {
              // Wire truth: signature arrives as its own delta (no text event).
              if (!signature) signature = delta["signature"] as string;
            } else if (dType === "arguments" || dType === "arguments_delta") {
              // Wire truth is `arguments`; prose says `partial_arguments` — accept both.
              // Deltas accumulate separately from step.start (see
              // parseStreamedToolArguments): start may be `{}` with the full
              // JSON in one delta, or a genuine first partial.
              const chunk =
                (delta["arguments"] as string) ?? (delta["partial_arguments"] as string) ?? "";
              const entry = calls.get(index);
              if (entry && typeof chunk === "string") entry.deltaArgs += chunk;
            }
          } else if (type === "step.start") {
            const index = (msg["index"] as number) ?? 0;
            const step = (msg["step"] as Record<string, unknown>) ?? {};
            if (step["type"] === "function_call") {
              const args = step["arguments"];
              const startArgs = typeof args === "string" ? args : args ? JSON.stringify(args) : "";
              calls.set(index, {
                id: (step["id"] as string) || `call_${Math.random().toString(36).slice(2, 9)}`,
                name: (step["name"] as string) || "unknown",
                startArgs,
                deltaArgs: "",
              });
            }
          } else if (type === "interaction.completed") {
            const interaction = (msg["interaction"] as InteractionObject) ?? {};
            completedBody = msg["interaction"];
            if (interaction.id) responseId = interaction.id;
            if (interaction.usage) usage = mapUsage(interaction.usage);
            finishReason = mapFinishReason(interaction.status);
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
          for (const m of parser.feed(chunk)) handleMessage(m.event, m.data);
        }
        for (const m of parser.flush()) handleMessage(m.event, m.data);
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
            id: c.id,
            name: c.name,
            arguments: args,
            rawArguments: c.startArgs + c.deltaArgs,
          };
          toolCalls.push(record);
          eventStream.push({ type: "tool_call_complete", toolCall: record });
        }

        if (sessionId) {
          if (responseId && body.store !== false) setChain(sessionId, { interactionId: responseId, model: clean });
          else if (body.store === false) interactionChains.delete(sessionId);
        }
        noteProviderTurn(sessionId, "google");

        // Trim provider trailing blank lines from finalized thinking (live
        // deltas already emitted raw; display collapse happens in the
        // wrapThinking presentation layer). Stateful bodies unaffected.
        const cleanThinking = thinking.replace(/\n{3,}/g, "\n\n").trim();
        const finalResponse = new AgentResponse({
          text,
          thinking: cleanThinking || undefined,
          thoughtSignature: signature,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage,
          finishReason,
          responseId,
          model: clean,
          provider: "google",
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
