/**
 * `generateEmbedding`: one call that turns text (and, on the models that read them, pictures, sounds, video and PDF) into vectors with
 * a known embedding model (`listEmbeddingModels`). It checks the request against what that model supports, reads any media, splits a
 * long list into the requests the model takes (a few at a time, each under the concurrency limit), checks what comes back, prices it
 * and returns an `EmbeddingResult` with one vector per input item, in order. The SDK only makes vectors: storing and searching them is
 * a vector database's job.
 */
import { getEmbeddingModel, unsupportedEmbeddingModelReason } from "../models/embedding-models.ts";
import { ensureOpenRouterEmbeddingModels } from "../models/openrouter-embeddings.ts";
import { assertModelAllowed } from "../config/models.ts";
import { getProvider } from "../providers/registry.ts";
import { emitProviderWarning } from "../providers.ts";
import { withProviderSlot } from "../agent/governor.ts";
import { applyCaptureRaw } from "../utils/raw-capture.ts";
import { abortError, addUsage, bounded, providerOptionsFrom, readInputPart } from "../utils/provider-call.ts";
import { BudgetExceededError, ConfigError, ProviderError, ValidationError } from "../types/errors.ts";
import type { TokenUsage } from "../types/core.ts";
import type {
  EmbeddingOptions,
  EmbeddingPartData,
  ProviderEmbeddingRequest,
  ProviderEmbeddingResult,
} from "../types/embedding.ts";
import { priceEmbeddingUsage } from "./pricing.ts";
import { sumCosts } from "../image/pricing.ts";
import { resolveEmbeddingRequest } from "./request.ts";
import { EmbeddingResult } from "./result.ts";

/** Default time one provider request may take. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Items per request for a model that states no maximum. */
const DEFAULT_CHUNK = 100;
/** Requests in flight at once for one call (each also waits for the concurrency limit, when one is set). */
const PARALLEL_REQUESTS = 4;

