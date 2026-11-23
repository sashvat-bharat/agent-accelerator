/**
 * OpenRouter's embedding models, read from OpenRouter's own public list (`GET /api/v1/embeddings/models`, no key needed) and
 * cached in the catalog folder (`<cache>/openrouter-embeddings.json`, see `openrouter-list.ts` for the refresh rules).
 * OpenRouter has dozens of embedding models that change often, so the SDK keeps no hand-written table for them: the list
 * carries each model's inputs, length limit and prices, which is all the request checks need.
 */
import {
  createOpenRouterList,
  type OpenRouterList,
  type RefreshOpenRouterListOptions,
  pricePerMillion,
} from "./openrouter-list.ts";
import { isRecord } from "../utils/guards.ts";
import type { EmbeddingInputKind, EmbeddingModelInfo, EmbeddingPrices } from "./embedding-models.ts";
import { DEFAULT_BASE_URLS } from "../providers/base-urls.ts";

const DEFAULT_URL = `${DEFAULT_BASE_URLS.openrouter}/embeddings/models`;

/** Options of a refresh. */
export type RefreshOpenRouterEmbeddingsOptions = RefreshOpenRouterListOptions;

// One entry of OpenRouter's list as our model info, or undefined for an entry that is not usable (no id, expired, or not an embedding model); in: parseList, out: the entry.
function toModel(raw: unknown, now: number): EmbeddingModelInfo | undefined {
  if (!isRecord(raw) || typeof raw["id"] !== "string" || !raw["id"]) return undefined;
  const arch = raw["architecture"];
  const modalities = isRecord(arch) ? arch["input_modalities"] : undefined;
  const outputs = isRecord(arch) ? arch["output_modalities"] : undefined;
  if (!Array.isArray(modalities) || (Array.isArray(outputs) && !outputs.includes("embeddings"))) return undefined;
  const expires = typeof raw["expiration_date"] === "string" ? Date.parse(raw["expiration_date"]) : NaN;
  if (Number.isFinite(expires) && expires <= now) return undefined;
  const inputs = [
    ...new Set(
      modalities.flatMap((m): EmbeddingInputKind[] =>
        m === "file" ? ["pdf"] : m === "text" || m === "image" || m === "audio" || m === "video" ? [m] : []
      )
    ),
  ];
  if (inputs.length === 0) return undefined;
  const id = raw["id"];
  const pricing = isRecord(raw["pricing"]) ? raw["pricing"] : {};
  const text = pricePerMillion(pricing["prompt"]);
  const image = pricePerMillion(pricing["image"] ?? pricing["image_token"]);
  const audio = pricePerMillion(pricing["audio"]);
  const prices: EmbeddingPrices | undefined =
    text === undefined
      ? undefined
      : {
          textInput: text,
          ...(image !== undefined ? { imageInput: image } : {}),
          ...(audio !== undefined ? { audioInput: audio } : {}),
        };
  const context =
    typeof raw["context_length"] === "number" && raw["context_length"] > 0 ? raw["context_length"] : undefined;
  return {
    model: `openrouter/${id}`,
    provider: "openrouter",
    id,
    name: typeof raw["name"] === "string" && raw["name"] ? raw["name"] : id,
    description:
      typeof raw["description"] === "string" && raw["description"]
        ? raw["description"]
        : `${id} through OpenRouter's embeddings endpoint.`,
    inputs,
    limits: context !== undefined ? { inputTokens: context } : {},
    // The list does not say whether `dimensions` or `input_type` works for a model, so the request is sent as asked and the provider decides.
    task: "inputType",
    ...(prices ? { prices } : {}),
  };
}

// Turns OpenRouter's `{ data: [...] }` into model infos (unusable entries are skipped); throws when the body is not the list; in: refresh, out: the models.
function parseList(body: unknown, now: number): EmbeddingModelInfo[] {
  const data = isRecord(body) ? body["data"] : undefined;
  if (!Array.isArray(data)) throw new Error("the reply has no `data` list");
  const models = data.flatMap((raw) => {
    const m = toModel(raw, now);
    return m ? [m] : [];
  });
  if (models.length === 0) throw new Error("the list has no embedding model");
  return models;
}

const list = createOpenRouterList<EmbeddingModelInfo>({
  file: "openrouter-embeddings.json",
  url: DEFAULT_URL,
  what: "embedding model list",
  codes: { writeFailed: "embedding_models_cache_write_failed", refreshFailed: "embedding_models_refresh_failed" },
  parse: parseList,
});

/** The OpenRouter embedding models from the saved list, read from disk without any network call (empty until the list was downloaded once). */
export const openRouterEmbeddingModels: OpenRouterList<EmbeddingModelInfo>["read"] = list.read;

/**
 * Downloads OpenRouter's embedding model list and saves it (unless the saved copy is still fresh and `force` is not set).
 * Throws a `ProviderError` when the download fails or is not the list; the saved copy is left as it was.
 */
export const refreshOpenRouterEmbeddingModels: OpenRouterList<EmbeddingModelInfo>["refresh"] = list.refresh;

/**
 * The OpenRouter embedding models, downloading the list only when needed: a fresh saved copy is returned at once; a missing or
 * stale one is refreshed (one download at a time). If the refresh fails, a stale copy is still used (with a warning on the bus);
 * without any copy the failure is thrown. The `catalog_refresh: "off"` setting never downloads: the saved copy, or `[]`, is returned.
 */
export const ensureOpenRouterEmbeddingModels: OpenRouterList<EmbeddingModelInfo>["ensure"] = list.ensure;

/** Forgets the in-memory copy and the failure backoff (tests only). */
export const resetOpenRouterEmbeddingsCache: OpenRouterList<EmbeddingModelInfo>["reset"] = list.reset;
