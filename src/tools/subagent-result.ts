import type { SubAgentExecutionMetadata } from "../types/response.ts";

/**
 * Module-private brand proving a tool result was produced by the SDK's own
 * delegation tools (`agentToTool` / `spawn_subagents`). Symbols cannot be
 * forged by JSON a tool fetched from the web, so only branded results get
 * their `_subagentMetadata` trusted (usage/cost rolled up, XML shown to the
 * model).
 */
const SUBAGENT_RESULT_BRAND: unique symbol = Symbol("agent-accelerator.subagent-result") as never;

/** Branded envelope returned by delegation tools. */
export interface SubagentResult {
  xml: string;
  _subagentMetadata: SubAgentExecutionMetadata[];
  toString(): string;
  readonly [SUBAGENT_RESULT_BRAND]: true;
}

/** Wraps worker output + metadata in the branded envelope. */
export function makeSubagentResult(xml: string, metas: SubAgentExecutionMetadata[]): SubagentResult {
  return {
    xml,
    _subagentMetadata: metas,
    toString() {
      return xml;
    },
    [SUBAGENT_RESULT_BRAND]: true,
  };
}

/** True only for envelopes created by {@link makeSubagentResult}. */
export function isSubagentResult(value: unknown): value is SubagentResult {
  return !!value && typeof value === "object" && (value as Record<symbol, unknown>)[SUBAGENT_RESULT_BRAND] === true;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Defensive copy of worker metadata: guarantees the fields the loop reads
 * (`usage` numbers, string `provider`/`model`) exist, so one malformed entry
 * can never crash a run.
 */
export function normalizeSubagentMetadata(metas: unknown): SubAgentExecutionMetadata[] {
  if (!Array.isArray(metas)) return [];
  const out: SubAgentExecutionMetadata[] = [];
  for (const raw of metas) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const u = (m.usage && typeof m.usage === "object" ? m.usage : {}) as Record<string, unknown>;
    const usage = { ...u, inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), totalTokens: num(u.totalTokens) };
    out.push({
      ...(m as unknown as SubAgentExecutionMetadata),
      model: typeof m.model === "string" ? m.model : "unknown",
      provider: typeof m.provider === "string" ? m.provider : "unknown",
      usage,
    });
  }
  return out;
}
