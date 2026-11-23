/**
 * OpenAI decisions (`POST {baseUrl}/decisions`, `gpt-6-luna`). The shared question shape is Google's and OpenRouter's, so this file
 * translates it to OpenAI's: `questions` is an ARRAY in order (each question named by its key), a yes/no is a `predicate` (it has no
 * criteria field, so what yes and no mean is written under the instructions), a choice is `choices` of `{ value, description }`, a
 * score is `levels` of `{ label, description }` numbered from 0. `input` is a plain string when it is one piece of text, else one
 * user message of `input_text` and `input_image` parts (an image's `resolution` becomes `detail`). The reply's `answers` is an
 * array in question order; each is mapped back to the shared shape under its question's name (a predicate has no confidence: the
 * core fills it). The request arrives already checked (`decision/request.ts`). Output is not charged for decisions, and the cache
 * tokens are read from `usage.input_tokens_details`. Not yet checked against the real API (no key); covered by mocked tests built
 * from the API reference.
 */
import type { ProviderRequestOptions } from "../types/model.ts";
import { BULK_REPLY_LIMIT, readTextCapped } from "../utils/body.ts";
import type {
  ProviderDecisionAnswer,
  ProviderDecisionRequest,
  ProviderDecisionResult,
  ResolvedDecisionQuestion,
} from "../types/decision.ts";
import type { InputPartData } from "../utils/provider-call.ts";
import type { TokenUsage } from "../types/core.ts";
import type { MediaResolution } from "../types/message.ts";
import { buildSessionHeaders, setHeaderCaseInsensitive } from "../utils/headers.ts";
import { toConciseProviderError } from "../utils/errors.ts";
import { withRetries } from "../utils/retry.ts";
import { ConfigError, ValidationError } from "../types/errors.ts";
import {
  combinedSignal,
  headersToRecord,
  redactedHeaders,
  resolveProviderApiKey,
  resolveProviderBaseUrl,
  retryOptionsFrom,
  timeoutFor,
} from "./shared.ts";
import { throwOpenAIHttpError } from "./openai-image.ts";

/** `ImagePart.resolution` as OpenAI's `input_image.detail`. */
const IMAGE_DETAIL: Record<MediaResolution, "low" | "auto" | "high" | "original"> = {
  low: "low",
  medium: "auto",
  high: "high",
  ultra_high: "original",
};

type WireAnswer = {
  type?: string;
  name?: string | null;
  probability?: number;
  choice?: string | boolean;
  confidence?: number;
  score?: number;
  probabilities?: Array<{ value?: string | boolean | number; probability?: number }>;
};
interface DecisionReply {
  answers?: WireAnswer[];
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

// The input as OpenAI takes it: a plain string for one piece of text, else one user message of text and image parts; audio, video and PDF are not read by this model (the core refuses them first); in: openaiDecide, out: the request `input`.
function toInput(parts: InputPartData[], modelId: string): string | Array<Record<string, unknown>> {
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only?.kind === "text") return only.text;
  const content = parts.map((p) => {
    if (p.kind === "text") return { type: "input_text", text: p.text };
    if (p.kind === "image")
      return {
        type: "input_image",
        image_url: p.media.dataUrl,
        ...(p.resolution ? { detail: IMAGE_DETAIL[p.resolution] } : {}),
      };
    throw new ValidationError(
      `[Agent Accelerator] [openai/${modelId}] does not read ${p.kind}: decisions take text and images only.`,
      { provider: "openai", model: modelId }
    );
  });
  return [{ type: "message", role: "user", content }];
}

// One question in OpenAI's shape; in: toQuestions, out: a predicate, choice or score object named by its key.
function toQuestion(name: string, q: ResolvedDecisionQuestion): Record<string, unknown> {
  if (q.type === "noul") {
    const yes = q.criteria?.true ? `\nYes means: ${q.criteria.true}` : "";
    const no = q.criteria?.false ? `\nNo means: ${q.criteria.false}` : "";
    return { type: "predicate", name, instructions: `${q.instructions}${yes}${no}` };
  }
  if (q.type === "choice")
    return {
      type: "choice",
      name,
      instructions: q.instructions,
      choices: Object.entries(q.criteria).map(([value, description]) => ({
        value,
        ...(description ? { description } : {}),
      })),
    };
  return {
    type: "score",
    name,
    instructions: q.instructions,
    levels: q.criteria.map((description, i) => ({ label: String(i), description })),
  };
}

