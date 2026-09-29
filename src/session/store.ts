/**
 * Conversation history + telemetry persistence for Agent Accelerator.
 *
 * Replaces the ~170 lines of manual JSONL / totals / cost code previously
 * copied into `examples/05-chat.ts`. Devs now do:
 *
 * ```ts
 * import { Agent, loadSessionFile, saveSessionFile, SessionTelemetry } from "agent-accelerator";
 * const saved = loadSessionFile(".session.json");
 * const telemetry = SessionTelemetry.fromSaved(saved);
 * const agent = new Agent({ model: saved?.model ?? MODEL, sessionId: saved?.sessionId, ... });
 * if (saved) agent.importSession(saved);
 * const res = await agent.run(q);
 * telemetry.add(res.usage, agent.modelStringOrSpec as string);
 * saveSessionFile(".session.json", agent, telemetry);
 * ```
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "../types/message.ts";
import type { TokenUsage, ThinkingLevel, CacheConfig } from "../types/core.ts";
import type { AgentResponse } from "../types/response.ts";
import { getModelFromCatalog } from "../models/catalog.ts";

/** Cumulative per-session token + cost totals (JSON-safe). */
export interface SessionTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
}

/** Single-file session snapshot (v1). Written as one JSON object. */
export interface PersistedAgentSession {
  version: 1;
  sessionId: string;
  model: string;
  subagentModel?: string;
  thinkingLevel?: string;
  cache?: CacheConfig;
  instructions?: string;
  systemPrompt?: string;
  cachedContentId?: string;
  messages: Message[];
  totals?: SessionTotals;
}

export function emptyTotals(): SessionTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
}

