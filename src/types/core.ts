/**
 * Level-based reasoning — single flag for all levels (bloatfree)
 */
/** Public reasoning control accepted by AgentConfig. */
export type ThinkingLevel = "none" | "dynamic" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Internal normalized config (SDK-internal, not exposed as Agent flag)
/** Internal normalized reasoning configuration passed to providers. */
export interface ThinkingConfig {
  enabled?: boolean;
  level?: ThinkingLevel;
  budgetTokens?: number;
  budget?: number;
  thinking_budget?: number;
  includeThoughts?: boolean;
}

/**
 * Prompt-cache lifetime: `"implicit"` (automatic prefix caching) or an explicit TTL. Each provider honours only
 * the values it supports; others fall back to its default with one warning. Omit for the provider default.
 */
export type CacheOption = "implicit" | "5m" | "30m" | "1h" | "12h";

/** Every accepted {@link CacheOption}, for runtime validation. */
export const CACHE_OPTIONS: readonly CacheOption[] = ["implicit", "5m", "30m", "1h", "12h"];

/**
 * Service tier controls — bloatfree: only flex / priority (standard is default, no flag needed)
 */
/** Optional provider service-priority routing tier. */
export type ServiceTier = "flex" | "priority";

/**
 * Token and cost usage — actual provider values, not heuristic
 */
/** Normalized provider usage and optional calculated cost. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thinkingTokens?: number;
  cost?: {
    inputCost?: number;
    outputCost?: number;
    cacheReadCost?: number;
    cacheWriteCost?: number;
    totalCost?: number;
  };
}
