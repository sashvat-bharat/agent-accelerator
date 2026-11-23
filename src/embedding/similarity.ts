import { ValidationError } from "../types/errors.ts";

/** How close in direction two vectors are, from -1 (opposite) to 1 (the same direction); 0 means unrelated. Both must come from the same model and have the same length (`ValidationError` otherwise, also for a vector of only zeros, which has no direction). */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length)
    throw new ValidationError(
      `[Agent Accelerator] cosineSimilarity needs vectors of the same length (got ${a.length} and ${b.length}): were they made by the same model with the same dimensions?`
    );
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0; // both lists have the same length, checked above
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (a.length === 0 || na === 0 || nb === 0)
    throw new ValidationError(
      "[Agent Accelerator] cosineSimilarity needs vectors that are not empty and not all zeros."
    );
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
