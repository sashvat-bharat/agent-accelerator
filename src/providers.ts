/**
 * Canonical provider contract for Agent Accelerator.
 *
 * This module is provider-agnostic: it defines how canonical Agent Accelerator
 * capabilities map onto provider concepts WITHOUT containing any
 * provider-specific HTTP, endpoints, headers, or response parsing. Those live
 * in `src/providers/<provider>.ts` (e.g. `src/providers/google.ts`).
 *
 * Rule: OpenAI, OpenRouter, and future providers must be addable here without
 * redesigning this abstraction — only new per-provider mappers/adapters.
 */
import type { CacheOption, ServiceTier, ThinkingLevel } from "./types/core.ts";
import type { StructuredOutputSpec } from "./types/model.ts";
import type { Message } from "./types/message.ts";
import type { EmbeddingTask } from "./types/embedding.ts";
import { zodToJsonSchema } from "./tools/schema.ts";
import { ValidationError } from "./types/errors.ts";
import { TRUNCATED_ARGS_KEY } from "./types/tool.ts";
import { telemetryBus } from "./telemetry.ts";
import { DEFAULT_PROMPTS, fillPrompt } from "./prompts/prompts.ts";

/** Classification of a canonical capability on a given provider. */
export type ProviderCapabilityStatus = "NATIVE" | "TRANSLATED" | "AUTOMATIC" | "EMULATED" | "UNSUPPORTED";

/**
 * Single warning mechanism for provider capability differences.
 *
 * There is no pre-existing logger in `src/` (only CLI logs in
 * `update-models.ts`), so this `console.warn` line IS the mechanism — do not
 * introduce a second one. Used when a requested capability cannot be applied
 * as-is (e.g. an unsupported `cache` TTL) so it never silently
 * disappears.
 *
 * Warnings are deduped per provider+capability+requested: agent loops call
 * mappers once per turn, and repeating the same warning every turn is noise.
 * A repeated identical request logs once per process.
 *
 * @example `emitProviderWarning({ provider: "google", capability: "cache", requested: "12h", reason: "...", fallback: "..." })`
 */
const emittedWarnings = new Set<string>();

/** Warns once per provider, capability and request about something that cannot be applied as asked: a `provider_warning` bus event, the legacy global sink and console; in: the mappers and adapters, out: those channels. */
export function emitProviderWarning(options: {
  provider: string;
  capability: string;
  requested?: string;
  reason: string;
  fallback: string;
}): void {
  const key = `${options.provider}::${options.capability}::${options.requested ?? ""}`;
  if (emittedWarnings.has(key)) return;
  emittedWarnings.add(key);
  const requested = options.requested ? ` (requested: "${options.requested}")` : "";
  // Primary channel: the telemetry bus (code `provider_warning`). The legacy
  // global sink and `console.warn` remain for existing capture-based tests and
  // CLIs that predate the bus.
  const msg = `[Agent Accelerator] WARNING [${options.provider}] ${options.capability}${requested}: ${options.reason} Using ${options.fallback} instead.`;
  telemetryBus.emitWarning("provider_warning", msg, {
    provider: options.provider,
    capability: options.capability,
    requested: options.requested,
    reason: options.reason,
    fallback: options.fallback,
  });
  try {
    console.warn(msg);
  } catch {}
}

/** Clears deduped-warning state (mainly for tests). */
export function clearEmittedWarnings(): void {
  emittedWarnings.clear();
}

// ---------------------------------------------------------------------------
// Per-session provider routing state (canonical conversation stays agnostic)
// ---------------------------------------------------------------------------

interface SessionRoutingState {
  /** Provider id that served the last turn in this session. */
  lastProvider?: string;
  /** True once a session mixed providers and must stay on explicit history. */
  mixedProviders?: boolean;
}

const sessionRouting = new Map<string, SessionRoutingState>();

/** Records which provider served a turn so adapters can detect switches. */
export function noteProviderTurn(sessionId: string | undefined, providerId: string): void {
  if (!sessionId) return;
  const state = sessionRouting.get(sessionId) ?? {};
  if (state.lastProvider && state.lastProvider !== providerId) {
    state.mixedProviders = true;
  }
  state.lastProvider = providerId;
  sessionRouting.set(sessionId, state);
}

/** Returns the provider id that served the previous turn in this session. */
export function lastProviderFor(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return sessionRouting.get(sessionId)?.lastProvider;
}

/** True when this session already mixed providers (history must be explicit). */
export function isMixedProviderSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return sessionRouting.get(sessionId)?.mixedProviders === true;
}

