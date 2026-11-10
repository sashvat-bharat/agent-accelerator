/**
 * What one agent spent on ITS OWN model calls, kept exactly: tokens as the provider reported them, cost in integer
 * micro-USD priced per turn (so cache hits, cache writes and price tiers are right), plus where each turn's price came
 * from. Every agent records its own turns and saves them in its session; `usageReport()` then adds the agent and its
 * workers up WITHOUT counting anything twice (a parent's `AgentResponse.usage` already contains its workers' usage, so
 * responses are never summed). Pure functions, no Agent import.
 */
import type { TokenUsage } from "../types/core.ts";
import type { PricedCost } from "./store.ts";

/** Raw totals of one agent's own model calls, as saved in its session (`usage`). */
export interface UsageTotals {
  /** Model calls made. */
  turns: number;
  /** Input tokens; they INCLUDE the cache reads and writes. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Output tokens; they INCLUDE the thinking tokens. */
  outputTokens: number;
  thinkingTokens: number;
  /** Integer micro-USD, summed over the turns that had a price. */
  costMicroUSD: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** Turns by where their price came from: the provider's reported cost, the catalog, or nowhere (unknown pricing). */
  turnsBy: { provider: number; catalog: number; unpriced: number };
}

/** A zeroed {@link UsageTotals}. */
export function emptyUsage(): UsageTotals {
  return {
    turns: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costMicroUSD: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turnsBy: { provider: 0, catalog: 0, unpriced: 0 },
  };
}

// A finite whole number >= 0, else 0; in: the usage maths and readUsage, out: a safe count.
const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** A model reference (string or catalog spec) as a plain string for a report line. */
export function modelName(model: unknown): string {
  return typeof model === "string" ? model : String((model as { id?: unknown } | null | undefined)?.id ?? "unknown");
}

/** Adds one model call (`priced` from `priceUsage`; undefined = unknown pricing, which is counted but never turned into $0). */
export function addTurn(totals: UsageTotals, usage: TokenUsage, priced: PricedCost | undefined): void {
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  totals.turns += 1;
  totals.inputTokens += input;
  totals.outputTokens += output;
  totals.cacheReadTokens += Math.min(count(usage.cachedTokens ?? usage.cacheReadTokens), input);
  totals.cacheWriteTokens += Math.min(count(usage.cacheWriteTokens), input);
  totals.thinkingTokens += Math.min(count(usage.thinkingTokens), output);
  if (!priced) {
    totals.turnsBy.unpriced += 1;
    return;
  }
  totals.turnsBy[priced.source === "provider" ? "provider" : "catalog"] += 1;
  const b = priced.breakdown;
  totals.costMicroUSD.input += b.inputMicroUSD;
  totals.costMicroUSD.output += b.outputMicroUSD + b.audioMicroUSD;
  totals.costMicroUSD.cacheRead += b.cacheReadMicroUSD;
  totals.costMicroUSD.cacheWrite += b.cacheWriteMicroUSD;
  totals.costMicroUSD.total += b.totalMicroUSD;
}

/** Adds `other` into `into` (workers into a total). */
export function mergeUsage(into: UsageTotals, other: UsageTotals): void {
  for (const k of [
    "turns",
    "inputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "outputTokens",
    "thinkingTokens",
  ] as const)
    into[k] += other[k];
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
    into.costMicroUSD[k] += other.costMicroUSD[k];
  for (const k of ["provider", "catalog", "unpriced"] as const) into.turnsBy[k] += other.turnsBy[k];
}

/** Reads saved totals back defensively (a hand-edited or older file never breaks a load); unusable input gives zeros. */
export function readUsage(saved: unknown): UsageTotals {
  const out = emptyUsage();
  const s = saved as Partial<UsageTotals> | null | undefined;
  if (!s || typeof s !== "object") return out;
  for (const k of [
    "turns",
    "inputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "outputTokens",
    "thinkingTokens",
  ] as const)
    out[k] = count(s[k]);
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
    out.costMicroUSD[k] = count(s.costMicroUSD?.[k]);
  for (const k of ["provider", "catalog", "unpriced"] as const) out.turnsBy[k] = count(s.turnsBy?.[k]);
  return out;
}

/** Where a total's price came from: `provider` (the provider's reported cost), `catalog`, `mixed` (both), or `unknown` (no turn had a price). */
export type CostSource = "provider" | "catalog" | "mixed" | "unknown";

