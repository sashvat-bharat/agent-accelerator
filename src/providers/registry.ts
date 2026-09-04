import type { Provider, ProviderId, ModelSpec } from "../types/model.ts";
import type { ThinkingLevel } from "../types/core.ts";
import { GoogleAIStudioProvider } from "./google.ts";
import { OpenCodeProvider } from "./opencode.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import { OpenAIProvider } from "./openai.ts";
import { OpenAICompatibleProvider } from "./custom.ts";
import { getModelFromCatalog } from "../models/catalog.ts";
import { getEnv } from "../utils/env.ts";

const providerRegistry = new Map<ProviderId, Provider>();

// Initialize default supported providers
const googleProvider = new GoogleAIStudioProvider();
const opencodeProvider = new OpenCodeProvider();
const openrouterProvider = new OpenRouterProvider();
const openaiProvider = new OpenAIProvider();

providerRegistry.set("google", googleProvider);
providerRegistry.set("opencode", opencodeProvider);
providerRegistry.set("opencode-zen", opencodeProvider);
providerRegistry.set("opencode-go", opencodeProvider);
providerRegistry.set("openrouter", openrouterProvider);
providerRegistry.set("openai", openaiProvider);

// ---------------------------------------------------------------------------
// Unified multi-provider layer (OpenRouter-style, zero 5% fee)
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

export function normalizeProviderPrefix(prefix: string): string {
  return prefix.trim().toLowerCase();
}

