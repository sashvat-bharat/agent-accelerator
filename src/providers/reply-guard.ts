/**
 * Checks that a parsed provider reply really looks like a reply, BEFORE an adapter casts it to its wire type. Without this, a
 * gateway that answers HTTP 200 with `{}`, `[]` or `null` is read as a normal empty answer (or a raw `TypeError`). Each check
 * is small on purpose: it only asks for the one field the adapter's parser cannot do without. A bad reply becomes a retryable
 * `ProviderError`, like a 502, so `retry` and `runRetries` get another go.
 */
import { toConciseProviderError } from "../utils/errors.ts";

// Why a value is not an object, or undefined when it is one; in: every wire check below, out: a short problem text.
function notAnObject(raw: unknown): string | undefined {
  if (raw === null) return "the reply is null";
  if (Array.isArray(raw)) return "the reply is a list, not an object";
  if (typeof raw !== "object") return `the reply is a ${typeof raw}, not an object`;
  return undefined;
}

/** Why a Chat Completions reply is unusable, or undefined: an object that carries an `error` (the parser reports it) or a first choice. */
export function chatReplyProblem(raw: unknown): string | undefined {
  const bad = notAnObject(raw);
  if (bad) return bad;
  const reply = raw as Record<string, unknown>;
  if (reply["error"]) return undefined;
  const choices = reply["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return "the reply has no `choices`";
  if (choices[0] === null || typeof choices[0] !== "object" || Array.isArray(choices[0])) {
    return "the first choice is not an object";
  }
  return undefined;
}

/** Why a Responses API reply is unusable, or undefined: an object with an `output` list, or one that failed (the parser reports it). */
export function responsesReplyProblem(raw: unknown): string | undefined {
  const bad = notAnObject(raw);
  if (bad) return bad;
  const reply = raw as Record<string, unknown>;
  if (reply["status"] === "failed" || reply["error"]) return undefined;
  return Array.isArray(reply["output"]) ? undefined : "the reply has no `output` list";
}

/** Why a Messages API reply is unusable, or undefined: an object with a `content` list. An `error` object sent with HTTP 200 is a problem too. */
export function messageReplyProblem(raw: unknown): string | undefined {
  const bad = notAnObject(raw);
  if (bad) return bad;
  const reply = raw as Record<string, unknown>;
  if (reply["type"] === "error") return "the reply is an error object";
  return Array.isArray(reply["content"]) ? undefined : "the reply has no `content` list";
}

/** Why an Interactions API reply is unusable, or undefined: an object with an `id` or a `steps` list. */
export function interactionReplyProblem(raw: unknown): string | undefined {
  const bad = notAnObject(raw);
  if (bad) return bad;
  const reply = raw as Record<string, unknown>;
  if (typeof reply["id"] === "string" || Array.isArray(reply["steps"])) return undefined;
  return "the reply has neither an `id` nor a `steps` list";
}

/** The retryable `ProviderError` for a reply that cannot be used: it is treated like an HTTP 502, so the retry layers try again. The message carries the cause and the start of the reply. */
export function badReplyError(provider: string, modelId: string, url: string, problem: string, body = ""): Error {
  const shown = body.length > 200 ? `${body.slice(0, 200)}...` : body;
  return toConciseProviderError(
    Object.assign(
      new Error(`The provider sent a reply that cannot be used: ${problem}. Reply: ${shown || "(empty)"}`),
      {
        statusCode: 502,
        transient: true,
        retryable: true,
        url: url.split("?")[0],
      }
    ),
    provider,
    modelId
  );
}
