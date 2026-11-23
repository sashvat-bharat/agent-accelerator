/**
 * `generateDecision`: one call that asks typed questions (yes/no, one of several options, a rating) about an input with a known
 * decision model (`listDecisionModels`) and returns calibrated probabilities, never text. It checks the request against what that
 * model supports, reads any media, makes ONE provider request (all questions share it, so the input is paid for once), checks
 * every answer, prices it and returns a `DecisionResult`. Deciding what to do with the probabilities (thresholds, routing) is the
 * caller's job.
 */
import { getDecisionModel, unsupportedDecisionModelReason } from "../models/decision-models.ts";
import { ensureOpenRouterDecisionModels } from "../models/openrouter-decisions.ts";
import { assertModelAllowed } from "../config/models.ts";
import { getProvider } from "../providers/registry.ts";
import { withProviderSlot } from "../agent/governor.ts";
import { applyCaptureRaw } from "../utils/raw-capture.ts";
import { bounded, providerOptionsFrom, readInputPart } from "../utils/provider-call.ts";
import { BudgetExceededError, ConfigError, ProviderError, ValidationError, abortErrorFor } from "../types/errors.ts";
import type {
  DecisionAnswer,
  DecisionOptions,
  ProviderDecisionAnswer,
  ProviderDecisionRequest,
  ProviderDecisionResult,
  ResolvedDecisionQuestion,
} from "../types/decision.ts";
import { priceDecisionUsage } from "./pricing.ts";
import { resolveDecisionRequest } from "./request.ts";
import { DecisionResult } from "./result.ts";

/** Default time the provider request may take (decision models answer in a moment). */
const DEFAULT_TIMEOUT_MS = 60_000;
/** A probability a hair outside 0..1 from float rounding is accepted. */
const EPSILON = 1e-6;

// True for a number from 0 to 1 (within float rounding); in: the answer checks, out: a boolean.
const isProbability = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= -EPSILON && v <= 1 + EPSILON;

// Checks one provider answer against its question and fills what some providers leave out (the confidence of a yes/no, the legend of a score); in: checkAnswers, out: the answer or a problem text.
function completeAnswer(q: ResolvedDecisionQuestion, a: ProviderDecisionAnswer | undefined): DecisionAnswer | string {
  if (!a || typeof a !== "object") return "no answer came back";
  if (a.type === "refusal") return { type: "refusal" };
  if (a.type !== q.type) return `the answer is a ${String(a.type)}, the question was a ${q.type}`;
  if (a.type === "noul") {
    if (!isProbability(a.noul)) return "the yes probability is not a number from 0 to 1";
    const confidence = isProbability(a.confidence) ? a.confidence : Math.max(a.noul, 1 - a.noul);
    return { type: "noul", noul: a.noul, confidence };
  }
  const probs = a.probabilities;
  if (
    !probs ||
    typeof probs !== "object" ||
    Object.values(probs).some((p) => !isProbability(p)) ||
    Object.keys(probs).length === 0
  )
    return "the probabilities are missing or not numbers from 0 to 1";
  const top = Math.max(...Object.values(probs));
  const confidence = isProbability(a.confidence) ? a.confidence : top;
  if (a.type === "choice") {
    if (q.type !== "choice") return "unreachable";
    if (typeof a.choice !== "string" || !Object.hasOwn(q.criteria, a.choice))
      return `"${String(a.choice)}" is not one of the options`;
    if (Object.keys(probs).some((k) => !Object.hasOwn(q.criteria, k)))
      return "the probabilities name an option that was not asked";
    return { type: "choice", choice: a.choice, probabilities: probs, confidence };
  }
  if (q.type !== "score") return "unreachable";
  const last = q.criteria.length - 1;
  if (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < -EPSILON || a.score > last + EPSILON)
    return `the score is not a number from 0 to ${last}`;
  if (Object.keys(probs).some((k) => !/^\d+$/.test(k) || Number(k) > last))
    return "the probabilities name a level that was not asked";
  const legend = Object.fromEntries(q.criteria.map((text, i) => [String(i), text]));
  return { type: "score", score: a.score, probabilities: probs, legend, confidence };
}

