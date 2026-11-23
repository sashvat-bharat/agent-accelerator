/**
 * Checks a decision request against what the chosen model supports (`models/decision-models.ts`) and turns it into the one
 * request the rest of the call works from. Pure: no network, no files. A value the model cannot take (an input kind it does not
 * read, too many questions, a badly formed question) is a problem that fails the whole call with ONE `ValidationError` listing
 * every problem, so one fix round is enough. The rules are the strictest the three providers state (question names of
 * `A-Z a-z 0-9 _ -`, option names Google accepts), so the same request keeps working on every model.
 */
import { ValidationError } from "../types/errors.ts";
import { isRecord } from "../utils/guards.ts";
import { mediaKeyOf } from "../utils/media-part.ts";
import type { DecisionInputKind, DecisionModelInfo } from "../models/decision-models.ts";
import {
  DECISION_QUESTION_TYPES,
  type DecisionInput,
  type DecisionQuestionType,
  type DecisionOptions,
  type ResolvedDecisionQuestion,
} from "../types/decision.ts";
import type { InputPart } from "../utils/provider-call.ts";

/** The request after the checks: the input is a list of text and media parts (JSON is text), the questions are final. */
export interface ResolvedDecisionRequest {
  def: DecisionModelInfo;
  input: InputPart[];
  questions: Record<string, ResolvedDecisionQuestion>;
  /** The kinds of input the request carries. */
  kinds: ReadonlySet<DecisionInputKind>;
}

const QUESTION_KEY = /^[A-Za-z0-9_-]{1,64}$/;
// Option names: 1 to 128 characters, no control characters, no non-ASCII spaces, no leading or trailing space (Google's rule).
const CONTROL = /[\u0000-\u001f\u007f]/;
const WIDE_SPACE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

// The input kind of a part (a `file` is a PDF), or undefined for a part type this call does not know; in: input normalization, out: the kind.
function kindOf(part: { type?: unknown }): DecisionInputKind | undefined {
  switch (part.type) {
    case "text":
    case "image":
    case "audio":
    case "video":
      return part.type;
    case "file":
      return "pdf";
    default:
      return undefined;
  }
}

