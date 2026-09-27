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
import type { CacheConfig, ServiceTier, ThinkingLevel } from "./types/core.ts";

/** Classification of a canonical capability on a given provider. */
export type ProviderCapabilityStatus =
  | "NATIVE"
  | "TRANSLATED"
  | "AUTOMATIC"
  | "EMULATED"
  | "UNSUPPORTED";

/**
 * Single warning mechanism for provider capability differences.
 *
 * There is no pre-existing logger in `src/` (only CLI logs in
 * `update-models.ts`), so this `console.warn` line IS the mechanism — do not
 * introduce a second one. Used when a requested capability cannot be applied
 * as-is (e.g. Google explicit cache retention) so it never silently
 * disappears.
 *
 * Warnings are deduped per provider+capability+requested: agent loops call
 * mappers once per turn, and repeating the same warning every turn is noise.
 * A repeated identical request logs once per process.
 *
 * @example `emitProviderWarning({ provider: "google", capability: "cache retention", requested: "high", reason: "...", fallback: "..." })`
 */
const emittedWarnings = new Set<string>();

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
  // Leading newline: warnings fire at the start of a turn's request build,
  // when the previous turn's streamed text may have left the terminal cursor
  // mid-line. Without it the warning glues onto streamed output.
  console.warn(
    `\n[Agent Accelerator] WARNING [${options.provider}] ${options.capability}${requested}: ${options.reason} Using ${options.fallback} instead.`
  );
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
 * Google values: minimal|low|medium|high (no off switch, no xhigh).
 */