// One wire answer back to the shared shape, or undefined when it is not usable (the core then names the question); in: mapAnswers, out: the answer.
function fromAnswer(a: WireAnswer | undefined): ProviderDecisionAnswer | undefined {
  if (!a || typeof a !== "object") return undefined;
  if (a.type === "refusal") return { type: "refusal" };
  if (a.type === "predicate") return { type: "noul", noul: a.probability as number };
  if (a.type === "choice") {
    const probabilities = Object.fromEntries(
      (a.probabilities ?? []).map((p) => [String(p.value), p.probability as number])
    );
    return {
      type: "choice",
      choice: String(a.choice),
      probabilities,
      ...(typeof a.confidence === "number" ? { confidence: a.confidence } : {}),
    };
  }
  if (a.type === "score") {
    const probabilities = Object.fromEntries(
      (a.probabilities ?? []).map((p) => [String(p.value), p.probability as number])
    );
    return {
      type: "score",
      score: a.score as number,
      probabilities,
      ...(typeof a.confidence === "number" ? { confidence: a.confidence } : {}),
    };
  }
  return undefined;
}

// The answers array (in question order) as a map by question name; an answer is matched by position and, when it carries a name, that name must agree; in: doCall, out: the answers by name.
function mapAnswers(names: string[], list: WireAnswer[] | undefined): ProviderDecisionResult["answers"] {
  const out: ProviderDecisionResult["answers"] = {};
  names.forEach((name, i) => {
    const wire = list?.[i];
    if (wire && typeof wire.name === "string" && wire.name !== name) return; // out of order: left out, the core says which question has no answer
    const mapped = fromAnswer(wire);
    if (mapped) out[name] = mapped;
  });
  return out;
}

// Usage as TokenUsage: input and output tokens, the cache reads and writes (both subsets of the input) and the reasoning tokens; in: a reply, out: TokenUsage.
function mapUsage(raw: DecisionReply["usage"]): TokenUsage {
  const input = raw?.input_tokens ?? 0;
  const output = raw?.output_tokens ?? 0;
  const cached = Math.min(raw?.input_tokens_details?.cached_tokens ?? 0, input);
  const written = Math.min(raw?.input_tokens_details?.cache_write_tokens ?? 0, Math.max(0, input - cached));
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: raw?.total_tokens ?? input + output,
    cachedTokens: cached,
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    thinkingTokens: raw?.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

/** Answers the questions of a decision request with an OpenAI decision model, in one `/decisions` request. */
export async function openaiDecide(
  modelId: string,
  request: ProviderDecisionRequest,
  options?: ProviderRequestOptions
): Promise<ProviderDecisionResult> {
  const started = Date.now();
  const apiKey = resolveProviderApiKey("openai", options);
  if (!apiKey) {
    throw new ConfigError(
      "[Agent Accelerator] Missing OpenAI API key. Set OPENAI_API_KEY (or OPENAI_BASE_API_KEY) or pass apiKey."
    );
  }
  const url = `${resolveProviderBaseUrl("openai", options)}/decisions`;
  const names = Object.keys(request.questions);
  const body = {
    model: modelId,
    input: toInput(request.input, modelId),
    questions: names.map((name) => toQuestion(name, request.questions[name]!)),
  };
  const headers = buildSessionHeaders("openai", options?.headers, undefined);
  setHeaderCaseInsensitive(headers, "Content-Type", "application/json");
  if (apiKey !== "unused") setHeaderCaseInsensitive(headers, "Authorization", `Bearer ${apiKey}`);
  const rawRequest = {
    url,
    method: "POST",
    headers: redactedHeaders({ ...headers, Authorization: "[REDACTED]" }),
    body,
  };

  const doCall = async (): Promise<ProviderDecisionResult> => {
    const { signal, cleanup } = combinedSignal(options?.signal, timeoutFor(options));
    let res: Response;
    let text: string;
    try {
      res = await (options?.fetch ?? fetch)(url, { method: "POST", headers, body: JSON.stringify(body), signal });
      text = await readTextCapped(res, BULK_REPLY_LIMIT);
    } finally {
      cleanup();
    }
    const responseHeaders = headersToRecord(res.headers);
    throwOpenAIHttpError(res.status, url, text, modelId, responseHeaders);
    let reply: DecisionReply;
    try {
      reply = JSON.parse(text) as DecisionReply;
    } catch {
      throw toConciseProviderError(
        Object.assign(new Error("Invalid JSON response from the OpenAI decisions API"), {
          statusCode: res.status,
          responseBody: text.slice(0, 500),
          url,
        }),
        "openai",
        modelId
      );
    }
    return {
      answers: mapAnswers(names, reply.answers),
      usage: mapUsage(reply.usage),
      ...(responseHeaders["x-request-id"] ? { responseId: responseHeaders["x-request-id"] } : {}),
      model: modelId,
      provider: "openai",
      raw: {
        request: rawRequest,
        response: { status: res.status, statusText: res.statusText, headers: responseHeaders, body: reply },
      },
      durationMs: Date.now() - started,
    };
  };

  return withRetries(doCall, {
    ...retryOptionsFrom(options),
    signal: options?.signal,
    label: { providerId: "openai", modelId },
  });
}
