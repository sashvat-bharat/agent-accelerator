/**
 * Model catalog — battle-tested single source of truth (models.dev)
 * Stored at src/data/models.dev.json (fetched from https://models.dev/api.json)
 * All context length, pricing, limits, reasoning, modalities come from here.
 * Providers' hardcoded GOOGLE_MODELS etc. are DEPRECATED fallbacks only.
 */

import catalogData from "../data/models.dev.json" with { type: "json" };
import type { ModelSpec, ProviderId, ModelLimit, ModelCost, ModelModalities } from "../types/model.ts";
import type { ThinkingLevel } from "../types/core.ts";

// ---------------------------------------------------------------------------
// Provider aliases — maps our internal ids to models.dev keys
// battle-tested: opencode covers zen/go, google covers vertex variants
// ---------------------------------------------------------------------------
const PROVIDER_ALIASES: Record<string, string[]> = {
  google: ["google", "google-vertex", "google-vertex-anthropic"],
  opencode: ["opencode", "opencode-zen", "opencode-go"],
  "opencode-zen": ["opencode"],
  "opencode-go": ["opencode-go", "opencode"],
  openrouter: ["openrouter"],
  openai: ["openai"],
};

// Verified modality corrections — models.dev lags on some inputs (e.g. gpt-4o
// accepts audio). Keyed `provider/model`, merged over upstream data so
// `npm run update-models` never wipes them. Add entries here, not in the JSON.
const MODALITY_OVERRIDES: Record<string, { input?: string[]; output?: string[] }> = {
  "openai/gpt-4o": { input: ["text", "image", "audio", "pdf"] },
  "openai/gpt-4o-mini": { input: ["text", "image", "audio", "pdf"] },
  // OpenRouter routes this free model to an endpoint that parses PDFs,
  // verified end-to-end via examples/08. If routing changes, the runtime
  // 404 still surfaces as a one-line error.
  "openrouter/nvidia/nemotron-3.5-lightning:free": { input: ["text", "pdf"] },
};

function applyModalityOverrides(provider: string, modelId: string, base: ModelModalities): ModelModalities {
  const hit =
    MODALITY_OVERRIDES[`${provider}/${modelId}`] ??
    MODALITY_OVERRIDES[`${provider}/${normalizeModelIdForLookup(modelId)}`];
  if (!hit) return base;
  return {
    input: ((hit.input ?? base.input) as ModelModalities["input"]),
    output: ((hit.output ?? base.output) as ModelModalities["output"]),
  };
}

function normalizeModelIdForLookup(modelId: string): string {
  if (modelId.includes("/")) {
    const parts = modelId.split("/");
    return parts.slice(1).join("/");
  }
  return modelId;
}

// ---------------------------------------------------------------------------
// Internal cache — battle-tested: avoid repeated global scans (7487 models)
// ---------------------------------------------------------------------------
const lookupCache = new Map<string, ModelSpec | undefined>();
const providerModelsCache = new Map<string, ModelSpec[]>();

function mapCapabilities(raw: any, cost: ModelCost, reasoning: boolean, toolCall: boolean, modalities: ModelModalities) {
  return {
    supportsThinking: reasoning,
    supportsThinkingLevel: !!raw.reasoning_options,
    supportsThinkingBudget: Array.isArray(raw.reasoning_options) && raw.reasoning_options.some((o: any) => o.type === "budget_tokens"),
    supportsImplicitCaching: cost.cache_read !== undefined || cost.cache_write !== undefined,
    supportsLongCacheRetention: cost.cache_read !== undefined,
    supportsExplicitCaching: cost.cache_read !== undefined,
    supportsParallelToolCalls: toolCall,
    supportsStreaming: true,
    supportsReasoningToggle: Array.isArray(raw.reasoning_options) && raw.reasoning_options.some((o: any) => o.type === "toggle"),
    supportsReasoningEffort: Array.isArray(raw.reasoning_options) && raw.reasoning_options.some((o: any) => o.type === "effort"),
    modalities: [...(modalities.input || []), ...(modalities.output || [])].filter((v: any, i: any, a: any) => a.indexOf(v) === i),
  };
}

