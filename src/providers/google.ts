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
import type {
  ProviderContext,
  ContentPart,
  ProviderSteps,
  ToolResultPart,
  MediaResolution,
  VideoProcessing,
} from "../types/message.ts";
import type { StandardToolDeclaration, ToolCallRecord } from "../types/tool.ts";
import type { TokenUsage } from "../types/core.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { SSEParser } from "../streaming/sse-parser.ts";
import { AgentResponse } from "../types/response.ts";
import { getApiKey, getEnv } from "../utils/env.ts";
import { normalizeMediaInput, inferMimeType } from "../utils/media.ts";
import { ConfigError, ValidationError, isAbortError } from "../types/errors.ts";
import { safeStringify } from "../utils/serialization.ts";
import { stripSchemaForGoogle } from "../tools/schema.ts";
import { toConciseProviderError, assertModalitiesSupported } from "../utils/errors.ts";
import { withRetries, sleep } from "../utils/retry.ts";
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
  openStreamResponse,
  retryOptionsFrom,
  headersToRecord,
  parseRetryAfterMs,
  linkStreamAbort,
  withAbortTimer,
} from "./shared.ts";
import { telemetryBus } from "../telemetry.ts";
import { createGenericModelSpec } from "../models/catalog.ts";
import { getModelFromCatalog, getModelsForProvider, modelSupportsStructuredOutput } from "../models/catalog.ts";
import {
  mapThinkingLevelToGoogle,
  mapServiceTierToGoogle,
  resolveCache,
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
// Supported inputs (api-ref `interactions-api.md` enums, `docs/file-input-methods.md`)
// ---------------------------------------------------------------------------

/** Image MIME types Google accepts inline. */
export const GOOGLE_IMAGE_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/bmp",
  "image/tiff",
] as const;
/** Audio MIME types Google accepts inline (audio is never fetched by URL). */
export const GOOGLE_AUDIO_MIME = [
  "audio/wav",
  "audio/mp3",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/mpeg",
  "audio/m4a",
  "audio/l16",
  "audio/opus",
  "audio/alaw",
  "audio/mulaw",
  "audio/webm",
] as const;
/** Video MIME types Google accepts inline. */
export const GOOGLE_VIDEO_MIME = [
  "video/mp4",
  "video/mpeg",
  "video/mpg",
  "video/mov",
  "video/avi",
  "video/x-flv",
  "video/webm",
  "video/wmv",
  "video/3gpp",
] as const;
/** Document MIME types Google accepts (the only two). */
export const GOOGLE_DOCUMENT_MIME = ["application/pdf", "text/csv"] as const;
/** MIME types Google fetches itself from a public `https://` URL. */
export const GOOGLE_URL_MIME = [
  "text/html",
  "text/css",
  "text/plain",
  "text/xml",
  "text/csv",
  "text/rtf",
  "text/javascript",
  "application/json",
  "application/pdf",
  "image/bmp",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/avi",
  "video/x-flv",
  "video/mpg",
  "video/webm",
  "video/wmv",
  "video/3gpp",
] as const;
/** Common MIME spellings mapped to Google's inline names. */
export const GOOGLE_INLINE_MIME_ALIASES: Readonly<Record<string, string>> = {
  "video/quicktime": "video/mov",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "image/jpg": "image/jpeg",
};
// Documented size limits (file-input-methods.md). `assertGoogleInlineSizes` below checks them, but it is NOT called yet:
// the owner is not sure how Files API uploads should be handled, so oversized inputs still get Google's own error for now.
/** Max inline payload per request (bytes). */
export const GOOGLE_MAX_INLINE_REQUEST_BYTES = 100 * 1024 * 1024;
/** Max inline PDF size (bytes). */
export const GOOGLE_MAX_INLINE_PDF_BYTES = 50 * 1024 * 1024;
/** Max size of one file Google fetches by URL (bytes). */
export const GOOGLE_MAX_URL_FILE_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Long decode (`docs/long-decode.md`, `docs/background-execution.md`)
// ---------------------------------------------------------------------------

/** Output tokens one non-background request may produce; above it Gemini 4 runs as a background interaction (long decode). */
export const GOOGLE_MAX_SYNC_OUTPUT_TOKENS = 65_536;
// A background stream pauses between ~5K-token chunks; only this much silence counts as a dropped connection (docs: 15-20 min).
const BACKGROUND_STREAM_STALL_MS = 15 * 60_000;
// Reconnects in a row that bring no new event before a background stream gives up.
const BACKGROUND_MAX_RECONNECTS = 5;

// True when a request needs Gemini 4 long decode (background); any other model above the limit fails before the network; in: model id + maxOutputTokens, out: buildBody, isLongRunning.
function needsLongDecode(modelId: string, maxOutputTokens: number | undefined): boolean {
  if (!maxOutputTokens || maxOutputTokens <= GOOGLE_MAX_SYNC_OUTPUT_TOKENS) return false;
  if (/^gemini-4/i.test(modelId)) return true;
  throw new ConfigError(
    `[Agent Accelerator] [google/${modelId}] maxOutputTokens ${maxOutputTokens} is above Google's ${GOOGLE_MAX_SYNC_OUTPUT_TOKENS} limit; only Gemini 4 models can write more (long decode). Lower maxOutputTokens or use a gemini-4 model.`
  );
}

