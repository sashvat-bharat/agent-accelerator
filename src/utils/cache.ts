/** Cache-key clamping and central secret redaction shared by the provider adapters. */

const CACHE_KEY_MAX = 64;

/** Clamps a cache/session affinity key to the provider-safe 64-character limit. */
export function clampCacheKey(key?: string): string | undefined {
  if (!key) return undefined;
  const chars = Array.from(key);
  if (chars.length <= CACHE_KEY_MAX) return key;
  return chars.slice(0, CACHE_KEY_MAX).join("");
}

// ---------------------------------------------------------------------------
// Central redaction helpers (Q-11, temporary home to avoid owner conflicts).
// Providers must call these instead of maintaining local deny-lists.
// ---------------------------------------------------------------------------

/** Header-name deny-list (case-insensitive substring match). */
const REDACT_HEADER_SUBSTRINGS = ["key", "token", "secret", "cookie", "authorization"];

/**
 * Credential-looking values. Anchored on a non-alphanumeric boundary so plain
 * words that merely contain "sk-" (e.g. `Task-Manager`, `Disk-Cache`) are NOT
 * redacted, while `sk-…`, `gsk_…`, `xoxb-…` and `AIza…` tokens are.
 */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /(^|[^A-Za-z0-9])(sk|gsk|xox[a-z]?)[-_][A-Za-z0-9_-]{8,}/,
  /(^|[^A-Za-z0-9])AIza[A-Za-z0-9_-]{10,}/,
];

// True when a header name contains key, token, secret, cookie or authorization; in: redactHeadersCentral, out: a boolean.
function headerNameIsSensitive(name: string): boolean {
  const lower = String(name ?? "").toLowerCase();
  return REDACT_HEADER_SUBSTRINGS.some((s) => lower.includes(s));
}

// True when a string looks like a credential (sk-, gsk_, xox, AIza, long Bearer token); in: the redactors, out: a boolean.
function valueLooksSensitive(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (SENSITIVE_VALUE_PATTERNS.some((re) => re.test(v))) return true;
  // Bearer-style long tokens: "Bearer <20+ chars>"
  if (/^bearer\s+\S{20,}/i.test(v)) return true;
  return false;
}

/**
 * Redacts a single value: sensitive strings become "[REDACTED]" (Q-11).
 */
export function redactValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (valueLooksSensitive(value)) return "[REDACTED]";
  return value;
}

/**
 * Redacts sensitive header values (Q-11). Returns a shallow copy; input untouched.
 * Deny-list (name contains): *key*, *token*, *secret*, cookie, authorization.
 * Value patterns (redacted regardless of name): sk-, AIza, gsk-, xox-.
 */
export function redactHeadersCentral(
  headers: Record<string, unknown> | undefined | null
): Record<string, unknown> {
  if (!headers || typeof headers !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (headerNameIsSensitive(k) || valueLooksSensitive(v)) out[k] = "[REDACTED]";
    else out[k] = v;
  }
  return out;
}

/**
 * Redacts secret-looking substrings inside free text (Q-11).
 * Replaces `sk-...`, `AIza...`, `gsk-...`, `xox-...` tokens with "[REDACTED]".
 */
export function redactText(text: string): string {
  if (typeof text !== "string" || !text) return text;
  // Note: longer prefixes (gsk-/gsk_) first so the generic sk- pattern
  // does not partially match inside them (e.g. "gsk-abc" -> one token).
  return text
    .replace(/gsk_[A-Za-z0-9]{8,}/g, "[REDACTED]")
    .replace(/gsk-[A-Za-z0-9-_]{8,}/g, "[REDACTED]")
    .replace(/xox-[A-Za-z0-9-]{8,}/g, "[REDACTED]")
    .replace(/AIza[A-Za-z0-9-_]{10,}/g, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9-_]{8,}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/=]{20,}/gi, "Bearer [REDACTED]");
}
