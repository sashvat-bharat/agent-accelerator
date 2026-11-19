/**
 * OpenAI embeddings (`POST {baseUrl}/embeddings`), for `text-embedding-3-small`, `text-embedding-3-large` and
 * `text-embedding-ada-002`. Text only: the request is a list of strings, one per item, and the reply holds one vector per string
 * (put back in order by its `index`). The request arrives already checked (`embedding/request.ts`), so this file only maps it to the
 * wire (`dimensions` only when given, which the core allows on the `3` models alone), reads the reply and maps errors. OpenAI has no
 * task control, so a task never reaches here. Vectors are asked as floats (the default); `base64` is never used.
 */
import type { ProviderRequestOptions } from "../types/model.ts";
import type { ProviderEmbeddingRequest, ProviderEmbeddingResult } from "../types/embedding.ts";
import type { TokenUsage } from "../types/core.ts";
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

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface EmbeddingsReply {
  data?: Array<{ embedding?: number[] | string; index?: number }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

// The text of each item; an item that is not exactly one text part cannot be sent (the core refuses it earlier, this guards the adapter on its own); in: buildBody, out: the strings.
function texts(request: ProviderEmbeddingRequest, modelId: string): string[] {
  return request.items.map((item, i) => {
    const only = item.length === 1 ? item[0] : undefined;
    if (only?.kind !== "text")
      throw new ValidationError(`[Agent Accelerator] [openai/${modelId}] input[${i}] must be one piece of text.`, {
        provider: "openai",
        model: modelId,
      });
    return only.text;
  });
}

// Usage as TokenUsage: OpenAI reports the prompt tokens (embeddings have no output); in: a reply, out: TokenUsage.
function mapUsage(raw: EmbeddingsReply["usage"]): TokenUsage {
  const input = raw?.prompt_tokens ?? 0;
  return { inputTokens: input, outputTokens: 0, totalTokens: raw?.total_tokens ?? input };
}

/** Makes one vector per text with an OpenAI embedding model, in one `/embeddings` request. */
export async function openaiEmbed(
  modelId: string,
  request: ProviderEmbeddingRequest,
  options?: ProviderRequestOptions
): Promise<ProviderEmbeddingResult> {
  const started = Date.now();
  const apiKey = resolveProviderApiKey("openai", options);
  if (!apiKey) {
    throw new ConfigError(
      "[Agent Accelerator] Missing OpenAI API key. Set OPENAI_API_KEY (or OPENAI_BASE_API_KEY) or pass apiKey."
    );
  }
  const url = `${resolveProviderBaseUrl("openai", DEFAULT_BASE_URL, options)}/embeddings`;
  const body = {
    model: modelId,
    input: texts(request, modelId),
    ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
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

  const doCall = async (): Promise<ProviderEmbeddingResult> => {
    const { signal, cleanup } = combinedSignal(options?.signal, timeoutFor(options));
    let res: Response;
    let text: string;
    try {
      res = await (options?.fetch ?? fetch)(url, { method: "POST", headers, body: JSON.stringify(body), signal });
      text = await res.text();
    } finally {
      cleanup();
    }
    const responseHeaders = headersToRecord(res.headers);
    throwOpenAIHttpError(res.status, url, text, modelId, responseHeaders);
    let reply: EmbeddingsReply;
    try {
      reply = JSON.parse(text) as EmbeddingsReply;
    } catch {
      throw toConciseProviderError(
        Object.assign(new Error("Invalid JSON response from the OpenAI embeddings API"), {
          statusCode: res.status,
          responseBody: text.slice(0, 500),
          url,
        }),
        "openai",
        modelId
      );
    }
    // The reply lists vectors with their position in the request; put them back in order (a `base64` string is not a vector and is left for the core to refuse).
    const ordered = [...(reply.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return {
      vectors: ordered.map((d) => (Array.isArray(d.embedding) ? d.embedding : [])),
      usage: mapUsage(reply.usage),
      ...(responseHeaders["x-request-id"] ? { responseId: responseHeaders["x-request-id"] } : {}),
      model: modelId,
      provider: "openai",
      raw: {
        request: rawRequest,
        response: {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
          body: reply,
        },
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