/** Clears routing state for a session (mainly for tests). */
export function clearSessionRouting(sessionId?: string): void {
  if (sessionId) sessionRouting.delete(sessionId);
  else sessionRouting.clear();
}

// ---------------------------------------------------------------------------
// Canonical capability mappers (pure, no I/O)
// ---------------------------------------------------------------------------

/**
 * Maps a canonical ThinkingLevel onto Google Interactions `thinking_level`.
 * Google values: minimal|low|medium|high (no off switch, no xhigh/max).
 */
export function mapThinkingLevelToGoogle(level: ThinkingLevel | string | undefined): { thinkingLevel?: string } {
  if (!level) return {};
  const norm = String(level).toLowerCase().trim();
  if (norm === "dynamic") return {}; // server dynamic default (NATIVE)
  if (norm === "none") {
    emitProviderWarning({
      provider: "google",
      capability: "thinking level",
      requested: String(level),
      reason: "the Interactions API has no disable/off level — thought steps are always present.",
      fallback: "the server default (omit thinking_level)",
    });
    return {};
  }
  if (norm === "xhigh" || norm === "max") {
    emitProviderWarning({
      provider: "google",
      capability: "thinking level",
      requested: String(level),
      reason: "Google's maximum thinking level is high.",
      fallback: "thinking_level high",
    });
    return { thinkingLevel: "high" };
  }
  if (norm === "minimal" || norm === "low" || norm === "medium" || norm === "high") {
    return { thinkingLevel: norm };
  }
  return {};
}

/** Maps canonical ServiceTier onto Google `service_tier` (omit = standard). */
export function mapServiceTierToGoogle(tier: ServiceTier | undefined): "flex" | "priority" | undefined {
  if (tier === "flex" || tier === "priority") return tier;
  return undefined;
}

/**
 * Maps a canonical ThinkingLevel onto OpenRouter Chat Completions
 * `reasoning.effort`.
 *
 * Completions documents `reasoning_effort: xhigh|high|medium|low|minimal|none`
 * (parameters.md) and live probes accept `xhigh` verbatim (`03`), so — unlike
 * the discontinued Responses skin, which clamped `xhigh` — everything passes
 * through. `max` rides the same verbatim path. `dynamic` omits (server default).
 */
export function mapThinkingLevelToOpenRouterChat(level: ThinkingLevel | string | undefined): { effort?: string } {
  if (!level) return {};
  const norm = String(level).toLowerCase().trim();
  if (norm === "dynamic") return {}; // server default
  if (
    norm === "none" ||
    norm === "minimal" ||
    norm === "low" ||
    norm === "medium" ||
    norm === "high" ||
    norm === "xhigh" ||
    norm === "max"
  ) {
    return { effort: norm };
  }
  return {};
}

/** Maps canonical ServiceTier onto OpenRouter `service_tier` (omit = auto). */
export function mapServiceTierToOpenRouter(tier: ServiceTier | undefined): "flex" | "priority" | undefined {
  if (tier === "flex" || tier === "priority") return tier;
  return undefined;
}

/** Returns the `cache` value a provider will honour; an unsupported one warns once and falls back to the provider default (`undefined`). In: `ProviderRequestOptions.cache` from each adapter's buildBody, out: the adapter's wire mapping. */
export function resolveCache(
  provider: string,
  cache: CacheOption | undefined,
  supported: readonly CacheOption[],
  modelRef: string
): CacheOption | undefined {
  if (cache === undefined || supported.includes(cache)) return cache;
  emitProviderWarning({
    provider,
    capability: "cache",
    requested: `${cache} (${modelRef})`,
    reason: `supported values here are: ${supported.map((v) => `"${v}"`).join(", ")}.`,
    fallback: "the provider default (implicit caching)",
  });
  return undefined;
}

/** Warns once per provider/model that per-media `resolution` is ignored (no such control on that wire for the given kinds of media); in: an adapter's request messages, out: telemetry bus only. */
export function warnIgnoredMediaResolution(
  provider: string,
  messages: Message[],
  modelRef: string,
  kinds: Array<"image" | "video"> = ["image", "video"]
): void {
  const used = messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => (p.type === "image" || p.type === "video") && kinds.includes(p.type) && p.resolution)
  );
  if (!used) return;
  emitProviderWarning({
    provider,
    capability: "media resolution",
    requested: modelRef,
    reason: "this provider has no per-media detail control for this kind of media.",
    fallback: "the provider's default detail",
  });
}