// True while a background interaction is still working; in: Interaction.status, out: polling and stream reconnects.
function isRunning(status: string | undefined): boolean {
  return status === "queued" || status === "in_progress";
}

// The two reader calls the stream loop uses (Bun ships two incompatible reader typings, so only these are typed).
type StreamReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };

// Reads the next chunk, or cancels the reader and rejects after `ms` of silence; in: a background stream reader, out: the stream read loop.
async function readWithin(reader: StreamReader, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new Error("Google background stream stalled"));
    }, ms);
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

type MediaBlockType = "image" | "audio" | "video" | "document";

const INLINE_MIME: Record<MediaBlockType, readonly string[]> = {
  image: GOOGLE_IMAGE_MIME,
  audio: GOOGLE_AUDIO_MIME,
  video: GOOGLE_VIDEO_MIME,
  document: GOOGLE_DOCUMENT_MIME,
};

// A Google Files API link on either API version (`/v1/files/<id>` or `/v1beta/files/<id>`); the host is exact, so no other URL counts.
const FILES_API_URL = /^https:\/\/generativelanguage\.googleapis\.com\/v1(?:beta)?\/files\/[^/\s]+/;
const YOUTUBE_URL = /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i;

// ---------------------------------------------------------------------------
// Interactions wire shapes (subset used by this adapter)
// ---------------------------------------------------------------------------

type MediaBlock = {
  type: MediaBlockType;
  mime_type?: string;
  data?: string;
  uri?: string;
  resolution?: MediaResolution;
  processing?: VideoProcessing;
};
type InteractionContentBlock = { type: "text"; text: string } | MediaBlock;