function mapModelSpec(provider: string, modelId: string, raw: any): ModelSpec {
  const limit: ModelLimit = raw.limit || { context: 128000, output: 8192 };
  const cost: ModelCost = raw.cost || {};
  const modalities: ModelModalities = applyModalityOverrides(
    provider,
    modelId,
    raw.modalities || { input: ["text"], output: ["text"] }
  );
  const reasoning = !!raw.reasoning;
  const toolCall = !!raw.tool_call;

  // Ensure limit.context / limit.output exist
  const contextWindow = limit.context ?? limit.input ?? 128000;
  const maxOutputTokens = limit.output ?? 8192;

  const mergedLimit: ModelLimit = Object.assign({ context: contextWindow, output: maxOutputTokens }, limit);
  return {
    id: raw.id || modelId,
    provider: provider as ProviderId,
    name: raw.name || modelId,
    description: raw.description,
    family: raw.family,
    api: raw.provider?.api || raw.api,
    contextWindow,
    maxOutputTokens,
    // Battle-tested full fields
    limit: mergedLimit,
    cost,
    modalities,
    reasoning: raw.reasoning,
    reasoning_options: raw.reasoning_options,
    tool_call: raw.tool_call,
    attachment: raw.attachment,
    knowledge: raw.knowledge,
    release_date: raw.release_date,
    last_updated: raw.last_updated,
    capabilities: mapCapabilities(raw, cost, reasoning, toolCall, modalities),
    pricing: {
      inputPerMillion: cost.input,
      outputPerMillion: cost.output,
      cacheReadPerMillion: cost.cache_read,
      cacheWritePerMillion: cost.cache_write,
      inputAudioPerMillion: cost.input_audio,
    },
    raw,
  };
}

interface IndexEntry {
  provider: ProviderId;
  key: string;
  raw: any;
}

let globalIndex: Map<string, IndexEntry> | null = null;

function getGlobalIndex(): Map<string, IndexEntry> {
  if (globalIndex) return globalIndex;
  globalIndex = new Map();
  for (const [p, providerData] of Object.entries(catalogData as Record<string, any>)) {
    const models = (providerData as any)?.models;
    if (!models) continue;
    for (const [key, raw] of Object.entries(models as Record<string, any>)) {
      const entry: IndexEntry = { provider: p as ProviderId, key, raw };
      const lowerKey = key.toLowerCase();
      if (!globalIndex.has(lowerKey)) globalIndex.set(lowerKey, entry);
      const stripped = normalizeModelIdForLookup(key).toLowerCase();
      if (!globalIndex.has(stripped)) globalIndex.set(stripped, entry);
      const withSlash = `${p}/${stripped}`.toLowerCase();
      if (!globalIndex.has(withSlash)) globalIndex.set(withSlash, entry);
    }
  }
  return globalIndex;
}

// ---------------------------------------------------------------------------
// Public: getModelFromCatalog — battle-tested, cached, alias-aware
// ---------------------------------------------------------------------------
/**
 * Looks up one model using provider aliases, normalized IDs, and the global catalog index.
 *
 * @example `const model = getModelFromCatalog("google", "gemini-3.5-flash-lite");`
 */
export function getModelFromCatalog(providerInput: string, modelIdInput: string): ModelSpec | undefined {
  const cacheKey = `${providerInput}::${modelIdInput}`;
  if (lookupCache.has(cacheKey)) return lookupCache.get(cacheKey);

  const provider = providerInput.toLowerCase();
  const modelId = modelIdInput.trim();
  let result: ModelSpec | undefined;

  const aliasProviders = PROVIDER_ALIASES[provider] || [provider];
  const tryProviders = [...new Set([...aliasProviders, provider, provider.replace("-zen", ""), provider.replace("-go", "")])];

  for (const p of tryProviders) {
    const providerData: any = (catalogData as any)[p];
    if (!providerData?.models) continue;
    const candidates = [
      modelId,
      normalizeModelIdForLookup(modelId),
      `${p}/${normalizeModelIdForLookup(modelId)}`,
      `${p}/${modelId}`,
    ];
    for (const cand of candidates) {
      const raw = providerData.models[cand];
      if (raw) {
        result = mapModelSpec(p as ProviderId, cand, raw);
        lookupCache.set(cacheKey, result);
        return result;
      }
    }
    for (const [key, raw] of Object.entries(providerData.models as Record<string, any>)) {
      if (key === modelId || key.endsWith(`/${modelId}`) || modelId.endsWith(key) || normalizeModelIdForLookup(key) === normalizeModelIdForLookup(modelId)) {
        result = mapModelSpec(p as ProviderId, key, raw as any);
        lookupCache.set(cacheKey, result);
        return result;
      }
    }
  }

  // Global O(1) fallback via indexed catalog
  const index = getGlobalIndex();
  const lowerModelId = modelId.toLowerCase();
  const strippedLower = normalizeModelIdForLookup(modelId).toLowerCase();
  const hit = index.get(lowerModelId) || index.get(strippedLower);
  if (hit) {
    result = mapModelSpec(hit.provider, hit.key, hit.raw);
    lookupCache.set(cacheKey, result);
    return result;
  }

  lookupCache.set(cacheKey, undefined);
  return undefined;
}