/** Warns once per provider/model that a video's `processing` mode is ignored (only Google has one); in: an adapter's request messages, out: telemetry bus only. */
export function warnIgnoredVideoProcessing(provider: string, messages: Message[], modelRef: string): void {
  const used = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "video" && p.processing)
  );
  if (!used) return;
  emitProviderWarning({
    provider,
    capability: "video processing",
    requested: modelRef,
    reason: "only Google reads a video in a chosen processing mode (static or agentic).",
    fallback: "the provider's default video handling",
  });
}

/** Warns once per provider/model that media a tool returned with `toolContent` is not sent (only Google takes media inside a function result); the model still gets the tool's text; in: an adapter's request messages, out: telemetry bus only. */
export function warnIgnoredToolMedia(provider: string, messages: Message[], modelRef: string): void {
  const used = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "tool_result" && p.parts && p.parts.length > 0)
  );
  if (!used) return;
  emitProviderWarning({
    provider,
    capability: "media in tool results",
    requested: modelRef,
    reason: "only Google accepts images, audio, video or files inside a function result.",
    fallback: "the tool's text only (the media is not sent)",
  });
}

// Warns once that the `validated` tool choice (Google only) is dropped and the provider default (auto) is used; in: the OpenRouter and OpenAI tool-choice mappers (compat goes through the OpenAI one), out: a provider_warning on the bus.
function warnValidatedToolChoice(provider: string): void {
  emitProviderWarning({
    provider,
    capability: "tool choice",
    requested: "validated",
    reason: "only Google has a validated tool-choice mode.",
    fallback: "automatic tool choice",
  });
}

/** OpenRouter Chat Completions `tool_choice` wire values. */
export type OpenRouterChatToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

/**
 * Maps canonical toolChoice onto Chat Completions `tool_choice`.
 * `auto` is the server default (omitted); `required` is documented
 * (parameters.md) and accepted live (`05`); a function pin passes through
 * verbatim. Note the shape differs from the discontinued Responses skin
 * (`{type:function,name}`): completions nests the name under `function`.
 */
export function mapToolChoiceToOpenRouterChat(
  choice: "auto" | "none" | "required" | "validated" | { type: "function"; function: { name: string } } | undefined
): OpenRouterChatToolChoice | undefined {
  if (!choice || choice === "auto") return undefined;
  if (choice === "validated") return (warnValidatedToolChoice("openrouter"), undefined);
  if (choice === "none" || choice === "required") return choice;
  const name = choice.function?.name;
  if (name) return { type: "function", function: { name } };
  return undefined;
}

/**
 * Maps a canonical ThinkingLevel onto OpenAI Responses `reasoning.effort`.
 * Documented efforts: none|minimal|low|medium|high|xhigh|max (server default
 * medium). Unlike OpenRouter (which clamps xhigh), OpenAI documents xhigh
 * and max natively so they pass through verbatim. `dynamic` omits (server default).
 */
export function mapThinkingLevelToOpenAI(level: ThinkingLevel | string | undefined): { effort?: string } {
  if (!level) return {};
  const norm = String(level).toLowerCase().trim();
  if (norm === "dynamic") return {}; // server default
  if (
    norm === "none" ||
    norm === "minimal" ||
    norm === "low" ||
    norm === "medium" ||
    norm === "high" ||
    norm === "xhigh" ||
    norm === "max"
  ) {
    return { effort: norm };
  }
  return {};
}

/** Maps canonical ServiceTier onto OpenAI `service_tier` (omit = auto). */
export function mapServiceTierToOpenAI(tier: ServiceTier | undefined): "flex" | "priority" | undefined {
  if (tier === "flex" || tier === "priority") return tier;
  return undefined;
}

/** OpenAI Responses `tool_choice` wire values (most-important subset). */
export type OpenAIToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };

/**
 * Maps canonical toolChoice onto OpenAI Responses `tool_choice`.
 * `auto` is the server default (omitted); `required` forces one or more
 * calls; a function pin passes through verbatim. Built-in/MCP/allowed_tools
 * variants are out of scope and never emitted.
 */
export function mapToolChoiceToOpenAI(
  choice: "auto" | "none" | "required" | "validated" | { type: "function"; function: { name: string } } | undefined,
  provider = "openai"
): OpenAIToolChoice | undefined {
  if (!choice || choice === "auto") return undefined;
  if (choice === "validated") return (warnValidatedToolChoice(provider), undefined);
  if (choice === "none" || choice === "required") return choice;
  const name = choice.function?.name;
  if (name) return { type: "function", name };
  return undefined;
}

