import { describe, it, expect } from "bun:test";
import { Agent, setConfigs } from "../src/index.ts";
import { SETTING_KEYS } from "../src/config/settings.ts";
import { buildDynamicWorkerConfig } from "../src/agent/worker.ts";

// The spending caps come from the program's settings (`usage_limit`, `scheduled_action_budget`).
const settings = (values: Record<string, unknown> = {}) =>
  setConfigs({ values: { catalog_refresh: "off", ...values }, editable: [...SETTING_KEYS] });

const mk = (extra: Record<string, unknown> = {}) =>
  new Agent({ model: "groq/p", apiKey: "k", baseUrl: "https://x/v1", ...extra });
const withSched = (sched?: object, extra: Record<string, unknown> = {}) =>
  mk({ dynamicSubagents: { model: "groq/w", ...(sched ? { scheduledActionBudget: sched } : {}) }, ...extra });

describe("usageLimit from the settings", () => {
  it("no cap anywhere: no chat total", () => {
    expect(mk().chat).toBeUndefined();
  });

  it("the usage_limit setting sets the cap, per field", () => {
    settings({ usage_limit: { max_cost_usd: 5, max_total_tokens: 1000 } });
    expect(mk().chat?.limit).toEqual({ maxCostUsd: 5, maxTotalTokens: 1000 });
  });

  it("the Agent's own value wins over the setting, field by field", () => {
    settings({ usage_limit: { max_cost_usd: 2, max_total_tokens: 1000 } });
    expect(mk({ usageLimit: { maxTotalTokens: 50 } }).chat?.limit).toEqual({ maxCostUsd: 2, maxTotalTokens: 50 });
    expect(mk({ usageLimit: { maxCostUsd: 9, maxTotalTokens: 50 } }).chat?.limit).toEqual({ maxCostUsd: 9, maxTotalTokens: 50 });
  });

  it("a new setConfigs replaces the earlier one", () => {
    settings({ usage_limit: { max_cost_usd: 2 } });
    expect(mk().chat?.limit).toEqual({ maxCostUsd: 2 });
    settings({ scheduled_action_budget: { max_cost_usd: 1 } });
    expect(mk().chat).toBeUndefined();
  });
});

describe("scheduledActionBudget from the settings", () => {
  it("follows the same precedence and only exists for an agent that has dynamicSubagents", () => {
    expect(withSched().dynamicSubagents?.scheduledActionBudget).toBeUndefined();
    settings({ scheduled_action_budget: { max_cost_usd: 0.5, max_total_tokens: 9000 } });
    expect(withSched().dynamicSubagents?.scheduledActionBudget).toEqual({ maxCostUsd: 0.5, maxTotalTokens: 9000 });
    expect(withSched({ maxCostUsd: 3 }).dynamicSubagents?.scheduledActionBudget).toEqual({ maxCostUsd: 3, maxTotalTokens: 9000 });
    expect(mk().dynamicSubagents).toBeUndefined();
  });
});

describe("workers the SDK builds never take the settings", () => {
  it("a scheduled run or chat worker gets neither a chat cap nor a default scheduled cap", () => {
    settings({ usage_limit: { max_cost_usd: 1, max_total_tokens: 100 }, scheduled_action_budget: { max_cost_usd: 1 } });
    const parent = withSched(undefined);
    expect(parent.chat?.limit).toEqual({ maxCostUsd: 1, maxTotalTokens: 100 }); // the agent you built does
    const common = { name: "w", instructions: "", sessionId: "s", tools: {} };
    const oneShot = new Agent(buildDynamicWorkerConfig(parent, common));
    const persistent = new Agent(buildDynamicWorkerConfig(parent, { ...common, persistent: {} }));
    expect(oneShot.chat).toBeUndefined(); // a scheduled run is outside the chat
    expect(persistent.chat).toBeUndefined(); // a chat worker is handed its parent's total by the registry, never a new one
    expect(oneShot.budget).toEqual({ maxCostUsd: 1 }); // its cap is the parent's scheduledActionBudget (which took the setting)
  });
});
