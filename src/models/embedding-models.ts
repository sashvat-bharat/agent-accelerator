/**
 * The embedding models the SDK knows, as small tables of facts: what each one takes in (text, images, audio, video, PDF), its
 * limits, how long its vectors are, how a task such as "search query" is expressed, and its prices. Google and OpenAI are curated
 * by hand from the providers' own pages (checked 19 Nov 2026); a fact the provider does not state is left out, never guessed.
 * OpenRouter has dozens of embedding models that change often, so its entries come from OpenRouter's own public list, cached in
 * the home folder (`openrouter-embeddings.ts`). models.dev is not used for these.
 */
import { openRouterEmbeddingModels } from "./openrouter-embeddings.ts";

/** What an embedding model can read. */
export type EmbeddingInputKind = "text" | "image" | "audio" | "video" | "pdf";

/** Prices in USD. `…Input` fields are per 1M tokens; `per…` fields are per unit and are what the provider quotes next to the token price. */
export interface EmbeddingPrices {
  textInput: number;
  imageInput?: number;
  audioInput?: number;
  videoInput?: number;
  perImage?: number;
  perAudioSecond?: number;
  perVideoFrame?: number;
}

/** How a model is told what the vector is for (a search query, a document to search, a classification ...). */
export type EmbeddingTaskStyle =
  /** A `taskType` field in the request (Google `gemini-embedding-001`). */
  | "taskType"
  /** Words written in front of the text, such as `task: search result | query: ...` (Google `gemini-embedding-2`). */
  | "prefix"
  /** An `input_type` field in the request (OpenRouter). */
  | "inputType"
  /** The model has no such control. */
  | "none";

/** One supported embedding model and everything it can and cannot do. */
export interface EmbeddingModelInfo {
  /** The full `provider/id` string to pass as `model`. */
  model: string;
  provider: "google" | "openai" | "openrouter";
  id: string;
  name: string;
  description: string;
  /** Release month or date as the provider states it (`2026-04`). Unset when not stated. */
  released?: string;
  inputs: readonly EmbeddingInputKind[];
  /** Limits as the provider states them (unset = not stated). */
  limits: {
    /** Tokens one input may have. */
    inputTokens?: number;
    /** Inputs one request may carry. */
    maxInputs?: number;
    /** Tokens over all inputs of one request. */
    totalTokens?: number;
    images?: number;
    audioSeconds?: number;
    videoSeconds?: number;
    pdfFiles?: number;
    pdfPages?: number;
  };
  /** Vector length. Unset = the provider does not state it (OpenRouter models). `shortenable` = the `dimensions` option works. */
  dimensions?: { default: number; min?: number; max?: number; recommended?: readonly number[]; shortenable: boolean };
  task: EmbeddingTaskStyle;
  /** Several inputs sent in one request come back as ONE combined vector (Google `gemini-embedding-2`); the adapter then sends them one by one so a list always gives one vector per item. */
  combinesInputs?: boolean;
  /** A shortened vector is not unit length and must be normalized by the SDK (Google `gemini-embedding-001`). */
  renormalizeShortened?: boolean;
  /** Unset = the price is unknown (never $0). */
  prices?: EmbeddingPrices;
}

const GOOGLE_DIMENSIONS = {
  default: 3072,
  min: 128,
  max: 3072,
  recommended: [768, 1536, 3072],
  shortenable: true,
} as const;

/** The Google embedding models (`embedContent`). */
const GOOGLE: readonly EmbeddingModelInfo[] = [
  {
    model: "google/gemini-embedding-2",
    provider: "google",
    id: "gemini-embedding-2",
    name: "Gemini Embedding 2",
    description:
      "Google's first multimodal embedding model: text, images, audio, video and PDF share one vector space, over 100 languages.",
    released: "2026-04",
    inputs: ["text", "image", "audio", "video", "pdf"],
    // The 8,192 tokens are shared across every kind of input; the rest are per request (docs: embeddings, "Supported modalities and limits"). At most 100 requests fit in one batch (the API says so).
    limits: {
      inputTokens: 8192,
      maxInputs: 100,
      images: 6,
      audioSeconds: 180,
      videoSeconds: 120,
      pdfFiles: 1,
      pdfPages: 6,
    },
    dimensions: GOOGLE_DIMENSIONS,
    task: "prefix",
    combinesInputs: true,
    prices: {
      textInput: 0.2,
      imageInput: 0.45,
      audioInput: 6.5,
      videoInput: 12,
      perImage: 0.00012,
      perAudioSecond: 0.00016,
      perVideoFrame: 0.00079,
    },
  },
  {
    model: "google/gemini-embedding-001",
    provider: "google",
    id: "gemini-embedding-001",
    name: "Gemini Embedding",
    description: "Google's text-only embedding model.",
    released: "2025-06",
    inputs: ["text"],
    limits: { inputTokens: 2048, maxInputs: 100 },
    dimensions: GOOGLE_DIMENSIONS,
    task: "taskType",
    renormalizeShortened: true,
    prices: { textInput: 0.15 },
  },
];

