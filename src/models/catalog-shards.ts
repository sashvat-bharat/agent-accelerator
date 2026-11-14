/**
 * What the SDK keeps of models.dev: one small file per provider it supports, holding only the newest model series and only
 * the fields it reads. The full models.dev payload (6 MB, hundreds of providers) is downloaded, filtered here and thrown
 * away: it is never saved and never loaded at import. Pure functions, no I/O.
 */

/** The providers the catalog keeps, in the order their folders are written (`<cache>/<provider>/models.json`). */
export const CATALOG_PROVIDERS = ["google", "openai", "anthropic", "openrouter"] as const;

/** One catalog provider id. */
export type CatalogProvider = (typeof CATALOG_PROVIDERS)[number];

/** A model entry as saved: the fields `mapModelSpec` reads, nothing else. */
export type SlimModel = Record<string, unknown>;

/** Content of one `<provider>/models.json`. */
export interface Shard {
  version: 1;
  provider: CatalogProvider;
  models: Record<string, SlimModel>;
}

// Whole number of the generation in an id like `gemini-3.5-flash` (3), `gpt-5.4-mini` (5) or `claude-opus-5-5` (5); in: a model id and the pattern that captures it, out: the number or undefined.
function generation(id: string, pattern: RegExp): number | undefined {
  const m = pattern.exec(id);
  return m ? Number(m[1]) : undefined;
}

// Per-provider rule: which models of the models.dev entry are kept. Google gemini-3 and newer, OpenAI gpt-5 and newer, Anthropic claude 5 and newer, OpenRouter every model whose only output is text.
const KEEP: Record<CatalogProvider, (id: string, raw: Record<string, unknown>) => boolean> = {
  google: (id) => (generation(id, /^gemini-(\d+)(?:[.-]|$)/) ?? 0) >= 3,
  openai: (id) => (generation(id, /^gpt-(\d+)(?:[.-]|$)/) ?? 0) >= 5,
  anthropic: (id) => (generation(id, /^claude-[a-z]+-(\d+)(?:-\d+)*$/) ?? 0) >= 5,
  openrouter: (_id, raw) => {
    const out = (raw["modalities"] as { output?: unknown } | undefined)?.output;
    return Array.isArray(out) && out.length === 1 && out[0] === "text";
  },
};

// The fields of a models.dev entry the SDK reads (limits, prices, modalities, reasoning options, flags); descriptions and the rest are dropped; in: one raw entry, out: the slim entry.
const KEPT_FIELDS = [
  "id",
  "name",
  "family",
  "attachment",
  "reasoning",
  "reasoning_options",
  "tool_call",
  "structured_output",
  "knowledge",
  "release_date",
  "last_updated",
  "status",
  "open_weights",
  "modalities",
  "limit",
  "cost",
] as const;

// Copies only the kept fields of one entry; in: buildShards, out: the slim entry.
function slim(raw: Record<string, unknown>): SlimModel {
  const out: SlimModel = {};
  for (const key of KEPT_FIELDS) if (raw[key] !== undefined) out[key] = raw[key];
  return out;
}

/** Filters a downloaded models.dev payload into the four shards (an unknown provider or a malformed entry is skipped). */
export function buildShards(payload: Record<string, unknown>): Record<CatalogProvider, Shard> {
  const out = {} as Record<CatalogProvider, Shard>;
  for (const provider of CATALOG_PROVIDERS) {
    const models: Record<string, SlimModel> = {};
    const source = (payload[provider] as { models?: unknown } | undefined)?.models;
    if (source && typeof source === "object" && !Array.isArray(source)) {
      for (const [key, raw] of Object.entries(source as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const entry = raw as Record<string, unknown>;
        const id = typeof entry["id"] === "string" ? (entry["id"] as string) : key;
        if (KEEP[provider](id, entry)) models[key] = slim(entry);
      }
    }
    out[provider] = { version: 1, provider, models };
  }
  return out;
}

/** True when a parsed shard file has the expected shape (a hand-edited or truncated file is not trusted). */
export function isShard(value: unknown, provider: CatalogProvider): value is Shard {
  const v = value as Partial<Shard> | null;
  return (
    !!v &&
    typeof v === "object" &&
    v.version === 1 &&
    v.provider === provider &&
    !!v.models &&
    typeof v.models === "object" &&
    !Array.isArray(v.models)
  );
}
