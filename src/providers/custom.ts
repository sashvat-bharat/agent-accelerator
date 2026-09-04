import { OpenAIProvider } from "./openai.ts";
import type { ModelSpec, ProviderId } from "../types/model.ts";
import { getModelFromCatalog } from "../models/catalog.ts";
import { getApiKey, getEnv } from "../utils/env.ts";

// ============================================================================
// Custom / OpenAI-Compatible Provider Types
// ============================================================================

export interface CustomProviderOptions {
  /** Human label, defaults to `${id} (OpenAI-compatible)` */
  name?: string;
  /** Static baseUrl — overrides env. Env `{PREFIX}_BASE_URL` still wins at runtime if set. */
  baseUrl?: string;
  /** Static apiKey — overrides env. Explicit per-call `apiKey` still wins. */
  apiKey?: string;
  /** Default baseUrl when no env is set. Defaults to OpenAI cloud. */
  defaultBaseUrl?: string;
}

function normalizePrefix(prefix: string): string {
  return prefix.trim().toLowerCase().replace(/\/.*$/, "");
}

function envPrefix(prefix: string): string {
  return normalizePrefix(prefix).toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

// ============================================================================
// Custom / OpenAI-Compatible Provider Implementation
// ============================================================================

/**
 * OpenAI-compatible provider for ANY third-party endpoint.
 *
 * Zero-code switching:
 * ```bash
 * MODEL="groq/llama-3.3-70b-versatile"
 * GROQ_API_KEY="gsk_..."
 * GROQ_BASE_URL="https://api.groq.com/openai/v1"
 * ```
 * No SDK change — `resolveModel("groq/...")` auto-creates this provider.
 * Same wire format as OpenAI (`/chat/completions`, tools, SSE, usage),
 * so Ollama / vLLM / Together / Fireworks / Groq / Cerebras / DeepSeek /
 * xAI / Mistral / LM Studio / llama.cpp all work out of the box.
 */
export class OpenAICompatibleProvider extends OpenAIProvider {
  override readonly id: ProviderId;
  override readonly name: string;
  private readonly prefix: string;
  private readonly envName: string;
  private readonly configuredBaseUrl?: string;
  private readonly configuredApiKey?: string;

  constructor(prefix: string, opts?: CustomProviderOptions) {
    super();
    this.prefix = normalizePrefix(prefix);
    this.envName = envPrefix(prefix);
    this.id = this.prefix as ProviderId;
    this.name = opts?.name ?? `${this.prefix} (OpenAI-compatible)`;
    this.configuredBaseUrl = opts?.baseUrl;
    this.configuredApiKey = opts?.apiKey;
    if (opts?.defaultBaseUrl) {
      this.defaultBaseUrl = opts.defaultBaseUrl;
    }
    (this as any).models = [];
  }

  protected override resolveBaseUrl(_modelId?: string, explicit?: string): string {
    if (explicit) return explicit;
    if (this.configuredBaseUrl) return this.configuredBaseUrl;
    const prefixed =
      getEnv(`${this.envName}_BASE_URL`) ||
      getEnv(`${this.envName}_BASEURL`) ||
      getEnv(`${this.envName}_API_BASE`);
    if (prefixed) return prefixed;
    const generic = getEnv("OPENAI_BASE_URL") || getEnv("OPENAI_API_BASE");
    if (generic) return generic;
    return this.defaultBaseUrl;
  }

  protected override resolveApiKey(
    explicit?: string,
    env?: Record<string, string>
  ): string | undefined {
    if (explicit) return explicit;
    if (env) {
      const hit =
        env[`${this.envName}_API_KEY`] ||
        env[`${this.envName}_BASE_API_KEY`] ||
        env["OPENAI_BASE_API_KEY"] ||
        env["OPENAI_API_KEY"];
      if (hit) return hit;
    }
    return (
      getEnv(`${this.envName}_API_KEY`) ||
      getEnv(`${this.envName}_BASE_API_KEY`) ||
      this.configuredApiKey ||
      getEnv("OPENAI_BASE_API_KEY") ||
      getEnv("OPENAI_API_KEY") ||
      getApiKey(this.prefix, undefined, env)
    );
  }

  protected override cleanModelId(model: string | ModelSpec): string {
    const rawId = typeof model === "string" ? model : model.id;
    const lower = rawId.toLowerCase();
    const withSlash = `${this.prefix}/`;
    if (lower.startsWith(withSlash)) {
      return rawId.slice(withSlash.length);
    }
    return rawId.replace(/^(openai|models?)\//i, "");
  }

  /**
   * Catalog-first (models.dev knows `groq`, `together`, etc.), then
   * permissive generic spec so ANY ThinkingLevel validates and
   * context-window lookups never crash.
   */
  override getModel(modelId: string): ModelSpec | undefined {
    const clean = this.cleanModelId(modelId);
    const fromCatalog =
      getModelFromCatalog(this.prefix, clean) ||
      getModelFromCatalog(this.prefix, modelId) ||
      super.getModel(clean) ||
      super.getModel(modelId) ||
      getModelFromCatalog(clean, clean) ||
      getModelFromCatalog(modelId, modelId);
    if (fromCatalog) return fromCatalog;
    return createGenericModelSpec(this.prefix, clean);
  }
}

/**
 * Permissive placeholder so custom endpoints never fail preflight:
 * allows every ThinkingLevel (`none` → `xhigh` + `dynamic`).
 */
export function createGenericModelSpec(
  provider: string,
  modelId: string
): ModelSpec {
  const clean = modelId.includes("/")
    ? modelId.split("/").slice(1).join("/")
    : modelId;
  return {
    id: clean,
    provider: provider as ProviderId,
    name: clean,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    limit: { context: 128000, output: 8192 },
    cost: {},
    modalities: { input: ["text"], output: ["text"] },
    reasoning: true,
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] },
      { type: "budget_tokens", min: 0, max: 128000 },
    ],
    tool_call: true,
    capabilities: {
      supportsThinking: true,
      supportsThinkingLevel: true,
      supportsThinkingBudget: true,
      supportsReasoningToggle: true,
      supportsReasoningEffort: true,
      supportsImplicitCaching: true,
      supportsExplicitCaching: false,
      supportsLongCacheRetention: false,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text"],
    },
    pricing: {},
  };
}

/** Factory — same as `new OpenAICompatibleProvider(prefix, opts)`. */
export function createOpenAICompatibleProvider(
  prefix: string,
  opts?: CustomProviderOptions
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(prefix, opts);
}

/** Back-compat alias. */
export const createCustomProvider = createOpenAICompatibleProvider;
export const CustomProvider = OpenAICompatibleProvider;
