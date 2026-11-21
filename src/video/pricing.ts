/**
 * Prices a video call from the model's table entry (`models/video-models.ts`) and the usage the provider reported, in integer
 * micro-USD like `priceUsage`. Only models with a token price table (Google) can be priced here: OpenRouter reports the cost of every
 * job itself, and a model with neither stays unknown, never a made-up $0.
 */
import type { VideoModelInfo } from "../models/video-models.ts";
import type { TokenUsage } from "../types/core.ts";

// A count of tokens as a whole number >= 0, else 0; in: the usage fields below, out: a safe count.
const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * The cost of one call as `usage.cost`, or `undefined` when the table cannot price this usage exactly: no token prices, or no
 * tokens reported. Input (the prompt and any pictures or clips) bills at the input rate; of the output, the text the model wrote at
 * the text rate and the rest, the video, at the video rate.
 */
export function priceVideoUsage(def: VideoModelInfo, usage: TokenUsage): TokenUsage["cost"] {
  const { prices } = def;
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  if (!prices || (input === 0 && output === 0)) return undefined;
  const text = Math.min(count(usage.outputDetails?.textTokens), output);
  const video =
    usage.outputDetails?.videoTokens !== undefined
      ? Math.min(count(usage.outputDetails.videoTokens), output)
      : output - text;
  const inputMicro = Math.round(input * prices.inputPerMillion);
  const outputMicro = Math.round(text * prices.textOutputPerMillion + video * prices.videoOutputPerMillion);
  return {
    inputCost: inputMicro / 1_000_000,
    outputCost: outputMicro / 1_000_000,
    totalCost: (inputMicro + outputMicro) / 1_000_000,
  };
}

/**
 * What a clip of `seconds` will cost at the table's rate for `resolution` (the model's default when unset), counting the video
 * output only (the prompt and pictures add a little). `undefined` when the table has no token rate for it (OpenRouter models,
 * which report the real cost after the job).
 */
export function estimateVideoCostUsd(
  def: VideoModelInfo,
  seconds: number | undefined,
  resolution: string | undefined
): number | undefined {
  const { prices } = def;
  if (!prices || seconds === undefined) return undefined;
  const tokens = prices.outputTokensPerSecond[resolution ?? def.defaultResolution ?? ""];
  return tokens === undefined ? undefined : (tokens * seconds * prices.videoOutputPerMillion) / 1_000_000;
}
