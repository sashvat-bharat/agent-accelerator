/**
 * OpenRouter's decision models, read from OpenRouter's own list (`GET /api/v1/models?output_modalities=decisions`, which needs
 * an OpenRouter key) and cached in the catalog folder (`<cache>/openrouter-decisions.json`, see `openrouter-list.ts` for the
 * refresh rules). OpenRouter serves dozens of decision models that change often, so the SDK keeps no hand-written table for
 * them: each list entry carries the input kinds the model reads, its context length and its price per token.
 */
import { createOpenRouterList, type RefreshOpenRouterListOptions } from "./openrouter-list.ts";
import type { DecisionInputKind, DecisionModelInfo, DecisionPrices } from "./decision-models.ts";

const DEFAULT_URL = "https://openrouter.ai/api/v1/models?output_modalities=decisions";
/** The route a model must serve to take a decisions request (some models only serve `/api/alpha/extractions`). */
const DECISIONS_ROUTE = "/api/alpha/decisions";

/** Options of a refresh. */
export type RefreshOpenRouterDecisionsOptions = RefreshOpenRouterListOptions;

// True for a plain object; in: the readers below, out: a type guard.
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// A price string such as "0.000000042" per token as USD per 1M tokens, or undefined when it is not a number; in: toModel, out: a price.
function perMillion(v: unknown): number | undefined {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Number((n * 1_000_000).toFixed(6)) : undefined;
}

// One entry of OpenRouter's list as our model info, or undefined for an entry that is not usable (no id, expired, or a model that does not take decisions requests); in: parseList, out: the entry.
function toModel(raw: unknown, now: number): DecisionModelInfo | undefined {
  if (!isObject(raw) || typeof raw["id"] !== "string" || !raw["id"]) return undefined;
  const arch = raw["architecture"];
  const modalities = isObject(arch) ? arch["input_modalities"] : undefined;
  const outputs = isObject(arch) ? arch["output_modalities"] : undefined;
  if (!Array.isArray(modalities) || !Array.isArray(outputs) || !outputs.includes("decisions")) return undefined;
  const routes = raw["endpoints"];
  if (Array.isArray(routes) && !routes.includes(DECISIONS_ROUTE)) return undefined;
  const expires = typeof raw["expiration_date"] === "string" ? Date.parse(raw["expiration_date"]) : NaN;
  if (Number.isFinite(expires) && expires <= now) return undefined;
  const inputs = [
    ...new Set(
      modalities.flatMap((m): DecisionInputKind[] =>
        m === "file" ? ["pdf"] : m === "text" || m === "image" || m === "audio" || m === "video" ? [m] : []
      )
    ),
  ];
  if (inputs.length === 0) return undefined;
  const id = raw["id"];
  const pricing = isObject(raw["pricing"]) ? raw["pricing"] : {};
  const input = perMillion(pricing["prompt"]);
  const cacheRead = perMillion(pricing["input_cache_read"]);
  const cacheWrite = perMillion(pricing["input_cache_write"]);
  const prices: DecisionPrices | undefined =
    input === undefined
      ? undefined
      : {
          input,
          ...(cacheRead !== undefined && cacheRead > 0 ? { cacheRead } : {}),
          ...(cacheWrite !== undefined && cacheWrite > 0 ? { cacheWrite } : {}),
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
        : `${id} through OpenRouter's decisions endpoint.`,
    inputs,
    // The list states a context length and nothing about question counts: the provider answers when a request is too big.
    limits: context !== undefined ? { inputTokens: context } : {},
    ...(prices ? { prices } : {}),
  };
}

// Turns OpenRouter's `{ data: [...] }` into model infos (unusable entries are skipped); throws when the body is not the list; in: refresh, out: the models.
function parseList(body: unknown, now: number): DecisionModelInfo[] {
  const data = isObject(body) ? body["data"] : undefined;
  if (!Array.isArray(data)) throw new Error("the reply has no `data` list");
  const models = data.flatMap((raw) => {
    const m = toModel(raw, now);
    return m ? [m] : [];
  });
  if (models.length === 0) throw new Error("the list has no decision model");
  return models;
}

const list = createOpenRouterList<DecisionModelInfo>({
  file: "openrouter-decisions.json",
  url: DEFAULT_URL,
  what: "decision model list",
  codes: { writeFailed: "decision_models_cache_write_failed", refreshFailed: "decision_models_refresh_failed" },
  sendKey: true,
  parse: parseList,
});

/** The OpenRouter decision models from the saved list, read from disk without any network call (empty until the list was downloaded once). */
export const openRouterDecisionModels = list.read;

/**
 * Downloads OpenRouter's decision model list and saves it (unless the saved copy is still fresh and `force` is not set). The list
 * needs an OpenRouter key (`apiKey`, `env` or `OPENROUTER_API_KEY`). Throws a `ProviderError` when the download fails or is not the
 * list; the saved copy is left as it was.
 */
export const refreshOpenRouterDecisionModels = list.refresh;

/**
 * The OpenRouter decision models, downloading the list only when needed: a fresh saved copy is returned at once; a missing or stale
 * one is refreshed (one download at a time). If the refresh fails, a stale copy is still used (with a warning on the bus); without
 * any copy the failure is thrown. The `catalog_refresh: "off"` setting never downloads: the saved copy, or `[]`, is returned.
 */
export const ensureOpenRouterDecisionModels = list.ensure;

/** Forgets the in-memory copy and the failure backoff (tests only). */
export const resetOpenRouterDecisionsCache = list.reset;