/** One agent's (or the whole session's) spending in a form made to be read: tokens, cache hit rate, cost. */
export interface UsageLine {
  /** Model calls made. */
  turns: number;
  tokens: {
    /** Everything sent: `freshInput + cacheRead + cacheWrite`. */
    input: number;
    /** Input that was neither read from nor written to the cache. */
    freshInput: number;
    cacheRead: number;
    cacheWrite: number;
    /** Everything generated, thinking included. */
    output: number;
    /** The part of `output` that was thinking. */
    thinking: number;
    total: number;
  };
  /** `cacheRead / input` from 0 to 1; `null` when nothing was sent. */
  cacheHitRate: number | null;
  cost: {
    source: CostSource;
    /** Turns with no known price: when above 0 the totals are a lower bound. */
    unpricedTurns: number;
    /** USD; `null` when no turn had a price (unknown is never shown as 0). */
    totalUsd: number | null;
    /** The parts, in USD. For turns whose cost the provider reported, only the total is exact: the parts then add up to less than `totalUsd`. Absent when unknown. */
    parts?: { inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheWriteUsd: number };
  };
}

/** Turns raw totals into a readable {@link UsageLine}. */
export function usageLine(t: UsageTotals): UsageLine {
  const priced = t.turnsBy.provider + t.turnsBy.catalog;
  const source: CostSource =
    priced === 0
      ? "unknown"
      : t.turnsBy.provider > 0 && t.turnsBy.catalog > 0
        ? "mixed"
        : t.turnsBy.provider > 0
          ? "provider"
          : "catalog";
  const usd = (micro: number): number => micro / 1_000_000;
  const c = t.costMicroUSD;
  return {
    turns: t.turns,
    tokens: {
      input: t.inputTokens,
      freshInput: Math.max(0, t.inputTokens - t.cacheReadTokens - t.cacheWriteTokens),
      cacheRead: t.cacheReadTokens,
      cacheWrite: t.cacheWriteTokens,
      output: t.outputTokens,
      thinking: t.thinkingTokens,
      total: t.inputTokens + t.outputTokens,
    },
    cacheHitRate: t.inputTokens > 0 ? t.cacheReadTokens / t.inputTokens : null,
    cost: {
      source,
      unpricedTurns: t.turnsBy.unpriced,
      totalUsd: priced === 0 ? null : usd(c.total),
      ...(priced === 0
        ? {}
        : {
            parts: {
              inputUsd: usd(c.input),
              outputUsd: usd(c.output),
              cacheReadUsd: usd(c.cacheRead),
              cacheWriteUsd: usd(c.cacheWrite),
            },
          }),
    },
  };
}

/** One worker in the usage tree, with raw totals (the report turns them into lines). */
export interface UsageNode {
  id: string;
  name: string;
  role?: string;
  model: string;
  status: "open" | "closed" | "fixed";
  totals: UsageTotals;
  workers: UsageNode[];
}

/** An agent or worker line of a {@link UsageReport}. */
export interface AgentUsage extends UsageLine {
  id: string;
  name: string;
  model: string;
}

/** A worker line, with the workers it started (`open` and `closed` are `subagents`/`agent.workers` workers, `fixed` is a `subagents: [...]` worker). */
export interface WorkerUsage extends AgentUsage {
  role?: string;
  status: "open" | "closed" | "fixed";
  workers: WorkerUsage[];
}

/** What `agent.usageReport()` returns. `agent` is the agent's own model calls only; `total` is the agent plus every worker below it. */
export interface UsageReport {
  agent: AgentUsage;
  workers: WorkerUsage[];
  total: UsageLine;
}

// Adds a node and everything below it into `into`; in: a usage tree, out: the whole-session total.
function sumTree(into: UsageTotals, nodes: UsageNode[]): void {
  for (const n of nodes) {
    mergeUsage(into, n.totals);
    sumTree(into, n.workers);
  }
}

// One node as a report line, children included; in: a usage node, out: UsageReport.workers.
function nodeLine(n: UsageNode): WorkerUsage {
  return {
    id: n.id,
    name: n.name,
    ...(n.role ? { role: n.role } : {}),
    model: n.model,
    status: n.status,
    ...usageLine(n.totals),
    workers: n.workers.map(nodeLine),
  };
}

/** Builds the report from the agent's own totals and its worker tree. */
export function buildUsageReport(
  own: { id: string; name: string; model: string; totals: UsageTotals },
  workers: UsageNode[]
): UsageReport {
  const total = emptyUsage();
  mergeUsage(total, own.totals);
  sumTree(total, workers);
  return {
    agent: { id: own.id, name: own.name, model: own.model, ...usageLine(own.totals) },
    workers: workers.map(nodeLine),
    total: usageLine(total),
  };
}
