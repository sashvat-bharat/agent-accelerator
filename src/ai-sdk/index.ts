export {
  getAiSdkProvider,
  getAiSdkModel,
  type AiSdkModelOptions,
  type AnyAiSdkProvider,
} from "./provider.ts";

export {
  toAiSdkPrompt,
  toAiSdkTools,
  fromAiSdkGenerateResult,
  extractAiSdkUsage,
} from "./converters.ts";

export {
  executeAiSdkGenerate,
  executeAiSdkStream,
} from "./executor.ts";

export {
  AiSdkBaseProvider,
  GoogleAiSdkProvider,
  OpenAiAiSdkProvider,
  OpenCodeAiSdkProvider,
  OpenRouterAiSdkProvider,
  CustomAiSdkProvider,
  createGenericModelSpec,
} from "./model-provider.ts";

export {
  getProvider,
  resolveModel,
  ModelProvider,
  ensureCustomProvider,
  normalizeProviderPrefix,
  type ResolvedModel,
  type ModelProviderConfig,
  type ModelProviderInstance,
} from "./registry.ts";

export {
  mapThinkingToReasoning,
  resolveEffectiveThinking,
  mapToolChoice,
  mapThinkingToProviderOptions,
  mapServiceTierToProviderOptions,
  mapCacheToProviderOptions,
  buildAiSdkCallOptions,
  withAiSdkRetries,
  isTransientAiSdkError,
  type AiSdkReasoning,
  type AiSdkToolChoice,
  type AiSdkCallOptions,
} from "./options.ts";
export { toConciseProviderError, assertModalitiesSupported } from "./errors.ts";
