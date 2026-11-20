import type { TokenUsage } from "./core.ts";
import type { ProviderId, ProviderRawData } from "./model.ts";
import type { CaptureRawMode } from "../utils/raw-capture.ts";
import type { ConnectionOptions, InputPart, InputPartData } from "../utils/provider-call.ts";

/** What a vector is for. The SDK turns it into whatever the model needs (a request field, words in front of the text, or nothing). */
export const EMBEDDING_TASKS = [
  "search_query",
  "search_document",
  "question_answering",
  "fact_checking",
  "code_retrieval",
  "classification",
  "clustering",
  "similarity",
] as const;

/** One of {@link EMBEDDING_TASKS}. `search_query` and `search_document` go together (embed the question as a query and the passages as documents); `classification`, `clustering` and `similarity` use the same task on both sides. */
export type EmbeddingTask = (typeof EMBEDDING_TASKS)[number];

/** One piece of input: text, or a picture, sound, video or PDF (`file`) on the models that read them. */
export type EmbeddingPart = InputPart;

/** One thing to embed: a string, one part, or `{ parts }` to embed several parts as ONE combined vector (a caption and its picture). */
export type EmbeddingItem = string | EmbeddingPart | { parts: EmbeddingPart[] };

/** What `generateEmbedding` takes. Only `model` and `input` are required; everything else is checked against that model. */
export interface EmbeddingOptions extends ConnectionOptions {
  /** `provider/model` of a known embedding model (see `listEmbeddingModels`). */
  model: string;
  /** One item or a list of items. A list gives one vector per item, in order, on every model. */
  input: EmbeddingItem | EmbeddingItem[];
  /** Vector length. Each model lists what it accepts; a shorter vector keeps most of the quality. */
  dimensions?: number;
  /** What the vectors are for (see {@link EmbeddingTask}). A model with no such control gets a warning and the option is dropped. */
  task?: EmbeddingTask;
  /** Title of a document, with `task: "search_document"` (Google models only). */
  title?: string;
  /** Stops the call (an `AbortError`). */
  signal?: AbortSignal;
  /** Per request, in ms. Default 60 000; `0` or `Infinity` turns it off. */
  timeoutMs?: number;
  /** A cost cap for this call: stops (a `BudgetExceededError`) once the reported or priced cost passes it. */
  budget?: { maxCostUsd?: number };
  /** Local picture, sound, video and PDF paths must be inside these folders (`[]` denies all local paths). */
  fileAccess?: { roots?: string[] };
  /** What `EmbeddingResult.raw` keeps of the wire exchange (same policy as `AgentConfig.captureRaw`). */
  captureRaw?: CaptureRawMode;
}

/** One part of an item after it was read: text, or media already loaded as base64 and a type. */
export type EmbeddingPartData = InputPartData;

/** What an adapter receives: the request already checked. One entry of `items` makes ONE vector (several parts are combined). */
export interface ProviderEmbeddingRequest {
  items: EmbeddingPartData[][];
  dimensions?: number;
  task?: EmbeddingTask;
  title?: string;
}

/** What an adapter returns for one call: one vector per item, in the order of `items`. */
export interface ProviderEmbeddingResult {
  vectors: number[][];
  usage: TokenUsage;
  responseId?: string;
  model: string;
  provider: ProviderId;
  raw: ProviderRawData;
  durationMs: number;
}

/** The vectors of one `generateEmbedding` call. */
export interface EmbeddingResultData {
  vectors: number[][];
  usage: TokenUsage;
  model: string;
  provider: ProviderId;
  raw: ProviderRawData;
  durationMs: number;
  /** Provider requests made (more than one when the list is longer than the model takes in one request). */
  requests: number;
}
