/**
 * `generateImage`: one call that makes pictures with a supported image model (`listImageModels`). It checks the request
 * against what that model supports, reads the reference images, calls the provider adapter (several parallel requests when `n`
 * is above the model's per-request maximum, each under the concurrency limit), and returns an `ImageResult`. A call that
 * yields no picture always throws, so `result.image` exists whenever it returns.
 */
import { getImageModel, unsupportedImageModelReason } from "../models/image-models.ts";
import { assertModelAllowed } from "../config/models.ts";
import { getProvider } from "../providers/registry.ts";
import { emitProviderWarning } from "../providers.ts";
import { withProviderSlot } from "../agent/governor.ts";
import { assertPathAllowed, isLocalPathInput } from "../utils/safe-io.ts";
import { normalizeMediaInput, type NormalizedMedia } from "../utils/media.ts";
import { applyCaptureRaw } from "../utils/raw-capture.ts";
import { BudgetExceededError, ConfigError, ProviderError, ValidationError, abortErrorFor } from "../types/errors.ts";
import { addUsage, bounded, providerOptionsFrom } from "../utils/provider-call.ts";
import type { TokenUsage } from "../types/core.ts";
import type {
  ImageEditOptions,
  ImageInput,
  ImageOptions,
  ProviderImageRequest,
  ProviderImageResult,
} from "../types/image.ts";
import { estimateImageCostUsd, resolveImageRequest } from "./request.ts";
import { priceImageUsage, sumCosts } from "./pricing.ts";
import { GeneratedImage, ImageResult, attachOrigin, originOf } from "./result.ts";

/** Default time one provider request may take (image models can think for a while). */
const DEFAULT_TIMEOUT_MS = 300_000;

// Reads one picture: one the SDK made goes in as its bytes, anything else through the media normalizer (a local path must be inside `fileAccess.roots` when set); in: generateImage and generateVideo, out: the normalized media.
export async function readImageInput(input: ImageInput, fileAccess?: { roots?: string[] }): Promise<NormalizedMedia> {
  if (input instanceof GeneratedImage)
    return { mimeType: input.mimeType, base64Data: input.base64, dataUrl: input.dataUrl };
  if (fileAccess?.roots && isLocalPathInput(input)) await assertPathAllowed(input, fileAccess.roots);
  const media = await normalizeMediaInput(input);
  if (!media.mimeType.startsWith("image/"))
    throw new ValidationError(
      `[Agent Accelerator] A reference image has the type "${media.mimeType}", which is not an image.`
    );
  return media;
}

// Reads every reference image; in: generateImage, out: the normalized media.
async function readReferences(opts: ImageOptions): Promise<NormalizedMedia[]> {
  const out: NormalizedMedia[] = [];
  for (const input of opts.images ?? []) out.push(await readImageInput(input, opts.fileAccess));
  return out;
}

/**
 * Makes `n` pictures (default 1) with a supported image model. `model` is a `provider/model` string from `listImageModels()`;
 * every other option is checked against what that model supports: a ratio, size tier, quality, format, thinking level or
 * reference-image count it does not take is one `ValidationError` listing every problem, and a control the model does not
 * have at all is dropped with a single `provider_warning`. Throws `ConfigError` for an unsupported model or a missing key,
 * `ModelNotAllowedError` for a model outside the `setModels` list, `BudgetExceededError` over `budget.maxCostUsd`,
 * `ProviderError` when the provider returns no picture, and `AbortError` when `signal` aborts.
 *
 * @example `const r = await generateImage({ model: "google/gemini-nano-banana-2.1", prompt: "A red fox", aspectRatio: "16:9" }); await r.image.save("fox.png");`
 */