// JSON as compact text, or undefined when it cannot be written (a cycle, a BigInt); in: input and instructions, out: the text.
function jsonText(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

// One instructions value as one string (list entries joined in order with no separator, JSON written as compact text), or a problem; in: every question, out: the text.
function instructionsText(raw: unknown, at: string, problems: string[]): string {
  const pieces = Array.isArray(raw) ? raw : [raw];
  const before = problems.length;
  let out = "";
  pieces.forEach((piece, i) => {
    const where = Array.isArray(raw) ? `${at}[${i}]` : at;
    if (typeof piece === "string") out += piece;
    else if (piece && typeof piece === "object" && (piece as { type?: unknown }).type === "text") {
      const text = (piece as { text?: unknown }).text;
      if (typeof text === "string") out += text;
      else problems.push(`${where}: a text part needs a string \`text\`.`);
    } else if (piece && typeof piece === "object" && (piece as { type?: unknown }).type === "json") {
      const text = jsonText((piece as { json?: unknown }).json);
      if (text === undefined) problems.push(`${where}: the JSON cannot be written as text.`);
      else out += text;
    } else problems.push(`${where}: expected text (a string, { type: "text", text } or { type: "json", json }).`);
  });
  if (!out.trim() && problems.length === before) problems.push(`${at}: required, not empty.`);
  return out;
}

// Whether a name is a usable option name; in: choice criteria, out: a problem text or undefined.
function optionNameProblem(name: string): string | undefined {
  if (name.length < 1 || name.length > 128) return "must have 1 to 128 characters";
  if (name !== name.trim()) return "must not start or end with a space";
  if (CONTROL.test(name) || WIDE_SPACE.test(name)) return "must not hold control characters or non-ASCII spaces";
  return undefined;
}

/**
 * Checks `opts` against `def` and returns the final request. Throws one `ValidationError` that lists every problem.
 */
export function resolveDecisionRequest(opts: DecisionOptions, def: DecisionModelInfo): ResolvedDecisionRequest {
  const problems: string[] = [];
  const kinds = new Set<DecisionInputKind>();

  // Input: a string, one part or a list; JSON becomes text.
  const raw: DecisionInput | undefined = opts.input;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw];
  const input: InputPart[] = [];
  if (list.length === 0) problems.push("input: required, a string, a part or a non-empty list of them.");
  list.forEach((entry, i) => {
    const at = Array.isArray(raw) ? `input[${i}]` : "input";
    const part: unknown = typeof entry === "string" ? { type: "text", text: entry } : entry;
    if (!part || typeof part !== "object")
      return void problems.push(`${at}: expected a string or a part like { type: "image", image }.`);
    if ((part as { type?: unknown }).type === "json") {
      const text = jsonText((part as { json?: unknown }).json);
      if (text === undefined) return void problems.push(`${at}: the JSON cannot be written as text.`);
      kinds.add("text");
      return void input.push({ type: "text", text });
    }
    const kind = kindOf(part as { type?: unknown });
    if (!kind)
      return void problems.push(`${at}: unknown part type ${JSON.stringify((part as { type?: unknown }).type)}.`);
    if (!def.inputs.includes(kind))
      return void problems.push(`${at}: ${def.model} cannot read ${kind}. It reads: ${def.inputs.join(", ")}.`);
    if (kind === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text !== "string" || !text.trim()) return void problems.push(`${at}: text is empty.`);
    } else {
      const key = mediaKeyOf(part);
      const media: unknown = key ? Reflect.get(part, key) : undefined;
      if (!(typeof media === "string" && media) && !(media instanceof Uint8Array) && !(media instanceof ArrayBuffer))
        return void problems.push(`${at}: the ${kind} is missing (a path, a URL, a data URL, base64 or bytes).`);
    }
    kinds.add(kind);
    input.push(part as InputPart);
  });

  // Questions.
  const questions: Record<string, ResolvedDecisionQuestion> = {};
  const asked =
    opts.questions && typeof opts.questions === "object" && !Array.isArray(opts.questions) ? opts.questions : undefined;
  const names = asked ? Object.keys(asked) : [];
  if (!asked || names.length === 0) problems.push("questions: required, an object of at least one question by name.");
  const maxQuestions = def.limits.questions;
  if (maxQuestions !== undefined && names.length > maxQuestions)
    problems.push(`questions: ${names.length} questions; this model takes at most ${maxQuestions} per request.`);
  for (const name of names) {
    const at = `questions.${name}`;
    const q: unknown = asked?.[name];
    if (!QUESTION_KEY.test(name)) {
      problems.push(`${at}: the name must be 1 to 64 characters of A-Z, a-z, 0-9, "_" or "-".`);
      continue;
    }
    if (!isRecord(q)) {
      problems.push(`${at}: expected a question like { type: "noul", instructions }.`);
      continue;
    }
    const rawType = q["type"];
    if (!(DECISION_QUESTION_TYPES as readonly unknown[]).includes(rawType)) {
      problems.push(`${at}.type: ${JSON.stringify(rawType)} is not one of: ${DECISION_QUESTION_TYPES.join(", ")}.`);
      continue;
    }
    const type = rawType as DecisionQuestionType;
    const before = problems.length;
    const instructions = instructionsText(q["instructions"], `${at}.instructions`, problems);
    const criteria = q["criteria"];
    if (type === "noul") {
      if (criteria !== undefined) {
        const c = criteria as Record<string, unknown> | null;
        if (!c || typeof c !== "object" || Array.isArray(c))
          problems.push(`${at}.criteria: expected { true, false } descriptions.`);
        else
          for (const [k, v] of Object.entries(c)) {
            if (k !== "true" && k !== "false")
              problems.push(`${at}.criteria: unknown key "${k}" (allowed: true, false).`);
            else if (typeof v !== "string") problems.push(`${at}.criteria.${k}: must be a string.`);
          }
      }
      if (problems.length === before)
        questions[name] = {
          type,
          instructions,
          ...(criteria ? { criteria: criteria as { true?: string; false?: string } } : {}),
        };
    } else if (type === "choice") {
      const c = criteria as Record<string, unknown> | null | undefined;
      if (!c || typeof c !== "object" || Array.isArray(c))
        problems.push(`${at}.criteria: required, an object of options like { billing: "Payments." }.`);
      else {
        const options = Object.keys(c);
        const max = def.limits.options;
        if (options.length < 2) problems.push(`${at}.criteria: a choice needs at least 2 options.`);
        if (max !== undefined && options.length > max)
          problems.push(`${at}.criteria: ${options.length} options; this model takes at most ${max}.`);
        for (const o of options) {
          const bad = optionNameProblem(o);
          if (bad) problems.push(`${at}.criteria: the option ${JSON.stringify(o)} ${bad}.`);
          if (typeof c[o] !== "string")
            problems.push(`${at}.criteria.${o}: the description must be a string ("" when the name says it all).`);
        }
        if (problems.length === before) questions[name] = { type, instructions, criteria: c as Record<string, string> };
      }
    } else {
      const c = criteria as unknown[] | undefined;
      if (!Array.isArray(c))
        problems.push(`${at}.criteria: required, a list of level descriptions from lowest to highest.`);
      else {
        const max = def.limits.levels;
        if (c.length < 2) problems.push(`${at}.criteria: a score needs at least 2 levels.`);
        if (max !== undefined && c.length > max)
          problems.push(`${at}.criteria: ${c.length} levels; this model takes at most ${max}.`);
        c.forEach((level, i) => {
          if (typeof level !== "string" || !level.trim())
            problems.push(`${at}.criteria[${i}]: a level needs a non-empty description.`);
        });
        if (problems.length === before) questions[name] = { type, instructions, criteria: c as string[] };
      }
    }
  }

  if (problems.length > 0)
    throw new ValidationError(
      `[Agent Accelerator] Invalid decision request for ${def.model} (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.map((p, i) => `(${i + 1}) ${p}`).join(" ")}`,
      { provider: def.provider, model: def.id }
    );
  return { def, input, questions, kinds };
}
