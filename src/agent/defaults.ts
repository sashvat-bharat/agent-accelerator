/**
 * The spending caps an Agent gets from the program's settings (`usage_limit`, `scheduled_action_budget`, see
 * `config/settings.ts`: the developer's value, or the user's when the program lets them change it). Precedence, per
 * field (`maxCostUsd`, `maxTotalTokens`): the Agent's own config, then the setting, then no cap. Only agents YOU construct
 * take the settings: the workers and scheduled runs the SDK builds itself never do (a chat worker joins its parent's cap;
 * a scheduled run has its own).
 */
import { capSetting } from "../config/settings.ts";
import type { UsageLimitConfig } from "./usage-limit.ts";

/** The cap an Agent uses: its own value, field by field over the setting; undefined when nothing sets one. `withDefaults: false` ignores the settings (SDK-built workers). */
export function mergeCap(
  name: "usageLimit" | "scheduledActionBudget",
  own: UsageLimitConfig | undefined,
  withDefaults: boolean
): UsageLimitConfig | undefined {
  const base = withDefaults ? capSetting(name === "usageLimit" ? "usage_limit" : "scheduled_action_budget") : undefined;
  const maxCostUsd = own?.maxCostUsd ?? base?.maxCostUsd;
  const maxTotalTokens = own?.maxTotalTokens ?? base?.maxTotalTokens;
  if (maxCostUsd === undefined && maxTotalTokens === undefined) return undefined;
  return {
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
  };
}
