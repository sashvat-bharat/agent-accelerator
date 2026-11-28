/**
 * Shared provider helpers.
 *
 * Single home for the `redactedHeaders` / `readErrorPayload` /
 * `parseArguments` / `normalizeThinkingParts` helpers previously duplicated
 * across the four REST transports, plus timeout/signal and id helpers.
 */
import { toConciseProviderError } from "../utils/errors.ts";
import { noop } from "../utils/noop.ts";
import { CHAT_REPLY_LIMIT, ERROR_BODY_LIMIT, readTextCapped } from "../utils/body.ts";
import { getApiKey } from "../utils/env.ts";
import { baseUrlSetting } from "../config/settings.ts";
import { safeStringify } from "../utils/serialization.ts";
import type { ModelSpec, ProviderGenerateResult, ProviderRequestOptions } from "../types/model.ts";
import { withRetries } from "../utils/retry.ts";
import { redactHeadersCentral } from "../utils/cache.ts";
import { TRUNCATED_ARGS_KEY, isTruncatedArguments } from "../types/tool.ts";
import { SSEParser } from "../streaming/sse-parser.ts";
import type { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentResponse } from "../types/response.ts";
import { TimeoutError, abortError } from "../types/errors.ts";
import { DEFAULT_BASE_URLS } from "./base-urls.ts";

/** The arguments of a tool call as an object: a JSON text is parsed and an object (some OpenAI-compatible servers send one) is taken as it is; anything else becomes the truncated-arguments marker, which always holds text. */
export function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  const text = argumentsText(raw) ?? String(raw);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { [TRUNCATED_ARGS_KEY]: text };
  } catch {
    return { [TRUNCATED_ARGS_KEY]: text };
  }
}

/** The JSON text of a tool call's `arguments` as the wire sent them: text as it is, an object or a list as its JSON; undefined for anything else (nothing to add). */
export function argumentsText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return value !== null && typeof value === "object" ? JSON.stringify(value) : undefined;
}

/** Trims/collapses assembled thinking parts (no edge-tripling). */
export function normalizeThinkingParts(parts: string[]): string | undefined {
  const cleaned = parts.map((p) => p.replace(/\n{3,}/g, "\n\n").trim()).filter((p) => p.length > 0);
  return cleaned.length > 0 ? cleaned.join("\n") : undefined;
}

/**
 * Redacts secret-bearing headers for the raw audit trail via the central
 * deny-list: any header whose NAME contains key / token / secret / cookie /
 * authorization (so `x-api-key`, `api-key`, `cf-aig-authorization` …), plus any
 * value that looks like a credential. Everything else passes through.
 */
export function redactedHeaders(headers: Record<string, string>): Record<string, string> {
  return redactHeadersCentral(headers) as Record<string, string>;
}

/**
 * Extracts `{ message, code, errorType, raw, limitSource }` from a non-2xx JSON body. Handles
 * OpenAI `type`, OpenRouter `metadata.error_type` + `metadata.raw` + `metadata.limit_source`, and Google
 * `status` code shapes; unknown bodies degrade to a 300-char slice.
 */
export function readErrorPayload(bodyText: string): {
  message: string;
  code?: string | number;
  errorType?: string;
  raw?: string;
  limitSource?: string;
} {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const err = (
      first as {
        error?: {
          message?: string;
          code?: string | number;
          type?: string;
          status?: string | number;
          metadata?: { error_type?: string; raw?: unknown; limit_source?: unknown };
        };
      }
    )?.error;
    if (err && typeof err.message === "string") {
      const code = err.code ?? err.status;
      const errorType = err.type ?? err.metadata?.error_type ?? (first as { error_type?: string })?.error_type;
      const rawCandidate =
        (err as { metadata?: { raw?: unknown } }).metadata?.raw ??
        (first as { metadata?: { raw?: unknown } })?.metadata?.raw;
      const raw =
        typeof rawCandidate === "string" && rawCandidate.trim() ? rawCandidate.trim().slice(0, 500) : undefined;
      return {
        message: err.message,
        ...(code !== undefined ? { code } : {}),
        ...(typeof errorType === "string" ? { errorType } : {}),
        ...(raw ? { raw } : {}),
        ...(typeof err.metadata?.limit_source === "string" ? { limitSource: err.metadata.limit_source } : {}),
      };
    }
    return { message: bodyText.slice(0, 300) };
  } catch {
    return { message: bodyText.slice(0, 300) };
  }
}

