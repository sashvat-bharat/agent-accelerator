/**
 * The decision models the SDK knows, as small tables of facts: what each one reads (text, images, audio, video, PDF), its limits
 * and its prices. A decision model answers typed questions (yes/no, one of several options, a rating) about an input with
 * calibrated probabilities and writes no text. Google and OpenAI are curated by hand from the providers' own pages (checked
 * 20 Nov 2026); a fact the provider does not state is left out, never guessed. OpenRouter serves dozens of decision models that
 * change often, so its entries come from OpenRouter's own list, cached in the home folder (`openrouter-decisions.ts`).
 * models.dev is not used for these.
 */
import { openRouterDecisionModels } from "./openrouter-decisions.ts";

/** What a decision model can read. */
export type DecisionInputKind = "text" | "image" | "audio" | "video" | "pdf";

/** Prices in USD per 1M input tokens. Decision models write no text, so nothing is charged for output. Unset = unknown (never $0). */
export interface DecisionPrices {
  /** Every kind of input bills at this rate (Google and OpenRouter state one rate for all kinds). */
  input: number;
  /** Input served from the provider's cache. */
  cacheRead?: number;
  /** Writing input to the provider's cache. */
  cacheWrite?: number;
  /** A request whose input is longer than `aboveTokens` costs `multiplier` times these rates (OpenAI: over 272,000 tokens, twice). */
  longContext?: { aboveTokens: number; multiplier: number };
}

/** One supported decision model and everything it can and cannot do. */
export interface DecisionModelInfo {
  /** The full `provider/id` string to pass as `model`. */
  model: string;
  provider: "google" | "openai" | "openrouter";
  id: string;
  name: string;
  description: string;
  inputs: readonly DecisionInputKind[];
  /** Limits as the provider states them (unset = not stated). */
  limits: {
    /** Tokens of the shared input and every question together. */
    inputTokens?: number;
    /** Questions one request may carry. */
    questions?: number;
    /** Options of one choice question. */
    options?: number;
    /** Levels of one score question. */
    levels?: number;
  };
  /** Unset = the price is unknown (OpenRouter reports the cost of each request itself). */
  prices?: DecisionPrices;
}

/** The Google decision model (`POST /v1beta/decisions`). Prices: Google's pricing page, one rate for text, image, video, audio and PDF. */
const GOOGLE: readonly DecisionModelInfo[] = [
  {
    model: "google/gemini-decision-1",
    provider: "google",
    id: "gemini-decision-1",
    name: "Gemini Decision 1",
    description:
      "Google's decision model: yes/no, single-choice and rating questions about text, images, audio, video and PDF, answered with calibrated probabilities and no output tokens.",
    inputs: ["text", "image", "audio", "video", "pdf"],
    limits: { inputTokens: 262_144, questions: 1000, options: 255, levels: 255 },
    prices: { input: 0.1 },
  },
];

/** The OpenAI decision model (`POST /v1/decisions`). Prices: OpenAI's Decisions guide (output is not charged; its cache-write rate is not stated, so it is left out). */
const OPENAI: readonly DecisionModelInfo[] = [
  {
    model: "openai/gpt-6-luna",
    provider: "openai",
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    description:
      "OpenAI's model for the Decisions API: predicate, choice and score questions about text and images, answered with probabilities.",
    inputs: ["text", "image"],
    limits: { questions: 400, options: 255, levels: 10 },
    prices: { input: 0.1, cacheRead: 0.01, longContext: { aboveTokens: 272_000, multiplier: 2 } },
  },
];

const CURATED: readonly DecisionModelInfo[] = [...GOOGLE, ...OPENAI];

// `provider/id`, trimmed; a bare id has no provider; in: getDecisionModel and unsupportedDecisionModelReason, out: the parts.
function split(model: string): { provider?: string; id: string } {
  const text = String(model ?? "").trim();
  const slash = text.indexOf("/");
  if (slash <= 0) return { id: text.toLowerCase() };
  const provider = text.slice(0, slash).toLowerCase();
  return { provider: provider === "gemini" ? "google" : provider, id: text.slice(slash + 1) };
}

// Every known model: the curated Google and OpenAI tables plus the OpenRouter models read from the cached list; in: the public functions, out: the entries.
function all(): readonly DecisionModelInfo[] {
  return [...CURATED, ...openRouterDecisionModels()];
}

/**
 * The known decision models, sorted by `model`; pass a provider (`"google"`, `"openai"`, `"openrouter"`) to see only its models.
 * The OpenRouter models come from the list cached by the last refresh (empty until `generateDecision` or
 * `refreshOpenRouterDecisionModels` has read it once). A `setModels` list does not hide a model here; it still stops a call.
 */
export function listDecisionModels(provider?: string): readonly DecisionModelInfo[] {
  const wanted = provider ? split(`${provider}/x`).provider : undefined;
  return all()
    .filter((m) => !wanted || m.provider === wanted)
    .sort((a, b) => a.model.localeCompare(b.model));
}

/** One known decision model by its `provider/id` string (a bare id matches when only one provider has it), or `undefined`. */
export function getDecisionModel(model: string): DecisionModelInfo | undefined {
  const { provider, id } = split(model);
  const found = all().filter((m) => m.id.toLowerCase() === id.toLowerCase() && (!provider || m.provider === provider));
  return provider || found.length === 1 ? found[0] : undefined;
}

/** Why `model` is not a known decision model, or `undefined` when it is known. */
export function unsupportedDecisionModelReason(model: string): string | undefined {
  if (getDecisionModel(model)) return undefined;
  const { provider } = split(model);
  const known = all()
    .map((m) => m.model)
    .join(", ");
  const openrouterNote =
    provider === "openrouter"
      ? " (the OpenRouter list is read when the first decision is made; it may not be loaded yet, and it needs an OpenRouter key)"
      : "";
  return `"${model}" is not a known decision model${openrouterNote}. Known decision models: ${known}.`;
}