/** Normalized tool-choice mode shared by provider adapters. */
export type CanonicalToolChoiceMode = "auto" | "any" | "none" | "validated";

/**
 * Normalizes canonical toolChoice into a provider-neutral mode + optional
 * pinned tool name. Google renders this as
 * `{ allowed_tools: { mode, tools? } }` in its own adapter.
 */
export function normalizeToolChoice(
  choice: "auto" | "none" | "required" | "validated" | { type: "function"; function: { name: string } } | undefined,
  availableToolNames: string[]
): { mode: CanonicalToolChoiceMode; tools?: string[] } | undefined {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    if (choice === "auto") return undefined; // server default
    if (choice === "none") return { mode: "none" };
    if (choice === "validated") return { mode: "validated" };
    if (choice === "required") {
      return availableToolNames.length > 0 ? { mode: "any", tools: availableToolNames } : { mode: "any" };
    }
    return undefined;
  }
  const name = choice.function?.name;
  if (name) return { mode: "any", tools: [name] };
  return { mode: "any" };
}

// True for a non-array object; in: the argument and schema helpers, out: a type guard.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reconstructs tool arguments from streamed chunks.
 *
 * Wire behavior varies across providers: some send the complete JSON in a
 * single delta after an empty initial payload, others genuinely split
 * partials across start + deltas. Concatenating blindly can yield
 * `"{}{...}"` (unparseable), so candidates are tried in order and the first
 * chunk that parses to a plain object wins.
 *
 * @example `parseStreamedToolArguments("{}", '{"location":"Paris"}')`
 */
export function parseStreamedToolArguments(startText: string, deltaText: string): Record<string, unknown> {
  if (!startText.trim() && !deltaText.trim()) return {}; // no argument text at all is a call that takes none
  const candidates = [startText + deltaText, deltaText, startText].filter((c) => c && c.trim());
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return { [TRUNCATED_ARGS_KEY]: startText + deltaText };
}

/**
 * Returns the wire string that actually parsed in
 * {@link parseStreamedToolArguments} (identical candidate trial order), so
 * `rawArguments` audit trails never store concatenation artifacts like
 * `"{}{...}"` (empty start payload + complete delta). Falls back to the raw
 * concatenation when nothing parses, preserving the truncated-call marker
 * path (`{ __truncated_raw }`, never executed).
 *
 * @example `selectRawArguments("{}", '{"location":"Paris"}') // '{"location":"Paris"}'`
 */
export function selectRawArguments(startText: string, deltaText: string): string {
  if (!startText.trim() && !deltaText.trim()) return "{}";
  const candidates = [startText + deltaText, deltaText, startText].filter((c) => c && c.trim());
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isPlainObject(parsed)) return candidate;
    } catch {
      // try next candidate
    }
  }
  return startText + deltaText;
}

// ---------------------------------------------------------------------------
// Generation controls (maxOutputTokens)
// ---------------------------------------------------------------------------

/** Canonical generation controls as carried on `ProviderRequestOptions`. */
export interface GenerationParams {
  maxOutputTokens?: number;
}

// The output-token cap as a whole number above zero, else undefined; in: the three generation-param mappers, out: their wire field.
function outputTokenCap(params: GenerationParams | undefined): number | undefined {
  const n = params?.maxOutputTokens;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Chat Completions (OpenRouter + generic compat endpoints): `max_tokens`, only when the caller set it, so strict endpoints never see anything unasked. */
export function mapGenerationParamsToChat(params: GenerationParams | undefined): { max_tokens?: number } {
  const cap = outputTokenCap(params);
  return cap === undefined ? {} : { max_tokens: cap };
}

/** OpenAI Responses: `max_output_tokens`. */
export function mapGenerationParamsToOpenAI(params: GenerationParams | undefined): { max_output_tokens?: number } {
  const cap = outputTokenCap(params);
  return cap === undefined ? {} : { max_output_tokens: cap };
}

/** Google Interactions `generation_config`: `max_output_tokens`. */
export function mapGenerationParamsToGoogle(params: GenerationParams | undefined): { max_output_tokens?: number } {
  const cap = outputTokenCap(params);
  return cap === undefined ? {} : { max_output_tokens: cap };
}

// ---------------------------------------------------------------------------
// Structured outputs (canonical, pure, no I/O)
// ---------------------------------------------------------------------------

// True when a value looks like a Zod schema (parse/safeParse/_def/~standard); in: structured-output normalization, out: a boolean.
function isZodLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v["safeParse"] === "function" || typeof v["parse"] === "function" || "_def" in v || "~standard" in v;
}

