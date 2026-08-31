import type { ModelSpec } from "../../types/model.ts";
import { getModelsForProvider } from "../../models/catalog.ts";

/**
 * @deprecated Hardcoded fallback — battle-tested source is models.dev catalog.
 * Opencode total context length now from catalog limit.context (e.g. hy3-free: 190000, via getModelFromCatalog).
 */
const FALLBACK: ModelSpec[] = [
  {
    id: "hy3-free",
    provider: "opencode",
    name: "OpenCode HY3 Free",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    limit: { context: 190000, output: 64000 },
    modalities: { input: ["text"], output: ["text"] },
    capabilities: {
      supportsThinking: true,
      supportsImplicitCaching: true,
      supportsLongCacheRetention: true,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text", "image"],
    },
  },
  {
    id: "glm-5.2",
    provider: "opencode",
    name: "GLM 5.2",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    limit: { context: 128000, output: 8192 },
    modalities: { input: ["text"], output: ["text"] },
    capabilities: {
      supportsThinking: true,
      supportsImplicitCaching: true,
      supportsParallelToolCalls: true,
      supportsStreaming: true,
      modalities: ["text"],
    },
  },
];

const dynamic = getModelsForProvider("opencode");
export const OPENCODE_MODELS: ModelSpec[] = dynamic.length > 2 ? dynamic : FALLBACK;