// Scales a vector to length 1 (a zero vector stays as it is); in: generateEmbedding for the models whose shortened vectors are not normalized, out: a new vector.
function unit(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

// Checks what an adapter returned: one vector per item, each a non-empty list of finite numbers, all the same length; in: each request's reply, out: nothing or a ProviderError.
function checkVectors(res: ProviderEmbeddingResult, expected: number, model: string, provider: string): void {
  const bad = (why: string): never => {
    throw new ProviderError(`[${model}] returned an unusable embedding reply: ${why}.`, {
      provider,
      model,
      retryable: false,
    });
  };
  if (!Array.isArray(res.vectors) || res.vectors.length !== expected)
    bad(`${Array.isArray(res.vectors) ? res.vectors.length : "no"} vectors for ${expected} inputs`);
  const length = res.vectors[0]?.length ?? 0;
  for (const v of res.vectors)
    if (
      !Array.isArray(v) ||
      v.length === 0 ||
      v.length !== length ||
      !v.every((x) => typeof x === "number" && Number.isFinite(x))
    )
      bad("a vector is empty, has a different length or holds a value that is not a number");
}

/**
 * Makes one vector per input item (a string, a part, or `{ parts }` combined into one vector) with a known embedding model.
 * `model` is a `provider/model` string from `listEmbeddingModels()`; every other option is checked against what that model
 * supports: a kind of input it cannot read, a vector length outside its range or a part count over its limit is one
 * `ValidationError` listing every problem, and a control the model does not have at all is dropped with a single
 * `provider_warning`. A list longer than the model takes in one request is split into several. Throws `ConfigError` for an unknown
 * model or a missing key, `ModelNotAllowedError` for a model outside the `setModels` list, `BudgetExceededError` over
 * `budget.maxCostUsd`, `ProviderError` for an unusable reply, and `AbortError` when `signal` aborts. A failure after some
 * requests finished carries them as `error.partial.vectors` (aligned with the input, `undefined` where missing).
 *
 * @example `const r = await generateEmbedding({ model: "openai/text-embedding-3-small", input: ["cats purr", "dogs bark"] }); r.vectors[0];`
 */
export async function generateEmbedding(opts: EmbeddingOptions): Promise<EmbeddingResult> {
  const modelText = String(opts?.model ?? "");
  // OpenRouter's embedding models come from its own list, read once and cached: make sure it is there before the lookup.
  if (modelText.toLowerCase().startsWith("openrouter/"))
    await ensureOpenRouterEmbeddingModels(opts.fetch ? { fetch: opts.fetch } : {});
  const def = getEmbeddingModel(modelText);
  if (!def)
    throw new ConfigError(`[Agent Accelerator] ${unsupportedEmbeddingModelReason(modelText) ?? "No model given."}`);
  assertModelAllowed(def.provider, def.id);
  const { request, warnings } = resolveEmbeddingRequest(opts, def);
  for (const w of warnings)
    emitProviderWarning({
      provider: def.provider,
      capability: w.capability,
      requested: `${w.requested} (${def.model})`,
      reason: w.reason,
      fallback: w.fallback,
    });

  const provider = getProvider(def.provider);
  if (!provider.embed)
    throw new ConfigError(`[Agent Accelerator] The ${def.provider} provider cannot make embeddings yet.`);

  const maxCost = opts.budget?.maxCostUsd;
  if (maxCost !== undefined && !(typeof maxCost === "number" && Number.isFinite(maxCost) && maxCost > 0))
    throw new ValidationError("[Agent Accelerator] budget.maxCostUsd must be a number greater than 0.");

  const items: EmbeddingPartData[][] = [];
  for (const parts of request.items) items.push(await Promise.all(parts.map((p) => readInputPart(p, opts.fileAccess))));

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const providerOptions = providerOptionsFrom(opts, timeoutMs);
  // One shared controller: the caller's signal plus "a sibling request failed", so a failure stops the rest from billing.
  const stop = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
  if (signal.aborted) throw abortError(signal, "Embedding aborted");

  // The list is cut into the requests the model takes; the last one gets the rest.
  const size = def.limits.maxInputs ?? DEFAULT_CHUNK;
  const chunks: EmbeddingPartData[][][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));

  const started = Date.now();
  const spent = { usd: 0 };
  const call = async (chunk: EmbeddingPartData[][]): Promise<ProviderEmbeddingResult> => {
    const body: ProviderEmbeddingRequest = {
      items: chunk,
      ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
      ...(request.task ? { task: request.task } : {}),
      ...(request.title ? { title: request.title } : {}),
    };
    const res = await withProviderSlot(def.provider, signal, () =>
      bounded(() => provider.embed!(def.id, body, { ...providerOptions, signal }), timeoutMs, signal, {
        timeout: "Embedding request",
        aborted: "Embedding aborted",
      })
    );
    checkVectors(res, chunk.length, def.model, def.provider);
    // The provider's own cost wins; else the table prices the reported tokens; else it stays unknown (and counts as 0 for the budget).
    if (res.usage.cost?.totalCost === undefined) {
      const cost = priceEmbeddingUsage(def, res.usage, { kinds: request.kinds });
      if (cost) res.usage = { ...res.usage, cost };
    }
    spent.usd += res.usage.cost?.totalCost ?? 0;
    if (maxCost !== undefined && spent.usd > maxCost)
      throw Object.assign(
        new BudgetExceededError(
          `[Agent Accelerator] Cost $${spent.usd.toFixed(6)} is above budget.maxCostUsd $${maxCost}.`
        ),
        { partial: res }
      );
    return res;
  };

  // A few requests at a time; the first real failure stops the others and is the one thrown.
  const done: Array<ProviderEmbeddingResult | undefined> = new Array(chunks.length).fill(undefined);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const lane = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= chunks.length) return;
      try {
        done[i] = await call(chunks[i]!);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err; // the cause, not the AbortError the siblings get next
        }
        stop.abort();
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_REQUESTS, chunks.length) }, lane));
  if (failed) {
    const err = firstError instanceof Error ? firstError : new Error(String(firstError));
    try {
      (err as { partial?: unknown }).partial ??= {
        vectors: chunks.flatMap((c, i) => c.map((_, k) => done[i]?.vectors[k])),
      };
    } catch {
      // why: attaching the finished vectors is a courtesy and must never hide the real error
    }
    throw err;
  }

  const results = done as ProviderEmbeddingResult[];
  let vectors = results.flatMap((r) => r.vectors);
  const length = vectors[0]!.length;
  if (request.dimensions !== undefined && length !== request.dimensions)
    emitProviderWarning({
      provider: def.provider,
      capability: "dimensions",
      requested: `${request.dimensions} (${def.model})`,
      reason: `the model returned vectors of ${length} numbers.`,
      fallback: `the length the model made (${length})`,
    });
  if (
    def.renormalizeShortened &&
    request.dimensions !== undefined &&
    request.dimensions < (def.dimensions?.default ?? 0)
  )
    vectors = vectors.map(unit); // a shortened vector of this model is not length 1: the SDK makes it so

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const r of results) addUsage(usage, r.usage);
  const cost = sumCosts(results.map((r) => r.usage.cost));
  if (cost) usage.cost = cost;
  const first = results[0]!;
  return new EmbeddingResult({
    vectors,
    usage,
    model: def.id,
    provider: def.provider,
    raw: applyCaptureRaw(first.raw, opts.captureRaw) ?? first.raw,
    durationMs: Date.now() - started,
    requests: results.length,
  });
}
