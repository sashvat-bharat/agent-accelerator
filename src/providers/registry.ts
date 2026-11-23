import { ConfigError } from "../types/errors.ts";
import type { Provider, ProviderId, ModelSpec } from "../types/model.ts";
import type { ThinkingLevel } from "../types/core.ts";
import { OpenAICompatibleChatProvider } from "./openai-compat.ts";
import { getModelFromCatalog } from "../models/catalog.ts";
import { getEnv } from "../utils/env.ts";
import { baseUrlSetting } from "../config/settings.ts";
import { GoogleInteractionsProvider } from "./google.ts";
import { OpenRouterChatCompletionsProvider } from "./openrouter.ts";
import { OpenAIResponsesProvider } from "./openai.ts";
import { AnthropicMessagesProvider } from "./anthropic.ts";
import { assertModelAllowed } from "../config/models.ts";

const providerRegistry = new Map<ProviderId, Provider>();

// Google + OpenAI + Anthropic + OpenRouter are served by dedicated native REST adapters
// (`./google.ts` Interactions, `./openai.ts` Responses, `./anthropic.ts` Messages,
// `./openrouter.ts` Chat Completions). Any other prefix is served by the generic native
// OpenAI-compatible Chat Completions adapter (`./openai-compat.ts`).
const googleProvider = new GoogleInteractionsProvider();
const openrouterProvider = new OpenRouterChatCompletionsProvider();
const openaiProvider = new OpenAIResponsesProvider();
const anthropicProvider = new AnthropicMessagesProvider();

providerRegistry.set("google", googleProvider);
providerRegistry.set("gemini", googleProvider);
providerRegistry.set("openrouter", openrouterProvider);
providerRegistry.set("openai", openaiProvider);
providerRegistry.set("anthropic", anthropicProvider);

// ---------------------------------------------------------------------------
// Unified multi-provider layer (all native REST, no SDK transport)
// Any `<prefix>/<model-id>` model works without code changes as long as
// `{PREFIX}_API_KEY` is set and the endpoint is in the `base_urls.<prefix>` setting. Examples:
//   "groq/llama-3.3-70b-versatile" + GROQ_API_KEY + base_urls.groq
//   "cerebras/gpt-oss-120b"        + CEREBRAS_API_KEY + base_urls.cerebras
//   "ollama/qwen2.5-coder"         + base_urls.ollama (key optional for local)
// ---------------------------------------------------------------------------
const FIRST_CLASS = new Set(["google", "gemini", "openrouter", "openai", "anthropic"]);

// Removed providers: fail loudly instead of misrouting. OpenCode free models
// are harness-only since 2026, so the opencode/opencode-go prefixes no longer
// resolve anywhere.
const REMOVED_PROVIDERS = new Set(["opencode", "opencode-go"]);

// The error text for a removed provider prefix; in: assertProviderNotRemoved, out: a message.
function removedProviderMessage(id: string): string {
  return (
    `[Agent Accelerator] Provider "${id}" has been removed: OpenCode free models are ` +
    `harness-only and are no longer served over the API. Use google, openai, anthropic, openrouter, or any ` +
    `OpenAI-compatible endpoint ({PREFIX}_API_KEY + the base_urls.<prefix> setting) instead.`
  );
}

/** Throws for removed provider prefixes. */
function assertProviderNotRemoved(id: string): void {
  if (REMOVED_PROVIDERS.has(id.trim().toLowerCase())) {
    throw new ConfigError(removedProviderMessage(id.trim()));
  }
}

/**
 * Normalizes a provider prefix for registry lookup and environment resolution.
 * @example `const prefix = normalizeProviderPrefix("  Groq/llama  ");`
 */
export function normalizeProviderPrefix(prefix: string): string {
  return prefix.trim().toLowerCase();
}

/**
 * Registers or retrieves a native OpenAI-compatible provider for any custom prefix.
 * Cached, so repeated `resolveModel("groq/...")` calls reuse one instance.
 */
/**
 * Registers or retrieves an OpenAI-compatible provider for any custom prefix.
 *
 * @example `const groq = ensureCustomProvider("groq", { baseUrl: "https://api.groq.com/openai/v1" });`
 */