type InteractionInputStep =
  | { type: "user_input"; content: string | InteractionContentBlock[] }
  | { type: "thought"; signature?: string; summary?: Array<{ type: string; text?: string }> }
  | { type: "function_call"; id: string; name: string; arguments: Record<string, unknown> }
  | {
      type: "function_result";
      name: string;
      call_id: string;
      result: InteractionContentBlock[];
      is_error?: boolean;
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
  background?: boolean;
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

/** One parsed Interactions HTTP reply (create POST or poll GET). */
interface InteractionReply {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  interaction: InteractionObject;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

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

// Storage tier for the chain TTL (`paid` only when set, else the safe `free`); in: ProviderRequestOptions.googleTier, out: chainTtlMs.
function resolveInteractionTier(options?: ProviderRequestOptions): "free" | "paid" {
  return options?.googleTier === "paid" ? "paid" : "free";
}

// How long a chained interaction pointer is trusted locally (23 h free, 54 d paid); in: the tier, out: liveChainFor.
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

// The saved interaction pointer of a session, if any; in: liveChainFor, out: a ChainEntry or undefined.
function chainFor(sessionId: string | undefined): ChainEntry | undefined {
  if (!sessionId) return undefined;
  return interactionChains.get(sessionId);
}

// Saves the pointer of the interaction a turn just created; in: generate/stream, out: interactionChains.
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
function checkTurnTokens(
  sessionId: string | undefined,
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number }
): void {
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

// Endpoint from the option, GOOGLE_BASE_URL, else the v1beta default; in: each request, out: the base URL without a trailing slash.
function resolveBaseUrl(options?: ProviderRequestOptions): string {
  return (
    options?.baseUrl ||
    options?.env?.["GOOGLE_BASE_URL"] ||
    getEnv("GOOGLE_BASE_URL") ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

// API key from the option or env, or `unused` when custom headers carry the auth; in: each request, out: the key or undefined.
function resolveApiKey(options?: ProviderRequestOptions): string | undefined {
  const key = getApiKey("google", options?.apiKey, options?.env);
  if (key) return key;
  if (hasAuthHeader(options?.headers)) return "unused";
  return undefined;
}

// Strips a google/, gemini/ or models/ prefix; in: generate/stream/getModel, out: the bare model id.
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
    throw new ConfigError(
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

// Canonical tool declarations as Interactions function tools with a Google-safe schema; in: options.tools, out: request `tools`.
function toGoogleTools(tools?: StandardToolDeclaration[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: stripSchemaForGoogle((t.parameters || { type: "object", properties: {} }) as Record<string, unknown>),
  }));
}

// Canonical tool choice as `generation_config.tool_choice.allowed_tools`; in: options.toolChoice + tool names, out: the config value.
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

type MediaValue = string | Uint8Array | ArrayBuffer;

// Lower-cases a MIME type and drops parameters (`text/csv; charset=utf-8` -> `text/csv`); in: part or response MIME, out: list checks.
function bareMime(mime: string | undefined): string | undefined {
  return mime ? mime.split(";")[0]!.trim().toLowerCase() || undefined : undefined;
}

// Returns the `uri` block for a link Google fetches itself (YouTube, Files API, `gs://`, https URL of a URL-supported type), else undefined; in: a media part's string value, out: contentPartsToBlocks.
function uriBlock(type: MediaBlockType, value: string, mimeType?: string): MediaBlock | undefined {
  const explicit = bareMime(mimeType);
  const withMime = (mime?: string): MediaBlock => ({ type, uri: value, ...(mime ? { mime_type: mime } : {}) });
  if (type === "video" && YOUTUBE_URL.test(value)) return withMime(explicit);
  const mime = explicit ?? bareMime(inferMimeType(value, ""));
  if (FILES_API_URL.test(value) || value.startsWith("gs://")) return withMime(mime);
  return value.startsWith("https://") && mime && (GOOGLE_URL_MIME as readonly string[]).includes(mime)
    ? withMime(mime)
    : undefined;
}

// Inlines a media part as base64 under Google's MIME name, failing before the network on an unsupported type; in: any media value (bytes, data URL, path, http URL), out: contentPartsToBlocks.
async function inlineBlock(type: MediaBlockType, value: MediaValue, mimeType?: string): Promise<MediaBlock> {
  const norm = await normalizeMediaInput(value, mimeType);
  const raw = bareMime(norm.mimeType) ?? "";
  const mime = GOOGLE_INLINE_MIME_ALIASES[raw] ?? raw;
  if (!INLINE_MIME[type].includes(mime)) {
    const what =
      type === "document" ? "Google reads only PDF and CSV documents" : `Google does not accept ${type} type "${mime}"`;
    throw new ValidationError(
      `[Agent Accelerator] ${what} (got "${mime}"; supported: ${INLINE_MIME[type].join(", ")}). Convert the file or pass the correct mimeType.`
    );
  }
  return { type, mime_type: mime, data: norm.base64Data };
}

// Maps canonical text and media parts to Interactions content blocks (one builder for chained and full-history input); in: a message's parts, out: request `input`.
async function contentPartsToBlocks(parts: ContentPart[]): Promise<InteractionContentBlock[]> {
  const blocks: InteractionContentBlock[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type !== "image" && part.type !== "audio" && part.type !== "video" && part.type !== "file") continue;
    const type: MediaBlockType = part.type === "file" ? "document" : part.type;
    const value = (part as unknown as Record<string, MediaValue>)[part.type]!;
    const uri = typeof value === "string" ? uriBlock(type, value, part.mimeType) : undefined;
    const block = uri ?? (await inlineBlock(type, value, part.mimeType));
    // Per-item detail level (image and video blocks only, api-ref `MediaResolution`).
    const resolution = part.type === "image" || part.type === "video" ? part.resolution : undefined;
    // Per-video processing mode (`static` | `agentic`, api-ref `MediaProcessing`): the model may then add `processing_call` / `processing_result` steps, which the raw-steps replay keeps like any other step.
    const processing = part.type === "video" ? part.processing : undefined;
    if (processing !== undefined && processing !== "static" && processing !== "agentic")
      throw new ValidationError(
        `[Agent Accelerator] Invalid video processing ${JSON.stringify(processing)}: expected "static" or "agentic".`
      );
    blocks.push({ ...block, ...(resolution ? { resolution } : {}), ...(processing ? { processing } : {}) });
  }
  return blocks;
}

// Decoded size in bytes of a base64 string, without decoding it; in: assertGoogleInlineSizes, out: a byte count.
function base64Bytes(b64: string): number {
  const clean = b64.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

// Every inline media block (`data` + `mime_type`) found anywhere in a request `input`, including blocks inside steps and function results; in: assertGoogleInlineSizes, out: the blocks.
function inlineBlocks(
  value: unknown,
  out: Array<{ mime?: string; bytes: number }> = []
): Array<{ mime?: string; bytes: number }> {
  if (Array.isArray(value)) {
    for (const v of value) inlineBlocks(v, out);
  } else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o["data"] === "string" && typeof o["mime_type"] === "string")
      out.push({ mime: bareMime(o["mime_type"]), bytes: base64Bytes(o["data"]) });
    else for (const v of Object.values(o)) inlineBlocks(v, out);
  }
  return out;
}

/**
 * Fails before the network when the inline media of one request is over Google's documented limits: 100 MB in total and
 * 50 MB for each PDF (larger files go through the Files API). Counts decoded bytes, over the whole `input` (the full
 * history on a reseed). NOT called by the adapter yet (see the call sites in `generate` and `stream`).
 */
export function assertGoogleInlineSizes(input: unknown, modelId: string): void {
  const blocks = inlineBlocks(input);
  const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  for (const b of blocks) {
    if (b.mime === "application/pdf" && b.bytes > GOOGLE_MAX_INLINE_PDF_BYTES) {
      throw new ValidationError(
        `[Agent Accelerator] [google/${modelId}] A PDF of ${mb(b.bytes)} is over Google's ${mb(GOOGLE_MAX_INLINE_PDF_BYTES)} limit for inline PDFs. Upload it with the Files API and pass its link instead.`
      );
    }
  }
  const total = blocks.reduce((n, b) => n + b.bytes, 0);
  if (total > GOOGLE_MAX_INLINE_REQUEST_BYTES) {
    throw new ValidationError(
      `[Agent Accelerator] [google/${modelId}] The inline media of this request is ${mb(total)}, over Google's ${mb(GOOGLE_MAX_INLINE_REQUEST_BYTES)} limit per request. Upload the large files with the Files API and pass their links instead.`
    );
  }
}

// Keeps a turn's model-generated steps exactly as received (input echoes and empty signatures dropped); in: REST `steps` or assembled stream steps, out: ProviderGenerateResult.providerSteps.
function replaySteps(steps: unknown[] | undefined): ProviderSteps | undefined {
  const kept = (steps ?? [])
    .filter((s) => {
      const type = (s as { type?: unknown } | null)?.type;
      return typeof type === "string" && type !== "user_input" && type !== "function_result";
    })
    .map((s) => {
      const { signature, ...rest } = s as Record<string, unknown>;
      return signature === "" ? rest : s;
    });
  return kept.length > 0 ? { provider: "google", steps: kept } : undefined;
}

// Appends streamed text to the last text block of a step's `content`/`summary`, or starts one; in: step.delta, out: the assembled stream step.
function appendBlockText(step: Record<string, unknown> | undefined, key: "content" | "summary", text: string): void {
  if (!step) return;
  const blocks = (Array.isArray(step[key]) ? step[key] : (step[key] = [])) as Array<{ type?: string; text?: string }>;
  const last = blocks[blocks.length - 1];
  if (last?.type === "text" && typeof last.text === "string") last.text += text;
  else blocks.push({ type: "text", text });
}

// Joins the `text` of content/summary blocks; in: a `step.start` step's `content` or `summary`, out: stream text/thinking.
function blockText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks.map((b) => (typeof b?.text === "string" ? b.text : "")).join("");
}

