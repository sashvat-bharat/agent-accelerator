/**
 * Prices one image call from the model's table entry (`models/image-models.ts`) and the usage the provider reported, in
 * integer micro-USD like `priceUsage`. Image output tokens bill at the image rate and everything else the model writes (text,
 * thinking) at the text rate, so the split matters: Google reports it per modality, OpenAI's image models write only images.
 * What cannot be priced exactly is left unknown (`undefined`), never a made-up number. Cache hits are not priced: the
 * Image API and these Google models report none.
 */
import type { ImageModelInfo } from "../models/image-models.ts";
import type { TokenUsage } from "../types/core.ts";
import type { ImageResolution } from "../types/image.ts";
import type { PricedCost } from "../session/store.ts";

// A count of tokens as a whole number >= 0, else 0; in: the usage fields below, out: a safe count.
const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * The cost of one call: `images` is how many pictures it returned and `resolution` the tier asked for (both only used to
 * estimate the image tokens when the provider did not report them). `undefined` when the table cannot price this usage exactly.
 */
export function priceImageUsage(
  def: ImageModelInfo,
  usage: TokenUsage,
  call: { images: number; references: number; resolution?: ImageResolution }
): PricedCost | undefined {
  const { prices } = def;
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  if (input === 0 && output === 0) return undefined; // the provider reported no usage: unknown, not $0

  // Input: one price when text and image input cost the same (both Google models); else it needs the split, or no reference images.
  let inputMicro: number;
  if (prices.textInput === prices.imageInput) inputMicro = Math.round(input * prices.textInput);
  else if (usage.inputDetails?.imageTokens !== undefined) {
    const image = Math.min(count(usage.inputDetails.imageTokens), input);
    inputMicro = Math.round((input - image) * prices.textInput + image * prices.imageInput);
  } else if (call.references === 0) {
    inputMicro = Math.round(input * prices.textInput);
  } else return undefined; // reference images were sent and the provider did not say how many input tokens they were

  // Output: reported image tokens, else all of it for a model that writes only images, else the table's tokens per picture.
  let imageOut: number;
  if (usage.outputDetails?.imageTokens !== undefined)
    imageOut = Math.min(count(usage.outputDetails.imageTokens), output);
  else if (prices.textOutput === undefined) imageOut = output;
  else {
    const perImage = def.tokensPerImage?.[call.resolution ?? def.defaultResolution ?? ""];
    if (perImage === undefined) return undefined;
    imageOut = Math.min(perImage * call.images, output);
  }
  const textOut = output - imageOut;
  const outputMicro = Math.round(imageOut * prices.imageOutput + textOut * (prices.textOutput ?? 0));

  const totalMicro = inputMicro + outputMicro;
  return {
    inputCost: inputMicro / 1_000_000,
    outputCost: outputMicro / 1_000_000,
    totalCost: totalMicro / 1_000_000,
    source: "catalog",
    breakdown: {
      inputMicroUSD: inputMicro,
      outputMicroUSD: outputMicro,
      cacheReadMicroUSD: 0,
      cacheWriteMicroUSD: 0,
      audioMicroUSD: 0,
      totalMicroUSD: totalMicro,
      tier: "image-table",
      serviceTierMultiplier: 1,
    },
  };
}

/** The total cost of the calls when EVERY call has one (provider-reported, else priced from the table), else undefined: one unpriced call makes the total unknown, never a partial sum; in: generateImage, out: the result's usage.cost. */
export function sumCosts(costs: Array<TokenUsage["cost"]>): TokenUsage["cost"] {
  if (costs.length === 0 || costs.some((c) => c?.totalCost === undefined)) return undefined;
  const sum = (k: "inputCost" | "outputCost" | "totalCost"): number =>
    Math.round(costs.reduce((n, c) => n + (c?.[k] ?? 0), 0) * 1e6) / 1e6;
  const hasParts = costs.every((c) => c?.inputCost !== undefined && c?.outputCost !== undefined);
  return {
    ...(hasParts ? { inputCost: sum("inputCost"), outputCost: sum("outputCost") } : {}),
    totalCost: sum("totalCost"),
  };
}