/**
 * Get-or-create an OpenAI-compatible provider for any prefix.
 * Cached, so repeated `resolveModel("groq/...")` calls reuse one instance.
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
  const created = new OpenAICompatibleProvider(id, opts);
  providerRegistry.set(id, created);
  return created;
}

/**
 * Retrieves a provider by ID.
 * Unknown ids auto-create an OpenAI-compatible provider (unified layer),
 * so `getProvider("groq")` works after setting `GROQ_API_KEY`/`GROQ_BASE_URL`.
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

export interface ResolvedModel {
  provider: Provider;
  modelId: string;
  modelSpec?: ModelSpec;
}

/**
 * Resolves a model string (e.g. "google/model-id", "opencode/model-id", "openrouter/scope/model:variant")
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

  const hasCustomOpenAIBase = !!(getEnv("OPENAI_BASE_URL") || getEnv("OPENAI_API_BASE"));

  // Explicit prefix with slash — deterministic
  if (modelStr.includes("/")) {
    const parts = modelStr.split("/");
    const providerPrefix = parts[0]!.toLowerCase();
    const remainingModel = parts.slice(1).join("/");

    // 1. Explicit openai/ prefix ALWAYS routes to OpenAI provider (trust user model name)
    if (providerPrefix === "openai") {
      const p = getProvider("openai");
      const spec = p.getModel(remainingModel) || getModelFromCatalog("openai", remainingModel) || getModelFromCatalog(remainingModel, remainingModel);
      return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
    }

    // 2. Unified layer: any non-first-class prefix (groq, cerebras, together,
    //    fireworks, ollama, vllm, deepseek, xai, ...) routes to an
    //    auto-created OpenAI-compatible provider — no SDK change needed.
    //    Just set `{PREFIX}_API_KEY` + `{PREFIX}_BASE_URL`.
    //    If only generic OPENAI_BASE_URL is set (single-endpoint mode) and the
    //    prefix has no dedicated env, preserve legacy behavior: trust the
    //    generic OpenAI endpoint.
    const isExplicitOther = ["google", "gemini", "opencode", "opencode-zen", "opencode-go", "openrouter"].includes(providerPrefix);
    if (!isExplicitOther && providerPrefix !== "openai") {
      const envName = providerPrefix.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      const hasDedicatedEnv = !!(getEnv(`${envName}_BASE_URL`) || getEnv(`${envName}_BASEURL`) || getEnv(`${envName}_API_BASE`) || getEnv(`${envName}_API_KEY`) || getEnv(`${envName}_BASE_API_KEY`));
      // Preserve OpenRouter scoped shorthand (`z-ai/glm-5.2:free`) when the
      // prefix has no dedicated env — otherwise `z-ai` would become a custom
      // provider instead of an OpenRouter scope.
      const looksLikeOpenRouterScope = parts.length === 2 && modelStr.includes(":") && !hasDedicatedEnv;
      if (!looksLikeOpenRouterScope) {
        if (hasCustomOpenAIBase && !hasDedicatedEnv) {
          const p = getProvider("openai");
          const spec = p.getModel(remainingModel) || getModelFromCatalog(remainingModel, remainingModel);
          return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
        }
        // Dedicated env (or no generic base) → direct provider routing. No 5% fee.
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
      const spec = p.getModel(remainingModel) || getModelFromCatalog("google", remainingModel) || getModelFromCatalog(remainingModel, remainingModel);
      return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
    }
    if (
      providerPrefix === "opencode" ||
      providerPrefix === "opencode-zen" ||
      providerPrefix === "opencode-go"
    ) {
      const p = getProvider("opencode");
      const spec = p.getModel(remainingModel) || getModelFromCatalog("opencode", remainingModel) || getModelFromCatalog(remainingModel, remainingModel);
      return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
    }
    if (providerPrefix === "openrouter") {
      const p = getProvider("openrouter");
      const spec = p.getModel(remainingModel) || getModelFromCatalog("openrouter", remainingModel) || getModelFromCatalog(remainingModel, remainingModel);
      return { provider: p, modelId: remainingModel, modelSpec: spec as ModelSpec };
    }

    // For scoped OpenRouter models like "scope/model:variant" without openrouter prefix,
    if (parts.length === 2 && modelStr.includes(":")) {
      const p = getProvider("openrouter");
      const spec = p.getModel(modelStr) || tryCatalogLookup("openrouter", modelStr);
      return { provider: p, modelId: modelStr, modelSpec: spec as ModelSpec };
    }

    // Check catalog for this exact provider/model (getProvider auto-creates custom).
    const catalogSpec = tryCatalogLookup(providerPrefix, remainingModel) || tryCatalogLookup(providerPrefix, modelStr);
    if (catalogSpec) {
      const internalProvider = getProvider(catalogSpec.provider);
      return { provider: internalProvider, modelId: catalogSpec.id, modelSpec: catalogSpec };
    }

    // Unknown provider prefix — try catalog with priority (getProvider auto-creates
    // custom OpenAI-compatible providers for ids like groq/together/anthropic).
    const prioritizedUnknown = tryCatalogLookup(providerPrefix, remainingModel) || tryCatalogLookup("google", remainingModel) || tryCatalogLookup("opencode", remainingModel) || tryCatalogLookup("openai", remainingModel) || tryCatalogLookup("openrouter", remainingModel) || getModelFromCatalog(modelStr, modelStr);
    if (prioritizedUnknown) {
      const internalProvider = getProvider(prioritizedUnknown.provider);
      return { provider: internalProvider, modelId: prioritizedUnknown.id, modelSpec: prioritizedUnknown };
    }
    // No catalog hit (private / brand-new model id) → still route to the
    // custom prefix so `{PREFIX}_BASE_URL` + `{PREFIX}_API_KEY` just works.
    const fallbackCustom = ensureCustomProvider(providerPrefix);
    const fallbackSpec = fallbackCustom.getModel(remainingModel) || fallbackCustom.getModel(modelStr);
    return { provider: fallbackCustom, modelId: remainingModel, modelSpec: fallbackSpec as ModelSpec };
  }

  // When OPENAI_BASE_URL is set: trust user completely!
  // Do NOT check provider lists in catalog or hijack to Google/OpenCode/OpenRouter.
  if (hasCustomOpenAIBase) {
    const p = getProvider("openai");
    const spec = p.getModel(modelStr) || getModelFromCatalog(modelStr, modelStr);
    return { provider: p, modelId: modelStr, modelSpec: spec as ModelSpec };
  }

  // No slash — try catalog with internal provider priority (U7 fix: deterministic, not insertion order)
  // getProvider() auto-creates custom providers for catalog ids outside first-class.
  const prioritized = tryCatalogLookup("google", modelStr) || tryCatalogLookup("opencode", modelStr) || tryCatalogLookup("openai", modelStr) || tryCatalogLookup("openrouter", modelStr) || getModelFromCatalog(modelStr, modelStr);
  if (prioritized) {
    const internalProvider = getProvider(prioritized.provider);
    return { provider: internalProvider, modelId: prioritized.id, modelSpec: prioritized };
  }

  // Fallback to openrouter (keeps SDK lightweight, not per-model hardcoded — catalog is source of truth)
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

  OpenAI(
    model: string,
    apiKey?: string,
    options?: { thinking_level?: ThinkingLevel; thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return {
      model: model.startsWith("openai/") ? model : `openai/${model}`,
      apiKey,
      baseUrl: options?.baseUrl,
      thinkingLevel: options?.thinking_level || options?.thinkingLevel,
    };
  },

  /**
   * Unified third-party provider — OpenRouter-style without the 5% fee.
   * ```ts
   * // Env-only (no code): MODEL="groq/llama-3.3-70b-versatile"
   * // Explicit (multi-provider in one process):
   * new Agent({ model: ModelProvider.Custom("groq/llama-3.3-70b-versatile", "gsk_...", {
   *   baseUrl: "https://api.groq.com/openai/v1",
   * }) })
   * ```
   */
  Custom(
    model: string,
    apiKey?: string,
    options?: { thinking_level?: ThinkingLevel; thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    const normalized = model.includes("/") ? model : `custom/${model}`;
    const prefix = normalized.split("/")[0]!;
    // Ensure the provider exists immediately so `getProvider(prefix)` works.
    try {
      ensureCustomProvider(prefix, { baseUrl: options?.baseUrl, apiKey });
    } catch {}
    return {
      model: normalized,
      apiKey,
      baseUrl: options?.baseUrl,
      thinkingLevel: options?.thinking_level || options?.thinkingLevel,
    };
  },

  /** Alias for `Custom` — explicit OpenAI-compatible endpoint. */
  OpenAICompatible(
    model: string,
    apiKey?: string,
    options?: { thinking_level?: ThinkingLevel; thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return ModelProvider.Custom(model, apiKey, options);
  },

  /** Alias for `Custom` — any generic endpoint (Ollama, vLLM, Together, ...). */
  Generic(
    model: string,
    apiKey?: string,
    options?: { thinking_level?: ThinkingLevel; thinkingLevel?: ThinkingLevel; baseUrl?: string }
  ): ModelProviderInstance {
    return ModelProvider.Custom(model, apiKey, options);
  },
};
