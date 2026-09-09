import type { Provider, ProviderId, ModelSpec } from "../types/model.ts";
import type { ThinkingLevel } from "../types/core.ts";
import {
  GoogleAiSdkProvider,
  OpenCodeAiSdkProvider,
  OpenRouterAiSdkProvider,
  OpenAiAiSdkProvider,
  CustomAiSdkProvider,
} from "./model-provider.ts";
import { getModelFromCatalog } from "../models/catalog.ts";
import { getEnv } from "../utils/env.ts";

const providerRegistry = new Map<ProviderId, Provider>();

// Initialize default supported providers powered purely by Vercel AI SDK
const googleProvider = new GoogleAiSdkProvider();
const opencodeProvider = new OpenCodeAiSdkProvider();
const openrouterProvider = new OpenRouterAiSdkProvider();
const openaiProvider = new OpenAiAiSdkProvider();

providerRegistry.set("google", googleProvider);
providerRegistry.set("gemini", googleProvider);
providerRegistry.set("opencode", opencodeProvider);
providerRegistry.set("opencode-zen", opencodeProvider);
providerRegistry.set("opencode-go", opencodeProvider);
providerRegistry.set("openrouter", openrouterProvider);
providerRegistry.set("openai", openaiProvider);

// ---------------------------------------------------------------------------
// Unified multi-provider layer powered purely by Vercel AI SDK
// Any `MODEL="<prefix>/<model-id>"` works without SDK changes as long as
// `{PREFIX}_API_KEY` (+ optional `{PREFIX}_BASE_URL`) is set. Examples:
//   MODEL="groq/llama-3.3-70b-versatile" + GROQ_API_KEY + GROQ_BASE_URL
//   MODEL="cerebras/gpt-oss-120b"      + CEREBRAS_API_KEY + CEREBRAS_BASE_URL
//   MODEL="ollama/qwen2.5-coder"        + OLLAMA_BASE_URL (key optional for local)
// ---------------------------------------------------------------------------
const FIRST_CLASS = new Set([
  "google",
  "gemini",
  "opencode",
  "opencode-zen",
  "opencode-go",
  "openrouter",
  "openai",
]);

/**
 * Normalizes a provider prefix for registry lookup and environment resolution.
 * @example `const prefix = normalizeProviderPrefix("  Groq/llama  ");`
 */
export function normalizeProviderPrefix(prefix: string): string {
  return prefix.trim().toLowerCase();
}

/**
 * Get-or-create an OpenAI-compatible provider for any prefix backed by Vercel AI SDK.
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
  const id = normalizeProviderPrefix(prefix) as ProviderId;
  const existing = providerRegistry.get(id);
  if (existing && !FIRST_CLASS.has(id.toLowerCase())) return existing;
  if (existing && opts?.baseUrl === undefined && opts?.apiKey === undefined) {
    return existing;
  }
  const created = new CustomAiSdkProvider(id, opts);
  providerRegistry.set(id, created);
  return created;
}

/**
 * Retrieves a provider by ID.
 * Unknown ids auto-create an OpenAI-compatible provider (unified layer),
 * so `getProvider("groq")` works after setting `GROQ_API_KEY`/`GROQ_BASE_URL`.
 */
/**
 * Retrieves a first-class provider or lazily creates a custom compatible provider.
 *
 * @example `const provider = getProvider("google");`
 */
export function getProvider(id: ProviderId | string): Provider {
  const key = String(id).trim() as ProviderId;
  const provider = providerRegistry.get(key);
  if (provider) return provider;
  if (!key) {
    throw new Error(
      `Provider '' is not supported or not registered. Available first-support providers: google, opencode, openrouter, openai — or any custom prefix via {PREFIX}_API_KEY + {PREFIX}_BASE_URL.`
    );
  }
  // Unified layer: lazily create OpenAI-compatible provider for any custom prefix.
  return ensureCustomProvider(key);
}

/** Provider/model pair returned by resolveModel. */
export interface ResolvedModel {
  provider: Provider;
  modelId: string;
  modelSpec?: ModelSpec;
}

/**
 * Resolves a model string (e.g. "google/model-id", "opencode/model-id", "openrouter/scope/model:variant")
 * or ModelSpec into provider instance and model ID using Vercel AI SDK provider layer.
 */
/**
 * Resolves `provider/model`, catalog specs, scoped OpenRouter IDs, and custom prefixes.
 *
 * @example `const { provider, modelId } = resolveModel("openai/gpt-4o");`
 */