// True when a plain object has JSON Schema keywords; in: structured-output normalization, out: a boolean.
function looksLikeJsonSchema(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["type"] === "string" ||
    isPlainObject(v["properties"]) ||
    Array.isArray(v["anyOf"]) ||
    Array.isArray(v["oneOf"]) ||
    Array.isArray(v["allOf"]) ||
    typeof v["$schema"] === "string" ||
    isPlainObject(v["$defs"]) ||
    isPlainObject(v["definitions"])
  );
}

// A structured-output name limited to letters, digits, `_` and `-` (64 chars), default `structured_output`; in: normalizeStructuredOutput, out: the name.
function sanitizeOutputName(raw: unknown): string {
  const base = typeof raw === "string" && raw.trim() ? raw.trim() : "structured_output";
  const cleaned = base.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "structured_output";
  return cleaned;
}

// A Zod schema or JSON Schema object as a JSON Schema object, else a ValidationError; in: normalizeStructuredOutput, out: the schema.
function schemaToJsonSchema(schema: unknown, what: string): Record<string, unknown> {
  if (isZodLike(schema)) {
    try {
      const converted = zodToJsonSchema(schema);
      if (isPlainObject(converted)) return converted;
    } catch {
      // fall through to error below
    }
  }
  if (isPlainObject(schema)) return schema as Record<string, unknown>;
  throw new ValidationError(
    `[Agent Accelerator] Invalid structured output ${what}: expected a Zod schema, a JSON Schema object, or { name, schema, strict }.`
  );
}

/**
 * Normalizes `AgentConfig.output` into a provider-agnostic spec.
 *
 * Accepts a Zod schema, a JSON Schema object, or an explicit
 * `{ name?, description?, schema, strict? }` wrapper. Returns `undefined`
 * when no output was requested. Throws `ValidationError` for invalid shapes.
 *
 * @example `normalizeStructuredOutput(z.object({ city: z.string() }))`
 */
export function normalizeStructuredOutput(output: unknown): StructuredOutputSpec | undefined {
  if (output === undefined || output === null) return undefined;
  if (isPlainObject(output) && "schema" in (output as Record<string, unknown>)) {
    const rec = output as Record<string, unknown>;
    const schema = schemaToJsonSchema(rec["schema"], "`output.schema`");
    return {
      name: sanitizeOutputName(rec["name"]),
      schema,
      strict: typeof rec["strict"] === "boolean" ? (rec["strict"] as boolean) : true,
      ...(typeof rec["description"] === "string" && (rec["description"] as string).trim()
        ? { description: (rec["description"] as string).trim() }
        : {}),
    };
  }
  if (isZodLike(output) || looksLikeJsonSchema(output)) {
    return {
      name: "structured_output",
      schema: schemaToJsonSchema(output, "`output`"),
      strict: true,
    };
  }
  throw new ValidationError(
    "[Agent Accelerator] Invalid structured output: expected a Zod schema, a JSON Schema object, or { name, schema, strict }."
  );
}

/**
 * Extracts the original Zod validator from a canonical output option, when
 * present (bare Zod schema or `{ schema: Zod }`). Used by the loop for
 * post-parse validation; `undefined` means JSON-parse only.
 */
export function extractOutputValidator(
  output: unknown
): { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } } } | undefined {
  if (!output) return undefined;
  if (isZodLike(output) && typeof (output as { safeParse?: unknown }).safeParse === "function") {
    return output as { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } } };
  }
  if (isPlainObject(output) && isZodLike((output as Record<string, unknown>)["schema"])) {
    const inner = (output as Record<string, unknown>)["schema"] as { safeParse?: unknown };
    if (typeof inner.safeParse === "function") {
      return inner as { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } } };
    }
  }
  return undefined;
}

// Removes a surrounding ```json fence from a model answer; in: parseStructuredOutput, out: the bare text.
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenced && typeof fenced[1] === "string") return fenced[1].trim();
  return trimmed;
}

/**
 * Parses and validates a final answer against a canonical output option.
 * Strips markdown fences, requires valid JSON, then applies the Zod validator
 * when the original option carried one. Throws `ValidationError` on mismatch.
 *
 * @example `parseStructuredOutput('{"city":"Paris"}', z.object({ city: z.string() }))`
 */