/** Retryable incomplete-stream error for truncated SSE: a `ProviderError` whose `code` is `incomplete_stream`. */
export function incompleteStreamError(provider: string, modelId: string): Error {
  const err = toConciseProviderError(
    Object.assign(new Error("Stream ended without terminal event"), {
      statusCode: 502,
      transient: true,
      retryable: true,
      url: provider,
    }),
    provider,
    modelId
  );
  return Object.assign(err, { code: "incomplete_stream" });
}

/**
 * True when an error signals an evicted/invalid chained interaction
 * (Google Interactions `404` / `{code: not_found}` on REST, `{event_type:
 * error, error: {code: not_found}}` on SSE). Structured-data only: HTTP
 * status, `code`, or `errorType` — never message text.
 */
export function isNotFoundChainError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as Record<string, unknown>;
  const status = Number(
    (err["status"] as number | undefined) ??
      (err["statusCode"] as number | undefined) ??
      ((err["response"] as Record<string, unknown> | undefined)?.["status"] as number | undefined) ??
      NaN
  );
  if (status === 404) return true;
  // `providerCode` on a wrapped ProviderError (its `code` is the SDK kind), `code` on a raw error.
  return [err["providerCode"], err["code"], err["errorType"]].some(
    (c) => String(c ?? "").toLowerCase() === "not_found"
  );
}

/** Per-request timeout ms from provider options. */
export function timeoutFor(options: { timeoutMs?: number } | undefined): number | undefined {
  const t = (options as { timeoutMs?: unknown } | undefined)?.timeoutMs;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.floor(t) : undefined;
}

// The reason a request timer aborts with: a retryable TimeoutError, which `fetch` rejects with, so the retry layers see a timeout and never the caller's own abort; in: combinedSignal and withAbortTimer, out: the abort reason.
function requestTimeout(ms: number): TimeoutError {
  return new TimeoutError(`[Agent Accelerator] Provider request timed out after ${ms} ms.`);
}

/** True for a timeout (an SDK `TimeoutError`, or a platform one such as `AbortSignal.timeout`'s), as opposed to the caller's abort. */
export function isTimeoutError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "TimeoutError";
}

/** Merges a parent signal with a timeout into one effective signal; the timer aborts it with a TimeoutError, the parent with its own reason. Caller must call cleanup when the request settles so the timer never holds the loop open. */
export function combinedSignal(
  signal?: AbortSignal,
  timeoutMs?: number
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (timeoutMs === undefined) return { signal, cleanup: noop };
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    try {
      ctrl.abort(requestTimeout(timeoutMs));
    } catch {
      // why: cancelling or releasing something that is already closed is harmless.
    }
  }, timeoutMs);
  try {
    timer.unref?.();
  } catch {
    // why: cancelling or releasing something that is already closed is harmless.
  }
  const cleanup = () => {
    try {
      clearTimeout(timer);
    } catch {
      // why: cancelling or releasing something that is already closed is harmless.
    }
  };
  if (signal) {
    if (signal.aborted) {
      cleanup();
      ctrl.abort(signal.reason); // the caller's reason survives (`interrupt(new Error("..."))`)
    } else {
      signal.addEventListener(
        "abort",
        () => {
          cleanup();
          try {
            ctrl.abort(signal.reason);
          } catch {
            // why: cancelling or releasing something that is already closed is harmless.
          }
        },
        { once: true }
      );
    }
  }
  return { signal: ctrl.signal, cleanup };
}

/** Crypto-backed tool-call id, no Math.random primary. */
export function newToolCallId(prefix = "call"): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * True when custom headers already carry auth (proxy/Copilot flows).
 * Case-insensitive, non-empty `Authorization` or `cf-aig-authorization`.
 * Callers return `"unused"` instead of throwing missing-key.
 */
export function hasAuthHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (
      (lower === "authorization" || lower === "cf-aig-authorization") &&
      typeof v === "string" &&
      v.trim().length > 0
    ) {
      return true;
    }
  }
  return false;
}

/** True for truncated streamed tool args (the `__truncated_raw` marker from `parseStreamedToolArguments`). */
export function hasTruncatedToolArguments(args: unknown): boolean {
  return isTruncatedArguments(args);
}

// True when a stream with no terminal event left a tool call whose arguments never fully arrived (none at all, or cut mid-JSON); in: the adapter's assembled calls and their records, out: its incomplete_stream guard.
export function hasUnfinishedToolCall(
  calls: Iterable<{ startArgs: string; deltaArgs: string }>,
  toolCalls: Array<{ arguments: unknown }>
): boolean {
  for (const c of calls) if (!c.startArgs.trim() && !c.deltaArgs.trim()) return true;
  return toolCalls.some((c) => isTruncatedArguments(c.arguments));
}