// Checks every answer of a reply (one per question, right type, usable numbers); an unusable reply is a non-retryable ProviderError that names the question; in: generateDecision, out: the completed answers by question name.
function checkAnswers(
  questions: Record<string, ResolvedDecisionQuestion>,
  res: ProviderDecisionResult,
  model: string,
  provider: string
): Record<string, DecisionAnswer> {
  const out: Record<string, DecisionAnswer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const done = completeAnswer(q, res.answers?.[name]);
    if (typeof done === "string")
      throw new ProviderError(`[${model}] returned an unusable decision reply for "${name}": ${done}.`, {
        provider,
        model,
        retryable: false,
      });
    out[name] = done;
  }
  return out;
}

/**
 * Asks typed questions about an input with a known decision model. `model` is a `provider/model` string from
 * `listDecisionModels()`; `questions` map a name to `{ type: "noul" | "choice" | "score", instructions, criteria }`, exactly as the
 * providers define them, and each answer comes back under its name: `noul` (the probability of yes), `choice` with `probabilities`,
 * `score` with `probabilities` and `legend`, each with a `confidence`, or `{ type: "refusal" }` for a question the model declined.
 * Everything is checked against the model first (input kinds it reads, question and option counts, names): a problem is one
 * `ValidationError` listing all of them. Throws `ConfigError` for an unknown model or a missing key, `ModelNotAllowedError` for a
 * model outside the `setModels` list, `BudgetExceededError` over `budget.maxCostUsd`, `ProviderError` for an unusable reply, and
 * `AbortError` when `signal` aborts.
 *
 * @example `const r = await generateDecision({ model: "google/gemini-decision-1", input: "Arrived cracked.", questions: { damaged: { type: "noul", instructions: "Did the item arrive damaged?" } } }); r.answers.damaged;`
 */
export async function generateDecision(opts: DecisionOptions): Promise<DecisionResult> {
  const modelText = String(opts?.model ?? "");
  // OpenRouter's decision models come from its own list, read once and cached: make sure it is there before the lookup.
  if (modelText.toLowerCase().startsWith("openrouter/"))
    await ensureOpenRouterDecisionModels({
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
  const def = getDecisionModel(modelText);
  if (!def)
    throw new ConfigError(`[Agent Accelerator] ${unsupportedDecisionModelReason(modelText) ?? "No model given."}`);
  assertModelAllowed(def.provider, def.id);
  const request = resolveDecisionRequest(opts, def);

  const provider = getProvider(def.provider);
  if (!provider.decide)
    throw new ConfigError(`[Agent Accelerator] The ${def.provider} provider cannot make decisions yet.`);

  const maxCost = opts.budget?.maxCostUsd;
  if (maxCost !== undefined && !(typeof maxCost === "number" && Number.isFinite(maxCost) && maxCost > 0))
    throw new ValidationError("[Agent Accelerator] budget.maxCostUsd must be a number greater than 0.");

  const input = await Promise.all(request.input.map((p) => readInputPart(p, opts.fileAccess)));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const providerOptions = providerOptionsFrom(opts, timeoutMs);
  const signal = opts.signal ?? new AbortController().signal;
  if (signal.aborted) throw abortErrorFor(signal, "Decision aborted");

  const body: ProviderDecisionRequest = { input, questions: request.questions };
  const started = Date.now();
  const res = await withProviderSlot(def.provider, signal, () =>
    bounded(() => provider.decide!(def.id, body, { ...providerOptions, signal }), timeoutMs, signal, {
      timeout: "Decision request",
      aborted: "Decision aborted",
    })
  );
  const answers = checkAnswers(request.questions, res, def.model, def.provider);
  // The provider's own cost wins; else the table prices the reported tokens; else it stays unknown (and counts as 0 for the budget).
  let usage = res.usage;
  if (usage.cost?.totalCost === undefined) {
    const cost = priceDecisionUsage(def, usage);
    if (cost) usage = { ...usage, cost };
  }
  const spent = usage.cost?.totalCost ?? 0;
  if (maxCost !== undefined && spent > maxCost)
    throw Object.assign(
      new BudgetExceededError(`[Agent Accelerator] Cost $${spent.toFixed(6)} is above budget.maxCostUsd $${maxCost}.`),
      { partial: { answers, usage } }
    );
  return new DecisionResult({
    answers,
    usage,
    model: def.id,
    provider: def.provider,
    raw: applyCaptureRaw(res.raw, opts.captureRaw) ?? res.raw,
    durationMs: Date.now() - started,
  });
}