export function parseStructuredOutput(text: string, output: unknown): unknown {
  const cleaned = stripCodeFences(typeof text === "string" ? text : String(text ?? ""));
  if (!cleaned) {
    throw new ValidationError(
      "[Agent Accelerator] Structured output validation failed: model returned empty text, expected JSON matching the output schema."
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ValidationError(
      `[Agent Accelerator] Structured output validation failed: model text is not valid JSON (${cleaned.slice(0, 120)}).`
    );
  }
  const validator = extractOutputValidator(output);
  if (validator) {
    const res = validator.safeParse(parsed);
    if (!res.success) {
      const detail = res.error?.message ? ` ${res.error.message}`.slice(0, 500) : "";
      throw new ValidationError(
        `[Agent Accelerator] Structured output validation failed: JSON does not match the output schema.${detail}`
      );
    }
    return res.data ?? parsed;
  }
  return parsed;
}

/**
 * Maps a normalized spec onto OpenAI Responses `text.format`.
 * `{ type: json_schema, name, schema, strict }` (docs: responses/create).
 */
export function mapOutputToOpenAI(spec: StructuredOutputSpec | undefined):
  | {
      format: {
        type: "json_schema";
        name: string;
        schema: Record<string, unknown>;
        strict: boolean;
        description?: string;
      };
    }
  | undefined {
  if (!spec) return undefined;
  return {
    format: {
      type: "json_schema",
      name: spec.name,
      schema: spec.schema,
      strict: spec.strict ?? true,
      ...(spec.description ? { description: spec.description } : {}),
    },
  };
}

/**
 * Maps a normalized spec onto Google Interactions `response_format`.
 * `{ type: text, mime_type: application/json, schema }` (docs: structured-output).
 */
export function mapOutputToGoogle(
  spec: StructuredOutputSpec | undefined
): { responseFormat: { type: "text"; mime_type: "application/json"; schema: Record<string, unknown> } } | undefined {
  if (!spec) return undefined;
  return {
    responseFormat: {
      type: "text",
      mime_type: "application/json",
      schema: spec.schema,
    },
  };
}

/** Chat Completions `response_format` wire shape (OpenRouter + compat). */
export type ChatCompletionsResponseFormat = {
  type: "json_schema";
  json_schema: { name: string; schema: Record<string, unknown>; strict: boolean; description?: string };
};

/**
 * Maps a normalized spec onto Chat Completions `response_format`.
 * `{ type: json_schema, json_schema: { name, schema, strict } }`
 * (docs: openai completions/create, openrouter parameters).
 */
export function mapOutputToOpenRouterChat(
  spec: StructuredOutputSpec | undefined
): { response_format: ChatCompletionsResponseFormat } | undefined {
  if (!spec) return undefined;
  return {
    response_format: {
      type: "json_schema",
      json_schema: {
        name: spec.name,
        schema: spec.schema,
        strict: spec.strict ?? true,
        ...(spec.description ? { description: spec.description } : {}),
      },
    },
  };
}

/**
 * Maps a normalized spec onto generic compat Chat Completions
 * `response_format` (same standard shape as OpenRouter Chat).
 */
export function mapOutputToCompatChat(
  spec: StructuredOutputSpec | undefined
): { response_format: ChatCompletionsResponseFormat } | undefined {
  return mapOutputToOpenRouterChat(spec);
}

/**
 * Builds the emulated structured-output instruction for models without
 * native `response_format` support (catalog `structured_output: false`).
 * Appended to the system prompt so the model still targets JSON; the loop
 * still validates into `AgentResponse.parsed`.
 *
 * @example `augmentSystemPromptWithStructuredOutput(sys, spec)`
 */
export function buildStructuredOutputInstruction(
  spec: StructuredOutputSpec,
  template = DEFAULT_PROMPTS.structuredOutput
): string {
  return fillPrompt(template, { schema: JSON.stringify(spec.schema) });
}

/**
 * Returns a system prompt with the emulated structured-output instruction
 * appended (stable per Agent since `output` is agent-level, so prefix-cache
 * affinity is preserved). No-op when spec is undefined.
 */
export function augmentSystemPromptWithStructuredOutput(
  systemPrompt: string | undefined,
  spec: StructuredOutputSpec | undefined,
  template?: string
): string | undefined {
  if (!spec) return systemPrompt;
  const instruction = `[Structured Output]\n${buildStructuredOutputInstruction(spec, template)}`;
  if (!systemPrompt) return instruction;
  if (systemPrompt.includes(instruction)) return systemPrompt;
  return `${systemPrompt}\n\n${instruction}`;
}

// ---------------------------------------------------------------------------
// Anthropic Messages mappers (pure: all HTTP and wire parsing live in providers/anthropic.ts)
// ---------------------------------------------------------------------------

/** Anthropic `thinking` request value: adaptive (with visible summaries) or one of the "off" shapes some models accept. */
export type AnthropicThinking = { type: "adaptive"; display: "summarized" } | { type: "disabled" | "between_tools" };

/** Anthropic `output_config.effort` values. */
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Maps a canonical ThinkingLevel onto Anthropic 5.x thinking. Thinking is adaptive and on by default, so a level only sets
 * `output_config.effort` and asks for summarized thinking text (the default `display` is "omitted": an empty text plus a signature).
 * `none` uses the model's own off switch (`off`) when it has one, else the lowest effort; `minimal` is `low`; `dynamic` omits everything.
 */
export function mapThinkingLevelToAnthropic(
  level: ThinkingLevel | string | undefined,
  off: { type: "disabled" | "between_tools" } | undefined,
  modelRef: string
): { thinking?: AnthropicThinking; effort?: AnthropicEffort } {
  if (!level) return {};
  const norm = String(level).toLowerCase().trim();
  if (norm === "dynamic") return {};
  if (norm === "none") {
    if (off) return { thinking: off };
    emitProviderWarning({
      provider: "anthropic",
      capability: "thinking level",
      requested: `none (${modelRef})`,
      reason: "this model always thinks and has no off switch.",
      fallback: "adaptive thinking at effort low",
    });
    return { effort: "low" };
  }
  if (norm === "minimal") {
    emitProviderWarning({
      provider: "anthropic",
      capability: "thinking level",
      requested: `minimal (${modelRef})`,
      reason: "Anthropic's lowest effort is low.",
      fallback: "effort low",
    });
    return { thinking: { type: "adaptive", display: "summarized" }, effort: "low" };
  }
  if (norm === "low" || norm === "medium" || norm === "high" || norm === "xhigh" || norm === "max") {
    return { thinking: { type: "adaptive", display: "summarized" }, effort: norm };
  }
  return {};
}

/** Maps canonical ServiceTier onto Anthropic `service_tier`: `priority` is `auto` (use Priority Tier capacity when the account has it); `flex` has no equivalent. */
export function mapServiceTierToAnthropic(tier: ServiceTier | undefined): "auto" | undefined {
  if (!tier) return undefined;
  if (tier === "priority") return "auto";
  emitProviderWarning({
    provider: "anthropic",
    capability: "service tier",
    requested: tier,
    reason: "Anthropic's service_tier is auto or standard_only: there is no flex tier on the Messages API.",
    fallback: "the standard tier (no service_tier is sent)",
  });
  return undefined;
}

/** Anthropic `tool_choice` wire values (`auto` is the server default and is never sent). */
export type AnthropicToolChoice = { type: "none" } | { type: "any" } | { type: "tool"; name: string };

/**
 * Maps canonical toolChoice onto Anthropic `tool_choice`. `required` is `any` and a pinned function is `tool`; models that reject forced
 * tool use (`forcedSupported: false`) and the Google-only `validated` mode warn once and fall back to automatic choice.
 */
export function mapToolChoiceToAnthropic(
  choice: "auto" | "none" | "required" | "validated" | { type: "function"; function: { name: string } } | undefined,
  forcedSupported: boolean,
  modelRef: string
): AnthropicToolChoice | undefined {
  if (!choice || choice === "auto") return undefined;
  if (choice === "none") return { type: "none" };
  if (choice === "validated") {
    warnValidatedToolChoice("anthropic");
    return undefined;
  }
  if (!forcedSupported) {
    emitProviderWarning({
      provider: "anthropic",
      capability: "tool choice",
      requested: `${choice === "required" ? "required" : "a pinned tool"} (${modelRef})`,
      reason: 'this model rejects tool_choice "any" and "tool" with a 400.',
      fallback: "automatic tool choice",
    });
    return undefined;
  }
  if (choice === "required") return { type: "any" };
  const name = choice.function?.name;
  return name ? { type: "tool", name } : undefined;
}

const ANTHROPIC_SCHEMA_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);
const ANTHROPIC_DROPPED_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
] as const;