/** Thinking capabilities and allowed levels for a catalog model. */
export interface ModelThinkingInfo {
  supportsThinking: boolean;
  reasoningOptions?: any[];
  allowedLevels: string[];
  supportsDisable: boolean;
  description: string;
}

/**
 * Returns reasoning support and permitted ThinkingLevel values for a model.
 *
 * @example `const info = getModelThinkingInfo("google", "gemini-3.5-flash-lite");`
 */
export function getModelThinkingInfo(provider: string, modelId: string): ModelThinkingInfo {
  const spec = getModelFromCatalog(provider, modelId) || getModelFromCatalog(modelId, modelId);
  if (!spec) {
    return {
      supportsThinking: true,
      allowedLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "dynamic"],
      supportsDisable: true,
      description: "Model not found in catalog; generic thinking levels allowed.",
    };
  }

  const supportsThinking = !!spec.reasoning || spec.capabilities.supportsThinking;
  const reasoningOptions = spec.reasoning_options || [];

  if (!supportsThinking) {
    return {
      supportsThinking: false,
      reasoningOptions: [],
      allowedLevels: ["none"],
      supportsDisable: true,
      description: `Model "${spec.id}" does not support thinking/reasoning.`,
    };
  }

  // Model supports thinking — inspect reasoning_options from models.dev.json
  const effortOpt: any = reasoningOptions.find((o: any) => o.type === "effort");
  const toggleOpt: any = reasoningOptions.find((o: any) => o.type === "toggle");
  const budgetOpt: any = reasoningOptions.find((o: any) => o.type === "budget_tokens");

  const allowed = new Set<string>();

  if (effortOpt && Array.isArray(effortOpt.values) && effortOpt.values.length > 0) {
    for (const val of effortOpt.values) {
      allowed.add(String(val).toLowerCase());
    }
  }

  if (toggleOpt) {
    allowed.add("none");
    allowed.add("low");
    allowed.add("medium");
    allowed.add("high");
    allowed.add("dynamic");
    allowed.add("minimal");
  }

  if (budgetOpt) {
    if (budgetOpt.min === undefined || budgetOpt.min <= 0) {
      allowed.add("none");
    }
    allowed.add("dynamic");
    allowed.add("minimal");
    allowed.add("low");
    allowed.add("medium");
    allowed.add("high");
    allowed.add("xhigh");
  }

  // Fixed reasoning model (no reasoning_options) e.g. DeepSeek-R1, QwQ-32B
  if (reasoningOptions.length === 0) {
    return {
      supportsThinking: true,
      reasoningOptions: [],
      allowedLevels: [],
      supportsDisable: false,
      description: `Model "${spec.id}" is a fixed-reasoning model and does not support configurable thinking levels.`,
    };
  }

  const allowedLevels = Array.from(allowed);
  const supportsDisable = allowed.has("none") || !!toggleOpt || Boolean(budgetOpt && (budgetOpt.min === undefined || budgetOpt.min <= 0));

  return {
    supportsThinking: true,
    reasoningOptions,
    allowedLevels,
    supportsDisable,
    description: `Supported thinking levels for "${spec.id}": [${allowedLevels.map((l) => `"${l}"`).join(", ")}]`,
  };
}

/** Thrown when a requested ThinkingLevel is unsupported by the selected model. */
export class ThinkingLevelError extends Error {
  readonly provider: string;
  readonly modelId: string;
  readonly requestedLevel: string;
  readonly allowedLevels: string[];
  readonly supportsThinking: boolean;

  /**
   * Creates a descriptive validation error for an unsupported thinking level.
   *
   * @param opts Provider/model, requested level, supported levels, and remedy.
   */
  constructor(opts: {
    provider: string;
    modelId: string;
    requestedLevel: string;
    allowedLevels: string[];
    supportsThinking: boolean;
    reason: string;
    remedy?: string;
  }) {
    const remedyLines = opts.remedy
      ? `\n\n  \x1b[36m💡 How to fix:\x1b[0m\n    ${opts.remedy}`
      : "";
    const allowedLine = opts.allowedLevels.length > 0
      ? `\n  \x1b[1mAllowed Levels:\x1b[0m  [${opts.allowedLevels.map((l) => `"${l}"`).join(", ")}]`
      : "";

    const formattedMessage =
      `\x1b[31m[Agent Accelerator] ThinkingLevel Mismatch for "${opts.provider}/${opts.modelId}":\x1b[0m\n` +
      `  \x1b[1mRequested Level:\x1b[0m "${opts.requestedLevel}"\n` +
      `  \x1b[1mIssue:\x1b[0m           ${opts.reason}` +
      allowedLine +
      remedyLines;

    super(formattedMessage);
    this.name = "ThinkingLevelError";
    this.provider = opts.provider;
    this.modelId = opts.modelId;
    this.requestedLevel = opts.requestedLevel;
    this.allowedLevels = opts.allowedLevels;
    this.supportsThinking = opts.supportsThinking;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ThinkingLevelError);
    }
  }
}

