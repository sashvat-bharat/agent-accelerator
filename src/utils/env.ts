/**
 * Safe environment lookup for API keys and configurations
 */
/**
 * Reads an environment/global value without assuming a Node-only runtime.
 *
 * @example `const apiKey = getEnv("OPENAI_API_KEY");`
 */
export function getEnv(key: string, fallback?: string): string | undefined {
  if (typeof process !== "undefined" && process.env && process.env[key]) {
    return process.env[key];
  }
  if (typeof globalThis !== "undefined" && (globalThis as any)[key]) {
    return (globalThis as any)[key];
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
  if (explicitKey) return explicitKey;
  // ProviderEnv override takes precedence (agent-accel inspiration, SDK-light)
  if (env) {
    const upper = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    if (env[upper]) return env[upper];
    // google aliases
    if (provider.toLowerCase().startsWith("google") || provider.toLowerCase() === "gemini") {
      if (env["GEMINI_API_KEY"]) return env["GEMINI_API_KEY"];
      if (env["GOOGLE_API_KEY"]) return env["GOOGLE_API_KEY"];
    }
    // openai aliases
    if (provider.toLowerCase() === "openai") {
      if (env["OPENAI_BASE_API_KEY"]) return env["OPENAI_BASE_API_KEY"];
      if (env["OPENAI_API_KEY"]) return env["OPENAI_API_KEY"];
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
    case "opencode":
    case "opencode-go":
      return (
        getEnv("OPENCODE_API_KEY") ||
        getEnv("OPENCODE_ZEN_API_KEY") ||
        getEnv("OPENCODE_GO_API_KEY")
      );
    case "openrouter":
      return getEnv("OPENROUTER_API_KEY");
    case "openai":
      return getEnv("OPENAI_BASE_API_KEY") || getEnv("OPENAI_API_KEY");
    case "anthropic":
      return getEnv("ANTHROPIC_API_KEY");
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
