import type { Provider, ProviderId, ModelSpec } from "../types/model.ts";
import type { ThinkingLevel } from "../types/core.ts";
import { GoogleAIStudioProvider } from "./google/index.ts";
import { OpenCodeProvider } from "./opencode/index.ts";
import { OpenRouterProvider } from "./openrouter/index.ts";
import { getModelFromCatalog } from "../models/catalog.ts";

const providerRegistry = new Map<ProviderId, Provider>();

// Initialize default supported providers
const googleProvider = new GoogleAIStudioProvider();
const opencodeProvider = new OpenCodeProvider();
const openrouterProvider = new OpenRouterProvider();

providerRegistry.set("google", googleProvider);
providerRegistry.set("opencode", opencodeProvider);
providerRegistry.set("opencode-zen", opencodeProvider);
providerRegistry.set("opencode-go", opencodeProvider);
providerRegistry.set("openrouter", openrouterProvider);

/**
 * Registers or overrides a provider
 */
export function registerProvider(provider: Provider): void {
  providerRegistry.set(provider.id, provider);
}

/**
 * Retrieves a provider by ID
 */
export function getProvider(id: ProviderId | string): Provider {
  const provider = providerRegistry.get(id as ProviderId);
  if (!provider) {
    throw new Error(
      `Provider '${id}' is not supported or not registered. Available first-support providers: google, opencode, openrouter.`
    );
  }
  return provider;
}

export interface ResolvedModel {
  provider: Provider;
  modelId: string;
  modelSpec?: ModelSpec;
}

/**
 * Resolves a model string (e.g. "google/gemini-3.5-flash-lite", "opencode-zen/hy3-free", "openrouter/...")
 * or ModelSpec into provider instance and model ID
 * Now uses models.dev catalog (src/data/models.dev.json) as single source of truth for
 * context-length, pricing, thinking levels, modalities etc. — whatever model user passes is validated here.
 */
export function resolveModel(model: string | ModelSpec): ResolvedModel {
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

  // Try catalog first for any provider/model — handles all 7487 models from models.dev
  // This checks provider prefix + model id against the stored json
  const tryCatalogLookup = (prov: string, mid: string): ModelSpec | undefined => {
    return getModelFromCatalog(prov, mid) || getModelFromCatalog(prov.toLowerCase(), mid) || getModelFromCatalog(mid, mid);
  };

  // Explicit prefix with slash — deterministic
  if (modelStr.includes("/")) {
    const parts = modelStr.split("/");
    const providerPrefix = parts[0]!.toLowerCase();
    const remainingModel = parts.slice(1).join("/");

    // Check catalog first for this exact provider/model
    const catalogSpec = tryCatalogLookup(providerPrefix, remainingModel) || tryCatalogLookup(providerPrefix, modelStr);
    // If found in catalog, use that spec and route via appropriate provider (fallback to openrouter for unknown providers)
    if (catalogSpec) {
      // Map catalog provider to our internal provider (opencode, google, openrouter keep, others fallback to openrouter)
      const internalProvider = providerRegistry.has(catalogSpec.provider as ProviderId) ? getProvider(catalogSpec.provider) : getProvider("openrouter");
      return { provider: internalProvider, modelId: catalogSpec.id, modelSpec: catalogSpec };
    }

    if (providerPrefix === "google" || providerPrefix === "gemini") {
      const p = getProvider("google");
      const spec = p.getModel(remainingModel) || tryCatalogLookup("google", remainingModel);
      return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
    }
    if (
      providerPrefix === "opencode" ||
      providerPrefix === "opencode-zen" ||
      providerPrefix === "opencode-go"
    ) {
      const p = getProvider("opencode");
      const spec = p.getModel(remainingModel) || tryCatalogLookup("opencode", remainingModel);
      return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
    }
    if (providerPrefix === "openrouter") {
      const p = getProvider("openrouter");
      const spec = p.getModel(remainingModel) || tryCatalogLookup("openrouter", remainingModel);
      return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
    }
    // For scoped OpenRouter models like "z-ai/glm-5.2:free" without openrouter prefix,
    if (parts.length === 2 && modelStr.includes(":")) {
      const p = getProvider("openrouter");
      const spec = p.getModel(modelStr) || tryCatalogLookup("openrouter", modelStr);
      return { provider: p, modelId: modelStr, modelSpec: spec as ModelSpec };
    }
    // Unknown provider prefix — try catalog with priority, else fallback to openrouter with full id (U7)
    const prioritizedUnknown = tryCatalogLookup(providerPrefix, remainingModel) || tryCatalogLookup("google", remainingModel) || tryCatalogLookup("opencode", remainingModel) || tryCatalogLookup("openrouter", remainingModel) || getModelFromCatalog(modelStr, modelStr);
    if (prioritizedUnknown) {
      const internalProvider = providerRegistry.has(prioritizedUnknown.provider as ProviderId) ? getProvider(prioritizedUnknown.provider) : getProvider("openrouter");
      return { provider: internalProvider, modelId: prioritizedUnknown.id, modelSpec: prioritizedUnknown };
    }
  }

  // No slash or unknown — try catalog with internal provider priority (U7 fix: deterministic, not insertion order)
  const prioritized = tryCatalogLookup("google", modelStr) || tryCatalogLookup("opencode", modelStr) || tryCatalogLookup("openrouter", modelStr) || getModelFromCatalog(modelStr, modelStr);
  if (prioritized) {
    const internalProvider = providerRegistry.has(prioritized.provider as ProviderId) ? getProvider(prioritized.provider) : getProvider("openrouter");
    return { provider: internalProvider, modelId: prioritized.id, modelSpec: prioritized };
  }

  // Fallback to openrouter (keeps SDK lightweight, not per-model hardcoded — catalog is source of truth)
  // Note: gemini-*, hy3, etc. are handled by catalog lookup above, not manual ifs (generic)
  const p = getProvider("openrouter");
  return { provider: p, modelId: modelStr, modelSpec: p.getModel(modelStr) };
}

export interface ModelProviderConfig {
  apiKey?: string;
  thinking_level?: ThinkingLevel;
  thinkingLevel?: ThinkingLevel;
  baseUrl?: string;
}

export interface ModelProviderInstance {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  thinkingLevel?: ThinkingLevel;
}

/**
 * ModelProvider builder helper for python-like and expressive syntax
 */
export const ModelProvider = {
  GoogleGenAI(
    model: string,
    apiKey?: string,
    options?: { thinking_level?: ThinkingLevel; thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return {
      model: model.startsWith("google/") ? model : `google/${model}`,
      apiKey,
      baseUrl: options?.baseUrl,
      thinkingLevel: options?.thinking_level || options?.thinkingLevel,
    };
  },

  OpenCode(
    model: string,
    apiKey?: string,
    options?: { thinking_level?: ThinkingLevel; thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return {
      model: model.startsWith("opencode") ? model : `opencode/${model}`,
      apiKey,
      baseUrl: options?.baseUrl,
      thinkingLevel: options?.thinking_level || options?.thinkingLevel,
    };
  },

  OpenRouter(
    model: string,
    apiKey?: string,
    options?: { thinking_level?: ThinkingLevel; thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return {
      model: model.startsWith("openrouter/") ? model : `openrouter/${model}`,
      apiKey,
      baseUrl: options?.baseUrl,
      thinkingLevel: options?.thinking_level || options?.thinkingLevel,
    };
  },
};