export function ensureCustomProvider(
  prefix: string,
  opts?: { baseUrl?: string; apiKey?: string; name?: string }
): Provider {
  assertProviderNotRemoved(prefix);
  const id = normalizeProviderPrefix(prefix) as ProviderId;
  if (FIRST_CLASS.has(id.toLowerCase())) {
    if (opts?.baseUrl !== undefined || opts?.apiKey !== undefined) {
      throw new ConfigError(
        `[Agent Accelerator] Provider "${id}" is first-class and cannot be replaced with custom baseUrl/apiKey. Pass baseUrl/apiKey per-Agent instead.`
      );
    }
    const existing = providerRegistry.get(id);
    if (!existing) throw new ConfigError(`[Agent Accelerator] Provider "${id}" is not registered.`);
    return existing;
  }
  const existing = providerRegistry.get(id);
  if (existing) {
    const prevBase = (existing as { configuredBaseUrl?: string }).configuredBaseUrl;
    if (opts?.baseUrl !== undefined && prevBase !== undefined && prevBase !== opts.baseUrl) {
      throw new ConfigError(
        `[Agent Accelerator] Conflicting re-registration for provider "${id}". Registry is immutable after creation.`
      );
    }
    return existing;
  }
  const created = new OpenAICompatibleChatProvider(id, { baseUrl: opts?.baseUrl, name: opts?.name });
  providerRegistry.set(id, created);
  return created;
}

/**
 * Retrieves a provider by ID.
 * Unknown ids auto-create a native OpenAI-compatible provider (unified layer),
 * so `getProvider("groq")` works after setting `GROQ_API_KEY`/`GROQ_BASE_URL`.
 */
/**
 * Retrieves a first-class provider or lazily creates a custom compatible provider.
 *
 * @example `const provider = getProvider("google");`
 */
export function getProvider(id: ProviderId | string): Provider {
  const key = String(id).trim() as ProviderId;
  assertProviderNotRemoved(key);
  const provider = providerRegistry.get(key);
  if (provider) return provider;
  if (!key) {
    throw new ConfigError(
      `Provider '' is not supported or not registered. Available first-support providers: google, openrouter, openai, anthropic — or any custom prefix via {PREFIX}_API_KEY + the base_urls.<prefix> setting.`
    );
  }
  // Unified layer: lazily create a native OpenAI-compatible provider for any custom prefix.
  return ensureCustomProvider(key);
}

/** Provider/model pair returned by resolveModel. */
export interface ResolvedModel {
  provider: Provider;
  modelId: string;
  modelSpec?: ModelSpec;
}

/**
 * Resolves a model string (e.g. "google/model-id", "openai/gpt-5.5", "openrouter/scope/model:variant")
 * or ModelSpec into provider instance and model ID.
 */
/**
 * Resolves `provider/model`, catalog specs, scoped OpenRouter IDs, and custom prefixes.
 *
 * @example `const { provider, modelId } = resolveModel("openai/gpt-5.5");`
 */
export function resolveModel(model: string | ModelSpec): ResolvedModel {
  const resolved = resolveModelUnchecked(model);
  assertModelAllowed(resolved.provider.id, resolved.modelId); // the program's list (`setModels`), when it set one
  return resolved;
}