export async function generateImage(opts: ImageOptions): Promise<ImageResult> {
  const def = getImageModel(String(opts?.model ?? ""));
  if (!def)
    throw new ConfigError(
      `[Agent Accelerator] ${unsupportedImageModelReason(String(opts?.model ?? "")) ?? "No model given."}`
    );
  assertModelAllowed(def.provider, def.id);
  // Continuing from a picture: on the same Google model the stored interaction is continued; anywhere else the picture is the first reference image.
  const from = opts.continueFrom;
  if (from !== undefined && !(from instanceof GeneratedImage))
    throw new ValidationError("[Agent Accelerator] continueFrom must be a picture from generateImage.");
  const origin = from ? originOf(from) : undefined;
  const chainId = from && def.provider === "google" && origin?.model === def.model ? origin.chainId : undefined;
  const effective: ImageOptions = from && !chainId ? { ...opts, images: [from, ...(opts.images ?? [])] } : opts;
  const { request, warnings } = resolveImageRequest(effective, def);
  for (const w of warnings)
    emitProviderWarning({
      provider: def.provider,
      capability: w.capability,
      requested: `${w.requested} (${def.model})`,
      reason: w.reason,
      fallback: w.fallback,
    });

  const provider = getProvider(def.provider);
  if (!provider.generateImage)
    throw new ConfigError(`[Agent Accelerator] The ${def.provider} provider cannot make images yet.`);

  const maxCost = opts.budget?.maxCostUsd;
  if (maxCost !== undefined) {
    if (!(typeof maxCost === "number" && Number.isFinite(maxCost) && maxCost > 0))
      throw new ValidationError("[Agent Accelerator] budget.maxCostUsd must be a number greater than 0.");
    const estimate = estimateImageCostUsd(def, request.resolution, request.count);
    if (estimate !== undefined && estimate > maxCost)
      throw new BudgetExceededError(
        `[Agent Accelerator] Estimated cost $${estimate.toFixed(4)} for ${request.count} image(s) on ${def.model} is above budget.maxCostUsd $${maxCost}.`
      );
  }

  const references = await readReferences(effective);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const providerOptions = providerOptionsFrom(opts, timeoutMs);

  // One shared controller: the caller's signal plus "a sibling request failed", so a failure stops the rest from billing.
  const stop = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
  if (signal.aborted) throw abortErrorFor(signal, "Image generation aborted");

  // How many pictures each request asks for: the model's per-request maximum, the last one gets the rest.
  const per = def.imagesPerRequest.max;
  const counts: number[] = [];
  for (let left = request.count; left > 0; left -= per) counts.push(Math.min(per, left));

  const started = Date.now();
  const spent = { usd: 0 };
  const call = async (count: number): Promise<ProviderImageResult> => {
    const body: ProviderImageRequest = {
      prompt: request.prompt,
      images: references,
      count,
      ...(chainId ? { previousInteractionId: chainId } : {}),
      ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.size ? { size: request.size } : {}),
      ...(request.quality ? { quality: request.quality } : {}),
      ...(request.format ? { format: request.format } : {}),
      ...(request.background ? { background: request.background } : {}),
      ...(request.thinking ? { thinking: request.thinking } : {}),
    };
    const res = await withProviderSlot(def.provider, signal, () =>
      bounded(() => provider.generateImage!(def.id, body, { ...providerOptions, signal }), timeoutMs, signal, {
        timeout: "Image request",
        aborted: "Image generation aborted",
      })
    );
    // The provider's own cost wins; else the table prices the reported tokens; else it stays unknown (and counts as 0 for the budget).
    if (res.usage.cost?.totalCost === undefined) {
      const priced = priceImageUsage(def, res.usage, {
        images: res.images.length,
        references: references.length,
        ...(request.resolution ? { resolution: request.resolution } : {}),
      });
      if (priced)
        res.usage = {
          ...res.usage,
          cost: { inputCost: priced.inputCost, outputCost: priced.outputCost, totalCost: priced.totalCost },
        };
    }
    spent.usd += res.usage.cost?.totalCost ?? 0;
    if (maxCost !== undefined && spent.usd > maxCost)
      throw Object.assign(
        new BudgetExceededError(
          `[Agent Accelerator] Cost $${spent.usd.toFixed(4)} is above budget.maxCostUsd $${maxCost}.`
        ),
        { partial: res }
      );
    return res;
  };
  let firstError: unknown;
  let failed = false;
  const settled = await Promise.allSettled(
    counts.map((c) =>
      call(c).catch((err) => {
        if (!failed) {
          failed = true;
          firstError = err; // the cause, not the AbortError the siblings get next
        }
        stop.abort(); // the others would only add cost to a call that already failed
        throw err;
      })
    )
  );
  const done = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  if (failed) {
    const err = firstError instanceof Error ? firstError : new Error(String(firstError));
    try {
      (err as { partial?: unknown }).partial ??= {
        images: done.flatMap((r) => r.images.map((i) => new GeneratedImage(i.bytes, i.mimeType))),
      };
    } catch {
      // why: attaching the finished pictures is a courtesy and must never hide the real error
    }
    throw err;
  }

  const inherit: ImageEditOptions = {
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.captureRaw ? { captureRaw: opts.captureRaw } : {}),
    ...(opts.fileAccess ? { fileAccess: opts.fileAccess } : {}),
  };
  const images = done.flatMap((r) =>
    r.images.map((i) => {
      const img = new GeneratedImage(i.bytes, i.mimeType);
      attachOrigin(img, {
        model: def.model,
        ...(def.provider === "google" && r.responseId ? { chainId: r.responseId } : {}),
        inherit,
      });
      return img;
    })
  );
  if (images.length === 0) {
    const why = done.map((r) => r.text || r.finishReason).find(Boolean);
    throw new ProviderError(`[${def.model}] returned no image${why ? `: ${why}` : ""}.`, {
      provider: def.provider,
      model: def.id,
      retryable: false,
    });
  }
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const r of done) addUsage(usage, r.usage);
  const cost = sumCosts(done.map((r) => r.usage.cost));
  if (cost) usage.cost = cost;
  const first = done[0]!;
  const text = done
    .map((r) => r.text)
    .filter(Boolean)
    .join("\n");
  const finishReason = first.finishReason;
  return new ImageResult({
    images,
    ...(text ? { text } : {}),
    usage,
    model: def.id,
    provider: def.provider,
    ...(finishReason ? { finishReason } : {}),
    raw: applyCaptureRaw(first.raw, opts.captureRaw) ?? first.raw,
    durationMs: Date.now() - started,
    requests: done.length,
  });
}
