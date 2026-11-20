import type { TokenUsage } from "./core.ts";
import type { ProviderId, ProviderRawData } from "./model.ts";
import type { CaptureRawMode } from "../utils/raw-capture.ts";
import type { ConnectionOptions, InputPart, InputPartData } from "../utils/provider-call.ts";

/** The question types, in the providers' own words: `noul` is a yes/no question, `choice` picks one option, `score` rates on ordered levels. */
export const DECISION_QUESTION_TYPES = ["noul", "choice", "score"] as const;

/** One of {@link DECISION_QUESTION_TYPES}. */
export type DecisionQuestionType = (typeof DECISION_QUESTION_TYPES)[number];

/** A piece of data in the input or the instructions: serialized to text (all providers advise that: the keys stay plain data). */
export interface DecisionJsonPart {
  type: "json";
  json: Record<string, unknown> | unknown[];
}

/** One piece of the input: text, a picture, sound, video or PDF (`file`), or JSON. */
export type DecisionPart = InputPart | DecisionJsonPart;

/** What `input` takes: a string, one part or a list of parts. Every question is asked about all of it. */
export type DecisionInput = string | DecisionPart | Array<string | DecisionPart>;

/** The text of a question: a string, or a list of strings, `{ type: "text" }` parts and JSON parts that are joined in order with no separator (include your own spaces or newlines). Text only. */
export type DecisionInstructions = string | Array<string | { type: "text"; text: string } | DecisionJsonPart>;

/** A yes/no question. `criteria` says what yes and no mean when the question alone is ambiguous. */
export interface NoulQuestion {
  type: "noul";
  instructions: DecisionInstructions;
  criteria?: { true?: string; false?: string };
}

/** A question that picks one option. `criteria` maps each option to a description of when it applies (`""` when the option name says it all). */
export interface ChoiceQuestion {
  type: "choice";
  instructions: DecisionInstructions;
  criteria: Record<string, string>;
}

/** A question that rates the input on ordered levels. `criteria` lists the levels from lowest to highest; they are numbered from 0. */
export interface ScoreQuestion {
  type: "score";
  instructions: DecisionInstructions;
  criteria: string[];
}

/** One question. */
export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** What `generateDecision` takes. Only `model`, `input` and `questions` are required; everything else is checked against that model. */
export interface DecisionOptions extends ConnectionOptions {
  /** `provider/model` of a known decision model (see `listDecisionModels`). */
  model: string;
  /** What every question is about. */
  input: DecisionInput;
  /** The questions, by name (`A-Z a-z 0-9 _ -`, up to 64 characters). Each answer comes back under its question's name. */
  questions: Record<string, DecisionQuestion>;
  /** Stops the call (an `AbortError`). */
  signal?: AbortSignal;
  /** The request, in ms. Default 60 000; `0` or `Infinity` turns it off. */
  timeoutMs?: number;
  /** A cost cap for this call: stops (a `BudgetExceededError`) once the reported or priced cost passes it. */
  budget?: { maxCostUsd?: number };
  /** Local picture, sound, video and PDF paths must be inside these folders (`[]` denies all local paths). */
  fileAccess?: { roots?: string[] };
  /** What `DecisionResult.raw` keeps of the wire exchange (same policy as `AgentConfig.captureRaw`). */
  captureRaw?: CaptureRawMode;
}

/** The answer to a yes/no question. `noul` is the probability of yes (the probability of no is `1 - noul`); `confidence` is `max(noul, 1 - noul)` when the provider sends none. */
export interface NoulAnswer {
  type: "noul";
  noul: number;
  confidence: number;
}

/** The answer to a choice question: the most likely option and the probability of every option (they add up to 1). */
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

/** The answer to a score question: the probability-weighted average of the level numbers (it can fall between levels), the probability of each level by its number, and the description of each level. */
export interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  legend: Record<string, string>;
  confidence: number;
}

/** The model declined this question; the other questions still have their answers. Treat it as "not answered". */
export interface RefusalAnswer {
  type: "refusal";
}

/** One answer; check `type` first. */
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer | RefusalAnswer;

/** A question after the checks: its instructions are one string and its criteria are final. */
export type ResolvedDecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

/** What an adapter receives: the request already checked. `input` holds text and media already read; JSON is already text. */
export interface ProviderDecisionRequest {
  input: InputPartData[];
  questions: Record<string, ResolvedDecisionQuestion>;
}

/** An answer as a provider sends it: fields some providers leave out are optional (the core fills them). */
export type ProviderDecisionAnswer =
  | { type: "noul"; noul: number; confidence?: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | {
      type: "score";
      score: number;
      probabilities?: Record<string, number>;
      legend?: Record<string, string>;
      confidence?: number;
    }
  | { type: "refusal" };

/** What an adapter returns for one call: one answer per question, by name. */
export interface ProviderDecisionResult {
  answers: Record<string, ProviderDecisionAnswer>;
  usage: TokenUsage;
  responseId?: string;
  model: string;
  provider: ProviderId;
  raw: ProviderRawData;
  durationMs: number;
}

/** The answers of one `generateDecision` call. */
export interface DecisionResultData {
  answers: Record<string, DecisionAnswer>;
  usage: TokenUsage;
  model: string;
  provider: ProviderId;
  raw: ProviderRawData;
  durationMs: number;
}