export function mapThinkingLevelToGoogle(
  level: ThinkingLevel | string | undefined
): { thinkingLevel?: string } {
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
  if (norm === "xhigh") {
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
 * through. `dynamic` omits (server default).
 */
export function mapThinkingLevelToOpenRouterChat(
  level: ThinkingLevel | string | undefined
): { effort?: string } {
  if (!level) return {};
  const norm = String(level).toLowerCase().trim();
  if (norm === "dynamic") return {}; // server default
  if (
    norm === "none" ||
    norm === "minimal" ||
    norm === "low" ||
    norm === "medium" ||
    norm === "high" ||
    norm === "xhigh"
  ) {
    return { effort: norm };
  }
  return {};
}

/**
 * Maps a canonical ThinkingLevel onto OpenRouter Responses `reasoning.effort`.
 * Documented efforts: minimal|low|medium|high (server default medium).
 * Wire-validated extras: `none` disables reasoning output; `xhigh` is echoed
 * but is NOT a documented level, so it clamps to `high` with a warning.
 *
 * @deprecated The Responses skin is discontinued for OpenRouter
 * (`src/providers/openrouter-responses.ts`, archived). Use
 * {@link mapThinkingLevelToOpenRouterChat} with the stable Chat Completions
 * transport instead.
 */
export function mapThinkingLevelToOpenRouter(
  level: ThinkingLevel | string | undefined
): { effort?: string } {
  if (!level) return {};
  const norm = String(level).toLowerCase().trim();
  if (norm === "dynamic") return {}; // server default (medium)
  if (norm === "none") return { effort: "none" };
  if (norm === "xhigh") {
    emitProviderWarning({
      provider: "openrouter",
      capability: "thinking level",
      requested: String(level),
      reason: "OpenRouter documents reasoning efforts up to high.",
      fallback: "reasoning effort high",
    });
    return { effort: "high" };
  }
  if (norm === "minimal" || norm === "low" || norm === "medium" || norm === "high") {
    return { effort: norm };
  }
  return {};
}

/** Maps canonical ServiceTier onto OpenRouter `service_tier` (omit = auto). */
export function mapServiceTierToOpenRouter(tier: ServiceTier | undefined): "flex" | "priority" | undefined {
  if (tier === "flex" || tier === "priority") return tier;
  return undefined;
}

/**
 * Applies canonical cache config for OpenRouter. Session affinity flows via
 * top-level body `session_id` (sent by the adapter) plus the `x-session-id`
 * header fallback; there is no retention body primitive, so explicit
 * retention/cachedContentId are UNSUPPORTED: warn and drop.
 */
export function applyCacheForOpenRouter(
  cache: CacheConfig | undefined,
  modelRef: string
): void {
  if (!cache) return;
  if (cache.retention && cache.retention !== "implicit") {
    emitProviderWarning({
      provider: "openrouter",
      capability: "cache retention",
      requested: `${cache.retention} (${modelRef})`,
      reason: "OpenRouter documents no retention control on the stable Chat Completions endpoint.",
      fallback: "default gateway caching with headers-only session affinity (no retention payload is sent)",
    });
  }
  if (cache.cachedContentId) {
    emitProviderWarning({
      provider: "openrouter",
      capability: "explicit cached content",
      requested: cache.cachedContentId,
      reason: "cached content references do not exist on the Responses API.",
      fallback: "full-history sends instead (cachedContentId is ignored)",
    });
  }
}

/**
 * Applies canonical cache config for custom OpenAI-compatible endpoints.
 * Affinity is headers-only (`x-session-id`): unknown body properties make
 * strict endpoints (groq, ollama, …) fail, so nothing cache-related is ever
 * placed in the body. Explicit retention/cachedContentId are UNSUPPORTED:
 * warn and drop.
 */
export function applyCacheForCustom(
  prefix: string,
  cache: CacheConfig | undefined,
  modelRef: string
): void {
  if (!cache) return;
  if (cache.retention && cache.retention !== "implicit") {
    emitProviderWarning({
      provider: prefix,
      capability: "cache retention",
      requested: `${cache.retention} (${modelRef})`,
      reason: "custom OpenAI-compatible endpoints define no retention control, and strict endpoints reject unknown body properties.",
      fallback: "default caching with headers-only session affinity (no retention payload is sent)",
    });
  }
  if (cache.cachedContentId) {
    emitProviderWarning({
      provider: prefix,
      capability: "explicit cached content",
      requested: cache.cachedContentId,
      reason: "cached content references do not exist on OpenAI-compatible endpoints.",
      fallback: "full-history sends instead (cachedContentId is ignored)",
    });
  }
}

/** OpenRouter Chat Completions `tool_choice` wire values. */
export type OpenRouterChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

/**
 * Maps canonical toolChoice onto Chat Completions `tool_choice`.
 * `auto` is the server default (omitted); `required` is documented
 * (parameters.md) and accepted live (`05`); a function pin passes through
 * verbatim. Note the shape differs from the discontinued Responses skin
 * (`{type:function,name}`): completions nests the name under `function`.
 */
export function mapToolChoiceToOpenRouterChat(
  choice: "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined
): OpenRouterChatToolChoice | undefined {
  if (!choice || choice === "auto") return undefined;
  if (choice === "none" || choice === "required") return choice;
  const name = choice.function?.name;
  if (name) return { type: "function", function: { name } };
  return undefined;
}

/** OpenRouter Responses `tool_choice` wire values.
 * @deprecated Discontinued skin; see {@link OpenRouterChatToolChoice}. */
export type OpenRouterToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };

/**
 * Maps canonical toolChoice onto OpenRouter Responses `tool_choice`.
 * `auto` is the server default (omitted); `required` is natively supported
 * (validated); a function pin passes through verbatim.
 */
export function mapToolChoiceToOpenRouter(
  choice: "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined
): OpenRouterToolChoice | undefined {
  if (!choice || choice === "auto") return undefined;
  if (choice === "none" || choice === "required") return choice;
  const name = choice.function?.name;
  if (name) return { type: "function", name };
  return undefined;
}

/**
 * Maps a canonical ThinkingLevel onto OpenAI Responses `reasoning.effort`.
 * Documented efforts: none|minimal|low|medium|high|xhigh|max (server default
 * medium). Unlike OpenRouter (which clamps xhigh), OpenAI documents xhigh
 * natively so it passes through verbatim. `dynamic` omits (server default).
 */
export function mapThinkingLevelToOpenAI(
  level: ThinkingLevel | string | undefined
): { effort?: string } {
  if (!level) return {};
  const norm = String(level).toLowerCase().trim();
  if (norm === "dynamic") return {}; // server default
  if (
    norm === "none" ||
    norm === "minimal" ||
    norm === "low" ||
    norm === "medium" ||
    norm === "high" ||
    norm === "xhigh"
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

/**
 * Applies canonical cache config for OpenAI. Session affinity flows via
 * `prompt_cache_key` (handled by the adapter); explicit retention control
 * lives in `prompt_cache_options` (gpt-5.6+ explicit breakpoints) which is
 * out of scope for the most-important subset, so retention/cachedContentId
 * are UNSUPPORTED: warn and drop. `prompt_cache_retention` is deprecated.
 */
export function applyCacheForOpenAI(
  cache: CacheConfig | undefined,
  modelRef: string
): void {
  if (!cache) return;
  if (cache.retention && cache.retention !== "implicit") {
    emitProviderWarning({
      provider: "openai",
      capability: "cache retention",
      requested: `${cache.retention} (${modelRef})`,
      reason: "the native Responses adapter uses prompt_cache_key affinity only; explicit retention modes are out of scope.",
      fallback: "default caching with prompt_cache_key affinity (no retention payload is sent)",
    });
  }
  if (cache.cachedContentId) {
    emitProviderWarning({
      provider: "openai",
      capability: "explicit cached content",
      requested: cache.cachedContentId,
      reason: "cached content references do not exist on the Responses API.",
      fallback: "full-history sends instead (cachedContentId is ignored)",
    });
  }
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
  choice: "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined
): OpenAIToolChoice | undefined {
  if (!choice || choice === "auto") return undefined;
  if (choice === "none" || choice === "required") return choice;
  const name = choice.function?.name;
  if (name) return { type: "function", name };
  return undefined;
}

/**
 * Applies canonical cache config for Google. The Interactions API supports
 * implicit/automatic caching ONLY — there is no cache payload to send.
 * Explicit retention/cachedContentId are UNSUPPORTED: warn and drop.
 */
export function applyCacheForGoogle(
  cache: CacheConfig | undefined,
  modelRef: string
): void {
  if (!cache) return;
  if (cache.retention && cache.retention !== "implicit") {
    emitProviderWarning({
      provider: "google",
      capability: "cache retention",
      requested: `${cache.retention} (${modelRef})`,
      reason: "the Interactions API does not support user-defined explicit cache retention.",
      fallback: "Google automatic/implicit caching (no cache payload is sent)",
    });
  }
  if (cache.cachedContentId) {
    emitProviderWarning({
      provider: "google",
      capability: "explicit cached content",
      requested: cache.cachedContentId,
      reason: "cachedContents resources do not exist on the Interactions API.",
      fallback: "stateful interaction chaining / stateless history instead (cachedContentId is ignored)",
    });
  }
}

/** Normalized tool-choice mode shared by provider adapters. */
export type CanonicalToolChoiceMode = "auto" | "any" | "none";

/**
 * Normalizes canonical toolChoice into a provider-neutral mode + optional
 * pinned tool name. Google renders this as
 * `{ allowed_tools: { mode, tools? } }` in its own adapter.
 */
export function normalizeToolChoice(
  choice: "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined,
  availableToolNames: string[]
): { mode: CanonicalToolChoiceMode; tools?: string[] } | undefined {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    if (choice === "auto") return undefined; // server default
    if (choice === "none") return { mode: "none" };
    if (choice === "required") {
      return availableToolNames.length > 0 ? { mode: "any", tools: availableToolNames } : { mode: "any" };
    }
    return undefined;
  }
  const name = choice.function?.name;
  if (name) return { mode: "any", tools: [name] };
  return { mode: "any" };
}

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
  const candidates = [startText + deltaText, deltaText, startText].filter((c) => c && c.trim());
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return { raw: startText + deltaText };
}