/** Short hash for tool-ID clamping (FNV-1a, 8 hex chars, no deps). */
export function shortHashId(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Clamps a tool-call ID to the 40-char OpenAI limit (pi `api/openai-completions.ts:1194`).
 * Pipe IDs (`callId|itemId`) become `callId_itemHash`; overlong IDs truncate
 * with hash suffix. Plain IDs pass through (truncated if needed).
 */
export function clampToolCallId(id: string): string {
  const clean = String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!clean.includes("|")) {
    if (clean.length <= 40) return clean || "call_unknown";
    // A hard cut would give two long ids with the same first 40 characters the same id; a hash of the whole id keeps them apart.
    const hash = shortHashId(id);
    return `${clean.slice(0, 40 - hash.length - 1)}_${hash}`;
  }
  const sep = clean.indexOf("|");
  const callId = clean.slice(0, sep).replace(/_+$/, "") || "call";
  const itemId = clean.slice(sep + 1).replace(/_+$/, "");
  const combined = itemId ? `${callId}_${itemId}` : callId;
  if (combined.length <= 40) return combined;
  const hash = shortHashId(id).slice(0, 8);
  const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
  return `${prefix}_${hash}`;
}

// The finish reason of a turn that produced tool calls: `tool_calls`, except that a turn cut off by the output limit (`length`) keeps saying so when one of its calls was cut mid-JSON; in: the wire finish reason + the assembled calls, out: each streaming adapter.
export function toolTurnFinishReason(finishReason: string, toolCalls: Array<{ arguments: unknown }>): string {
  return finishReason === "length" && toolCalls.some((c) => isTruncatedArguments(c.arguments))
    ? "length"
    : "tool_calls";
}

// The JSON text of a tool call's arguments for a history message: `{}` for a call whose streamed arguments were cut off (the internal `__truncated_raw` marker was never the model's own output and is never resent); in: a stored tool call, out: each adapter's history builder.
export function toolArgumentsJson(args: unknown): string {
  return isTruncatedArguments(args) ? "{}" : JSON.stringify(args || {});
}

/** Plain lower-cased header record from a fetch `Headers` object. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/**
 * Parses a rate-limit hint from response headers into milliseconds:
 * `retry-after-ms`, then `retry-after` (delta-seconds or HTTP-date).
 * Returns undefined when absent or unparseable.
 */
