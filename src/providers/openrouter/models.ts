import type { ModelSpec } from "../../types/model.ts";
import { getModelsForProvider } from "../../models/catalog.ts";

/**
 * @deprecated Hardcoded fallback — battle-tested source is models.dev catalog.
 */
const FALLBACK: ModelSpec[] = [
  {
    id: "example/scope-model:free",
    provider: "openrouter",
    name: "Example Scope Model (Free)",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    limit: { context: 256000, output: 230400 },
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

const dynamic = getModelsForProvider("openrouter");
export const OPENROUTER_MODELS: ModelSpec[] = dynamic.length > 1 ? dynamic : FALLBACK;