export function resolveModel(model: string | ModelSpec): ResolvedModel {
  if (!model || (typeof model === "string" && !model.trim())) {
    throw new Error(
      "[Agent Accelerator] No model specified. Please specify 'model' in Agent configuration or set the MODEL environment variable."
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
      getModelFromCatalog(prov, mid) ||
      getModelFromCatalog(prov.toLowerCase(), mid) ||
      getModelFromCatalog(mid, mid)
    );
  };

  const hasCustomOpenAIBase = !!(getEnv("OPENAI_BASE_URL") || getEnv("OPENAI_API_BASE"));

  // Explicit prefix with slash — deterministic
  if (modelStr.includes("/")) {
    const parts = modelStr.split("/");
    const providerPrefix = parts[0]!.toLowerCase();
    const remainingModel = parts.slice(1).join("/");

    // 1. Explicit openai/ prefix ALWAYS routes to OpenAI provider
    if (providerPrefix === "openai") {
      const p = getProvider("openai");
      const spec =
        p.getModel(remainingModel) ||
        getModelFromCatalog("openai", remainingModel) ||
        getModelFromCatalog(remainingModel, remainingModel);
      return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
    }

    // 2. Unified layer: any non-first-class prefix routes to auto-created custom provider
    const isExplicitOther = [
      "google",
      "gemini",
      "opencode",
      "opencode-zen",
      "opencode-go",
      "openrouter",
    ].includes(providerPrefix);

    if (!isExplicitOther && providerPrefix !== "openai") {
      const envName = providerPrefix.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      const hasDedicatedEnv = !!(
        getEnv(`${envName}_BASE_URL`) ||
        getEnv(`${envName}_BASEURL`) ||
        getEnv(`${envName}_API_BASE`) ||
        getEnv(`${envName}_API_KEY`) ||
        getEnv(`${envName}_BASE_API_KEY`)
      );

      const looksLikeOpenRouterScope =
        parts.length === 2 && modelStr.includes(":") && !hasDedicatedEnv;

      if (!looksLikeOpenRouterScope) {
        if (hasCustomOpenAIBase && !hasDedicatedEnv) {
          const p = getProvider("openai");
          const spec = p.getModel(remainingModel) || getModelFromCatalog(remainingModel, remainingModel);
          return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
        }
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

    if (
      providerPrefix === "opencode" ||
      providerPrefix === "opencode-zen" ||
      providerPrefix === "opencode-go"
    ) {
      const p = getProvider("opencode");
      const spec =
        p.getModel(remainingModel) ||
        getModelFromCatalog("opencode", remainingModel) ||
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
    const catalogSpec =
      tryCatalogLookup(providerPrefix, remainingModel) ||
      tryCatalogLookup(providerPrefix, modelStr);
    if (catalogSpec) {
      const internalProvider = getProvider(catalogSpec.provider);
      return { provider: internalProvider, modelId: catalogSpec.id, modelSpec: catalogSpec };
    }

    // Unknown provider prefix — try catalog with priority
    const prioritizedUnknown =
      tryCatalogLookup(providerPrefix, remainingModel) ||
      tryCatalogLookup("google", remainingModel) ||
      tryCatalogLookup("opencode", remainingModel) ||
      tryCatalogLookup("openai", remainingModel) ||
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
    const fallbackSpec =
      fallbackCustom.getModel(remainingModel) || fallbackCustom.getModel(modelStr);
    return {
      provider: fallbackCustom,
      modelId: remainingModel,
      modelSpec: fallbackSpec as ModelSpec,
    };
  }

  // When OPENAI_BASE_URL is set: trust user completely
  if (hasCustomOpenAIBase) {
    const p = getProvider("openai");
    const spec = p.getModel(modelStr) || getModelFromCatalog(modelStr, modelStr);
    return { provider: p, modelId: modelStr, modelSpec: spec as ModelSpec };
  }

  // No slash — try catalog with internal provider priority
  const prioritized =
    tryCatalogLookup("google", modelStr) ||
    tryCatalogLookup("opencode", modelStr) ||
    tryCatalogLookup("openai", modelStr) ||
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

  /** Builds an OpenCode model selection. @example `ModelProvider.OpenCode("kimi-k2.5")` */
  OpenCode(
    model: string,
    apiKey?: string,
    options?: { thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return {
      model: model.startsWith("opencode") ? model : `opencode/${model}`,
      apiKey,
      baseUrl: options?.baseUrl,
      thinkingLevel: options?.thinkingLevel,
    };
  },

  /** Builds an OpenRouter model selection. @example `ModelProvider.OpenRouter("openai/gpt-4o")` */
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

  /** Builds an OpenAI model selection. @example `ModelProvider.OpenAI("gpt-4o")` */
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

  /** Builds an arbitrary OpenAI-compatible model selection. @example `ModelProvider.Custom("groq/llama-3.3-70b-versatile")` */
  Custom(
    model: string,
    apiKey?: string,
    options?: { thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    const normalized = model.includes("/") ? model : `custom/${model}`;
    const prefix = normalized.split("/")[0]!;
    try {
      ensureCustomProvider(prefix, { baseUrl: options?.baseUrl, apiKey });
    } catch {}
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
