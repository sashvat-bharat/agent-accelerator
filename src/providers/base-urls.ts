// The default API address of each first-class provider, and the one place these hosts are written. A per-agent `baseUrl`
// or the `base_urls` setting overrides them (`resolveProviderBaseUrl` in `shared.ts`). This file imports nothing, so the
// model-list readers in `models/` can use it without a cycle.

/** The default API address of Google, OpenAI, Anthropic and OpenRouter, without a trailing slash. */
export const DEFAULT_BASE_URLS: {
  readonly google: string;
  readonly openai: string;
  readonly anthropic: string;
  readonly openrouter: string;
} = {
  google: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};
