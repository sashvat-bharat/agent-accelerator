import type {
  Provider,
  ProviderId,
  ModelSpec,
  ProviderRequestOptions,
  ProviderGenerateResult,
} from "../types/model.ts";
import type { ProviderContext } from "../types/message.ts";
import type { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { getAiSdkModel } from "./provider.ts";
import { executeAiSdkGenerate, executeAiSdkStream } from "./executor.ts";
import { countTokens } from "../tokens/counter.ts";
import { getModelFromCatalog, getModelsForProvider } from "../models/catalog.ts";
import { getApiKey, getEnv } from "../utils/env.ts";

/**
 * Permissive placeholder so custom endpoints never fail preflight:
 * allows every ThinkingLevel (none -> xhigh + dynamic).
 * @example `const spec = createGenericModelSpec("groq", "llama-3.3-70b-versatile");`
 */
export function createGenericModelSpec(provider: string, modelId: string): ModelSpec {
  const clean = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
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

/**
 * Base provider class powered purely by Vercel AI SDK.
 */
export class AiSdkBaseProvider implements Provider {
  readonly id: ProviderId;
  readonly name: string;
  readonly models: ModelSpec[] = [];

  /**
   * Creates a provider adapter around the Vercel AI SDK.
   *
   * @param id Stable provider prefix used in `provider/model` strings.
   * @param name Human-readable provider label.
   * @param models Optional catalog entries exposed by this provider.
   */
  constructor(id: ProviderId, name: string, models: ModelSpec[] = []) {
    this.id = id;
    this.name = name;
    this.models = models;
  }

  getModel(modelId: string): ModelSpec | undefined {
    const clean = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
    const fromCatalog =
      getModelFromCatalog(this.id, modelId) ||
      getModelFromCatalog(this.id, clean) ||
      this.models.find((m) => m.id === modelId || m.id === clean);

    if (fromCatalog) return fromCatalog;
    return createGenericModelSpec(this.id, clean);
  }

  protected cleanModelId(model: string | ModelSpec): string {
    const rawId = typeof model === "string" ? model : model.id;
    return rawId.replace(new RegExp(`^(${this.id}|models?)/`, "i"), "");
  }

  toAiSdkModel(modelId: string, options?: ProviderRequestOptions): LanguageModelV4 {
    const clean = this.cleanModelId(modelId);
    return getAiSdkModel(this.id, clean, {
      apiKey: options?.apiKey,
      baseUrl: options?.baseUrl,
      headers: options?.headers,
      env: options?.env,
    });
  }

  async generate(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): Promise<ProviderGenerateResult> {
    const rawId = typeof model === "string" ? model : model.id;
    const clean = this.cleanModelId(rawId);
    const aiModel = this.toAiSdkModel(clean, options);
    return executeAiSdkGenerate(aiModel, this.id, clean, context, options);
  }

  stream(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): AssistantMessageEventStream {
    const rawId = typeof model === "string" ? model : model.id;
    const clean = this.cleanModelId(rawId);
    const aiModel = this.toAiSdkModel(clean, options);
    return executeAiSdkStream(aiModel, this.id, clean, context, options);
  }

  async countTokens(
    _model: string | ModelSpec,
    context: ProviderContext
  ): Promise<number> {
    return countTokens(context);
  }
}

/**
 * Pure Vercel AI SDK Google provider.
 */
export class GoogleAiSdkProvider extends AiSdkBaseProvider {
  /** Creates a Google AI Studio adapter with the supported Gemini catalog. */
  constructor() {
    const filtered = getModelsForProvider("google").filter(
      (m) => !m.id.toLowerCase().includes("gemini-2") && !m.id.toLowerCase().includes("gemini-1")
    );
    super("google", "Google AI Studio", filtered);
  }

  protected override cleanModelId(model: string | ModelSpec): string {
    const rawId = typeof model === "string" ? model : model.id;
    const clean = rawId.replace(/^(google\/|models\/)/, "");
    if (clean.toLowerCase().includes("gemini-2") || clean.toLowerCase().includes("gemini-1")) {
      throw new Error(
        `Gemini 2.x and 1.x models are not supported by the Google Provider. ` +
        `Only Gemini 3.x series models are supported (e.g. 'gemini-3.5-flash-lite', 'gemini-3.7-flash').`
      );
    }
    return clean;
  }

}

/**
 * Pure Vercel AI SDK OpenAI provider.
 */
export class OpenAiAiSdkProvider extends AiSdkBaseProvider {
  /** Creates an OpenAI adapter backed by the AI SDK and the OpenAI catalog. */
  constructor() {
    super("openai", "OpenAI", getModelsForProvider("openai"));
  }

  protected override cleanModelId(model: string | ModelSpec): string {
    const rawId = typeof model === "string" ? model : model.id;
    return rawId.replace(/^(openai|models?)\//, "");
  }
}

/**
 * Pure Vercel AI SDK OpenCode provider.
 */
export class OpenCodeAiSdkProvider extends AiSdkBaseProvider {
  /** Creates an OpenCode adapter backed by the AI SDK and OpenCode catalog. */
  constructor() {
    super("opencode", "OpenCode", getModelsForProvider("opencode"));
  }

  protected override cleanModelId(model: string | ModelSpec): string {
    const rawId = typeof model === "string" ? model : model.id;
    return rawId.replace(/^(opencode-zen\/|opencode-go\/|opencode\/)/, "");
  }
}

/**
 * Pure Vercel AI SDK OpenRouter provider.
 */
export class OpenRouterAiSdkProvider extends AiSdkBaseProvider {
  /** Creates an OpenRouter adapter backed by the AI SDK and OpenRouter catalog. */
  constructor() {
    super("openrouter", "OpenRouter", getModelsForProvider("openrouter"));
  }

  protected override cleanModelId(model: string | ModelSpec): string {
    const rawId = typeof model === "string" ? model : model.id;
    return rawId.replace(/^openrouter\//, "");
  }
}

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

/**
 * Pure Vercel AI SDK Custom/OpenAI-compatible provider.
 */
export class CustomAiSdkProvider extends AiSdkBaseProvider {
  private readonly prefix: string;
  private readonly configuredBaseUrl?: string;
  private readonly configuredApiKey?: string;

  /**
   * Creates an OpenAI-compatible provider for any endpoint prefix.
   *
   * @param prefix Prefix used in model strings and environment variables,
   * such as `groq` for `groq/llama-3.3-70b`.
   * @param opts Optional endpoint, key, and display-name overrides.
   *
   * @example
   * ```ts
   * const groq = new CustomAiSdkProvider("groq", {
   *   baseUrl: "https://api.groq.com/openai/v1",
   *   apiKey: process.env.GROQ_API_KEY,
   * });
   * ```
   */
  constructor(prefix: string, opts?: CustomProviderOptions) {
    const norm = prefix.trim().toLowerCase().replace(/\/.*$/, "");
    super(norm as ProviderId, opts?.name ?? `${norm} (OpenAI-compatible)`);
    this.prefix = norm;
    this.configuredBaseUrl = opts?.baseUrl ?? opts?.defaultBaseUrl;
    this.configuredApiKey = opts?.apiKey;
  }

  override toAiSdkModel(modelId: string, options?: ProviderRequestOptions): LanguageModelV4 {
    const clean = this.cleanModelId(modelId);
    const envPrefix = this.prefix.toUpperCase().replace(/[^A-Z0-9]/g, "_");

    const apiKey =
      options?.apiKey ||
      this.configuredApiKey ||
      options?.env?.[`${envPrefix}_API_KEY`] ||
      options?.env?.[`${envPrefix}_BASE_API_KEY`] ||
      getEnv(`${envPrefix}_API_KEY`) ||
      getEnv(`${envPrefix}_BASE_API_KEY`) ||
      getEnv("OPENAI_BASE_API_KEY") ||
      getEnv("OPENAI_API_KEY") ||
      getApiKey(this.prefix, undefined, options?.env);

    const baseUrl =
      options?.baseUrl ||
      this.configuredBaseUrl ||
      options?.env?.[`${envPrefix}_BASE_URL`] ||
      options?.env?.[`${envPrefix}_BASEURL`] ||
      getEnv(`${envPrefix}_BASE_URL`) ||
      getEnv(`${envPrefix}_BASEURL`) ||
      getEnv("OPENAI_BASE_URL") ||
      "https://api.openai.com/v1";

    return getAiSdkModel(this.prefix, clean, {
      apiKey,
      baseUrl,
      headers: options?.headers,
      env: options?.env,
    });
  }
}

// Legacy class aliases so instanceof checks in tests & user code succeed seamlessly
export {
  GoogleAiSdkProvider as GoogleAIStudioProvider,
  OpenAiAiSdkProvider as OpenAIProvider,
  OpenCodeAiSdkProvider as OpenCodeProvider,
  OpenRouterAiSdkProvider as OpenRouterProvider,
  CustomAiSdkProvider as OpenAICompatibleProvider,
};

/**
 * Creates a custom OpenAI-compatible provider backed by the Vercel AI SDK.
 * @example `const provider = createOpenAICompatibleProvider("groq", { baseUrl: "https://api.groq.com/openai/v1" });`
 */
export function createOpenAICompatibleProvider(
  prefix: string,
  opts?: CustomProviderOptions
): CustomAiSdkProvider {
  return new CustomAiSdkProvider(prefix, opts);
}
/** Backward-compatible alias for {@link createOpenAICompatibleProvider}. @example `createCustomProvider("ollama")` */
export const createCustomProvider = createOpenAICompatibleProvider;
/** Backward-compatible class alias for {@link CustomAiSdkProvider}. @example `new CustomProvider("ollama")` */
export const CustomProvider = CustomAiSdkProvider;