// The three OpenAI models differ in their vector length and whether it can be shortened; in: the table below, out: one EmbeddingModelInfo.
function openai(
  id: string,
  name: string,
  description: string,
  dimensions: EmbeddingModelInfo["dimensions"],
  textInput: number
): EmbeddingModelInfo {
  return {
    model: `openai/${id}`,
    provider: "openai",
    id,
    name,
    description,
    inputs: ["text"],
    limits: { inputTokens: 8192, maxInputs: 2048, totalTokens: 300_000 },
    ...(dimensions ? { dimensions } : {}),
    task: "none",
    prices: { textInput },
  };
}

/** The OpenAI embedding models (`POST /embeddings`). Prices: OpenAI's pricing page. */
const OPENAI: readonly EmbeddingModelInfo[] = [
  openai(
    "text-embedding-3-small",
    "text-embedding-3-small",
    "OpenAI's small third-generation embedding model.",
    { default: 1536, min: 1, shortenable: true },
    0.02
  ),
  openai(
    "text-embedding-3-large",
    "text-embedding-3-large",
    "OpenAI's most capable third-generation embedding model.",
    { default: 3072, min: 1, shortenable: true },
    0.13
  ),
  openai(
    "text-embedding-ada-002",
    "text-embedding-ada-002",
    "OpenAI's second-generation embedding model (no `dimensions` option).",
    { default: 1536, shortenable: false },
    0.1
  ),
];

const CURATED: readonly EmbeddingModelInfo[] = [...GOOGLE, ...OPENAI];

// `provider/id`, trimmed and lower-cased; a bare id has no provider; in: getEmbeddingModel and unsupportedEmbeddingModelReason, out: the parts.
function split(model: string): { provider?: string; id: string } {
  const text = String(model ?? "").trim();
  const slash = text.indexOf("/");
  if (slash <= 0) return { id: text.toLowerCase() };
  const provider = text.slice(0, slash).toLowerCase();
  return { provider: provider === "gemini" ? "google" : provider, id: text.slice(slash + 1) };
}

// Every known model: the curated Google and OpenAI tables plus the OpenRouter models read from the cached list; in: the two public functions, out: the entries.
function all(): readonly EmbeddingModelInfo[] {
  return [...CURATED, ...openRouterEmbeddingModels()];
}

/**
 * The known embedding models, sorted by `model`; pass a provider (`"google"`, `"openai"`, `"openrouter"`) to see only its models.
 * The OpenRouter models come from the list cached by the last refresh (empty until `generateEmbedding` or
 * `refreshOpenRouterEmbeddingModels` has read it once). A `setModels` list does not hide a model here; it still stops a call.
 */
export function listEmbeddingModels(provider?: string): readonly EmbeddingModelInfo[] {
  const wanted = provider ? split(`${provider}/x`).provider : undefined;
  return all()
    .filter((m) => !wanted || m.provider === wanted)
    .sort((a, b) => a.model.localeCompare(b.model));
}

/** One known embedding model by its `provider/id` string (a bare id matches when only one provider has it), or `undefined`. */
export function getEmbeddingModel(model: string): EmbeddingModelInfo | undefined {
  const { provider, id } = split(model);
  const found = all().filter((m) => m.id.toLowerCase() === id.toLowerCase() && (!provider || m.provider === provider));
  return provider || found.length === 1 ? found[0] : undefined;
}

/** Why `model` is not a known embedding model, or `undefined` when it is known. */
export function unsupportedEmbeddingModelReason(model: string): string | undefined {
  if (getEmbeddingModel(model)) return undefined;
  const { provider } = split(model);
  const known = all()
    .map((m) => m.model)
    .join(", ");
  const openrouterNote =
    provider === "openrouter"
      ? " (the OpenRouter list is read when the first embedding is made; it may not be loaded yet)"
      : "";
  return `"${model}" is not a known embedding model${openrouterNote}. Known embedding models: ${known}.`;
}