// A tool result as the text of a function_result block; in: functionResultStep, out: a string.
function resultToText(result: unknown): string {
  if (typeof result === "string") return result;
  return safeStringify(result);
}

// Builds the documented `function_result` step (`is_error` only when the tool failed); text first, then the media the tool returned with `toolContent` (Gemini 3 accepts image and document blocks in `result`); in: a canonical tool_result part, out: chained or full-history `input`.
async function functionResultStep(part: ToolResultPart): Promise<InteractionInputStep> {
  const media = part.parts && part.parts.length > 0 ? await contentPartsToBlocks(part.parts) : [];
  return {
    type: "function_result",
    name: part.name,
    call_id: part.id,
    result: [{ type: "text", text: resultToText(part.result) }, ...media],
    ...(part.isError ? { is_error: true } : {}),
  };
}

/**
 * Latest-turn input for stateful chaining (the server already holds history):
 * everything AFTER the last assistant message, in order. That is normally one
 * user prompt (sent as plain text/blocks), but after tool execution it is the
 * `function_result` steps, and a mid-run `steer()` can append user messages
 * behind them. Sending only the last message would drop the tool results and
 * leave the chained interaction waiting on its function calls.
 */
async function latestTurnInput(
  context: ProviderContext
): Promise<string | InteractionContentBlock[] | InteractionInputStep[]> {
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
          steps.push(await functionResultStep(part));
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

// Rebuilds the whole conversation as Interactions steps; Google turns replay their stored raw steps verbatim, others are reconstructed; in: AgentContext messages, out: request `input` on reseed/switch turns.
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
      // Exact replay: same bytes as the server returned (thought signatures included), best for implicit caching.
      if (m.providerSteps?.provider === "google") {
        steps.push(...(m.providerSteps.steps as InteractionInputStep[]));
        continue;
      }
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
      const turnStart = steps.length;
      for (const part of m.content) {
        if (part.type === "thinking" && part.thinking) {
          // Preserve namespaced signatures only — foreign-provider
          // signatures never echo here; untagged legacy echoes (compat).
          // Absent signatures are omitted (never sent as empty strings).
          const partProvider = (part as { thoughtSignatureProvider?: unknown }).thoughtSignatureProvider;
          const msgProvider = (m as { thoughtSignatureProvider?: unknown }).thoughtSignatureProvider;
          const sig = shouldEchoSignature(partProvider ?? msgProvider, "google")
            ? part.thoughtSignature || m.thoughtSignature || ""
            : "";
          const thoughtStep: { type: "thought"; signature?: string; summary: Array<{ type: string; text?: string }> } =
            {
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
      } else if (m.thoughtSignature && !steps.slice(turnStart).some((s) => s.type === "thought")) {
        // Preserve a signature-only thought so stateless chaining keeps
        // reasoning continuity even when no summary text was retained.
        // Only for google/untagged signatures.
        const msgProvider = (m as { thoughtSignatureProvider?: unknown }).thoughtSignatureProvider;
        if (shouldEchoSignature(msgProvider, "google")) {
          steps.push({ type: "thought", signature: m.thoughtSignature });
        }
      }
    } else if (m.role === "tool") {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content) {
        if (part.type === "tool_result") {
          steps.push(await functionResultStep(part));
        }
      }
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Response mapping (Interactions -> canonical)
// ---------------------------------------------------------------------------

// Google usage as TokenUsage, folding thought tokens into output and clamping cache reads to input; in: an interaction or step.stop usage, out: TokenUsage.
function mapUsage(raw?: InteractionObject["usage"]): TokenUsage {
  const input = raw?.total_input_tokens ?? 0;
  // Google reports thought tokens separately from `total_output_tokens`, but bills them as output
  // ("response pricing is the sum of output tokens and thinking tokens"). Fold them into output so
  // pricing is right and `thinkingTokens` stays a subset of `outputTokens`.
  const thought = raw?.total_thought_tokens ?? 0;
  const output = (raw?.total_output_tokens ?? 0) + thought;
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
    thinkingTokens: thought,
  };
}

// Interaction status as a finish reason (requires_action = tool_calls, incomplete = length, failed = error); in: parseInteraction/stream, out: finishReason.
function mapFinishReason(status?: string): string {
  if (status === "requires_action") return "tool_calls";
  if (status === "incomplete") return "length";
  if (status === "failed" || status === "cancelled" || status === "error") return "error";
  return "stop";
}

// Turns a finished Interaction into text, thinking, tool calls, usage and replayable steps, throwing on failed or cancelled; in: generate, out: ProviderGenerateResult.
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
        rawArgs && typeof rawArgs === "object" ? rawArgs : typeof rawArgs === "string" ? parseArguments(rawArgs) : {};
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
    providerSteps: replaySteps(interaction.steps),
  };
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

  // Builds the Interactions request: generation config, tools, structured output and the input (latest turn on a live chain, full history on a fresh or switched one); in: generate/stream, out: the request body.
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
      // The Interactions API caches implicitly only (docs: caching.md).
      resolveCache("google", options?.cache, ["implicit"], `google/${modelId}`);

      const toolNames = (tools ?? []).map((t) => t.name);
      const toolChoice = toGoogleToolChoice(options?.toolChoice, toolNames);

      const generationConfig: Record<string, unknown> = {};
      if (thinkingLevel) generationConfig["thinking_level"] = thinkingLevel;
      // Summaries surface reasoning as `thought.summary` / deltas; without it
      // only signatures return and canonical `thinking` would always be empty.
      // Enabled whenever thinking is active — including the default/dynamic
      // case where no explicit level is sent — and off only when disabled.
      const thinkingActive = options?.thinking?.enabled !== false && (options?.thinking?.level ?? "dynamic") !== "none";
      if (thinkingActive) generationConfig["thinking_summaries"] = "auto";
      if (toolChoice) generationConfig["tool_choice"] = toolChoice;
      // max_output_tokens only.
      Object.assign(generationConfig, mapGenerationParamsToGoogle(options));

      const body: InteractionRequestBody = {
        model: modelId,
        input: "",
        ...(stream ? { stream: true } : {}),
        ...(needsLongDecode(modelId, options?.maxOutputTokens) ? { background: true } : {}),
      };
      // Structured outputs: native `response_format` when supported, else
      // emulated via system instruction (catalog `structured_output: false`
      // would 400 on the wire shape).
      let outputEmulated = false;
      let outputSpec: import("../types/model.ts").StructuredOutputSpec | undefined;
      try {
        outputSpec = normalizeStructuredOutput(
          options?.output ?? (options as { outputSchema?: unknown })?.outputSchema
        );
      } catch {
        outputSpec = undefined;
      }
      let effectiveSystemPrompt = context.systemPrompt;
      if (outputSpec && !modelSupportsStructuredOutput("google", modelId)) {
        outputEmulated = true;
        effectiveSystemPrompt = augmentSystemPromptWithStructuredOutput(
          context.systemPrompt,
          outputSpec,
          options?.prompts?.structuredOutput
        );
        emitProviderWarning({
          provider: "google",
          capability: "structured output",
          requested: `${outputSpec.name} (google/${modelId})`,
          reason:
            "the catalog reports structured_output: false for this model, so native response_format is unsupported.",
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
      // A model switch reseeds from full history and tokenizes differently: drop the token
      // baseline so the new model's first turn is not mistaken for a shrunken history.
      if (chain && sessionId && chain.model !== modelId) lastTurnTotals.delete(sessionId);

      if (switched) {
        // Cross-provider turn: the Google server never saw the other
        // provider's turns, so send the full canonical history explicitly and
        // statelessly, then resume chaining fresh on the next turn.
        body.input = await fullHistorySteps(context);
        // Background runs need storage (`store: false` is a 400); this turn then simply starts a fresh chain.
        if (!body.background) body.store = false;
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

  // Fetch options with JSON headers and the x-goog-api-key header; in: doFetch and stream, out: RequestInit.
  private requestInit(
    method: "POST" | "GET",
    body: InteractionRequestBody | undefined,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    signal?: AbortSignal
  ): RequestInit {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...options?.headers };
    // Key travels as the `x-goog-api-key` header (never `?key=` in the
    // URL, which would leak into logs). Case-insensitive merge so a custom
    // `X-Goog-Api-Key` never duplicates the canonical header. Proxy flows
    // (`apiKey === "unused"`) preserve custom auth instead of overwriting.
    if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "x-goog-api-key", apiKey);
    return { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal };
  }

  // One HTTP call under the request timeout, returning status, headers and body text; in: fetchInteraction and cancelInteraction, out: the raw reply.
  private async doFetch(
    url: string,
    method: "POST" | "GET",
    body: InteractionRequestBody | undefined,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<{ status: number; statusText: string; headers: Record<string, string>; text: string }> {
    const { signal: effective, cleanup } = combinedSignal(
      signal,
      timeoutFor(options as { timeoutMs?: number } | undefined)
    );
    try {
      const res = await (options?.fetch ?? fetch)(url, this.requestInit(method, body, options, apiKey, effective));
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

  // Throws a concise provider error (status, code, Retry-After, key hint) for a non-2xx reply; in: every Google HTTP call, out: nothing or a thrown error.
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

  /** Poll delays (ms) for background interactions: before the first poll, then between polls. */
  pollDelaysMs: [number, number] = [2_000, 5_000];

  /** True for Gemini 4 long decode (`maxOutputTokens` above 65,536): the request runs in the background for up to 24 h. */
  isLongRunning(model: string | ModelSpec, options?: ProviderRequestOptions): boolean {
    return needsLongDecode(cleanModelId(model), options?.maxOutputTokens);
  }

  // One Interactions HTTP call parsed into its interaction (errors mapped concisely); in: create POST or poll GET, out: generate.
  private async fetchInteraction(
    url: string,
    method: "POST" | "GET",
    body: InteractionRequestBody | undefined,
    options: ProviderRequestOptions | undefined,
    apiKey: string,
    modelId: string
  ): Promise<InteractionReply> {
    const res = await this.doFetch(url, method, body, options, apiKey, options?.signal);
    this.throwIfError(res.status, url, res.text, modelId, res.headers);
    try {
      return {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        interaction: JSON.parse(res.text) as InteractionObject,
      };
    } catch {
      throw toConciseProviderError(
        Object.assign(new Error("Invalid JSON response from Google Interactions API"), {
          statusCode: res.status,
          responseBody: res.text.slice(0, 500),
          url,
        }),
        "google",
        modelId
      );
    }
  }

  // Fire-and-forget cancel so an aborted background run stops billing; in: an aborted generate/stream, out: POST {id}/cancel.
  private cancelInteraction(
    baseUrl: string,
    id: string,
    options: ProviderRequestOptions | undefined,
    apiKey: string
  ): void {
    void this.doFetch(`${baseUrl}/interactions/${id}/cancel`, "POST", undefined, options, apiKey).catch(() => {});
  }

  // Non-streaming turn: creates the interaction (polling it when it runs in the background), records the chain and self-heals once on a lost chain; in: runAgentLoop, out: ProviderGenerateResult.
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
      throw new ConfigError(
        "[Agent Accelerator] Missing Google API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) or pass apiKey."
      );
    }
    // Fail fast before any network call when the catalog knows the model
    // lacks the requested modality (clear one-liner instead of a provider 400).
    // Unknown models skip the guard; the provider verdict surfaces concisely.
    assertModalitiesSupported(context, "google", clean);
    const baseUrl = resolveBaseUrl(options);
    const url = `${baseUrl}/interactions`;
    const sessionId = options?.sessionId;
    const tools = options?.tools as StandardToolDeclaration[] | undefined;
    let body = await this.buildBody(clean, context, options, sessionId, tools, false);
    // Size limits are implemented but switched off for now (the owner is unsure about Files API handling yet):
    // assertGoogleInlineSizes(body.input, clean);

    const makeRawRequest = (b: InteractionRequestBody): ProviderRawData["request"] => ({
      url,
      method: "POST",
      headers: redactedHeaders({
        "Content-Type": "application/json",
        ...options?.headers,
        "x-goog-api-key": "[REDACTED]",
      }),
      body: b,
    });
    let rawRequest = makeRawRequest(body);
    const retryOptions = {
      ...retryOptionsFrom(options),
      signal: options?.signal,
      label: { providerId: "google", modelId: clean },
    };

    // Polls a background interaction until it leaves queued/in_progress; an abort also cancels it server-side.
    const waitForCompletion = async (reply: InteractionReply): Promise<InteractionReply> => {
      const id = reply.interaction.id;
      if (!id) return reply;
      try {
        for (let poll = 0; isRunning(reply.interaction.status); poll++) {
          await sleep(this.pollDelaysMs[poll === 0 ? 0 : 1], options?.signal);
          reply = await withRetries(
            () => this.fetchInteraction(`${url}/${id}`, "GET", undefined, options, apiKey, clean),
            retryOptions
          );
        }
        return reply;
      } catch (err) {
        if (options?.signal?.aborted || isAbortError(err)) this.cancelInteraction(baseUrl, id, options, apiKey);
        throw err;
      }
    };

    // Create (retried as a whole), wait if it runs in the background, then record the chain and map the result.
    const run = async (): Promise<ProviderGenerateResult> => {
      let reply = await withRetries(
        () => this.fetchInteraction(url, "POST", body, options, apiKey, clean),
        retryOptions
      );
      if (body.background) reply = await waitForCompletion(reply);
      const { interaction } = reply;
      if (interaction.id && sessionId && body.store !== false) {
        setChain(sessionId, { interactionId: interaction.id, model: clean, at: Date.now() });
      } else if (body.store === false && sessionId) {
        interactionChains.delete(sessionId);
        lastTurnTotals.delete(sessionId);
      }
      noteProviderTurn(sessionId, "google");
      const parsed = parseInteraction(interaction, clean, Date.now() - startTime, {
        request: rawRequest,
        response: { status: reply.status, statusText: reply.statusText, headers: reply.headers, body: interaction },
      });
      checkTurnTokens(sessionId, parsed.usage);
      return parsed;
    };

    try {
      return await run();
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
        return await run();
      }
      throw err;
    }
  }

  // Streaming turn over SSE: assembles text, thinking, calls and exact replay steps, reconnects a dropped background stream and fails clean on a lost chain; in: streamAgentLoop, out: an AssistantMessageEventStream.
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
      // Hoisted for the catch-block self-heal (consts inside try are not
      // visible in catch).
      let evictSessionId: string | undefined;
      let usedChain = false;
      // Set once a background interaction id is known: an abort then cancels it server-side.
      let cancelBackground = (): void => {};
      try {
        // Hard generation floor (mirrors generate): no network on legacy ids.
        assertSupportedGeneration(clean);
        const apiKey = resolveApiKey(options);
        if (!apiKey) {
          throw new ConfigError(
            "[Agent Accelerator] Missing Google API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) or pass apiKey."
          );
        }
        assertModalitiesSupported(context, "google", clean);
        const baseUrl = resolveBaseUrl(options);
        const url = `${baseUrl}/interactions?alt=sse`;
        const sessionId = options?.sessionId;
        const tools = options?.tools as StandardToolDeclaration[] | undefined;
        const body = await this.buildBody(clean, context, options, sessionId, tools, true);
        // Size limits are implemented but switched off for now (the owner is unsure about Files API handling yet):
        // assertGoogleInlineSizes(body.input, clean);
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
            ...options?.headers,
            "x-goog-api-key": "[REDACTED]",
          }),
          body,
        };

        const streamTimeoutMs = timeoutFor(options as { timeoutMs?: number } | undefined);
        // Opens one SSE connection (the create POST, or a background resume GET). Transient failures
        // (429/5xx/network) are retried before the first byte; a live stream is never retried.
        const open = (target: string, method: "POST" | "GET"): Promise<Response> =>
          openStreamResponse({
            fetchOnce: () =>
              withAbortTimer(linked, streamTimeoutMs, () =>
                (options?.fetch ?? fetch)(
                  target,
                  this.requestInit(method, method === "POST" ? body : undefined, options, apiKey, linked.signal)
                )
              ),
            onHttpError: (r, text) => this.throwIfError(r.status, target, text, clean, headersToRecord(r.headers)),
            noBodyError: () =>
              toConciseProviderError(new Error("Google streaming response had no body"), "google", clean),
            retry: retryOptionsFrom(options),
            signal: linked.signal,
            label: { providerId: "google", modelId: clean },
          });
        const res = await open(url, "POST");
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

        let reader: StreamReader | undefined;
        let lastEventId: string | undefined;
        let text = "";
        let thinking = "";
        let signature: string | undefined;
        const calls = new Map<number, { id: string; name: string; startArgs: string; deltaArgs: string }>();
        // Every step as the server would return it (start + deltas), for exact history replay.
        const steps = new Map<number, Record<string, unknown>>();
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
              void reader?.cancel().catch(() => {}); // an aborted body is already errored: its cancel() rejects, and nobody else listens
            } catch {}
          },
          { once: true }
        );
        cancelBackground = () => {
          if (body.background && responseId) this.cancelInteraction(baseUrl, responseId, options, apiKey);
        };

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
          if (typeof msg["event_id"] === "string") lastEventId = msg["event_id"] as string;
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
              appendBlockText(steps.get(index), "content", delta["text"] as string);
              text += delta["text"] as string;
              eventStream.push({ type: "text_delta", delta: delta["text"] as string, partialText: text });
            } else if (dType === "thought_summary") {
              const content = delta["content"] as { type?: string; text?: string } | undefined;
              const t = content?.text ?? (typeof delta["text"] === "string" ? (delta["text"] as string) : "");
              if (t) {
                appendBlockText(steps.get(index), "summary", t);
                thinking += t;
                eventStream.push({ type: "thinking_delta", thinkingDelta: t, partialThinking: thinking });
              }
            } else if (dType === "thought_signature" && typeof delta["signature"] === "string") {
              const s = steps.get(index);
              if (s) s["signature"] = delta["signature"];
              // Wire truth: signature arrives as its own delta (no text event).
              if (!signature) signature = delta["signature"] as string;
            } else if (dType === "arguments" || dType === "arguments_delta") {
              // `arguments` carries a JSON string chunk (docs: streaming.md). Deltas accumulate
              // separately from step.start (see parseStreamedToolArguments): start may be `{}`
              // with the full JSON in one delta, or a genuine first partial.
              const chunk = (delta["arguments"] as string) ?? "";
              const entry = calls.get(index);
              if (entry && typeof chunk === "string") entry.deltaArgs += chunk;
            }
          } else if (type === "step.start") {
            const index = (msg["index"] as number) ?? 0;
            const step = (msg["step"] as Record<string, unknown>) ?? {};
            steps.set(index, step);
            if (step["type"] === "model_output") {
              const t = blockText(step["content"]);
              if (t) {
                text += t;
                eventStream.push({ type: "text_delta", delta: t, partialText: text });
              }
            } else if (step["type"] === "thought") {
              const t = blockText(step["summary"]);
              if (t) {
                thinking += t;
                eventStream.push({ type: "thinking_delta", thinkingDelta: t, partialThinking: thinking });
              }
              if (!signature && typeof step["signature"] === "string" && step["signature"])
                signature = step["signature"];
            } else if (step["type"] === "function_call") {
              const args = step["arguments"];
              const startArgs = typeof args === "string" ? args : args ? JSON.stringify(args) : "";
              calls.set(index, {
                id: (step["id"] as string) || newToolCallId(),
                name: (step["name"] as string) || "unknown",
                startArgs,
                deltaArgs: "",
              });
            }
          } else if (type === "step.stop" || type === "interaction.status_update") {
            // Cumulative usage so far: keeps usage when the stream is cut before `interaction.completed`.
            const stepUsage = msg["usage"] as InteractionObject["usage"] | undefined;
            if (stepUsage) {
              usage = mapUsage(stepUsage);
              sawUsage = true;
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

        // Reads one connection to its end. A background connection that drops or stalls just ends
        // (the caller reconnects); provider error events from handleMessage always throw.
        const readAll = async (response: Response): Promise<void> => {
          const parser = new SSEParser();
          const decoder = new TextDecoder();
          const current = (reader = response.body!.getReader()); // openStreamResponse guarantees a body
          try {
            while (true) {
              if (linked.signal.aborted || eventStream.isCancelled()) {
                try {
                  await current.cancel();
                } catch {}
                throw Object.assign(new Error("Stream aborted"), { name: "AbortError" });
              }
              let chunk: { done: boolean; value?: Uint8Array };
              try {
                chunk = body.background ? await readWithin(current, BACKGROUND_STREAM_STALL_MS) : await current.read();
              } catch (err) {
                if (!body.background || aborted || isAbortError(err)) throw err;
                break;
              }
              if (chunk.done) break;
              for (const m of parser.feed(decoder.decode(chunk.value, { stream: true })))
                handleMessage(m.event, m.data);
            }
            for (const m of parser.flush()) handleMessage(m.event, m.data);
          } finally {
            try {
              current.releaseLock();
            } catch {}
          }
        };

        await readAll(res);
        // Long decode: a background stream may drop; resume after the last event until the interaction ends.
        for (let misses = 0; body.background && completedBody === undefined && !aborted; ) {
          if (!responseId || ++misses > BACKGROUND_MAX_RECONNECTS) throw incompleteStreamError("google", clean);
          const before = framesSeen;
          const resume = `${baseUrl}/interactions/${responseId}?stream=true${lastEventId ? `&last_event_id=${encodeURIComponent(lastEventId)}` : ""}`;
          await readAll(await open(resume, "GET"));
          if (framesSeen > before) misses = 0;
        }

        if (linked.signal.aborted || eventStream.isCancelled() || aborted) {
          throw Object.assign(new Error("Stream aborted"), { name: "AbortError" });
        }

        const toolCalls: ToolCallRecord[] = [];
        for (const [index, c] of calls) {
          const args = parseStreamedToolArguments(c.startArgs, c.deltaArgs);
          const step = steps.get(index);
          if (step) step["arguments"] = args;
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
          if (responseId && body.store !== false)
            setChain(sessionId, { interactionId: responseId, model: clean, at: Date.now() });
          else if (body.store === false) {
            interactionChains.delete(sessionId);
            lastTurnTotals.delete(sessionId);
          }
        }
        noteProviderTurn(sessionId, "google");
        checkTurnTokens(sessionId, usage);

        // Terminal-state guard — fail `incomplete_stream` (retryable)
        // instead of resolving empty success. Skipped for non-SSE payloads
        // (JSON mocks) where no SSE frames were ever seen.
        const hasTerminal = completedBody !== undefined || sawFinishReason || sawUsage;
        // Trim provider trailing blank lines from finalized thinking (live
        // deltas already emitted raw). Stateful bodies unaffected.
        const cleanThinkingEarly = thinking.replace(/\n{3,}/g, "\n\n").trim();
        const ctEntry = Object.entries(responseHeaders).find(([k]) => k.toLowerCase() === "content-type");
        const isSSEPayload =
          (typeof ctEntry?.[1] === "string" &&
            ((ctEntry[1] as string).includes("event-stream") || (ctEntry[1] as string).startsWith("text/"))) ||
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
          providerSteps: replaySteps([...steps.entries()].sort(([a], [b]) => a - b).map(([, s]) => s)),
        });
        eventStream.push({ type: "done", delta: "", usage, finishReason, responseId });
        eventStream.end(finalResponse);
      } catch (err: unknown) {
        const raw = err instanceof Error ? err : new Error(String(err));
        const isAbort =
          linked.signal.aborted || eventStream.isCancelled() || (raw as { name?: string }).name === "AbortError";
        if (isAbort) {
          cancelBackground();
          eventStream.fail(Object.assign(new Error("Stream aborted"), { name: "AbortError" }));
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
        release();
      }
    })();

    return eventStream;
  }
}
