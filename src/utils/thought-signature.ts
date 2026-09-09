/**
 * Utilities for Gemini thought signatures via OpenAI-compatible endpoints & Google AI Studio.
 */

const base64SigPattern = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Checks whether a Gemini thought signature has valid base64 shape.
 * @example `const valid = isValidThoughtSignature(signature);`
 */
export function isValidThoughtSignature(sig?: string): boolean {
  if (!sig) return false;
  if (sig.length % 4 !== 0) return false;
  return base64SigPattern.test(sig);
}

/** Keeps an incoming signature when present, otherwise preserves the existing one. */
export function retainThoughtSignature(existing?: string, incoming?: string): string | undefined {
  if (typeof incoming === "string" && incoming.length > 0) return incoming;
  return existing;
}

/** Extracts a Google thought signature from OpenAI-compatible metadata. */
export function extractGoogleThoughtSignature(obj: any): string | undefined {
  const sig = obj?.extra_content?.google?.thought_signature;
  return typeof sig === "string" && sig.length > 0 ? sig : undefined;
}
