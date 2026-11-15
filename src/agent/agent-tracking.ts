/**
 * Worker trace lookups of one Agent: its own trace registry plus the process-wide store filtered to the sessions it
 * owns. `Agent.track`, `listTrackedSubAgents` and the loop's trace merge call these.
 */
import type { Agent } from "./agent.ts";
import type { SubAgentExecutionMetadata } from "../types/response.ts";
import { getSubAgentTraceForSessions, listSubAgentTraceIdsForSessions, type SubAgentTrace } from "./delegation.ts";

// The 32-hex tracking id inside a display id (`NAME-<hex>`), else the id itself; in: the readers below, out: the registry key.
function rawTrackingId(id: string): string {
  const tail = id.split("-").pop() ?? "";
  return /^[0-9a-f]{32}$/.test(tail) ? tail : id;
}

/** One worker's trace, copied so callers cannot change it; in: `Agent.track`, out: the trace or undefined. */
export function trackSubAgent(agent: Agent, trackingId: string): SubAgentTrace | undefined {
  if (!trackingId) return undefined;
  try {
    const hit = agent.subagentTraces[trackingId];
    if (hit) return { ...hit, steps: hit.steps.map((s) => ({ ...s })) };
  } catch {}
  // Process-wide store, filtered to sessions THIS agent owns: another agent's workers (e.g. a different tenant) are never reachable.
  return getSubAgentTraceForSessions(trackingId, agent.ownedSessionIds());
}

/** The tracking ids of the worker traces this agent can see, deduped; in: `Agent.listTrackedSubAgents`, out: ids. */
export function listTrackedSubAgents(agent: Agent): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [
    ...Object.keys(agent.subagentTraces),
    ...listSubAgentTraceIdsForSessions(agent.ownedSessionIds()),
  ]) {
    const raw = rawTrackingId(id);
    if (!seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

/** Merges finished worker metadata (with its steps) into the agent's trace registry; in: the loop's tool results, out: `agent.subagentTraces`. */
export function mergeSubagentTraces(agent: Agent, subagents: SubAgentExecutionMetadata[]): void {
  if (!subagents || subagents.length === 0) return;
  try {
    const registry = agent.subagentTraces;
    for (const s of subagents) {
      const raw = s.trackingId ? rawTrackingId(s.trackingId) : undefined;
      const key = raw || s.name;
      const existing = registry[key] ?? (raw ? registry[s.trackingId ?? ""] : undefined);
      if (existing) {
        existing.status = "done";
        if (s.steps && s.steps.length > 0 && existing.steps.length === 0) {
          existing.steps = s.steps.map((x) => ({ ...x }));
        }
        if (raw && !registry[raw]) registry[raw] = existing;
      } else if (raw) {
        registry[raw] = {
          trackingId: raw,
          name: s.name,
          sessionId: s.sessionId || "",
          parentSessionId: s.parentSessionId || agent.sessionId,
          status: "done",
          task: s.task,
          turns: 0,
          steps: (s.steps ?? []).map((x) => ({ ...x })),
        };
      }
    }
  } catch {}
}
