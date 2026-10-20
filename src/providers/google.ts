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
 * - Unlike the legacy transport path, Gemini 2.x is rejected here —
 *   the minimum supported generation is Gemini 3 (deprecated 1.x/2.x fail
 *   fast before any network call); the catalog still governs thinking
 *   validation upstream.
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
import { setHeaderCaseInsensitive, shouldEchoSignature } from "../utils/headers.ts";
import {
  newToolCallId,
  parseArguments,
  redactedHeaders,
  readErrorPayload,
  incompleteStreamError,
  isNotFoundChainError,
  combinedSignal,
  timeoutFor,
  hasAuthHeader,
  clampToolCallId,
  openStreamResponse,
  retryOptionsFrom,
  headersToRecord,
  parseRetryAfterMs,
} from "./shared.ts";
import { telemetryBus } from "../telemetry.ts";
import { createGenericModelSpec } from "../models/catalog.ts";
import { getModelFromCatalog, getModelsForProvider, modelSupportsStructuredOutput } from "../models/catalog.ts";
import {
  mapThinkingLevelToGoogle,
  mapServiceTierToGoogle,
  applyCacheForGoogle,
  normalizeToolChoice,
  lastProviderFor,
  noteProviderTurn,
  parseStreamedToolArguments,
  selectRawArguments,
  mapOutputToGoogle,
  mapGenerationParamsToGoogle,
  normalizeStructuredOutput,
  augmentSystemPromptWithStructuredOutput,
  emitProviderWarning,
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
  | { type: "thought"; signature?: string; summary?: Array<{ type: string; text?: string }> }
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
  error?: { message?: string; code?: string | number } | null;
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
  /** Wall-clock ms of the turn that established this chain (drives the TTL gate). */
  at: number;
}
const interactionChains = new Map<string, ChainEntry>();

/** Interaction storage TTLs: free 24h / paid 55d; local gate fires 1h/1d early. */
const FREE_CHAIN_TTL_MS = 23 * 3600 * 1000;
const PAID_CHAIN_TTL_MS = 54 * 24 * 3600 * 1000;

/** Last-turn total tokens per session for the rehydration invariant (Rule 3). */
const lastTurnTotals = new Map<string, number>();

function resolveInteractionTier(options?: ProviderRequestOptions): "free" | "paid" {
  return options?.googleTier === "paid" ? "paid" : "free";
}

function chainTtlMs(options?: ProviderRequestOptions): number {
  return resolveInteractionTier(options) === "paid" ? PAID_CHAIN_TTL_MS : FREE_CHAIN_TTL_MS;
}

/** Emits a chain anomaly on the telemetry bus (+ legacy global hook). Never throws. */
function reportChainAnomaly(detail: { type: string; [k: string]: unknown }): void {
  telemetryBus.emitWarning(detail.type, `[Agent Accelerator] [google] ${String(detail.type)}`, detail);
  try {
    (globalThis as unknown as { __agentAccelAnomaly?: (d: unknown) => void }).__agentAccelAnomaly?.(detail);
  } catch {}
}

function chainFor(sessionId: string | undefined): ChainEntry | undefined {
  if (!sessionId) return undefined;
  return interactionChains.get(sessionId);
}

function setChain(sessionId: string | undefined, entry: ChainEntry): void {
  if (!sessionId) return;
  interactionChains.set(sessionId, entry);
}

/**
 * Drops a chain entry whose storage TTL elapsed locally (Rule 1: zero wasted
 * RTT). Returns undefined when gated so the caller falls through to the
 * full-history seeding branch. Also resets the token baseline so the reseed
 * never trips the rehydration invariant.
 */
function liveChainFor(sessionId: string | undefined, options?: ProviderRequestOptions): ChainEntry | undefined {
  const entry = chainFor(sessionId);
  if (!entry || !sessionId) return entry;
  if (typeof entry.at === "number" && Date.now() - entry.at >= chainTtlMs(options)) {
    interactionChains.delete(sessionId);
    lastTurnTotals.delete(sessionId);
    reportChainAnomaly({ type: "interaction_chain_ttl_expired", sessionId, model: entry.model });
    return undefined;
  }
  return entry;
}

/**
 * Records a successful turn's token total and alerts when input tokens drop
 * below the previous turn's total (Rule 3: a caller dropped the chain without
 * rehydrating history). Never throws; observability-only.
 */
