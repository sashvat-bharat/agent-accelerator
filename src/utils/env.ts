/**
 * Safe environment lookup for API keys and configurations
 */
/**
 * Reads an environment value. Process env only. No globalThis fallback:
 * DOM-clobberable in browsers (Q-05).
 *
 * @example `const apiKey = getEnv("OPENAI_API_KEY");`
 */
export function getEnv(key: string, fallback?: string): string | undefined {
  if (typeof process !== "undefined" && process.env && process.env[key]) {
    // Trim quotes/whitespace from .env files (`sk-..."\n` -> 401 otherwise).
    const raw = String(process.env[key]);
    const trimmed = raw.trim().replace(/^["']|["']$/g, "").trim();
    if (trimmed) return trimmed;
  }
  return fallback;
}

export type ProviderEnv = Record<string, string>;

/**
 * Resolves a provider API key from explicit input, overrides, and standard aliases.
 *
 * @example `const key = getApiKey("google");`
 */
export function getApiKey(provider: string, explicitKey?: string, env?: ProviderEnv): string | undefined {
  const clean = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.trim().replace(/^["']|["']$/g, "").trim();
    return t || undefined;
  };
  const cleanedExplicit = clean(explicitKey);
  if (cleanedExplicit) return cleanedExplicit;
  // ProviderEnv override takes precedence (agent-accel inspiration, SDK-light)
  if (env) {
    const upper = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    const fromEnv = clean(env[upper]);
    if (fromEnv) return fromEnv;
    // google aliases
    if (provider.toLowerCase().startsWith("google") || provider.toLowerCase() === "gemini") {
      const g1 = clean(env["GEMINI_API_KEY"]);
      if (g1) return g1;
      const g2 = clean(env["GOOGLE_API_KEY"]);
      if (g2) return g2;
    }
    // openai aliases
    if (provider.toLowerCase() === "openai") {
      const o1 = clean(env["OPENAI_BASE_API_KEY"]);
      if (o1) return o1;
      const o2 = clean(env["OPENAI_API_KEY"]);
      if (o2) return o2;
    }
  }

  switch (provider.toLowerCase()) {
    case "google":
    case "gemini":
      return (
        getEnv("GEMINI_API_KEY") ||
        getEnv("GOOGLE_API_KEY") ||
        getEnv("GOOGLE_GENAI_API_KEY")
      );
    case "openrouter":
      return getEnv("OPENROUTER_API_KEY");
    case "openai":
      return getEnv("OPENAI_BASE_API_KEY") || getEnv("OPENAI_API_KEY");
    default:
      return getEnv(`${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`);
  }
}

/** Reads MODEL or MODEL_NAME, with an optional fallback. */
export function getModel(fallback?: string): string | undefined {
  return getEnv("MODEL") || getEnv("MODEL_NAME") || fallback;
}

/** Reads SUB_AGENT_MODEL, with an optional fallback. */
export function getSubModel(fallback?: string): string | undefined {
  return getEnv("SUB_AGENT_MODEL") || fallback;
}