export function parseRetryAfterMs(
  headers: Record<string, string> | undefined,
  now: number = Date.now()
): number | undefined {
  if (!headers) return undefined;
  const get = (name: string): string | undefined => {
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
    return undefined;
  };
  const ms = get("retry-after-ms");
  if (ms !== undefined && ms.trim() !== "" && Number.isFinite(Number(ms)) && Number(ms) >= 0)
    return Math.round(Number(ms));
  const ra = get("retry-after");
  if (ra === undefined || ra.trim() === "") return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return secs >= 0 ? Math.round(secs * 1000) : undefined;
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** A response that is known to have a body stream: what `openStreamResponse` gives back. */
export type StreamingResponse = Response & { body: ReadableStream<Uint8Array> };

// True when the response has a body stream; in: openStreamResponse, out: a type guard.
function hasBody(res: Response): res is StreamingResponse {
  return res.body !== null;
}

/** A stream request answered in one piece (a JSON body, not an event stream), as the adapter's `readPlainReply` read it. */
export interface PlainReply<T> {
  plain: T;
}

// True when a successful response is a JSON body rather than an event stream (a server or proxy that ignored `stream: true`, or answered with an error object); in: openStreamResponse, out: whether readPlainReply reads it.
function isPlainJsonReply(res: Response): boolean {
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  return type.includes("json") && !type.includes("event-stream");
}

/**
 * Opens an SSE response, retrying transient failures (429/5xx/network) BEFORE
 * any byte is consumed, so a streaming caller gets the same resilience as
 * `generate()`. Once this resolves the stream is live and never retried.
 * `onHttpError` must throw (usually the adapter's concise `throwIfError`).
 * A JSON body is read whole (with the chat reply cap) and handed to `readPlainReply`, which reads it the way the
 * adapter's `generate()` does and throws for an error or a reply that cannot be used, so those are retried here too.
 */
export function openStreamResponse<T>(args: {
  fetchOnce: () => Promise<Response>;
  onHttpError: (res: Response, bodyText: string) => void;
  noBodyError: () => Error;
  readPlainReply: (res: Response, bodyText: string) => T;
  retry: ReturnType<typeof retryOptionsFrom>;
  signal: AbortSignal;
  label: { providerId: string; modelId: string };
}): Promise<StreamingResponse | PlainReply<T>> {
  return withRetries(
    async (): Promise<StreamingResponse | PlainReply<T>> => {
      const res = await args.fetchOnce();
      if (!res.ok) {
        const text = await readTextCapped(res, ERROR_BODY_LIMIT).catch(() => "");
        args.onHttpError(res, text);
      }
      if (!hasBody(res)) throw args.noBodyError();
      if (isPlainJsonReply(res))
        return { plain: args.readPlainReply(res, await readTextCapped(res, CHAT_REPLY_LIMIT)) };
      return res;
    },
    { ...args.retry, signal: args.signal, label: args.label }
  );
}

/** Ends a stream with a reply that came in one piece: its thinking and text as one delta each, each tool call and the end event, then the response. */
export function endWithPlainReply(eventStream: AssistantMessageEventStream, result: ProviderGenerateResult): void {
  if (result.thinking) {
    eventStream.push({ type: "thinking_delta", thinkingDelta: result.thinking, partialThinking: result.thinking });
  }
  if (result.text) eventStream.push({ type: "text_delta", delta: result.text, partialText: result.text });
  for (const toolCall of result.toolCalls ?? []) eventStream.push({ type: "tool_call_complete", toolCall });
  const { usage, finishReason, responseId } = result;
  eventStream.push({ type: "done", delta: "", usage, finishReason, responseId });
  eventStream.end(new AgentResponse(result));
}

/** Retry knobs from provider request options, in the shape `withRetries` expects. */
export function retryOptionsFrom(
  options:
    | {
        maxRetries?: number;
        maxRetryDelayMs?: number;
        retryBaseDelayMs?: number;
        retryBudgetMs?: number;
      }
    | undefined
): { maxRetries?: number; maxRetryDelayMs?: number; baseDelayMs?: number; retryBudgetMs?: number } {
  return {
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    baseDelayMs: options?.retryBaseDelayMs,
    retryBudgetMs: options?.retryBudgetMs,
  };
}

// ---------------------------------------------------------------------------
// Streaming scaffold shared by the SSE adapters (abort linking, request timer, read loop, end-of-stream check, failure)
// ---------------------------------------------------------------------------

// Ties a provider stream to the caller's signal and to the stream's own cancel: one controller that aborts when either does; in: an adapter's stream(), out: the controller its request uses and the `release` its finally block calls.
export function linkStreamAbort(
  eventStream: AssistantMessageEventStream,
  signal: AbortSignal | undefined
): { linked: AbortController; release: () => void } {
  const linked = new AbortController();
  const forwardUserAbort = (): void => {
    try {
      linked.abort((signal as { reason?: unknown } | undefined)?.reason);
    } catch {
      try {
        linked.abort();
      } catch {
        // why: cancelling or releasing something that is already closed is harmless.
      }
    }
  };
  if (signal?.aborted) forwardUserAbort();
  else signal?.addEventListener("abort", forwardUserAbort, { once: true });
  const removeStreamCancel = eventStream.onCancel(() => {
    try {
      linked.abort();
    } catch {
      // why: cancelling or releasing something that is already closed is harmless.
    }
  });
  return {
    linked,
    release: () => {
      try {
        signal?.removeEventListener("abort", forwardUserAbort);
      } catch {
        // why: cancelling or releasing something that is already closed is harmless.
      }
      try {
        removeStreamCancel();
      } catch {
        // why: cancelling or releasing something that is already closed is harmless.
      }
    },
  };
}

// Runs one request attempt under its own timer: the attempt's signal follows `controller` (the caller's abort, the stream's cancel) and also aborts after `ms` with a TimeoutError, which ends only this attempt, so the opener's retry can run (no timer when unset); in: an adapter's fetchOnce, out: its Response.
export async function withAbortTimer<T>(
  controller: AbortController,
  ms: number | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (!ms || ms <= 0) return run(controller.signal);
  const attempt = new AbortController();
  const timer = setTimeout(() => {
    try {
      attempt.abort(requestTimeout(ms));
    } catch {
      // why: cancelling or releasing something that is already closed is harmless.
    }
  }, ms);
  try {
    return await run(AbortSignal.any([controller.signal, attempt.signal]));
  } finally {
    clearTimeout(timer);
  }
}

// Reads an SSE response body to its end, handing each `data:` payload to `onData`; stops with an AbortError as soon as the stream is aborted or cancelled (cancelling the body, whose rejection is absorbed); in: the opened Response body of an SSE adapter, out: calls to onData.
export async function readSseData(
  body: ReadableStream<Uint8Array>,
  linked: AbortController,
  eventStream: AssistantMessageEventStream,
  onData: (data: string) => void
): Promise<void> {
  const parser = new SSEParser();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const abort = (): Error => abortError("Stream aborted");
  linked.signal.addEventListener("abort", () => void reader.cancel().catch(noop), { once: true }); // an aborted body is already errored: its cancel() rejects, and nobody else listens
  while (true) {
    if (linked.signal.aborted || eventStream.isCancelled()) {
      try {
        await reader.cancel();
      } catch {
        // why: cancelling or releasing something that is already closed is harmless.
      }
      throw abort();
    }
    const { done, value } = await reader.read();
    if (done) break;
    for (const m of parser.feed(decoder.decode(value, { stream: true }))) onData(m.data);
  }
  for (const m of parser.flush()) onData(m.data);
  try {
    reader.releaseLock();
  } catch {
    // why: cancelling or releasing something that is already closed is harmless.
  }
  if (linked.signal.aborted || eventStream.isCancelled()) throw abort();
}

// The error to fail with when a stream ended without its final event while carrying no content or an unfinished tool call, whatever the body's content type (a JSON body never gets here: openStreamResponse reads it whole); in: the adapter's state after reading, out: `eventStream.fail`, else undefined.
export function incompleteStreamCheck(a: {
  provider: string;
  modelId: string;
  hasTerminal: boolean;
  empty: boolean;
  unfinishedCall: boolean;
}): Error | undefined {
  if (a.hasTerminal || !(a.empty || a.unfinishedCall)) return undefined;
  return incompleteStreamError(a.provider, a.modelId);
}

// Fails a stream with the right error: a timeout stays a `TimeoutError`, an abort (the signal, the stream's cancel, or an AbortError) becomes the plain `AbortError`, anything else passes through; in: an adapter's catch block, out: the stream's result() rejection.
export function failStream(eventStream: AssistantMessageEventStream, linked: AbortController, err: unknown): void {
  const raw = err instanceof Error ? err : new Error(String(err));
  // A timeout stays a timeout: a request timer's error, or the reason a whole-call timer aborted the stream with.
  const reason: unknown = linked.signal.reason;
  if (linked.signal.aborted && isTimeoutError(reason) && reason instanceof Error) return eventStream.fail(reason);
  const isAbort =
    linked.signal.aborted || eventStream.isCancelled() || (raw as { name?: string }).name === "AbortError";
  eventStream.fail(isAbort ? abortError("Stream aborted") : raw);
}

/** A tool result as the text of a tool message or function_call_output; in: each adapter's history builder, out: a string. */
export function resultToOutput(result: unknown): string {
  if (typeof result === "string") return result;
  return safeStringify(result);
}

/** The model id without its provider scope (`prefix` matches the scope, case-insensitive); in: a first-class adapter, out: the bare id. */
export function stripModelScope(model: string | ModelSpec, prefix: RegExp): string {
  const rawId = typeof model === "string" ? model : model.id;
  return rawId.replace(prefix, "");
}

/** The key of a first-class provider (option, then environment), `unused` when custom headers carry the auth; in: each request, out: the key or undefined. */
export function resolveProviderApiKey(provider: string, options?: ProviderRequestOptions): string | undefined {
  const key = getApiKey(provider, options?.apiKey, options?.env);
  if (key) return key;
  if (hasAuthHeader(options?.headers)) return "unused";
  return undefined;
}

/** The base URL of a first-class provider (option, then the `base_urls` setting, then its default in `base-urls.ts`) without trailing slashes; in: each request, out: a URL. */
export function resolveProviderBaseUrl(
  provider: keyof typeof DEFAULT_BASE_URLS,
  options?: ProviderRequestOptions
): string {
  return (options?.baseUrl || baseUrlSetting(provider) || DEFAULT_BASE_URLS[provider]).replace(/\/+$/, "");
}

/** The OpenRouter provider-routing keys taken from the `openrouter` setting (`order`, `only`, `ignore`, `allow_fallbacks`, `require_parameters`, `zdr`, `data_collection`, `sort`); the text and the image adapters both read them. */
export const OPENROUTER_ROUTING_KEYS = [
  "order",
  "only",
  "ignore",
  "allow_fallbacks",
  "require_parameters",
  "zdr",
  "data_collection",
  "sort",
] as const;

/** The tokens of one modality in a by-modality list (names compare in lower case), or undefined when the list does not mention it. */
export function modalityTokens(
  list: ReadonlyArray<{ modality?: string; tokens?: number }> | undefined,
  modality: string
): number | undefined {
  const want = modality.toLowerCase();
  const hits = (list ?? []).filter((m) => m.modality?.toLowerCase() === want);
  return hits.length > 0 ? hits.reduce((n, m) => n + (m.tokens ?? 0), 0) : undefined;
}