function checkTurnTokens(sessionId: string | undefined, usage: { inputTokens: number; outputTokens: number; cachedTokens?: number }): void {
  try {
    if (!sessionId) return;
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    const prev = lastTurnTotals.get(sessionId);
    lastTurnTotals.set(sessionId, total);
    if (prev !== undefined && prev > 0 && (usage.inputTokens ?? 0) < prev) {
      const input = usage.inputTokens ?? 0;
      reportChainAnomaly({
        type: "interaction_history_shrink",
        sessionId,
        inputTokens: input,
        previousTotalTokens: prev,
        cacheHitRate: input > 0 ? (usage.cachedTokens ?? 0) / input : 0,
      });
    }
  } catch {}
}

/** Clears chained interaction state (mainly for tests). */
export function clearInteractionChains(sessionId?: string): void {
  if (sessionId) {
    interactionChains.delete(sessionId);
    lastTurnTotals.delete(sessionId);
  } else {
    interactionChains.clear();
    lastTurnTotals.clear();
  }
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
  const key = getApiKey("google", options?.apiKey, options?.env);
  if (key) return key;
  if (hasAuthHeader(options?.headers)) return "unused";
  return undefined;
}

function cleanModelId(model: string | ModelSpec): string {
  const rawId = typeof model === "string" ? model : model.id;
  return rawId.replace(/^(google\/|gemini\/|models\/)/i, "");
}

/**
 * Enforces the Gemini 3 minimum generation floor: Gemini 1.x/2.x are
 * deprecated and unsupported — fail fast before any network call.
 * Non-`gemini-` model ids are left to the catalog/provider verdict.
 */
function assertSupportedGeneration(clean: string): void {
  const match = clean.match(/^gemini-(\d+)(?:[.\-]|$)/i);
  if (match && Number(match[1]) < 3) {
    throw new Error(
      `[Agent Accelerator] [google/${clean}] Unsupported generation: Gemini ${match[1]}.x and older are strictly rejected by this SDK. ` +
        `Use a Gemini 3 or later model for full support and feature coverage.`
    );
  }
}