// Rewrites one JSON Schema node (and its children) into Anthropic's strict subset: objects closed with additionalProperties:false, unsupported constraints moved into the description; in: mapOutputToAnthropic and strict tool schemas, out: the cleaned copy.
function cleanSchemaForAnthropic(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanSchemaForAnthropic);
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = { ...node };
  delete out["$schema"];
  const notes: string[] = [];
  for (const kw of ANTHROPIC_DROPPED_KEYWORDS) {
    if (kw in out) {
      notes.push(`${kw}: ${JSON.stringify(out[kw])}`);
      delete out[kw];
    }
  }
  if (typeof out["minItems"] === "number" && out["minItems"] > 1) {
    notes.push(`minItems: ${out["minItems"]}`);
    delete out["minItems"];
  }
  if (typeof out["format"] === "string" && !ANTHROPIC_SCHEMA_FORMATS.has(out["format"])) {
    notes.push(`format: ${out["format"]}`);
    delete out["format"];
  }
  if ("oneOf" in out && !("anyOf" in out)) {
    out["anyOf"] = out["oneOf"];
    delete out["oneOf"];
  }
  if (out["type"] === "object" || isPlainObject(out["properties"])) out["additionalProperties"] = false;
  for (const key of ["properties", "$defs", "definitions"] as const) {
    const group = out[key];
    if (isPlainObject(group)) {
      out[key] = Object.fromEntries(Object.entries(group).map(([k, v]) => [k, cleanSchemaForAnthropic(v)]));
    }
  }
  for (const key of ["items", "anyOf", "allOf", "prefixItems"] as const) {
    if (key in out) out[key] = cleanSchemaForAnthropic(out[key]);
  }
  if (notes.length > 0) {
    const base = typeof out["description"] === "string" && out["description"] ? `${out["description"]} ` : "";
    out["description"] = `${base}(${notes.join("; ")})`;
  }
  return out;
}

