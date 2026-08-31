import type { ModelSpec } from "../../types/model.ts";
import { getModelsForProvider } from "../../models/catalog.ts";

/**
 * @deprecated Hardcoded fallback — battle-tested source is models.dev catalog.
 * This export is now a dynamic view: if catalog has google models, use it; else fallback.
 * Total context length comes from catalog limit.context (e.g. gemini-3.5-flash: 1048576).
 */
const FALLBACK: ModelSpec[] = [
  {
    id: "gemini-3.5-flash",
    provider: "google",
    name: "Gemini 3.5 Flash",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    limit: { context: 1048576, output: 65536 },
    cost: { input: 0.1, output: 0.4, cache_read: 0.025 },
    modalities: { input: ["text", "image", "audio", "video"], output: ["text"] },
    capabilities: {
      supportsThinking: true,
      supportsThinkingLevel: true,
      supportsImplicitCaching: true,
      supportsExplicitCaching: true,
      supportsLongCacheRetention: true,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text", "image", "audio", "video"],
    },
    pricing: { inputPerMillion: 0.1, outputPerMillion: 0.4, cacheReadPerMillion: 0.025 },
  },
  {
    id: "gemini-3.5-flash-lite",
    provider: "google",
    name: "Gemini 3.5 Flash Lite",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    limit: { context: 1048576, output: 65536 },
    cost: { input: 0.075, output: 0.3, cache_read: 0.01875 },
    modalities: { input: ["text", "image", "audio", "video"], output: ["text"] },
    capabilities: {
      supportsThinking: true,
      supportsThinkingLevel: true,
      supportsImplicitCaching: true,
      supportsExplicitCaching: true,
      supportsLongCacheRetention: true,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text", "image", "audio", "video"],
    },
    pricing: { inputPerMillion: 0.075, outputPerMillion: 0.3, cacheReadPerMillion: 0.01875 },
  },
];

const dynamic = getModelsForProvider("google");
export const GOOGLE_MODELS: ModelSpec[] = dynamic.length > 5 ? dynamic : FALLBACK;
