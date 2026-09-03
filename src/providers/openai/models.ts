import type { ModelSpec } from "../../types/model.ts";
import { getModelsForProvider } from "../../models/catalog.ts";

const FALLBACK: ModelSpec[] = [
  {
    id: "gpt-4o",
    provider: "openai",
    name: "GPT-4o",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    limit: { context: 128000, output: 16384 },
    cost: { input: 2.5, output: 10, cache_read: 1.25 },
    modalities: { input: ["text", "image", "audio"], output: ["text"] },
    capabilities: {
      supportsThinking: false,
      supportsThinkingLevel: false,
      supportsImplicitCaching: true,
      supportsExplicitCaching: false,
      supportsLongCacheRetention: false,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text", "image", "audio"],
    },
    pricing: { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25 },
  },
  {
    id: "gpt-4o-mini",
    provider: "openai",
    name: "GPT-4o Mini",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    limit: { context: 128000, output: 16384 },
    cost: { input: 0.15, output: 0.6, cache_read: 0.075 },
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: {
      supportsThinking: false,
      supportsThinkingLevel: false,
      supportsImplicitCaching: true,
      supportsExplicitCaching: false,
      supportsLongCacheRetention: false,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text", "image"],
    },
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.075 },
  },
];

const dynamic = getModelsForProvider("openai");
export const OPENAI_MODELS: ModelSpec[] = dynamic.length > 0 ? dynamic : FALLBACK;
