/**
 * Option handling for an Agent: the normalized run limits, the thinking level, the tool choice and the one function
 * that turns agent config plus per-run options into what every provider call receives.
 */
import type { AgentConfig, AgentRunOptions, RetryPolicyConfig, ToolChoiceOption } from "../types/agent.ts";
import type { ProviderRequestOptions, StructuredOutputSpec } from "../types/model.ts";
import type { CacheOption, ServiceTier, ThinkingConfig, ThinkingLevel } from "../types/core.ts";
import type { Prompts } from "../prompts/prompts.ts";
import { normalizeThinkingV2 } from "../tools/tool.ts";
import { validateModelThinking } from "../models/catalog.ts";
import { telemetryBus } from "../telemetry.ts";

/**
 * Resolves a per-run thinking override without mutating agent config.
 */
export function resolveEffectiveThinking(base?: ThinkingConfig, overrideLevel?: string): ThinkingConfig | undefined {
  if (!overrideLevel) return base;
  if (overrideLevel === "none") return { enabled: false, level: "none", budgetTokens: 0 };
  if (overrideLevel === "dynamic") return { enabled: true, level: "dynamic", budgetTokens: -1 };
  return { enabled: true, level: overrideLevel as ThinkingConfig["level"] };
}

/** Normalized per-run limits. Sub-agents inherit these unless overridden. */
export interface AgentRunLimits {
  maxTurns?: number;
  deadlineMs?: number;
  maxToolCallsPerRun?: number;
  maxTotalTokens?: number;
  requestTimeoutMs: number;
  firstByteTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

/** Resolves `(config as any).limits` with defaults (timeouts tolerate reasoning). */
export function resolveAgentLimits(config: { limits?: Record<string, unknown> }): AgentRunLimits {
  const raw = (config as { limits?: Record<string, unknown> }).limits ?? {};
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  // A network timeout: `0` or `Infinity` turns it off, any other number is milliseconds, anything else is unset (the default applies).
  const timeout = (v: unknown): number | undefined => (typeof v === "number" && !Number.isNaN(v) ? v : undefined);
  return {
    ...(num(raw.maxTurns) !== undefined ? { maxTurns: Math.max(1, Math.floor(num(raw.maxTurns)!)) } : {}),
    ...(num(raw.deadlineMs) !== undefined ? { deadlineMs: num(raw.deadlineMs)! } : {}),
    ...(num(raw.maxToolCallsPerRun) !== undefined
      ? { maxToolCallsPerRun: Math.max(1, Math.floor(num(raw.maxToolCallsPerRun)!)) }
      : {}),
    ...(num(raw.maxTotalTokens) !== undefined
      ? { maxTotalTokens: Math.max(1, Math.floor(num(raw.maxTotalTokens)!)) }
      : {}),
    requestTimeoutMs: timeout(raw.requestTimeoutMs) ?? 300_000,
    firstByteTimeoutMs: timeout(raw.firstByteTimeoutMs) ?? 120_000,
    streamIdleTimeoutMs: timeout(raw.streamIdleTimeoutMs) ?? 300_000,
  };
}

/** The Agent settings `buildProviderOptions` reads. */
export interface ProviderOptionSource {
  apiKey?: string;
  baseUrl?: string;
  customHeaders?: Record<string, string>;
  thinkingConfig?: ThinkingConfig;
  cache?: CacheOption;
  serviceTier?: ServiceTier;
  sessionId: string;
  outputSpec?: StructuredOutputSpec;
  prompts: Prompts;
  googleTier?: "free" | "paid";
  callDefaults: {
    toolChoice?: ToolChoiceOption;
    maxOutputTokens?: number;
    retry?: RetryPolicyConfig;
    env?: Record<string, string>;
    fetch?: typeof fetch;
  };
}

/**
 * Single place that turns agent config + per-run options into the options
 * every provider call receives. Per-run values override agent defaults
 * (objects such as `retry` and `env` merge key by key).
 */
export function buildProviderOptions(
  agent: ProviderOptionSource,
  runOptions: AgentRunOptions | undefined
): ProviderRequestOptions {
  const d = agent.callDefaults;
  const sessionId = runOptions?.sessionId || agent.sessionId;
  const toolChoice = normalizeToolChoiceOption(runOptions?.toolChoice ?? d.toolChoice);
  const retry = { ...d.retry, ...runOptions?.retry };
  const env = { ...d.env, ...runOptions?.env };
  const maxOutputTokens = runOptions?.maxOutputTokens ?? d.maxOutputTokens;
  const fetchImpl = runOptions?.fetch ?? d.fetch;
  return {
    apiKey: agent.apiKey,
    baseUrl: agent.baseUrl,
    headers: { ...(agent.customHeaders ?? {}), ...(runOptions?.headers ?? {}) },
    thinking: resolveEffectiveThinking(agent.thinkingConfig, runOptions?.thinkingLevel),
    ...(agent.cache ? { cache: agent.cache } : {}),
    serviceTier: agent.serviceTier,
    sessionId,
    ...(agent.outputSpec ? { output: agent.outputSpec } : {}),
    prompts: { structuredOutput: agent.prompts.structuredOutput, toolBridge: agent.prompts.toolBridge },
    ...(agent.googleTier ? { googleTier: agent.googleTier } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(retry.maxRetries !== undefined ? { maxRetries: retry.maxRetries } : {}),
    ...(retry.maxDelayMs !== undefined ? { maxRetryDelayMs: retry.maxDelayMs } : {}),
    ...(retry.baseDelayMs !== undefined ? { retryBaseDelayMs: retry.baseDelayMs } : {}),
    ...(retry.budgetMs !== undefined ? { retryBudgetMs: retry.budgetMs } : {}),
  };
}

/** Normalizes the public `thinkingLevel` flag into provider-neutral thinking settings. */
export function normalizeThinking(config: AgentConfig, fallbackLevel?: string): ThinkingConfig | undefined {
  // DX4: only thinkingLevel, values: none, dynamic, minimal, low, medium, high, xhigh, max
  // `thinking` (canonical) wins over legacy `thinkingLevel`; `{ level }` objects are unwrapped.
  const rawLevel = normalizeThinkingV2(config.thinking, config.thinkingLevel) ?? fallbackLevel;
  if (typeof config.thinking === "object" && config.thinking?.budgetTokens !== undefined) {
    // No provider maps an explicit token budget yet: say so instead of ignoring it silently.
    telemetryBus.emitWarning(
      "config.thinking_budget_ignored",
      "[Agent Accelerator] thinking.budgetTokens is not forwarded by any provider adapter yet; the level alone is used.",
      { budgetTokens: config.thinking.budgetTokens }
    );
  }
  const level = rawLevel as ThinkingLevel | undefined;

  if (!level) return undefined;

  // Validate model thinking from catalog if model is configured
  if (config.model) {
    try {
      const rawModel: any = (config.model as any)?.model ? (config.model as any).model : config.model;
      const modelStr = typeof rawModel === "string" ? rawModel : rawModel?.id || "";
      const provStr =
        typeof rawModel === "object" && rawModel?.provider
          ? rawModel.provider
          : modelStr.includes("/")
            ? modelStr.split("/")[0]
            : "";
      const actualModelId = modelStr.includes("/") ? modelStr.split("/").slice(1).join("/") : modelStr;
      if (actualModelId) {
        validateModelThinking(provStr || "openrouter", actualModelId, level);
      }
    } catch (e) {
      throw e;
    }
  }

  if (level === "none") {
    return { enabled: false, level: "none", budgetTokens: 0 };
  }
  if (level === "dynamic") {
    return { enabled: true, level: "dynamic", budgetTokens: -1 };
  }
  return { enabled: true, level };
}

/** Maps the public `toolChoice` option onto the provider wire-neutral form. */
export function normalizeToolChoiceOption(choice: ToolChoiceOption | undefined): ProviderRequestOptions["toolChoice"] {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice;
  if (choice.tool) return { type: "function", function: { name: choice.tool } };
  return choice.mode;
}
