/**
 * Level-based reasoning — single flag for all levels (bloatfree)
 */
/** Public reasoning control accepted by AgentConfig. */
export type ThinkingLevel =
  | "none"
  | "dynamic"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

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
 * Cache retention:
 * - "implicit": automatic prefix caching ($0.00 storage fee, session affinity preserved)
 * - "short": 5 minutes explicit TTL
 * - "medium": 1 hour explicit TTL
 * - "long": 12 hours explicit TTL
 * - undefined: no explicit caching enforced (implicit may still happen)
 */
/** Prompt-cache retention policy. */
export type CacheRetention = "implicit" | "short" | "medium" | "long";

/** Prompt-cache IDs, retention, TTL, and session-affinity settings. */
export interface CacheConfig {
  /**
   * Retention duration:
   * - "implicit": automatic prefix caching ($0.00 storage fee, no explicit cloud cache entities created)
   * - "short": 5 minutes TTL
   * - "medium": 1 hour TTL
   * - "long": 12 hours TTL
   * - undefined: no explicit caching enforced (implicit may still happen)
   */
  retention?: CacheRetention;
  /**
   * Explicit cache ID / reference if using pre-created context cache
   */
  cachedContentId?: string;
  /**
   * Session ID for cache affinity routing (e.g. x-session-id, x-opencode-session)
   */
  sessionId?: string;
  /**
   * Explicit TTL in seconds for created caches (overrides retention mapping)
   */
  ttlSeconds?: number;
}

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
