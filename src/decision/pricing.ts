/**
 * Prices one decision call from the model's table entry (`models/decision-models.ts`) and the usage the provider reported, in
 * integer micro-USD like `priceUsage`. Every kind of input bills at one rate; decision models write no text, so nothing is
 * charged for output. What cannot be priced exactly is left unknown (`undefined`), never a made-up number.
 */
import type { DecisionModelInfo } from "../models/decision-models.ts";
import type { TokenUsage } from "../types/core.ts";

// A count of tokens as a whole number >= 0, else 0; in: the usage fields below, out: a safe count.
const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * The cost of one call as `usage.cost`, or `undefined` when the table cannot price this usage exactly: no price in the table, no
 * input tokens reported, or tokens written to the cache when the table states no cache-write rate. Cache reads and writes are a
 * subset of the input tokens; a read without its own rate bills at the input rate.
 */
export function priceDecisionUsage(def: DecisionModelInfo, usage: TokenUsage): TokenUsage["cost"] {
  const { prices } = def;
  const input = count(usage.inputTokens);
  if (!prices || input === 0) return undefined; // no price known, or no usage reported: unknown, not $0
  const written = Math.min(count(usage.cacheWriteTokens), input);
  if (written > 0 && prices.cacheWrite === undefined) return undefined; // those tokens cost a rate the provider does not state
  const read = Math.min(count(usage.cachedTokens ?? usage.cacheReadTokens), input - written);
  const fresh = input - read - written;
  const multiplier = prices.longContext && input > prices.longContext.aboveTokens ? prices.longContext.multiplier : 1;
  const micro = Math.round(
    (fresh * prices.input + read * (prices.cacheRead ?? prices.input) + written * (prices.cacheWrite ?? 0)) * multiplier
  );
  return { inputCost: micro / 1_000_000, outputCost: 0, totalCost: micro / 1_000_000 };
}