/**
 * Validates a ThinkingLevel against catalog metadata and throws ThinkingLevelError on mismatch.
 *
 * @example `validateModelThinking("google", "gemini-3.5-flash-lite", "medium");`
 */
export function validateModelThinking(provider: string, modelId: string, requestedLevel?: ThinkingLevel | string): void {
  if (!requestedLevel) return;
  const level = String(requestedLevel).toLowerCase().trim();
  const info = getModelThinkingInfo(provider, modelId);

  if (!info.supportsThinking) {
    if (level !== "none") {
      throw new ThinkingLevelError({
        provider,
        modelId,
        requestedLevel: String(requestedLevel),
        allowedLevels: [],
        supportsThinking: false,
        reason: `Model "${modelId}" does not support thinking/reasoning.`,
        remedy: `Omit thinkingLevel or set thinkingLevel: "none".`,
      });
    }
    return;
  }

  // Fixed reasoning model
  if (info.allowedLevels.length === 0) {
    if (level === "none") {
      throw new ThinkingLevelError({
        provider,
        modelId,
        requestedLevel: String(requestedLevel),
        allowedLevels: [],
        supportsThinking: true,
        reason: `Model "${modelId}" is a fixed-reasoning model and cannot have thinking disabled ("none").`,
        remedy: `Omit thinkingLevel to use the model's default reasoning.`,
      });
    }
    return;
  }

  // If user requested "none" on a model that does not allow disabling
  if (level === "none" && !info.supportsDisable) {
    throw new ThinkingLevelError({
      provider,
      modelId,
      requestedLevel: String(requestedLevel),
      allowedLevels: info.allowedLevels,
      supportsThinking: true,
      reason: `Model "${modelId}" requires thinking and does not support disabling it ("none").`,
      remedy: `Set thinkingLevel to one of: ${info.allowedLevels.map((l) => `"${l}"`).join(" | ")}, or omit thinkingLevel to use the model default.`,
    });
  }

  // If level is not in allowed levels
  if (!info.allowedLevels.includes(level)) {
    throw new ThinkingLevelError({
      provider,
      modelId,
      requestedLevel: String(requestedLevel),
      allowedLevels: info.allowedLevels,
      supportsThinking: true,
      reason: `Invalid thinking level "${requestedLevel}" for model "${modelId}".`,
      remedy: `Set thinkingLevel to one of: ${info.allowedLevels.map((l) => `"${l}"`).join(" | ")}, or omit thinkingLevel to use the model default.`,
    });
  }
}

// ---------------------------------------------------------------------------
// getModelsForProvider — battle-tested view for BaseProvider.models
// Opencode total context length now comes from catalog, not stale hardcoded file.
// ---------------------------------------------------------------------------
/**
 * Returns normalized catalog specs for a provider and its configured aliases.
 *
 * @example `const googleModels = getModelsForProvider("google");`
 */
export function getModelsForProvider(provider: string): ModelSpec[] {
  if (providerModelsCache.has(provider)) return providerModelsCache.get(provider)!;
  const aliases = PROVIDER_ALIASES[provider] || [provider];
  const seen = new Set<string>();
  const out: ModelSpec[] = [];
  for (const alias of aliases) {
    const data: any = (catalogData as any)[alias];
    if (!data?.models) continue;
    for (const [key, raw] of Object.entries(data.models as Record<string, any>)) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(mapModelSpec(alias as ProviderId, key, raw));
    }
  }
  // Also include our internal provider id mapping
  providerModelsCache.set(provider, out);
  return out;
}

export const GOOGLE_MODELS: ModelSpec[] = getModelsForProvider("google");
export const OPENAI_MODELS: ModelSpec[] = getModelsForProvider("openai");
export const OPENCODE_MODELS: ModelSpec[] = getModelsForProvider("opencode");
export const OPENROUTER_MODELS: ModelSpec[] = getModelsForProvider("openrouter");
