/** The result of `generateDecision`: one answer per question plus usage and the wire audit. */
import type { TokenUsage } from "../types/core.ts";
import type { DecisionAnswer, DecisionResultData } from "../types/decision.ts";
import type { ProviderId, ProviderRawData } from "../types/model.ts";

/** The answers of one `generateDecision` call. */
export class DecisionResult {
  /** One answer per question, under the question's name. Check each answer's `type` before reading it: a question the model declined is `{ type: "refusal" }`. */
  readonly answers: Record<string, DecisionAnswer>;
  readonly usage: TokenUsage;
  readonly model: string;
  readonly provider: ProviderId;
  readonly raw: ProviderRawData;
  readonly durationMs: number;

  constructor(data: DecisionResultData) {
    this.answers = data.answers;
    this.usage = data.usage;
    this.model = data.model;
    this.provider = data.provider;
    this.raw = data.raw;
    this.durationMs = data.durationMs;
  }
}
