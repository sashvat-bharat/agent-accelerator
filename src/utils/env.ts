/**
 * Safe environment lookup for API keys and configurations
 */
/**
 * Reads an environment value. Process env only. No globalThis fallback:
 * DOM-clobberable in browsers.
 *
 * @example `const apiKey = getEnv("OPENAI_API_KEY");`
 */
export function getEnv(key: string, fallback?: string): string | undefined {
  if (typeof process !== "undefined" && process.env && process.env[key]) {
    // Trim quotes/whitespace from .env files (`sk-..."\n` -> 401 otherwise).
    const raw = String(process.env[key]);
    const trimmed = raw
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    if (trimmed) return trimmed;
  }
  return fallback;
}

type ProviderEnv = Record<string, string>;

// The variables that hold a provider's key, in the order they are read: the same names for a per-call `env` and for `process.env`, and the Google names only for Google itself (never for a custom prefix such as `googleproxy`); in: getApiKey, out: the names.
function keyNames(provider: string): string[] {
  const id = provider.toLowerCase();
  if (id === "google" || id === "gemini") return ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"];
  if (id === "openai") return ["OPENAI_BASE_API_KEY", "OPENAI_API_KEY"];
  const upper = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (id === "anthropic" || id === "openrouter") return [`${upper}_API_KEY`];
  return [`${upper}_API_KEY`, `${upper}_BASE_API_KEY`];
}

/**
 * Resolves a provider API key: the explicit key, then a per-call `env`, then `process.env`, each by the provider's own names.
 *
 * @example `const key = getApiKey("google");`
 */
export function getApiKey(provider: string, explicitKey?: string, env?: ProviderEnv): string | undefined {
  const clean = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    return t || undefined;
  };
  const cleanedExplicit = clean(explicitKey);
  if (cleanedExplicit) return cleanedExplicit;
  const names = keyNames(provider);
  if (env) {
    for (const name of names) {
      const fromEnv = clean(env[name]);
      if (fromEnv) return fromEnv;
    }
  }
  for (const name of names) {
    const fromProcess = getEnv(name);
    if (fromProcess) return fromProcess;
  }
  return undefined;
}