/** Same routing as {@link resolveModel} without the allowed-models check: for code that only needs to know WHERE a model goes (provider matching, early checks that report their own error). */
export function resolveModelUnchecked(model: string | ModelSpec): ResolvedModel {
  if (!model || (typeof model === "string" && !model.trim())) {
    throw new ConfigError(
      "[Agent Accelerator] No model specified. Pass 'model' in the Agent configuration, or set a default list with setModels() or a saved choice with setModel()."
    );
  }

  if (typeof model === "object" && model !== null && "provider" in model) {
    const provider = getProvider(model.provider);
    // Enrich with catalog if available
    const catalogSpec = getModelFromCatalog(model.provider, model.id);
    return {
      provider,
      modelId: model.id,
      modelSpec: catalogSpec || model,
    };
  }

  const modelStr = String(model).trim();

  // Try catalog first for any provider/model
  const tryCatalogLookup = (prov: string, mid: string): ModelSpec | undefined => {
    return (
      getModelFromCatalog(prov, mid) || getModelFromCatalog(prov.toLowerCase(), mid) || getModelFromCatalog(mid, mid)
    );
  };

  const hasCustomOpenAIBase = !!baseUrlSetting("openai");

  // Explicit prefix with slash — deterministic
  if (modelStr.includes("/")) {
    const parts = modelStr.split("/");
    const providerPrefix = (parts[0] ?? "").toLowerCase();
    const remainingModel = parts.slice(1).join("/");
    assertProviderNotRemoved(providerPrefix);

    // 1. Explicit openai/ prefix ALWAYS routes to OpenAI provider
    if (providerPrefix === "openai") {
      const p = getProvider("openai");
      const spec =
        p.getModel(remainingModel) ||
        getModelFromCatalog("openai", remainingModel) ||
        getModelFromCatalog(remainingModel, remainingModel);
      return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
    }

    // 1b. Explicit anthropic/ prefix routes to the native Messages adapter
    if (providerPrefix === "anthropic") {
      const p = getProvider("anthropic");
      const spec =
        p.getModel(remainingModel) ||
        getModelFromCatalog("anthropic", remainingModel) ||
        getModelFromCatalog(remainingModel, remainingModel);
      return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
    }

    // 2. Unified layer: any non-first-class prefix routes to auto-created custom provider
    const isExplicitOther = ["google", "gemini", "openrouter"].includes(providerPrefix);

    if (!isExplicitOther && providerPrefix !== "openai") {
      const envName = providerPrefix.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      const hasDedicatedEnv = !!(
        baseUrlSetting(providerPrefix) ||
        getEnv(`${envName}_API_KEY`) ||
        getEnv(`${envName}_BASE_API_KEY`)
      );

      const looksLikeOpenRouterScope = parts.length === 2 && modelStr.includes(":") && !hasDedicatedEnv;

      if (!looksLikeOpenRouterScope) {
        const custom = ensureCustomProvider(providerPrefix);
        const spec =
          custom.getModel(remainingModel) ||
          custom.getModel(modelStr) ||
          tryCatalogLookup(providerPrefix, remainingModel) ||
          tryCatalogLookup(providerPrefix, modelStr) ||
          getModelFromCatalog(remainingModel, remainingModel);
        return { provider: custom, modelId: remainingModel, modelSpec: spec as ModelSpec };
      }
    }

    if (providerPrefix === "google" || providerPrefix === "gemini") {
      const p = getProvider("google");
      const spec =
        p.getModel(remainingModel) ||
        getModelFromCatalog("google", remainingModel) ||
        getModelFromCatalog(remainingModel, remainingModel);
      return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
    }

    if (providerPrefix === "openrouter") {
      const p = getProvider("openrouter");
      const spec =
        p.getModel(remainingModel) ||
        getModelFromCatalog("openrouter", remainingModel) ||
        getModelFromCatalog(remainingModel, remainingModel);
      return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
    }

    // Scoped OpenRouter models like "scope/model:variant" without openrouter prefix
    if (parts.length === 2 && modelStr.includes(":")) {
      const p = getProvider("openrouter");
      const spec = p.getModel(modelStr) || tryCatalogLookup("openrouter", modelStr);
      return { provider: p, modelId: modelStr, modelSpec: spec as ModelSpec };
    }

    // Check catalog for this exact provider/model
    const catalogSpec = tryCatalogLookup(providerPrefix, remainingModel) || tryCatalogLookup(providerPrefix, modelStr);
    if (catalogSpec) {
      const internalProvider = getProvider(catalogSpec.provider);
      return { provider: internalProvider, modelId: catalogSpec.id, modelSpec: catalogSpec };
    }

    // Unknown provider prefix — try catalog with priority
    const prioritizedUnknown =
      tryCatalogLookup(providerPrefix, remainingModel) ||
      tryCatalogLookup("google", remainingModel) ||
      tryCatalogLookup("openai", remainingModel) ||
      tryCatalogLookup("anthropic", remainingModel) ||
      tryCatalogLookup("openrouter", remainingModel) ||
      getModelFromCatalog(modelStr, modelStr);
    if (prioritizedUnknown) {
      const internalProvider = getProvider(prioritizedUnknown.provider);
      return {
        provider: internalProvider,
        modelId: prioritizedUnknown.id,
        modelSpec: prioritizedUnknown,
      };
    }

    // Fallback custom provider
    const fallbackCustom = ensureCustomProvider(providerPrefix);
    const fallbackSpec = fallbackCustom.getModel(remainingModel) || fallbackCustom.getModel(modelStr);
    return {
      provider: fallbackCustom,
      modelId: remainingModel,
      modelSpec: fallbackSpec as ModelSpec,
    };
  }

  // When the `base_urls.openai` setting is set: trust the program completely
  if (hasCustomOpenAIBase) {
    const p = getProvider("openai");
    const spec = p.getModel(modelStr) || getModelFromCatalog(modelStr, modelStr);
    return { provider: p, modelId: modelStr, modelSpec: spec as ModelSpec };
  }

  // No slash — try catalog with internal provider priority
  const prioritized =
    tryCatalogLookup("google", modelStr) ||
    tryCatalogLookup("openai", modelStr) ||
    tryCatalogLookup("anthropic", modelStr) ||
    tryCatalogLookup("openrouter", modelStr) ||
    getModelFromCatalog(modelStr, modelStr);
  if (prioritized) {
    const internalProvider = getProvider(prioritized.provider);
    return { provider: internalProvider, modelId: prioritized.id, modelSpec: prioritized };
  }

  // Fallback to openrouter
  const p = getProvider("openrouter");
  return { provider: p, modelId: modelStr, modelSpec: p.getModel(modelStr) };
}

