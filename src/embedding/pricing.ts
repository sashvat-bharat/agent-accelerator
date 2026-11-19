/**
 * Prices one embedding call from the model's table entry (`models/embedding-models.ts`) and the usage the provider reported, in
 * integer micro-USD like `priceUsage`. Text tokens bill at the text rate and, where the provider splits them, image, audio and
 * video tokens at their own rates. What cannot be priced exactly is left unknown (`undefined`), never a made-up number.
 */
import type { EmbeddingInputKind, EmbeddingModelInfo } from "../models/embedding-models.ts";
import type { TokenUsage } from "../types/core.ts";

// A count of tokens as a whole number >= 0, else 0; in: the usage fields below, out: a safe count.
const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * The cost of one call as `usage.cost`, or `undefined` when the table cannot price this usage exactly: no price in the table, no
 * tokens reported, or media tokens whose rate the table does not have. Without a per-kind split, only a text-only call can be priced.
 */
export function priceEmbeddingUsage(
  def: EmbeddingModelInfo,
  usage: TokenUsage,
  call: { kinds: ReadonlySet<EmbeddingInputKind> }
): TokenUsage["cost"] {
  const { prices } = def;
  const input = count(usage.inputTokens);
  if (!prices || input === 0) return undefined; // no price known, or no usage reported: unknown, not $0
  const d = usage.inputDetails;
  let micro: number;
  if (d && [d.imageTokens, d.audioTokens, d.videoTokens, d.textTokens].some((n) => n !== undefined)) {
    const image = count(d.imageTokens);
    const audio = count(d.audioTokens);
    const video = count(d.videoTokens);
    const text = d.textTokens !== undefined ? count(d.textTokens) : Math.max(0, input - image - audio - video);
    if (
      (image > 0 && prices.imageInput === undefined) ||
      (audio > 0 && prices.audioInput === undefined) ||
      (video > 0 && prices.videoInput === undefined)
    )
      return undefined;
    micro = Math.round(
      text * prices.textInput +
        image * (prices.imageInput ?? 0) +
        audio * (prices.audioInput ?? 0) +
        video * (prices.videoInput ?? 0)
    );
  } else if ([...call.kinds].every((k) => k === "text")) {
    micro = Math.round(input * prices.textInput);
  } else return undefined; // media was sent and the provider did not say how many of the tokens it was
  return { inputCost: micro / 1_000_000, outputCost: 0, totalCost: micro / 1_000_000 };
}