/** Throws a concise error for failed/cancelled interactions (never silent empty success). */
function throwIfFailedInteraction(interaction: InteractionObject, modelId: string): void {
  if (interaction.status !== "failed" && interaction.status !== "cancelled") return;
  const message =
    interaction.error && typeof interaction.error.message === "string" && interaction.error.message
      ? interaction.error.message
      : `Google interaction ${interaction.status}`;
  const failure: Record<string, unknown> & Error = new Error(message) as Record<string, unknown> & Error;
  if (interaction.error?.code !== undefined) failure["code"] = interaction.error.code;
  throw toConciseProviderError(failure, "google", modelId);
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

/**
 * Latest-turn input for stateful chaining (the server already holds history):
 * everything AFTER the last assistant message, in order. That is normally one
 * user prompt (sent as plain text/blocks), but after tool execution it is the
 * `function_result` steps, and a mid-run `steer()` can append user messages
 * behind them. Sending only the last message would drop the tool results and
 * leave the chained interaction waiting on its function calls.
 */
async function latestTurnInput(context: ProviderContext): Promise<string | InteractionContentBlock[] | InteractionInputStep[]> {
  const messages = context.messages;
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const tail = messages.slice(lastAssistant + 1).filter((m) => m.role !== "system");
  if (tail.length === 0) return "";

  const hasToolResults = tail.some((m) => m.role === "tool");
  if (!hasToolResults && tail.length === 1) {
    const only = tail[0]!;
    if (typeof only.content === "string") return only.content;
    const blocks = await contentPartsToBlocks(only.content);
    if (blocks.length === 1 && blocks[0]!.type === "text") {
      return (blocks[0] as { type: "text"; text: string }).text;
    }
    return blocks;
  }

  const steps: InteractionInputStep[] = [];
  for (const m of tail) {
    if (m.role === "tool") {
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
    } else if (m.role === "user") {
      if (typeof m.content === "string") {
        steps.push({ type: "user_input", content: [{ type: "text", text: m.content }] });
      } else {
        const blocks = await contentPartsToBlocks(m.content);
        if (blocks.length > 0) steps.push({ type: "user_input", content: blocks });
      }
    }
  }
  return steps;
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
          // Q-18: preserve namespaced signatures only — foreign-provider
          // signatures never echo here; untagged legacy echoes (compat).
          // Absent signatures are omitted (never sent as empty strings).
          const partProvider = (part as { thoughtSignatureProvider?: unknown }).thoughtSignatureProvider;
          const msgProvider = (m as { thoughtSignatureProvider?: unknown }).thoughtSignatureProvider;
          const sig = shouldEchoSignature(partProvider ?? msgProvider, "google")
            ? part.thoughtSignature || m.thoughtSignature || ""
            : "";
          const thoughtStep: { type: "thought"; signature?: string; summary: Array<{ type: string; text?: string }> } = {
            type: "thought",
            summary: [{ type: "text", text: part.thinking }],
          };
          if (sig) thoughtStep.signature = sig;
          steps.push(thoughtStep);
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
        // Q-18: only for google/untagged signatures.
        const msgProvider = (m as { thoughtSignatureProvider?: unknown }).thoughtSignatureProvider;
        if (shouldEchoSignature(msgProvider, "google")) {
          steps.push({ type: "thought", signature: m.thoughtSignature });
        }
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
  if (status === "failed" || status === "cancelled" || status === "error") return "error";
  return "stop";
}

function parseInteraction(
  interaction: InteractionObject,
  modelId: string,
  durationMs: number,
  raw: ProviderRawData
): ProviderGenerateResult {
  // Failed/cancelled interactions must surface loudly — never resolve as
  // empty successful stops.
  throwIfFailedInteraction(interaction, modelId);
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
      // Object args as-is; a JSON string is parsed (unparseable text becomes the
      // truncated marker); absent args mean a zero-argument call.
      const rawArgs: unknown = step.arguments;
      const args =
        rawArgs && typeof rawArgs === "object"
          ? rawArgs
          : typeof rawArgs === "string"
            ? parseArguments(rawArgs)
            : {};
      toolCalls.push({
        id: step.id || newToolCallId(),
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

/** Local per-provider signature tag (Q-18): google history preserves only
 * google/untagged signatures; foreign-provider signatures never echo here. */
function withGoogleSignature(sig: string | undefined): { thoughtSignature?: string; thoughtSignatureProvider?: string } {
  if (!sig) return {};
  return { thoughtSignature: sig, thoughtSignatureProvider: "google" };
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
      // max_output_tokens (+ temperature/top_p); stop and seed warn+drop: not documented for Interactions.
      Object.assign(generationConfig, mapGenerationParamsToGoogle(options, `google/${modelId}`));

      const body: InteractionRequestBody = {
        model: modelId,
        input: "",
        ...(stream ? { stream: true } : {}),
      };
      // Structured outputs: native `response_format` when supported, else
      // emulated via system instruction (catalog `structured_output: false`
      // would 400 on the wire shape).
      let outputEmulated = false;
      let outputSpec: import("../types/model.ts").StructuredOutputSpec | undefined;
      try {
        outputSpec = normalizeStructuredOutput(options?.output ?? (options as { outputSchema?: unknown })?.outputSchema);
      } catch {
        outputSpec = undefined;
      }
      let effectiveSystemPrompt = context.systemPrompt;
      if (outputSpec && !modelSupportsStructuredOutput("google", modelId)) {
        outputEmulated = true;
        effectiveSystemPrompt = augmentSystemPromptWithStructuredOutput(context.systemPrompt, outputSpec);
        emitProviderWarning({
          provider: "google",
          capability: "structured output",
          requested: `${outputSpec.name} (google/${modelId})`,
          reason: "the catalog reports structured_output: false for this model, so native response_format is unsupported.",
          fallback: "emulated JSON instruction + client validation (no response_format is sent)",
        });
      }
      if (effectiveSystemPrompt) body.system_instruction = effectiveSystemPrompt;
      const googleTools = toGoogleTools(tools);
      if (googleTools) body.tools = googleTools;
      if (Object.keys(generationConfig).length > 0) body.generation_config = generationConfig;
      if (serviceTier) body.service_tier = serviceTier;
      // Structured outputs: Interactions `response_format{type:text,mime_type:application/json,schema}`.
      // Skipped when emulated (instruction already in `system_instruction`).
      if (outputSpec && !outputEmulated) {
        try {
          const mapped = mapOutputToGoogle(outputSpec);
          if (mapped) (body as unknown as Record<string, unknown>)["response_format"] = mapped.responseFormat;
        } catch {
          // why: invalid output shapes fail fast at Agent construction/loop validation.
        }
      }

      const prevProvider = lastProviderFor(sessionId);
      const switched = !!prevProvider && prevProvider !== "google";
      // Proactive TTL gate (Rule 1): expired chains are dropped locally so
      // this turn seeds fresh instead of wasting an RTT on a dead pointer.
      const chain = liveChainFor(sessionId, options);
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
    // Q-17: key travels as the `x-goog-api-key` header (never `?key=` in the
    // URL, which would leak into logs). Case-insensitive merge so a custom
    // `X-Goog-Api-Key` never duplicates the canonical header. Proxy flows
    // (`apiKey === "unused"`) preserve custom auth instead of overwriting.
    if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "x-goog-api-key", apiKey);
    return { method: "POST", headers, body: JSON.stringify(body), signal };
  }

  private async doFetch(
    url: string,
    body: InteractionRequestBody,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<{ status: number; statusText: string; headers: Record<string, string>; text: string }> {
    const { signal: effective, cleanup } = combinedSignal(signal, timeoutFor(options as { timeoutMs?: number } | undefined));
    try {
      const res = await (options?.fetch ?? fetch)(url, this.requestInit(body, options, apiKey, effective));
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

  private throwIfError(
    status: number,
    statusText: string,
    url: string,
    bodyText: string,
    modelId: string,
    headers?: Record<string, string>
  ): void {
    if (status >= 200 && status < 300) return;
    const { message, code, errorType, raw } = readErrorPayload(bodyText);
    const hint =
      status === 401
        ? " Check GEMINI_API_KEY/GOOGLE_API_KEY (no quotes/spaces, correct provider), GOOGLE_BASE_URL, and that the key is loaded (bun --env-file=.env.local)."
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
    throw toConciseProviderError(err, "google", modelId);
  }

  async generate(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): Promise<ProviderGenerateResult> {
    const startTime = Date.now();
    const clean = cleanModelId(model);
    // Hard generation floor: Gemini 1.x/2.x fail fast before any network call.
    assertSupportedGeneration(clean);
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
    let body = await this.buildBody(clean, context, options, sessionId, tools, false);

    const makeRawRequest = (b: InteractionRequestBody): ProviderRawData["request"] => ({
      url,
      method: "POST",
      headers: redactedHeaders({
        "Content-Type": "application/json",
        ...Object.fromEntries(
          Object.entries(options?.headers ?? {}).filter(([k]) => !INTERNAL_HEADERS.has(k.toLowerCase()))
        ),
        "x-goog-api-key": "[REDACTED]",
      }),
      body: b,
    });
    let rawRequest = makeRawRequest(body);

    const doCall = async (): Promise<ProviderGenerateResult> => {
      const res = await this.doFetch(url, body, options, apiKey, options?.signal);
      this.throwIfError(res.status, res.statusText, url, res.text, clean, res.headers);
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
        setChain(sessionId, { interactionId: interaction.id, model: clean, at: Date.now() });
      } else if (body.store === false && sessionId) {
        interactionChains.delete(sessionId);
        lastTurnTotals.delete(sessionId);
      }
      noteProviderTurn(sessionId, "google");
      const parsed = parseInteraction(
        interaction,
        clean,
        Date.now() - startTime,
        { request: rawRequest, response: { status: res.status, statusText: res.statusText, headers: res.headers, body: interaction } }
      );
      checkTurnTokens(sessionId, parsed.usage);
      return parsed;
    };

    const retryOptions = {
      ...retryOptionsFrom(options),
      signal: options?.signal,
      label: { providerId: "google", modelId: clean },
    };
    try {
      return await withRetries(doCall, retryOptions);
    } catch (err) {
      if (err instanceof Error && (err as { name?: string }).name === "AbortError") throw err;
      // Reactive self-heal (Rule 2): a chained pointer the server no longer
      // has is retried once against the full canonical history with the dead
      // chain cleared, so the turn succeeds instead of wedging the session.
      if (sessionId && body.previous_interaction_id && isNotFoundChainError(err)) {
        reportChainAnomaly({ type: "interaction_chain_evicted", sessionId, model: clean });
        clearInteractionChains(sessionId);
        body = await this.buildBody(clean, context, options, sessionId, tools, false);
        rawRequest = makeRawRequest(body);
        return await withRetries(doCall, retryOptions);
      }
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
      // Hoisted for the catch-block self-heal (consts inside try are not
      // visible in catch).
      let evictSessionId: string | undefined;
      let usedChain = false;
      try {
        // Hard generation floor (mirrors generate): no network on legacy ids.
        assertSupportedGeneration(clean);
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
        evictSessionId = sessionId;
        usedChain = body.previous_interaction_id !== undefined;

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
              return await (options?.fetch ?? fetch)(url, this.requestInit(body, options, apiKey, linked.signal));
            } finally {
              if (timer) clearTimeout(timer);
            }
          },
          onHttpError: (r, text) => this.throwIfError(r.status, r.statusText, url, text, clean, headersToRecord(r.headers)),
          noBodyError: () => toConciseProviderError(new Error("Google streaming response had no body"), "google", clean),
          retry: retryOptionsFrom(options),
          signal: linked.signal,
          label: { providerId: "google", modelId: clean },
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
        let signature: string | undefined;
        const calls = new Map<number, { id: string; name: string; startArgs: string; deltaArgs: string }>();
        let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        let finishReason = "stop";
        let sawFinishReason = false;
        let sawUsage = false;
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
              void reader.cancel();
            } catch {}
          },
          { once: true }
        );

        const handleMessage = (event: string | undefined, data: string): void => {
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
                id: (step["id"] as string) || newToolCallId(),
                name: (step["name"] as string) || "unknown",
                startArgs,
                deltaArgs: "",
              });
            }
          } else if (type === "interaction.completed") {
            const interaction = (msg["interaction"] as InteractionObject) ?? {};
            // Failed/cancelled interactions must surface loudly — never
            // resolve as empty successful stops.
            throwIfFailedInteraction(interaction, clean);
            completedBody = msg["interaction"];
            if (interaction.id) responseId = interaction.id;
            if (interaction.usage) {
              usage = mapUsage(interaction.usage);
              sawUsage = true;
            }
            finishReason = mapFinishReason(interaction.status);
            sawFinishReason = true;
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
            rawArguments: selectRawArguments(c.startArgs, c.deltaArgs),
          };
          toolCalls.push(record);
          eventStream.push({ type: "tool_call_complete", toolCall: record });
        }

        if (sessionId) {
          if (responseId && body.store !== false) setChain(sessionId, { interactionId: responseId, model: clean, at: Date.now() });
          else if (body.store === false) {
            interactionChains.delete(sessionId);
            lastTurnTotals.delete(sessionId);
          }
        }
        noteProviderTurn(sessionId, "google");
        checkTurnTokens(sessionId, usage);

        // Q-23: terminal-state guard — fail `incomplete_stream` (retryable)
        // instead of resolving empty success. Skipped for non-SSE payloads
        // (JSON mocks) where no SSE frames were ever seen.
        const hasTerminal = completedBody !== undefined || sawFinishReason || sawUsage;
        // Trim provider trailing blank lines from finalized thinking (live
        // deltas already emitted raw; display collapse happens in the
        // wrapThinking presentation layer). Stateful bodies unaffected.
        const cleanThinkingEarly = thinking.replace(/\n{3,}/g, "\n\n").trim();
        const ctEntry = Object.entries(responseHeaders).find(([k]) => k.toLowerCase() === "content-type");
        const isSSEPayload =
          (typeof ctEntry?.[1] === "string" && ((ctEntry[1] as string).includes("event-stream") || (ctEntry[1] as string).startsWith("text/"))) ||
          framesSeen > 0 ||
          badFrames > 0;
        if (!hasTerminal && !text && !cleanThinkingEarly && toolCalls.length === 0 && isSSEPayload) {
          eventStream.fail(incompleteStreamError("google", clean));
          return;
        }

        const cleanThinking = cleanThinkingEarly;
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
        if (isAbort) {
          eventStream.fail(
            Object.assign(new Error("Stream aborted"), { name: "AbortError" })
          );
        } else if (evictSessionId && usedChain && isNotFoundChainError(raw)) {
          // Reactive self-heal, fail-clean variant (Rule 2): the `start`
          // event is already delivered, so a transparent in-stream retry
          // would duplicate it. Clear the dead pointer now so the next turn
          // reseeds from full history; mark retryable so a plain caller retry
          // of this turn succeeds.
          reportChainAnomaly({ type: "interaction_chain_evicted", sessionId: evictSessionId, model: clean });
          clearInteractionChains(evictSessionId);
          const retryable = toConciseProviderError(raw, "google", clean);
          (retryable as unknown as Record<string, unknown>)["retryable"] = true;
          (retryable as unknown as Record<string, unknown>)["transient"] = true;
          eventStream.fail(retryable);
        } else {
          eventStream.fail(raw);
        }
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
