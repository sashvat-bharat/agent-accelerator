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
import { BudgetExceededError, ConfigError, ProviderError, TimeoutError, ValidationError } from "../types/errors.ts";
import type { ProviderRequestOptions } from "../types/model.ts";
import type { TokenUsage } from "../types/core.ts";
import type { ImageOptions, ProviderImageRequest, ProviderImageResult } from "../types/image.ts";
import { estimateImageCostUsd, resolveImageRequest } from "./request.ts";
import { GeneratedImage, ImageResult } from "./result.ts";

/** Default time one provider request may take (image models can think for a while). */
const DEFAULT_TIMEOUT_MS = 300_000;

// An AbortError carrying the signal's reason message; in: the abort paths below, out: the error to throw.
function abortError(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  return Object.assign(new Error(reason instanceof Error ? reason.message : "Image generation aborted"), {
    name: "AbortError",
  });
}

// Runs `task`, rejecting with a TimeoutError after `ms` or an AbortError as soon as `signal` aborts, even when the adapter ignores its signal; in: each provider request, out: the task's result.
function bounded<T>(task: () => Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const timer =
      Number.isFinite(ms) && ms > 0
        ? setTimeout(() => reject(new TimeoutError(`[Agent Accelerator] Image request timed out after ${ms}ms.`)), ms)
        : undefined;
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    task()
      .then(resolve, reject)
      .finally(() => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      });
  });
}

// Adds one usage into a running total (tokens and provider-reported cost); in: generateImage after each request, out: the total.
function addUsage(total: TokenUsage, u: TokenUsage): void {
  total.inputTokens += u.inputTokens || 0;
  total.outputTokens += u.outputTokens || 0;
  total.totalTokens += u.totalTokens || 0;
  for (const k of ["cachedTokens", "cacheReadTokens", "cacheWriteTokens", "thinkingTokens"] as const)
    if (u[k] !== undefined) total[k] = (total[k] ?? 0) + (u[k] ?? 0);
  if (u.cost?.totalCost !== undefined) total.cost = { totalCost: (total.cost?.totalCost ?? 0) + u.cost.totalCost };
}

// Reads every reference image: a picture the SDK made goes in as its bytes, anything else through the media normalizer (local paths must be inside `fileAccess.roots` when set); in: generateImage, out: the normalized media.
async function readReferences(opts: ImageOptions): Promise<NormalizedMedia[]> {
  const out: NormalizedMedia[] = [];
  for (const input of opts.images ?? []) {
    if (input instanceof GeneratedImage) {
      out.push({ mimeType: input.mimeType, base64Data: input.base64, dataUrl: input.dataUrl });
      continue;
    }
    if (opts.fileAccess?.roots && isLocalPathInput(input)) await assertPathAllowed(input, opts.fileAccess.roots);
    const media = await normalizeMediaInput(input);
    if (!media.mimeType.startsWith("image/"))
      throw new ValidationError(
        `[Agent Accelerator] A reference image has the type "${media.mimeType}", which is not an image.`
      );
    out.push(media);
  }
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
  const { request, warnings } = resolveImageRequest(opts, def);
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

  const references = await readReferences(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retry = opts.retry ?? {};
  const providerOptions: ProviderRequestOptions = {
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(retry.maxRetries !== undefined ? { maxRetries: retry.maxRetries } : {}),
    ...(retry.maxDelayMs !== undefined ? { maxRetryDelayMs: retry.maxDelayMs } : {}),
    ...(retry.baseDelayMs !== undefined ? { retryBaseDelayMs: retry.baseDelayMs } : {}),
    ...(retry.budgetMs !== undefined ? { retryBudgetMs: retry.budgetMs } : {}),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  };

  // One shared controller: the caller's signal plus "a sibling request failed", so a failure stops the rest from billing.
  const stop = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
  if (signal.aborted) throw abortError(signal);

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
      ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.size ? { size: request.size } : {}),
      ...(request.quality ? { quality: request.quality } : {}),
      ...(request.format ? { format: request.format } : {}),
      ...(request.background ? { background: request.background } : {}),
      ...(request.thinking ? { thinking: request.thinking } : {}),
    };
    const res = await withProviderSlot(def.provider, signal, () =>
      bounded(() => provider.generateImage!(def.id, body, { ...providerOptions, signal }), timeoutMs, signal)
    );
    spent.usd += res.usage.cost?.totalCost ?? 0; // a price the provider did not report counts as 0 here, never a guess
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

  const images = done.flatMap((r) => r.images.map((i) => new GeneratedImage(i.bytes, i.mimeType)));
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