/** Configuration accepted by the ModelProvider helper family. */
export interface ModelProviderConfig {
  apiKey?: string;
  thinkingLevel?: ThinkingLevel;
  baseUrl?: string;
}

/** Serializable model/provider selection returned by ModelProvider helpers. */
export interface ModelProviderInstance {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  thinkingLevel?: ThinkingLevel;
}

/**
 * ModelProvider builder helper for python-like and expressive syntax
 */
/**
 * Provider/model builder helpers for expressive configuration.
 *
 * @example `new Agent({ model: ModelProvider.GoogleGenAI("gemini-3.5-flash-lite") })`
 */
export const ModelProvider = {
  /** Builds a Google AI Studio model selection. @example `ModelProvider.GoogleGenAI("gemini-3.5-flash-lite")` */
  GoogleGenAI(
    model: string,
    apiKey?: string,
    options?: { thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return {
      model: model.startsWith("google/") ? model : `google/${model}`,
      apiKey,
      baseUrl: options?.baseUrl,
      thinkingLevel: options?.thinkingLevel,
    };
  },

  /** Builds an OpenRouter model selection. @example `ModelProvider.OpenRouter("openai/gpt-5.5")` */
  OpenRouter(
    model: string,
    apiKey?: string,
    options?: { thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return {
      model: model.startsWith("openrouter/") ? model : `openrouter/${model}`,
      apiKey,
      baseUrl: options?.baseUrl,
      thinkingLevel: options?.thinkingLevel,
    };
  },

  /** Builds an OpenAI model selection. @example `ModelProvider.OpenAI("gpt-5.5")` */
  OpenAI(
    model: string,
    apiKey?: string,
    options?: { thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return {
      model: model.startsWith("openai/") ? model : `openai/${model}`,
      apiKey,
      baseUrl: options?.baseUrl,
      thinkingLevel: options?.thinkingLevel,
    };
  },

  /** Builds an Anthropic model selection. @example `ModelProvider.Anthropic("claude-sonnet-5-5")` */
  Anthropic(
    model: string,
    apiKey?: string,
    options?: { thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return {
      model: model.startsWith("anthropic/") ? model : `anthropic/${model}`,
      apiKey,
      baseUrl: options?.baseUrl,
      thinkingLevel: options?.thinkingLevel,
    };
  },

  /** Builds an arbitrary OpenAI-compatible model selection. @example `ModelProvider.Custom("groq/llama-3.3-70b-versatile")` */
  Custom(
    model: string,
    apiKey?: string,
    options?: { thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    const normalized = model.includes("/") ? model : `custom/${model}`;
    return {
      model: normalized,
      apiKey,
      baseUrl: options?.baseUrl,
      thinkingLevel: options?.thinkingLevel,
    };
  },

  /** Alias for Custom for explicit OpenAI-compatible endpoints. @example `ModelProvider.OpenAICompatible("ollama/qwen2.5-coder")` */
  OpenAICompatible(
    model: string,
    apiKey?: string,
    options?: { thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return ModelProvider.Custom(model, apiKey, options);
  },

  /** Alias for Custom for generic local/hosted endpoints. @example `ModelProvider.Generic("my-provider/model-id")` */
  Generic(
    model: string,
    apiKey?: string,
    options?: { thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return ModelProvider.Custom(model, apiKey, options);
  },
};
