/**
 * Turn grouping: a "turn" is one finished run (the user prompt plus the whole answer to it: text, thinking, tool calls
 * and results), found through the run marks the Agent keeps. A worker that starts from a copy of its parent's history
 * gets whole finished turns only, so a prompt never reaches it without its answer. Pure functions, no Agent import.
 */
import type { Message, ContentPart } from "../types/message.ts";
import type { SessionRunMark } from "../session/store.ts";
import { ValidationError } from "../types/errors.ts";
import { previewPrompt } from "../utils/session.ts";
import { deepCloneValue } from "./context.ts";

/** One finished turn: its 1-based number (counting finished turns only), a prompt preview, and its messages `[from, to)`. */
export interface Turn {
  n: number;
  prompt: string;
  from: number;
  to: number;
}

/** Longest prompt preview shown to a model in a turn list. */
const PREVIEW_CHARS = 200;

// A run counts as finished when it ended with its answer (`done`) or with a tool's `ctx.stop` (`stopped`); in: a run mark, out: finishedTurns.
function isFinished(mark: SessionRunMark): boolean {
  return mark.end === "done" || mark.end === "stopped";
}

/** The finished turns of a conversation, oldest first. The running turn and failed, aborted or abandoned runs are not turns. */
export function finishedTurns(messages: Message[], marks: SessionRunMark[]): Turn[] {
  const sorted = marks.filter((m) => m.i >= 0 && m.i < messages.length).sort((a, b) => a.i - b.i);
  const turns: Turn[] = [];
  sorted.forEach((mark, k) => {
    if (!isFinished(mark)) return;
    turns.push({
      n: turns.length + 1,
      prompt: previewPrompt(messages[mark.i]!.content as string | ContentPart[]).slice(0, PREVIEW_CHARS),
      from: mark.i,
      to: sorted[k + 1]?.i ?? messages.length,
    });
  });
  return turns;
}

/**
 * A deep copy of the first `n` finished turns (plus anything before the first run mark), in order. `0` gives an empty
 * history. Throws a `ValidationError` naming how many finished turns exist when `n` is not a whole number in range.
 */
export function historyUpTo(messages: Message[], marks: SessionRunMark[], n: number): Message[] {
  const turns = finishedTurns(messages, marks);
  if (!Number.isInteger(n) || n < 0 || n > turns.length) {
    throw new ValidationError(
      `history: ${JSON.stringify(n)} is not valid; use "none" or a whole number from 1 to ${turns.length} (the number of finished turns).`
    );
  }
  if (n === 0) return [];
  const first = marks
    .filter((m) => m.i >= 0 && m.i < messages.length)
    .reduce((lo, m) => Math.min(lo, m.i), messages.length);
  const kept = [...messages.slice(0, first)];
  for (const turn of turns.slice(0, n)) kept.push(...messages.slice(turn.from, turn.to));
  return deepCloneValue(kept);
}
