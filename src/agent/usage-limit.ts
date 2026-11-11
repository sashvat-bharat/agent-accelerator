/**
 * The chat-wide spending cap (`AgentConfig.usageLimit`). One `UsageLimit` belongs to the root agent of a chat and is
 * handed to every agent below it (registry workers at any depth, fixed `subagents` workers), so each model turn of the
 * whole tree adds to one running total and every turn is checked before it starts. The total survives a restart: the
 * first run rebuilds the starting point from the saved sessions of the agent and its workers (`usageReport()`), after
 * which only new turns are added. Scheduled actions are separate and never count.
 */
import { BudgetExceededError } from "../types/errors.ts";

/** What the cap is made of; either part may be set, the first one reached stops the chat. */
export interface UsageLimitConfig {
  maxCostUsd?: number;
  maxTotalTokens?: number;
}

/** A one-line problem with a `usageLimit` value, or undefined when it is valid; in: the Agent constructor, out: its ConfigError. */
export function checkUsageLimitConfig(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return "expected an object like { maxCostUsd, maxTotalTokens }";
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r).filter((k) => r[k] !== undefined);
  if (keys.length === 0) return "set maxCostUsd, maxTotalTokens or both";
  for (const k of keys) {
    if (k !== "maxCostUsd" && k !== "maxTotalTokens") return `unknown key "${k}" (use maxCostUsd or maxTotalTokens)`;
    const v = r[k];
    if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) return `${k} must be a number greater than 0`;
  }
  return undefined;
}

/** The running total of one chat and its limit. */
export class UsageLimit {
  private baseTokens = 0;
  private baseMicroUSD = 0;
  private addedTokens = 0;
  private addedMicroUSD = 0;
  private started = false;

  constructor(readonly limit: UsageLimitConfig) {}

  /** Takes the starting point (what the chat spent before this process) once; later calls do nothing until `restart()`. */
  begin(startingPoint: () => { tokens: number; microUSD: number }): void {
    if (this.started) return;
    this.started = true;
    const s = startingPoint();
    this.baseTokens = s.tokens;
    this.baseMicroUSD = s.microUSD;
    this.addedTokens = 0;
    this.addedMicroUSD = 0;
  }

  /** Forgets the total (a session was imported over this agent): the next `begin` takes a new starting point. */
  restart(): void {
    this.started = false;
  }

  /** Adds one model turn of any agent in the chat. Unpriced turns add tokens only (unknown pricing is never a made-up $0 of cost). */
  add(tokens: number, microUSD: number): void {
    this.addedTokens += tokens;
    this.addedMicroUSD += microUSD;
  }

  /** What the chat has spent so far. */
  spent(): { tokens: number; costUsd: number } {
    return {
      tokens: this.baseTokens + this.addedTokens,
      costUsd: (this.baseMicroUSD + this.addedMicroUSD) / 1_000_000,
    };
  }

  /** Throws a `BudgetExceededError` ("Usage limit reached") once the chat has spent its whole limit. */
  check(): void {
    const { tokens, costUsd } = this.spent();
    const { maxCostUsd, maxTotalTokens } = this.limit;
    const byCost = maxCostUsd !== undefined && costUsd >= maxCostUsd;
    const byTokens = maxTotalTokens !== undefined && tokens >= maxTotalTokens;
    if (!byCost && !byTokens) return;
    const parts = [
      ...(maxCostUsd !== undefined ? [`$${costUsd.toFixed(6)} of $${maxCostUsd}`] : []),
      ...(maxTotalTokens !== undefined ? [`${tokens} of ${maxTotalTokens} tokens`] : []),
    ];
    throw new BudgetExceededError(
      `[Agent Accelerator] Usage limit reached: ${parts.join(", ")} spent by this chat (the agent and all its workers).`,
      {
        context: {
          limit: "usageLimit",
          partial: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: tokens }, turns: 0 },
        },
      }
    );
  }
}
