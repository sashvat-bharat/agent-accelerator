/** The result of `generateEmbedding`: the vectors plus usage and the wire audit. */
import type { TokenUsage } from "../types/core.ts";
import type { EmbeddingResultData } from "../types/embedding.ts";
import type { ProviderId, ProviderRawData } from "../types/model.ts";

/** The vectors of one `generateEmbedding` call. */
export class EmbeddingResult {
  /** One vector per input item, in the order of the input. */
  readonly vectors: number[][];
  readonly usage: TokenUsage;
  readonly model: string;
  readonly provider: ProviderId;
  readonly raw: ProviderRawData;
  readonly durationMs: number;
  readonly requests: number;

  constructor(data: EmbeddingResultData) {
    this.vectors = data.vectors;
    this.usage = data.usage;
    this.model = data.model;
    this.provider = data.provider;
    this.raw = data.raw;
    this.durationMs = data.durationMs;
    this.requests = data.requests;
  }

  /** The first vector (a result always has at least one). */
  get vector(): number[] {
    return this.vectors[0]!;
  }

  /** How many numbers each vector has. */
  get dimensions(): number {
    return this.vector.length;
  }
}
