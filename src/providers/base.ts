import type {
  Provider,
  ProviderId,
  ModelSpec,
  ProviderRequestOptions,
  ProviderGenerateResult,
} from "../types/model.ts";
import type { ProviderContext } from "../types/message.ts";
import type { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { countTokens } from "../tokens/counter.ts";
import { getModelFromCatalog, getModelsForProvider } from "../models/catalog.ts";

export abstract class BaseProvider implements Provider {
  abstract readonly id: ProviderId;
  abstract readonly name: string;
  // Legacy hardcoded list — kept for offline fallback, but battle-tested path is catalog
  abstract readonly models: ModelSpec[];

  /**
   * Battle-tested: total context length now from catalog (limit.context), not stale hardcoded.
   * Delegates to getModelFromCatalog first, then falls back to hardcoded models.
   */
  getModel(modelId: string): ModelSpec | undefined {
    // 1) Catalog first — single source of truth (opencode total context length = limit.context)
    const fromCatalog = getModelFromCatalog(this.id, modelId) || getModelFromCatalog(this.id.replace("-zen", "").replace("-go", ""), modelId);
    if (fromCatalog) return fromCatalog;

    // 2) Hardcoded fallback (offline, or provider aliases like opencode-zen)
    let found = this.models.find((m) => m.id === modelId);
    if (found) return found;
    const clean = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
    found = this.models.find((m) => m.id === clean);
    if (found) return found;
    found = this.models.find((m) => m.id.endsWith(clean) || m.id.endsWith(modelId) || clean.endsWith(m.id));
    if (found) return found;
    const strippedStore = (id: string) => (id.includes("/") ? id.split("/").slice(1).join("/") : id);
    found = this.models.find((m) => strippedStore(m.id) === clean);
    if (found) return found;

    // 3) Dynamic catalog view for this provider (e.g. opencode -> zen/go variants)
    const dynamic = getModelsForProvider(this.id);
    found = dynamic.find((m) => m.id === modelId || m.id === clean);
    if (found) return found;
    return dynamic.find((m) => m.id.endsWith(clean) || clean.endsWith(m.id));
  }

  abstract generate(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): Promise<ProviderGenerateResult>;

  abstract stream(
    model: string | ModelSpec,
    context: ProviderContext,
    options?: ProviderRequestOptions
  ): AssistantMessageEventStream;

  async countTokens(
    model: string | ModelSpec,
    context: ProviderContext
  ): Promise<number> {
    return countTokens(context);
  }
}
