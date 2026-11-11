/**
 * Developer defaults for the spending caps, set in code (`configure()`) or through env vars, so one place can cap every
 * agent of a program. Precedence, per field (`maxCostUsd`, `maxTotalTokens`): the Agent's own config, then `configure()`,
 * then the env var, then no cap. Only agents YOU construct take defaults: the workers and scheduled runs the SDK builds
 * itself never do (a chat worker joins its parent's cap; a scheduled run has its own).
 */
import { ConfigError } from "../types/errors.ts";
import { getEnv } from "../utils/env.ts";
import { checkUsageLimitConfig, type UsageLimitConfig } from "./usage-limit.ts";

/** What `configure()` can set; every key is optional and has the same meaning as the Agent option of the same name. */
export interface AgentDefaults {
  /** Default for `AgentConfig.usageLimit` (the chat-wide cap). Env: `AGENT_ACCEL_USAGE_LIMIT_USD`, `AGENT_ACCEL_USAGE_LIMIT_TOKENS`. */
  usageLimit?: UsageLimitConfig;
  /** Default for `dynamicSubagents.scheduledActionBudget`. Env: `AGENT_ACCEL_SCHEDULED_BUDGET_USD`, `AGENT_ACCEL_SCHEDULED_BUDGET_TOKENS`. */
  scheduledActionBudget?: UsageLimitConfig;
}

type CapName = keyof AgentDefaults;

const ENV: Record<CapName, { maxCostUsd: string; maxTotalTokens: string }> = {
  usageLimit: { maxCostUsd: "AGENT_ACCEL_USAGE_LIMIT_USD", maxTotalTokens: "AGENT_ACCEL_USAGE_LIMIT_TOKENS" },
  scheduledActionBudget: {
    maxCostUsd: "AGENT_ACCEL_SCHEDULED_BUDGET_USD",
    maxTotalTokens: "AGENT_ACCEL_SCHEDULED_BUDGET_TOKENS",
  },
};

let configured: AgentDefaults = {};

/**
 * Sets developer defaults for the spending caps; call it once at startup, like `setHome()`. It REPLACES what an earlier
 * call set (`configure({})` clears it). A key an Agent sets itself wins, field by field; env vars are the fallback.
 * Throws a `ConfigError` for a value that is not a number above 0.
 *
 * @example `configure({ usageLimit: { maxCostUsd: 5 }, scheduledActionBudget: { maxCostUsd: 0.5 } });`
 */
export function configure(defaults: AgentDefaults = {}): void {
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new ConfigError("[Agent Accelerator] configure() expects an object like { usageLimit: { maxCostUsd: 5 } }.");
  }
  for (const key of Object.keys(defaults)) {
    if (!(key in ENV)) {
      throw new ConfigError(
        `[Agent Accelerator] configure(): unknown setting "${key}" (known: ${Object.keys(ENV).join(", ")}).`
      );
    }
    const value = (defaults as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const problem = checkUsageLimitConfig(value);
    if (problem) throw new ConfigError(`[Agent Accelerator] configure(): invalid ${key}: ${problem}.`);
  }
  configured = Object.fromEntries(
    Object.entries(defaults)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, { ...(v as UsageLimitConfig) }])
  ) as AgentDefaults;
}

// Reads one cap field from its env var: undefined when unset, a ConfigError naming the variable when it is not a number above 0; in: mergeCap, out: the value.
function fromEnv(variable: string): number | undefined {
  const raw = getEnv(variable);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!(Number.isFinite(n) && n > 0)) {
    throw new ConfigError(
      `[Agent Accelerator] Invalid ${variable} ${JSON.stringify(raw)}: expected a number greater than 0.`
    );
  }
  return n;
}

/** The cap an Agent uses: its own value, field by field over `configure()` over the env vars; undefined when nothing sets one. `withDefaults: false` ignores `configure()` and the env (SDK-built workers). */
export function mergeCap(
  name: CapName,
  own: UsageLimitConfig | undefined,
  withDefaults: boolean
): UsageLimitConfig | undefined {
  const base = withDefaults ? configured[name] : undefined;
  const maxCostUsd = own?.maxCostUsd ?? base?.maxCostUsd ?? (withDefaults ? fromEnv(ENV[name].maxCostUsd) : undefined);
  const maxTotalTokens =
    own?.maxTotalTokens ?? base?.maxTotalTokens ?? (withDefaults ? fromEnv(ENV[name].maxTotalTokens) : undefined);
  if (maxCostUsd === undefined && maxTotalTokens === undefined) return undefined;
  return {
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
  };
}