/** A JSON Schema in the subset Anthropic's grammar accepts (strict tools and structured output share it); in: tool parameters or an output spec, out: the wire schema. */
export function anthropicSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return cleanSchemaForAnthropic(schema) as Record<string, unknown>;
}

/**
 * Maps a normalized spec onto Anthropic `output_config.format` (`{ type: json_schema, schema }`, GA, no beta header).
 * The wire has no name or strict flag: the grammar is always enforced. The schema is cleaned to the supported subset; the loop
 * still validates the answer against the original schema.
 */
export function mapOutputToAnthropic(
  spec: StructuredOutputSpec | undefined
): { format: { type: "json_schema"; schema: Record<string, unknown> } } | undefined {
  if (!spec) return undefined;
  return { format: { type: "json_schema", schema: anthropicSchema(spec.schema) } };
}

// ---------------------------------------------------------------------------
// Embedding task mappers (pure: all HTTP and wire parsing live in providers/google-embedding.ts and friends)
// ---------------------------------------------------------------------------

const GOOGLE_TASK_TYPES: Record<EmbeddingTask, string> = {
  search_query: "RETRIEVAL_QUERY",
  search_document: "RETRIEVAL_DOCUMENT",
  question_answering: "QUESTION_ANSWERING",
  fact_checking: "FACT_VERIFICATION",
  code_retrieval: "CODE_RETRIEVAL_QUERY",
  classification: "CLASSIFICATION",
  clustering: "CLUSTERING",
  similarity: "SEMANTIC_SIMILARITY",
};

/** The `taskType` value of Google `gemini-embedding-001` for a canonical embedding task. */
export function mapEmbeddingTaskToGoogleTaskType(task: EmbeddingTask): string {
  return GOOGLE_TASK_TYPES[task];
}

const GOOGLE_QUERY_PREFIXES: Record<Exclude<EmbeddingTask, "search_document">, string> = {
  search_query: "search result",
  question_answering: "question answering",
  fact_checking: "fact checking",
  code_retrieval: "code retrieval",
  classification: "classification",
  clustering: "clustering",
  similarity: "sentence similarity",
};

/**
 * Google `gemini-embedding-2` has no task field: the task is written in front of the text (docs: embeddings, "Task types with
 * Embeddings 2"). A query-side task is `task: <name> | query: <text>`, a document is `title: <title or none> | text: <text>`; no task
 * leaves the text as it is. Only text-only items are prefixed (the docs advise against prefixing the text of a multimodal input).
 */
export function googleEmbeddingText(task: EmbeddingTask | undefined, title: string | undefined, text: string): string {
  if (!task) return text;
  if (task === "search_document") return `title: ${title ?? "none"} | text: ${text}`;
  return `task: ${GOOGLE_QUERY_PREFIXES[task]} | query: ${text}`;
}
