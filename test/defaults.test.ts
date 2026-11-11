import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Agent, configure, ConfigError } from "../src/index.ts";
import { buildDynamicWorkerConfig } from "../src/agent/worker.ts";

const VARS = [
  "AGENT_ACCEL_USAGE_LIMIT_USD",
  "AGENT_ACCEL_USAGE_LIMIT_TOKENS",
  "AGENT_ACCEL_SCHEDULED_BUDGET_USD",
  "AGENT_ACCEL_SCHEDULED_BUDGET_TOKENS",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  configure({});
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(() => {
  configure({});
  for (const v of VARS) saved[v] === undefined ? delete process.env[v] : (process.env[v] = saved[v]);
});

const mk = (extra: Record<string, unknown> = {}) =>
  new Agent({ model: "groq/p", apiKey: "k", baseUrl: "https://x/v1", ...extra });
const withSched = (sched?: object, extra: Record<string, unknown> = {}) =>
  mk({ dynamicSubagents: { model: "groq/w", ...(sched ? { scheduledActionBudget: sched } : {}) }, ...extra });

describe("usageLimit defaults", () => {
  it("no cap anywhere: no chat total", () => {
    expect(mk().chat).toBeUndefined();
  });

  it("an env var sets the cap, per field", () => {
    process.env["AGENT_ACCEL_USAGE_LIMIT_USD"] = "5";
    process.env["AGENT_ACCEL_USAGE_LIMIT_TOKENS"] = "1000";
    expect(mk().chat?.limit).toEqual({ maxCostUsd: 5, maxTotalTokens: 1000 });
  });

  it("configure() wins over env, and the Agent's own value wins over both, field by field", () => {
    process.env["AGENT_ACCEL_USAGE_LIMIT_USD"] = "5";
    process.env["AGENT_ACCEL_USAGE_LIMIT_TOKENS"] = "1000";
    configure({ usageLimit: { maxCostUsd: 2 } });
    expect(mk().chat?.limit).toEqual({ maxCostUsd: 2, maxTotalTokens: 1000 }); // cost from configure(), tokens from env
    expect(mk({ usageLimit: { maxTotalTokens: 50 } }).chat?.limit).toEqual({ maxCostUsd: 2, maxTotalTokens: 50 });
    expect(mk({ usageLimit: { maxCostUsd: 9, maxTotalTokens: 50 } }).chat?.limit).toEqual({ maxCostUsd: 9, maxTotalTokens: 50 });
  });

  it("configure() replaces an earlier call, and configure({}) clears it", () => {
    configure({ usageLimit: { maxCostUsd: 2 } });
    configure({ scheduledActionBudget: { maxCostUsd: 1 } });
    expect(mk().chat).toBeUndefined();
    configure({ usageLimit: { maxCostUsd: 2 } });
    expect(mk().chat?.limit).toEqual({ maxCostUsd: 2 });
    configure({});
    expect(mk().chat).toBeUndefined();
  });

  it("a bad env value names the variable; configure() rejects bad values, unknown settings and non-objects", () => {
    process.env["AGENT_ACCEL_USAGE_LIMIT_USD"] = "lots";
    expect(() => mk()).toThrow(/Invalid AGENT_ACCEL_USAGE_LIMIT_USD "lots"/);
    delete process.env["AGENT_ACCEL_USAGE_LIMIT_USD"];
    for (const bad of [{ usageLimit: { maxCostUsd: 0 } }, { usageLimit: {} }, { usageLimit: { maxTotalTokens: "5" } }, { nope: {} }, "x", []]) {
      expect(() => configure(bad as never)).toThrow(ConfigError);
    }
    expect(mk().chat).toBeUndefined(); // a rejected call changed nothing
  });
});

describe("scheduledActionBudget defaults", () => {
  it("follows the same precedence and only exists for an agent that has dynamicSubagents", () => {
    expect(withSched().dynamicSubagents?.scheduledActionBudget).toBeUndefined();
    process.env["AGENT_ACCEL_SCHEDULED_BUDGET_USD"] = "0.5";
    process.env["AGENT_ACCEL_SCHEDULED_BUDGET_TOKENS"] = "9000";
    expect(withSched().dynamicSubagents?.scheduledActionBudget).toEqual({ maxCostUsd: 0.5, maxTotalTokens: 9000 });
    configure({ scheduledActionBudget: { maxCostUsd: 0.1 } });
    expect(withSched().dynamicSubagents?.scheduledActionBudget).toEqual({ maxCostUsd: 0.1, maxTotalTokens: 9000 });
    expect(withSched({ maxCostUsd: 3 }).dynamicSubagents?.scheduledActionBudget).toEqual({ maxCostUsd: 3, maxTotalTokens: 9000 });
    expect(mk().dynamicSubagents).toBeUndefined();
  });
});

describe("workers the SDK builds never take developer defaults", () => {
  it("a scheduled run or chat worker gets neither a chat cap nor a default scheduled cap", () => {
    configure({ usageLimit: { maxCostUsd: 1 }, scheduledActionBudget: { maxCostUsd: 1 } });
    process.env["AGENT_ACCEL_USAGE_LIMIT_TOKENS"] = "100";
    const parent = withSched(undefined);
    expect(parent.chat?.limit).toEqual({ maxCostUsd: 1, maxTotalTokens: 100 }); // the agent you built does
    const common = { name: "w", instructions: "", sessionId: "s", tools: {} };
    const oneShot = new Agent(buildDynamicWorkerConfig(parent, common));
    const persistent = new Agent(buildDynamicWorkerConfig(parent, { ...common, persistent: {} }));
    expect(oneShot.chat).toBeUndefined(); // a scheduled run is outside the chat
    expect(persistent.chat).toBeUndefined(); // a chat worker is handed its parent's total by the registry, never a new one
    expect(oneShot.budget).toEqual({ maxCostUsd: 1 }); // its cap is the parent's scheduledActionBudget (which took the default)
  });
});