function toNumber(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Best-effort model resolution without importing the registry (avoids cycles). */
function specFor(modelStr: string): ReturnType<typeof getModelFromCatalog> {
  try {
    const raw = String(modelStr ?? "").trim();
    if (!raw) return undefined;
    if (raw.includes("/")) {
      const [prefix, ...rest] = raw.split("/");
      const id = rest.join("/");
      return (
        getModelFromCatalog(prefix!, id) ||
        getModelFromCatalog(prefix!.toLowerCase(), id) ||
        getModelFromCatalog(id, id)
      );
    }
    return (
      getModelFromCatalog("google", raw) ||
      getModelFromCatalog("openai", raw) ||
      getModelFromCatalog("openrouter", raw) ||
      getModelFromCatalog(raw, raw)
    );
  } catch {
    return undefined;
  }
}

/** Context window for telemetry display. Falls back to 1M like the chat CLI. */
export function getSessionContextWindow(modelStr: string): number {
  try {
    const spec = specFor(modelStr);
    if (spec?.limit?.context) return spec.limit.context;
    if (spec?.contextWindow) return spec.contextWindow;
  } catch {}
  return 1_048_576;
}

/** Turn cost: prefers provider-reported total, else catalog pricing. */
export function computeSessionTurnCost(usage: TokenUsage, modelStr: string): number {
  const reported = (usage as TokenUsage)?.cost?.totalCost ?? 0;
  if (reported > 0) return reported;
  try {
    const spec = specFor(modelStr);
    const inputP = spec?.pricing?.inputPerMillion ?? spec?.cost?.input ?? 0;
    const outputP = spec?.pricing?.outputPerMillion ?? spec?.cost?.output ?? 0;
    const crP = spec?.pricing?.cacheReadPerMillion ?? spec?.cost?.cache_read ?? 0;
    const cwP = spec?.pricing?.cacheWritePerMillion ?? spec?.cost?.cache_write ?? 0;
    if (!inputP && !outputP && !crP && !cwP) return 0;
    const cr = usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
    const uncachedIn = Math.max(0, (usage.inputTokens ?? 0) - cr);
    return (
      (uncachedIn / 1e6) * inputP +
      (cr / 1e6) * crP +
      ((usage.cacheWriteTokens ?? 0) / 1e6) * cwP +
      ((usage.outputTokens ?? 0) / 1e6) * outputP
    );
  } catch {
    return 0;
  }
}

export function formatSessionTokens(n: number): string {
  const v = toNumber(n);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return `${Math.floor(v)}`;
}

export function formatSessionCost(c?: number): string {
  if (!c || c <= 0) return "$0.00";
  if (c < 0.0001) return `$${c.toFixed(6)}`;
  if (c < 0.01) return `$${c.toFixed(4)}`;
  if (c < 1.0) return `$${c.toFixed(3)}`;
  return `$${c.toFixed(2)}`;
}

/**
 * Cumulative usage tracker for one chat session.
 *
 * @example `const t = SessionTelemetry.fromSaved(saved); t.add(res.usage, model);`
 */
export class SessionTelemetry {
  totals: SessionTotals;

  constructor(totals?: SessionTotals | null) {
    this.totals = {
      input: toNumber(totals?.input),
      output: toNumber(totals?.output),
      cacheRead: toNumber(totals?.cacheRead),
      cacheWrite: toNumber(totals?.cacheWrite),
      reasoning: toNumber(totals?.reasoning),
      cost: toNumber(totals?.cost),
    };
  }

  /** Restores totals from a loaded session (tolerates legacy `metrics` shape). */
  static fromSaved(saved?: PersistedAgentSession | { totals?: SessionTotals; metrics?: Record<string, number> } | null): SessionTelemetry {
    const raw: any = (saved as any)?.totals ?? (saved as any)?.metrics ?? null;
    if (!raw) return new SessionTelemetry();
    // Legacy metrics files used {input,output,cacheRead,cacheWrite,reasoning,cost}
    // with identical keys — accept as-is.
    return new SessionTelemetry(raw as SessionTotals);
  }

  /** Adds one turn's usage; returns the turn cost. */
  add(usage: TokenUsage, modelStr: string): number {
    this.totals.input += usage.inputTokens ?? 0;
    this.totals.output += usage.outputTokens ?? 0;
    this.totals.cacheRead += usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
    this.totals.cacheWrite += usage.cacheWriteTokens ?? 0;
    this.totals.reasoning += usage.thinkingTokens ?? 0;
    const turnCost = computeSessionTurnCost(usage, modelStr);
    this.totals.cost += turnCost;
    return turnCost;
  }

  reset(): void {
    this.totals = emptyTotals();
  }

  toJSON(): SessionTotals {
    return { ...this.totals };
  }

  /** Per-turn cache-hit % (0-100) for one usage snapshot. */
  turnHitRate(usage: TokenUsage): number {
    const input = usage.inputTokens ?? 0;
    if (input <= 0) return 0;
    const cr = usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
    return Math.min(100, Math.max(0, (cr / input) * 100));
  }

  /** Session-total cache-hit % (0-100) across all added turns. */
  totalHitRate(): number {
    if (this.totals.input <= 0) return 0;
    return Math.min(100, Math.max(0, (this.totals.cacheRead / this.totals.input) * 100));
  }

  /**
   * One-line status bar with BOTH turn and session hit rates (03-multi_agent style).
   * Shows per-turn tokens + `turn-CH%`, session totals + `total-CH%`, cost, context %.
   * `thinkingLevel` defaults to the agent's level when omitted.
   */
  formatBar(
    res: AgentResponse,
    opts?: { model?: string; thinkingLevel?: string }
  ): string {
    const inTok = res.usage.inputTokens ?? 0;
    const outTok = res.usage.outputTokens ?? 0;
    const crTok = res.usage.cachedTokens ?? res.usage.cacheReadTokens ?? 0;
    const cwTurnTok = res.usage.cacheWriteTokens ?? 0;
    const turnRate = (this.turnHitRate(res.usage)).toFixed(1);
    const totalRate = this.totalHitRate().toFixed(1);
    const cwTurnLabel = cwTurnTok > 0 ? ` CW${formatSessionTokens(cwTurnTok)}` : "";
    const totCW = this.totals.cacheWrite;
    const totCWLabel = totCW > 0 ? ` CW${formatSessionTokens(totCW)}` : "";
    const modelStr = opts?.model ?? `${res.provider}/${res.model}`;
    const window = getSessionContextWindow(modelStr);
    const usedTokens = this.totals.input + this.totals.output + this.totals.cacheRead;
    const pct = window > 0 ? ((usedTokens / window) * 100).toFixed(1) : "0.0";
    const turnCost = computeSessionTurnCost(res.usage, modelStr);
    const costDelta = turnCost > 0 ? ` (+${formatSessionCost(turnCost)})` : "";
    const level = opts?.thinkingLevel ?? "none";
    return `\x1b[35m↑${formatSessionTokens(inTok)} ↓${formatSessionTokens(outTok)} CR${formatSessionTokens(crTok)}${cwTurnLabel} turn-CH${turnRate}% | ↑${formatSessionTokens(this.totals.input)} ↓${formatSessionTokens(this.totals.output)} CR${formatSessionTokens(this.totals.cacheRead)}${totCWLabel} total-CH${totalRate}% ${formatSessionCost(this.totals.cost)}${costDelta} ${pct}%/${formatSessionTokens(window)} • ${res.provider}/${res.model} • ${level} ${res.durationMs}ms ${res.finishReason ?? "STOP"}\x1b[0m`;
  }
}

/**
 * Startup banner for the chat CLI: distinguishes resumed vs fresh sessions
 * and surfaces the session-total hit rate immediately on resume.
 *
 * @example `console.log(formatSessionBanner(saved, telemetry, SESSION_FILE))`
 */
export function formatSessionBanner(
  saved: PersistedAgentSession | null,
  telemetry: SessionTelemetry,
  filePath: string
): string {
  const shortFile = filePath.split("/").pop() ?? filePath;
  if (saved) {
    const msgCount = saved.messages.length;
    const msgLabel = `${msgCount} message${msgCount === 1 ? "" : "s"}`;
    const modelLabel = saved.model || "unknown model";
    const levelLabel = saved.thinkingLevel ? ` • ${saved.thinkingLevel}` : "";
    const totalRate = telemetry.totalHitRate().toFixed(1);
    const costLabel = formatSessionCost(telemetry.totals.cost);
    const shortId = (saved.sessionId ?? "").slice(0, 8);
    return `\x1b[32m↺ Previous session loaded\x1b[0m \x1b[90m• ${shortId}… (${shortFile}) • ${msgLabel} • ${modelLabel}${levelLabel} • total-CH${totalRate}% • ${costLabel} total\x1b[0m`;
  }
  return `\x1b[90mNew session • ${shortFile} (no prior history found)\x1b[0m`;
}

/** Minimal agent surface needed for persistence (avoids an Agent import cycle). */
export interface SessionAgentLike {
  sessionId: string;
  modelStringOrSpec: unknown;
  subagentModel?: unknown;
  thinkingConfig?: { level?: string };
  cacheConfig?: CacheConfig;
  instructions?: string;
  context: { systemPrompt?: string; messages: Message[]; cachedContentId?: string };
}

/** Builds a storable snapshot from a live agent + optional telemetry. */
export function buildSessionData(agent: SessionAgentLike, telemetry?: SessionTelemetry | SessionTotals | null): PersistedAgentSession {
  const rawModel = agent.modelStringOrSpec as any;
  const model = typeof rawModel === "string" ? rawModel : (rawModel?.id ?? String(rawModel ?? ""));
  const rawSub = agent.subagentModel as any;
  const subagentModel =
    typeof rawSub === "string" ? rawSub : rawSub?.model ?? rawSub?.id ?? undefined;
  const totals = telemetry instanceof SessionTelemetry
    ? telemetry.toJSON()
    : telemetry ?? undefined;
  return {
    version: 1,
    sessionId: agent.sessionId,
    model,
    ...(subagentModel ? { subagentModel: String(subagentModel) } : {}),
    ...(agent.thinkingConfig?.level ? { thinkingLevel: agent.thinkingConfig.level as string } : {}),
    ...(agent.cacheConfig ? { cache: agent.cacheConfig } : {}),
    ...(agent.instructions ? { instructions: agent.instructions } : {}),
    ...(agent.context.systemPrompt ? { systemPrompt: agent.context.systemPrompt } : {}),
    ...(agent.context.cachedContentId ? { cachedContentId: agent.context.cachedContentId } : {}),
    messages: agent.context.messages,
    ...(totals ? { totals } : {}),
  };
}

/** Serializes a snapshot to a pretty-printed `.json` document (2-space indent). */
export function serializeSession(data: PersistedAgentSession): string {
  return JSON.stringify({ ...data, version: 1 }, null, 2);
}

/** Parses new pretty `.session.json` snapshots AND legacy `.session.jsonl` documents. */
export function deserializeSession(raw: string): PersistedAgentSession | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  try {
    // Legacy JSONL: lines shaped {type: session|mainModel|subagentModel|metrics|message|...}
    if (text.startsWith('{"type"')) {
      let sessionId = "";
      let model = "";
      let subagentModel: string | undefined;
      let thinkingLevel: string | undefined;
      let cache: CacheConfig | undefined;
      let cachedContentId: string | undefined;
      let systemPrompt: string | undefined;
      let instructions: string | undefined;
      const messages: Message[] = [];
      let totals: SessionTotals | undefined;
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj: any = JSON.parse(t);
          if (obj.type === "session") {
            sessionId = obj.id ?? obj.sessionId ?? sessionId;
            cache = obj.cache ?? cache;
            cachedContentId = obj.cachedContentId ?? cachedContentId;
            model = obj.model ?? model;
            thinkingLevel = obj.thinkingLevel ?? thinkingLevel;
          } else if (obj.type === "mainModel") {
            model = obj.id ?? obj.model ?? model;
            thinkingLevel = obj.thinkingLevel ?? thinkingLevel;
          } else if (obj.type === "subagentModel") {
            subagentModel = obj.id ?? obj.model ?? subagentModel;
          } else if (obj.type === "metrics" || obj.type === "totals") {
            totals = (obj.metrics ?? obj.totals ?? totals) as SessionTotals | undefined;
            cache = obj.cache ?? cache;
            cachedContentId = obj.cachedContentId ?? cachedContentId;
          } else if (obj.type === "modelChange") {
            model = obj.modelId ?? obj.model ?? model;
          } else if (obj.type === "thinkingLevelChange") {
            thinkingLevel = obj.thinkingLevel;
          } else if (obj.type === "message" && obj.message) {
            messages.push(obj.message as Message);
          } else if (obj.type === "context") {
            if (obj.systemPrompt) systemPrompt = obj.systemPrompt;
            if (Array.isArray(obj.messages)) messages.push(...(obj.messages as Message[]));
          }
        } catch {
          // skip corrupt lines — one bad turn must not drop the session
        }
      }
      if (!sessionId && messages.length === 0) return null;
      return {
        version: 1,
        sessionId: sessionId || `accel-${Date.now()}`,
        model,
        ...(subagentModel ? { subagentModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(cache ? { cache } : {}),
        ...(instructions ? { instructions } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(cachedContentId ? { cachedContentId } : {}),
        messages,
        ...(totals ? { totals } : {}),
      };
    }
    const obj: any = JSON.parse(text);
    if (!obj || typeof obj !== "object") return null;
    // Very old single-JSON shape without version: {sessionId, model, context:{messages}}
    if (obj.context && Array.isArray(obj.context.messages) && !Array.isArray(obj.messages)) {
      return {
        version: 1,
        sessionId: obj.sessionId ?? obj.id ?? `accel-${Date.now()}`,
        model: obj.model ?? "",
        subagentModel: obj.subagentModel,
        thinkingLevel: obj.thinkingLevel ?? obj.thinkingLevelChange,
        cache: obj.cache,
        instructions: obj.instructions,
        systemPrompt: obj.context.systemPrompt,
        cachedContentId: obj.cachedContentId ?? obj.context.cachedContentId,
        messages: obj.context.messages as Message[],
        totals: obj.totals ?? obj.metrics,
      };
    }
    if (!obj.sessionId && !Array.isArray(obj.messages)) return null;
    return {
      version: 1,
      sessionId: obj.sessionId ?? `accel-${Date.now()}`,
      model: obj.model ?? "",
      subagentModel: obj.subagentModel,
      thinkingLevel: obj.thinkingLevel,
      cache: obj.cache,
      instructions: obj.instructions,
      systemPrompt: obj.systemPrompt,
      cachedContentId: obj.cachedContentId,
      messages: Array.isArray(obj.messages) ? (obj.messages as Message[]) : [],
      totals: obj.totals,
    };
  } catch {
    return null;
  }
}

/** Loads a session file (pretty `.json` or legacy `.jsonl`). Returns null when missing/corrupt. */
export function loadSessionFile(filePath: string): PersistedAgentSession | null {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return null;
    return deserializeSession(fs.readFileSync(resolved, "utf8"));
  } catch {
    return null;
  }
}

/** Saves an agent + telemetry snapshot as a pretty-printed `.json` document (2-space indent). */
export function saveSessionFile(
  filePath: string,
  agent: SessionAgentLike,
  telemetry?: SessionTelemetry | SessionTotals | null
): void {
  const resolved = path.resolve(filePath);
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  } catch {}
  const data = buildSessionData(agent, telemetry);
  try {
    fs.writeFileSync(resolved, serializeSession(data) + "\n", "utf8");
  } catch {
    // persistence must never crash a chat turn
  }
}
