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
 *
 * For binary media (images, audio, video, files as bytes / data URLs /
 * base64), prefer session folders — `saveSessionDir("sessions", agent,
 * telemetry)` writes `sessions/<sessionId>/{session.json, media/*}` with
 * parts rewritten to relative `media/…` paths, and
 * `loadSessionDir(dir)` resolves them back.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message, ContentPart } from "../types/message.ts";
import type { TokenUsage, CacheConfig, ServiceTier } from "../types/core.ts";
import type { ModelSpec } from "../types/model.ts";
import type { AgentResponse } from "../types/response.ts";
import { base64ToBytes } from "../utils/base64.ts";
import { getModelFromCatalog } from "../models/catalog.ts";
import type { SubAgentStep } from "../types/response.ts";

/** Cumulative per-session token + cost totals (JSON-safe). */
export interface SessionTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
}

/** Persisted per-worker trace inside the same session file (dedicated section). */
export interface PersistedSubAgentTrace {
  trackingId: string;
  name: string;
  sessionId?: string;
  parentSessionId?: string;
  status: "running" | "done" | "error";
  task: string;
  role?: string;
  model?: string;
  provider?: string;
  turns: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  steps: SubAgentStep[];
  text?: string;
  error?: string;
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
  /** Parent session this snapshot was spawned from, when applicable. */
  parentSessionId?: string;
  /** Dedicated sub-agent traces, keyed by worker TrackingID (32-char hex). */
  subagents?: Record<string, PersistedSubAgentTrace>;
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

/** Context window for telemetry display. Falls back to 1M like the chat CLI.
 * @deprecated (Q-34) Kept for compat; new code should use
 * `getSessionContextWindowOrUndefined` and handle `undefined` explicitly.
 */
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
    const priced = priceUsage(usage, spec);
    if (priced && typeof priced.totalCost === "number" && priced.totalCost > 0) return priced.totalCost;
    return 0;
  } catch {
    // why: cost is observability-only — pricing failures must never break turns.
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
  parentSessionId?: unknown;
  subagentTraces?: Record<string, PersistedSubAgentTrace>;
  context: { systemPrompt?: string; messages: Message[]; cachedContentId?: string };
}

function snapshotSubagents(traces: Record<string, PersistedSubAgentTrace> | undefined): Record<string, PersistedSubAgentTrace> | undefined {
  if (!traces) return undefined;
  const keys = Object.keys(traces);
  if (keys.length === 0) return undefined;
  // Key by raw TrackingID (32-hex): the live registry also holds display keys
  // (`NAME-{id}`), but the file keeps one lean key per worker.
  const byId = new Map<string, PersistedSubAgentTrace>();
  for (const k of keys) {
    const t = traces[k]!;
    if (!t || typeof t !== "object") continue;
    let id = (typeof t.trackingId === "string" && t.trackingId) || k;
    // Normalize display ids (`NAME-{32hex}`) to the raw TrackingID so the
    // live trace and its merged copy collapse to one entry.
    const tail = id.split("-").pop() ?? "";
    if (/^[0-9a-f]{32}$/.test(tail)) id = tail;
    else if (/^[0-9a-f]{32}$/.test(k)) id = k;
    if (!byId.has(id)) byId.set(id, t);
  }
  if (byId.size === 0) return undefined;
  const lean: Record<string, PersistedSubAgentTrace> = {};
  for (const [id, t] of byId) {
    // Drop assistant step text that merely repeats the final answer: the
    // step marker (turn/type/timestamp) stays, the full text lives on trace.text.
    const steps = (t.steps ?? []).map((s) =>
      s.type === "assistant" && typeof s.text === "string" && typeof t.text === "string" && s.text === t.text
        ? { turn: s.turn, type: s.type, timestamp: s.timestamp }
        : { ...s }
    );
    lean[id] = { ...t, steps };
  }
  try {
    return JSON.parse(JSON.stringify(lean)) as Record<string, PersistedSubAgentTrace>;
  } catch {
    return lean;
  }
}

/** Canonical JSON for deep comparison (sorted keys; safe values only). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Drops `rawArguments` from `tool_call` parts when it re-parses to the
 * stored `arguments` (pure duplicate, the common case). Divergent or
 * unparseable wire strings are kept — they carry info parsing lost.
 */
function stripRedundantRawArguments(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (!Array.isArray((m as Message).content)) return m;
    let changed = false;
    const content = (m as Message).content as ContentPart[];
    const next = content.map((p: any) => {
      if (!p || p.type !== "tool_call" || typeof p.rawArguments !== "string") return p;
      try {
        const parsed: unknown = JSON.parse(p.rawArguments);
        if (stableStringify(parsed) === stableStringify(p.arguments ?? {})) {
          changed = true;
          const { rawArguments: _dropped, ...rest } = p;
          return rest;
        }
      } catch {
        // unparseable wire — keep it
      }
      return p;
    });
    return changed ? { ...m, content: next } : m;
  });
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
  const parentSessionId =
    typeof (agent as any)?.parentSessionId === "string" ? (agent as any).parentSessionId as string : undefined;
  const subagents = snapshotSubagents((agent as any)?.subagentTraces as Record<string, PersistedSubAgentTrace> | undefined);
  const messages = stripRedundantRawArguments(agent.context.messages);
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
    messages,
    ...(totals ? { totals } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(subagents ? { subagents } : {}),
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
  // Q-10: reject oversized payloads (>10MB JSON) — return null, no console.
  if (text.length > MAX_SESSION_JSON_BYTES) return null;
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
      let parentSessionId: string | undefined;
      let subagents: Record<string, PersistedSubAgentTrace> | undefined;
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
            parentSessionId = obj.parentSessionId ?? parentSessionId;
            subagents = obj.subagents ?? subagents;
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
      // Q-10: oversize guard — return null, no console.
      if (messages.length > MAX_SESSION_MESSAGES) return null;
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
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(subagents ? { subagents } : {}),
      };
    }
    const obj: any = JSON.parse(text);
    if (!obj || typeof obj !== "object") return null;
    // Q-10: version check — reject unknown versions, accept legacy shapes
    // that predate versioning (no version field).
    if ("version" in obj && (obj as { version?: unknown }).version !== 1) return null;
    // Very old single-JSON shape without version: {sessionId, model, context:{messages}}
    if (obj.context && Array.isArray(obj.context.messages) && !Array.isArray(obj.messages)) {
      if ((obj.context.messages as unknown[]).length > MAX_SESSION_MESSAGES) return null;
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
        parentSessionId: obj.parentSessionId,
        subagents: obj.subagents,
      };
    }
    if (!obj.sessionId && !Array.isArray(obj.messages)) return null;
    if (Array.isArray(obj.messages) && (obj.messages as unknown[]).length > MAX_SESSION_MESSAGES) return null;
    if ("sessionId" in obj && obj.sessionId !== undefined && typeof obj.sessionId !== "string") return null;
    if ("messages" in obj && obj.messages !== undefined && !Array.isArray(obj.messages)) return null;
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
      parentSessionId: obj.parentSessionId,
      subagents: obj.subagents,
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

/** Atomic file write (temp + rename) so a crash never leaves half-written JSON. */
export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {}
  let tag = "tmp";
  try {
    const pid = (globalThis as any)?.process?.pid;
    const rand = (globalThis as any)?.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 8);
    tag = `${typeof pid === "number" ? pid : "np"}-${rand}`;
  } catch {
    tag = Math.random().toString(36).slice(2, 8);
  }
  const tmp = `${filePath}.tmp-${tag}`;
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, filePath);
}

/** Session id grammar: no traversal, no slashes, no hidden files. */
export function assertValidSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sessionId)) {
    throw new Error(`[Agent Accelerator] Invalid sessionId "${sessionId}": must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`);
  }
}

/** Saves an agent + telemetry snapshot as a pretty-printed `.json` document (2-space indent). */
export function saveSessionFile(
  filePath: string,
  agent: SessionAgentLike,
  telemetry?: SessionTelemetry | SessionTotals | null
): void {
  const resolved = path.resolve(filePath);
  // Q-28-partial: never overwrite a corrupt file in place — quarantine it
  // as `*.corrupt-<ts>` first (load returns null for corrupt payloads).
  try {
    if (fs.existsSync(resolved)) {
      try {
        const raw = fs.readFileSync(resolved, "utf8");
        if (raw.trim().length > 0 && deserializeSession(raw) === null) {
          try { fs.renameSync(resolved, `${resolved}.corrupt-${Date.now()}`); } catch {}
        }
      } catch {}
    }
  } catch {}
  const data = buildSessionData(agent, telemetry);
  try {
    writeFileAtomic(resolved, serializeSession(data) + "\n");
  } catch {
    // persistence must never crash a chat turn
  }
}

// ---------------------------------------------------------------------------
// Session directories: sessions/<sessionId>/{session.json, media/*}
// ---------------------------------------------------------------------------

const MEDIA_PART_KEYS = ["image", "audio", "video", "file"] as const;

function isHttpRef(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function parseDataUrl(value: string): { mimeType: string; base64: string } | undefined {
  const m = value.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s);
  if (m && m[2]) return { mimeType: m[1] || "application/octet-stream", base64: m[2] };
  return undefined;
}

/** Same embedded-bytes heuristic as the media normalizer (paths fail it on their own). */
function looksLikeEmbeddedBase64(value: string): boolean {
  if (value.includes("\\") || value.length <= 100) return false;
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=\n\r]+$/.test(value.slice(0, 500));
}

function extForMedia(mimeType?: string, filename?: string): string {
  const mime = (mimeType || "").toLowerCase().split(";")[0]!.trim();
  const known: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "application/pdf": "pdf",
    "text/csv": "csv",
    "text/plain": "txt",
  };
  if (mime && known[mime]) return known[mime]!;
  if (filename) {
    const ext = filename.split("?")[0]!.split(".").pop()?.toLowerCase() ?? "";
    if (/^[a-z0-9]{1,5}$/.test(ext)) return ext;
  }
  if (mime) {
    const sub = mime.split("/").pop()?.toLowerCase() ?? "";
    if (/^[a-z0-9]{1,5}$/.test(sub)) return sub;
  }
  return "bin";
}

function cloneMessages(messages: Message[]): Message[] {
  try {
    const g: any = globalThis as any;
    if (typeof g.structuredClone === "function") return g.structuredClone(messages);
  } catch {}
  try {
    return JSON.parse(JSON.stringify(messages));
  } catch {
    return [...messages];
  }
}

/**
 * Extracts embedded media bytes (binary, `data:` URLs, raw base64) into
 * `<sessionDir>/media/` and rewrites those parts to relative `media/…`
 * paths. Remote URLs and filesystem paths are left as references.
 */
export function extractMediaToDir(
  messages: Message[],
  sessionDir: string
): { messages: Message[]; wrote: string[] } {
  const cloned = cloneMessages(messages);
  const root = path.resolve(sessionDir);
  const mediaDir = path.resolve(root, "media");
  if (!mediaDir.startsWith(root + path.sep) && mediaDir !== root) {
    throw new Error("[Agent Accelerator] Media dir escapes session dir");
  }
  try {
    fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  } catch {}
  // Never rm -rf: remove only previously written media files matching our pattern.
  try {
    for (const f of fs.readdirSync(mediaDir)) {
      if (/^(image|audio|video|file)-\d+\.[a-z0-9]{1,5}$/.test(f)) {
        try { fs.unlinkSync(path.join(mediaDir, f)); } catch {}
      }
    }
  } catch {}
  const wrote: string[] = [];
  const counters: Record<string, number> = {};
  let hasBinary = false;

  for (const msg of cloned) {
    if (!Array.isArray((msg as Message).content)) continue;
    for (const part of (msg as Message).content as ContentPart[]) {
      const p: any = part as any;
      if (!p || typeof p.type !== "string") continue;
      if (!(MEDIA_PART_KEYS as readonly string[]).includes(p.type)) continue;
      const key = p.type as (typeof MEDIA_PART_KEYS)[number];
      const raw = p[key] as unknown;
      let bytes: Uint8Array | undefined;
      let mimeType: string | undefined = typeof p.mimeType === "string" ? p.mimeType : undefined;
      if (raw instanceof Uint8Array) bytes = raw;
      else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
      else if (typeof raw === "string") {
        if (isHttpRef(raw)) continue; // remote reference — provider fetches per turn
        const dataUrl = raw.startsWith("data:") ? parseDataUrl(raw) : undefined;
        if (dataUrl) {
          bytes = base64ToBytes(dataUrl.base64);
          mimeType = mimeType ?? dataUrl.mimeType;
        } else if (looksLikeEmbeddedBase64(raw)) {
          bytes = base64ToBytes(raw.replace(/\s/g, ""));
        } else continue; // local path or short label — keep as reference
      } else continue;

      hasBinary = true;
      const n = (counters[key] = (counters[key] ?? 0) + 1);
      const ext = extForMedia(mimeType, typeof p.filename === "string" ? p.filename : undefined);
      const file = `${key}-${String(n).padStart(3, "0")}.${ext}`;
      try {
        fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
        const dest = path.resolve(mediaDir, file);
        if (!dest.startsWith(mediaDir + path.sep)) continue;
        fs.writeFileSync(dest, bytes, { mode: 0o600 });
        try { fs.chmodSync(dest, 0o600); } catch {}
      } catch {
        continue;
      }
      p[key] = `media/${file}`;
      if (mimeType) p.mimeType = mimeType;
      wrote.push(`media/${file}`);
    }
  }

  return { messages: cloned, wrote };
}

/**
 * Resolves `media/…` relative refs to absolute paths anchored at the session
 * folder, so a resumed session runs from any cwd. Absolute paths, URLs, and
 * non-media strings pass through untouched. Rejects traversal outside dir.
 */
export function resolveMediaPaths(messages: Message[], sessionDir: string): Message[] {
  const cloned = cloneMessages(messages);
  const root = path.resolve(sessionDir);
  for (const msg of cloned) {
    if (!Array.isArray((msg as Message).content)) continue;
    for (const part of (msg as Message).content as ContentPart[]) {
      const p: any = part as any;
      if (!p || typeof p.type !== "string") continue;
      if (!(MEDIA_PART_KEYS as readonly string[]).includes(p.type)) continue;
      const v = p[p.type] as unknown;
      if (typeof v === "string" && (v === "media" || v.startsWith("media/"))) {
        if (v.includes("..") || path.isAbsolute(v)) continue;
        const resolved = path.resolve(root, v);
        if (!resolved.startsWith(root + path.sep) && resolved !== root) continue;
        p[p.type] = resolved;
      }
    }
  }
  return cloned;
}

/** `<rootDir>/<sessionId>` — one folder per session. Validates traversal. */
export function sessionDirFor(rootDir: string, sessionId: string): string {
  assertValidSessionId(sessionId);
  const root = path.resolve(rootDir);
  const dir = path.resolve(root, sessionId);
  const rel = path.relative(root, dir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`[Agent Accelerator] Session dir escapes root: ${sessionId}`);
  }
  return dir;
}

/**
 * Saves `sessions/<sessionId>/session.json` (pretty, 2-space) plus
 * `media/*` for embedded bytes. Returns the session folder. Re-saving the
 * same session id rewrites the folder (no orphan accumulation).
 */
export function saveSessionDir(
  rootDir: string,
  agent: SessionAgentLike,
  telemetry?: SessionTelemetry | SessionTotals | null
): string {
  // Q-28-partial: sessionDirFor already enforces assertValidSessionId.
  const sessionDir = sessionDirFor(rootDir, agent.sessionId);
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
  } catch {}
  const { messages } = extractMediaToDir(agent.context.messages, sessionDir);
  const data = buildSessionData(
    { ...agent, context: { ...agent.context, messages } },
    telemetry
  );
  try {
    const target = path.join(sessionDir, "session.json");
    // Q-28-partial: quarantine corrupt targets instead of overwriting.
    try {
      if (fs.existsSync(target)) {
        try {
          const raw = fs.readFileSync(target, "utf8");
          if (raw.trim().length > 0 && deserializeSession(raw) === null) {
            try { fs.renameSync(target, `${target}.corrupt-${Date.now()}`); } catch {}
          }
        } catch {}
      }
    } catch {}
    writeFileAtomic(target, serializeSession(data) + "\n");
  } catch {
    // persistence must never crash a chat turn
  }
  return sessionDir;
}

/** A loaded session folder: snapshot (media paths resolved) + folder location. */
export interface LoadedSessionDir {
  session: PersistedAgentSession;
  dir: string;
}

/**
 * Loads a session folder (`<dir>/` or `<dir>/session.json`, plus legacy
 * single files). Relative `media/…` refs resolve against the folder.
 * Returns null when nothing loadable exists.
 */
export function loadSessionDir(sessionPath: string): LoadedSessionDir | null {
  try {
    const resolved = path.resolve(sessionPath);
    let dir = resolved;
    try {
      const st = fs.statSync(resolved);
      if (st.isFile()) {
        const single = loadSessionFile(resolved);
        if (!single) return null;
        dir = path.dirname(resolved);
        if (single.messages) {
          single.messages = resolveMediaPaths(single.messages, dir);
        }
        return { session: single, dir };
      }
    } catch {
      // path does not exist yet — fall through to session.json lookup
    }
    const file = path.join(dir, "session.json");
    if (!fs.existsSync(file)) return null;
    const data = deserializeSession(fs.readFileSync(file, "utf8"));
    if (!data) return null;
    data.messages = resolveMediaPaths(data.messages, dir);
    return { session: data, dir };
  } catch {
    return null;
  }
}

/** Most-recently-modified `sessions/<id>` folder, for resume-latest CLIs. */
export function findLatestSessionDir(rootDir: string): string | null {
  try {
    const root = path.resolve(rootDir);
    if (!fs.existsSync(root)) return null;
    let best: { dir: string; mtime: number } | null = null;
    for (const entry of fs.readdirSync(root)) {
      const file = path.join(root, entry, "session.json");
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        if (!best || st.mtimeMs > best.mtime) best = { dir: path.join(root, entry), mtime: st.mtimeMs };
      } catch {
        continue;
      }
    }
    return best?.dir ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Q-10: session validation (append-only; deserializeSession above only gained
// size/version guards, no behavior change otherwise).
// ---------------------------------------------------------------------------

/** Max messages accepted in a session snapshot (Q-10). */
export const MAX_SESSION_MESSAGES = 5000;
/** Max raw JSON bytes accepted in deserializeSession (Q-10). */
export const MAX_SESSION_JSON_BYTES = 10 * 1024 * 1024;

function sessionLoadError(message: string): Error {
  const e = new Error(`[Agent Accelerator] Invalid session: ${message}`);
  e.name = "SessionLoadError";
  return e;
}

/**
 * Manual Zod-like validation for session snapshots (Q-10, no new deps).
 * Checks `version===1`, string `sessionId`, array `messages`, and oversize
 * (>5000 messages or >10MB JSON). Throws a `SessionLoadError`-named Error
 * on failure; returns the typed session on success.
 */
export function validateSessionData(data: unknown): PersistedAgentSession {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw sessionLoadError("expected an object");
  }
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) {
    throw sessionLoadError(`unsupported version ${String((obj as { version?: unknown }).version)} (expected 1)`);
  }
  if (typeof obj.sessionId !== "string" || obj.sessionId.length === 0) {
    throw sessionLoadError("sessionId must be a non-empty string");
  }
  if (!Array.isArray(obj.messages)) {
    throw sessionLoadError("messages must be an array");
  }
  if ((obj.messages as unknown[]).length > MAX_SESSION_MESSAGES) {
    throw sessionLoadError(`too many messages (${(obj.messages as unknown[]).length} > ${MAX_SESSION_MESSAGES})`);
  }
  let approxBytes = 0;
  try {
    approxBytes = JSON.stringify(data)?.length ?? 0;
  } catch {
    throw sessionLoadError("session is not JSON-serializable");
  }
  if (approxBytes > MAX_SESSION_JSON_BYTES) {
    throw sessionLoadError(`session JSON too large (${approxBytes} > ${MAX_SESSION_JSON_BYTES} bytes)`);
  }
  return data as PersistedAgentSession;
}

// ---------------------------------------------------------------------------
// Q-34: context-window lookup without the legacy 1M fallback.
// ---------------------------------------------------------------------------

/**
 * Returns the catalog context window for a model, or `undefined` when unknown
 * (Q-34). Prefer this over `getSessionContextWindow` for new code.
 */
export function getSessionContextWindowOrUndefined(modelStr: string): number | undefined {
  try {
    const spec = specFor(modelStr);
    if (spec?.limit?.context) return spec.limit.context;
    if (spec?.contextWindow) return spec.contextWindow;
  } catch {
    // why: catalog lookup is best-effort — unknown models yield undefined.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Q-41: telemetry bus (no console.* in library code).
// ---------------------------------------------------------------------------

/** Telemetry event emitted via the in-process bus (Q-41). */
export interface TelemetryEvent {
  code: string;
  message: string;
  level?: "info" | "warn" | "error";
  data?: unknown;
  timestamp: number;
}

/** Listener subscribed via `telemetryBus.onEvent`. */
export type TelemetryListener = (event: TelemetryEvent) => void;

interface TelemetryBus {
  /** Subscribes to telemetry events. Returns an unsubscribe function. Default: no-op delivery (no listeners, no console). */
  onEvent(listener: TelemetryListener): () => void;
  /** Emits a warning (level `warn`). Never throws, never logs to console. */
  emitWarning(code: string, message: string, data?: unknown): void;
  /** Emits a generic event. Never throws, never logs to console. */
  emit(event: Omit<TelemetryEvent, "timestamp"> & { timestamp?: number }): void;
  /** Removes all listeners (useful in tests). */
  clear(): void;
}

/**
 * In-process telemetry bus (Q-41). Library code routes warnings/anomalies
 * here instead of `console.*`. Default has zero listeners so emission is a
 * no-op; CLIs/tests attach a pretty logger via `onEvent`.
 */
export const telemetryBus: TelemetryBus = (() => {
  const listeners = new Set<TelemetryListener>();
  const deliver = (event: TelemetryEvent): void => {
    for (const l of [...listeners]) {
      try { l(event); } catch {
        // why: a faulty telemetry listener must not break the emitting run.
      }
    }
  };
  return {
    onEvent(listener: TelemetryListener): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emitWarning(code: string, message: string, data?: unknown): void {
      try {
        deliver({ code, message, level: "warn", data, timestamp: Date.now() });
      } catch {
        // why: telemetry emission is observability-only.
      }
    },
    emit(event: Omit<TelemetryEvent, "timestamp"> & { timestamp?: number }): void {
      try {
        deliver({ level: "info", ...event, timestamp: event.timestamp ?? Date.now() });
      } catch {
        // why: telemetry emission is observability-only.
      }
    },
    clear(): void {
      listeners.clear();
    },
  };
})();

/** Reports a usage/cost anomaly via the global hook + telemetry bus (Q-35). Never logs. */
export function reportUsageAnomaly(detail: { type: string; [k: string]: unknown }): void {
  try {
    (globalThis as unknown as { __agentAccelAnomaly?: (d: unknown) => void }).__agentAccelAnomaly?.(detail);
  } catch {
    // why: anomaly hooks are third-party — must never throw into the loop.
  }
  try {
    telemetryBus.emitWarning(detail.type, `usage anomaly: ${detail.type}`, detail);
  } catch {
    // why: telemetry emission is observability-only.
  }
}

// ---------------------------------------------------------------------------
// Q-35: canonical usage invariants.
// ---------------------------------------------------------------------------
/**
 * Canonical usage invariants (provider-agnostic, Q-35):
 * - all token counts are finite integers >= 0;
 * - `cachedTokens` / `cacheReadTokens` are a SUBSET of `inputTokens`
 *   (cache hits cannot exceed input; aggregates clamp — see `accumulateUsage`
 *   in `agent/loop.ts`), so hit rates never exceed 100%;
 * - `thinkingTokens` is a SUBSET of `outputTokens` when both are reported
 *   (reasoning is generated output); providers that omit one side are
 *   accepted, only impossible `thinking > output` with both present fails.
 *
 * Test helper: throws an Error describing the first violation, returns void
 * when invariants hold. Not called in hot paths (validation only).
 */
export function assertUsageInvariants(usage: TokenUsage): void {
  const fail = (msg: string): never => {
    throw new Error(`[Agent Accelerator] Invalid usage: ${msg}`);
  };
  const ints: Array<[string, unknown]> = [
    ["inputTokens", usage.inputTokens],
    ["outputTokens", usage.outputTokens],
    ["totalTokens", usage.totalTokens],
  ];
  for (const [k, v] of ints) {
    if (typeof v !== "number" || !Number.isFinite(v as number) || (v as number) < 0) {
      fail(`${k} must be a finite number >= 0 (got ${String(v)})`);
    }
  }
  const optional: Array<[string, unknown]> = [
    ["cachedTokens", usage.cachedTokens],
    ["cacheReadTokens", usage.cacheReadTokens],
    ["cacheWriteTokens", usage.cacheWriteTokens],
    ["thinkingTokens", usage.thinkingTokens],
  ];
  for (const [k, v] of optional) {
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v as number) || (v as number) < 0) {
      fail(`${k} must be a finite number >= 0 when present (got ${String(v)})`);
    }
  }
  const input = usage.inputTokens ?? 0;
  for (const k of ["cachedTokens", "cacheReadTokens"] as const) {
    const v = usage[k] ?? 0;
    if (v > input) fail(`${k} (${v}) exceeds inputTokens (${input})`);
  }
  if (usage.thinkingTokens !== undefined && usage.outputTokens !== undefined) {
    if (usage.thinkingTokens > usage.outputTokens) {
      fail(`thinkingTokens (${usage.thinkingTokens}) exceeds outputTokens (${usage.outputTokens})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Q-36: one cost model — integer micro-USD accumulation.
// ---------------------------------------------------------------------------

/** Where a priced cost came from (Q-36). Unknown stays unknown, never 0. */
export type CostSource = "provider" | "catalog" | "unknown";

/** Integer micro-USD breakdown behind a priced cost (Q-36). */
export interface CostBreakdown {
  inputMicroUSD: number;
  outputMicroUSD: number;
  cacheReadMicroUSD: number;
  cacheWriteMicroUSD: number;
  audioMicroUSD: number;
  totalMicroUSD: number;
  /** Which price tier applied (`base` or e.g. `context_over_200k` / `tiers:<size>`). */
  tier: string;
  /** Multiplier applied for the service tier (estimate — see below). */
  serviceTierMultiplier: number;
  serviceTier?: string;
}

/** Cost result of `priceUsage`: compat cost fields + source + breakdown. */
export type PricedCost = NonNullable<TokenUsage["cost"]> & {
  source: CostSource;
  breakdown: CostBreakdown;
};

/**
 * Service-tier price multipliers (Q-36). ESTIMATES, not vendor guarantees:
 * `flex` batches trade latency for ~0.5x price, `priority` reserves capacity
 * at ~1.5x. Standard/default is 1.0. Documented as estimates because vendors
 * do not publish exact tier multipliers in the catalog.
 */
const SERVICE_TIER_MULTIPLIERS: Record<string, number> = {
  flex: 0.5,
  priority: 1.5,
};

function serviceTierMultiplier(serviceTier?: string): { multiplier: number; tier?: string } {
  if (!serviceTier) return { multiplier: 1 };
  const m = SERVICE_TIER_MULTIPLIERS[serviceTier.toLowerCase()];
  return m !== undefined ? { multiplier: m, tier: serviceTier } : { multiplier: 1, tier: serviceTier };
}

function toDollars(microUSD: number): number {
  return microUSD / 1_000_000;
}

/**
 * Resolves effective per-1M pricing for a usage snapshot (Q-36). When
 * `usage.inputTokens > 200_000` and the catalog carries `cost.tiers` or
 * `cost.context_over_200k`, the over-200k tier prices apply; otherwise base
 * `pricing.*` (falling back to legacy `cost.*`) applies.
 */
function resolveEffectivePricing(
  spec: ModelSpec | undefined,
  inputTokens: number
): { input: number; output: number; cacheRead: number; cacheWrite: number; audio: number; tier: string } {
  const base = {
    input: spec?.pricing?.inputPerMillion ?? (spec?.cost?.input as number | undefined) ?? 0,
    output: spec?.pricing?.outputPerMillion ?? (spec?.cost?.output as number | undefined) ?? 0,
    cacheRead: spec?.pricing?.cacheReadPerMillion ?? (spec?.cost?.cache_read as number | undefined) ?? 0,
    cacheWrite: spec?.pricing?.cacheWritePerMillion ?? (spec?.cost?.cache_write as number | undefined) ?? 0,
    audio:
      spec?.pricing?.inputAudioPerMillion ?? (spec?.cost as { input_audio?: number } | undefined)?.input_audio ?? 0,
  };
  if (!spec || inputTokens <= 200_000) return { ...base, tier: "base" };
  const over = spec.cost?.context_over_200k as { input?: number; output?: number; cache_read?: number } | undefined;
  if (over && (over.input || over.output || over.cache_read)) {
    return {
      input: over.input ?? base.input,
      output: over.output ?? base.output,
      cacheRead: over.cache_read ?? base.cacheRead,
      cacheWrite: base.cacheWrite,
      audio: base.audio,
      tier: "context_over_200k",
    };
  }
  const tiers = spec.cost?.tiers;
  if (Array.isArray(tiers) && tiers.length > 0) {
    let best: { input: number; output: number; cache_read?: number; size: number } | undefined;
    for (const t of tiers as Array<{ tier?: { type?: string; size?: number }; input?: number; output?: number; cache_read?: number }>) {
      const size = typeof t?.tier?.size === "number" ? t.tier.size : undefined;
      if (size === undefined || size > inputTokens) continue;
      const type = String(t?.tier?.type ?? "").toLowerCase();
      if (type && type !== "context" && !type.includes("context")) continue;
      if (!best || size > best.size) {
        best = { input: t.input ?? base.input, output: t.output ?? base.output, cache_read: t.cache_read, size };
      }
    }
    if (best) {
      return {
        input: best.input,
        output: best.output,
        cacheRead: best.cache_read ?? base.cacheRead,
        cacheWrite: base.cacheWrite,
        audio: base.audio,
        tier: `tiers:${best.size}`,
      };
    }
  }
  return { ...base, tier: "base" };
}

/**
 * Prices one usage snapshot with integer micro-USD accumulation (Q-36).
 *
 * - Provider-reported `usage.cost.totalCost > 0` wins (source `provider`).
 * - Else catalog pricing via `resolveEffectivePricing` (source `catalog`).
 * - Else returns `undefined` (source `unknown` is implicit) — unknown stays
 *   unknown, never a fabricated 0 object.
 * - Audio tokens (`usage.audioTokens` / `usage.inputAudioTokens` when present)
 *   price at `pricing.inputAudioPerMillion` / `cost.input_audio` and fold into
 *   the total (separately itemized in `breakdown.audioMicroUSD`).
 * - `opts.serviceTier` (`flex` ~0.5x, `priority` ~1.5x, estimates) scales the
 *   catalog total; provider-reported costs are never rescaled.
 */
export function priceUsage(
  usage: TokenUsage,
  spec?: ModelSpec,
  opts?: { serviceTier?: ServiceTier | string }
): PricedCost | undefined {
  const reported = usage?.cost;
  if (reported && typeof reported.totalCost === "number" && reported.totalCost > 0) {
    const micro = (d?: number): number => (typeof d === "number" && d > 0 ? Math.round(d * 1_000_000) : 0);
    const inputMicroUSD = micro(reported.inputCost);
    const outputMicroUSD = micro(reported.outputCost);
    const cacheReadMicroUSD = micro(reported.cacheReadCost);
    const cacheWriteMicroUSD = micro(reported.cacheWriteCost);
    const totalMicroUSD = Math.round(reported.totalCost * 1_000_000);
    return {
      inputCost: reported.inputCost,
      outputCost: reported.outputCost,
      cacheReadCost: reported.cacheReadCost,
      cacheWriteCost: reported.cacheWriteCost,
      totalCost: reported.totalCost,
      source: "provider",
      breakdown: {
        inputMicroUSD,
        outputMicroUSD,
        cacheReadMicroUSD,
        cacheWriteMicroUSD,
        audioMicroUSD: 0,
        totalMicroUSD,
        tier: "provider-reported",
        serviceTierMultiplier: 1,
      },
    };
  }
  if (!spec) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cachedTokens = usage.cachedTokens ?? usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const audioTokens =
    (usage as { audioTokens?: unknown }).audioTokens ??
    (usage as { inputAudioTokens?: unknown }).inputAudioTokens ??
    0;
  const audioCount = typeof audioTokens === "number" && Number.isFinite(audioTokens) && audioTokens > 0 ? Math.round(audioTokens) : 0;
  const pricing = resolveEffectivePricing(spec, inputTokens);
  if (!pricing.input && !pricing.output && !pricing.cacheRead && !pricing.cacheWrite && !pricing.audio) {
    return undefined;
  }
  const { multiplier, tier: serviceTier } = serviceTierMultiplier(opts?.serviceTier);
  const nonCachedInput = Math.max(0, inputTokens - cachedTokens);
  // Integer micro-USD accumulation: microUSD = tokens * pricePerMillion
  // ($P per 1M tokens == $P/1e6 per token == P micro-USD per token).
  const inputMicroUSD = Math.round(nonCachedInput * pricing.input * multiplier);
  const cacheReadMicroUSD = Math.round(cachedTokens * pricing.cacheRead * multiplier);
  const cacheWriteMicroUSD = Math.round(cacheWriteTokens * pricing.cacheWrite * multiplier);
  const outputMicroUSD = Math.round(outputTokens * pricing.output * multiplier);
  const audioMicroUSD = Math.round(audioCount * pricing.audio * multiplier);
  const totalMicroUSD = inputMicroUSD + cacheReadMicroUSD + cacheWriteMicroUSD + outputMicroUSD + audioMicroUSD;
  return {
    inputCost: toDollars(inputMicroUSD),
    outputCost: toDollars(outputMicroUSD + audioMicroUSD),
    cacheReadCost: toDollars(cacheReadMicroUSD),
    cacheWriteCost: toDollars(cacheWriteMicroUSD),
    totalCost: toDollars(totalMicroUSD),
    source: "catalog",
    breakdown: {
      inputMicroUSD,
      outputMicroUSD,
      cacheReadMicroUSD,
      cacheWriteMicroUSD,
      audioMicroUSD,
      totalMicroUSD,
      tier: pricing.tier,
      serviceTierMultiplier: multiplier,
      ...(serviceTier ? { serviceTier } : {}),
    },
  };
}

/**
 * Computes and attaches catalog pricing to a usage snapshot (Q-36).
 * Keeps provider-reported costs untouched; returns the cost (or undefined
 * when unknown). Never fabricates a 0 object for unknown pricing.
 */
export function addCostToUsage(
  usage: TokenUsage,
  spec?: ModelSpec,
  opts?: { serviceTier?: ServiceTier | string }
): TokenUsage["cost"] | undefined {
  if (usage?.cost && typeof usage.cost.totalCost === "number" && usage.cost.totalCost > 0) {
    return usage.cost;
  }
  const priced = priceUsage(usage, spec, opts);
  if (!priced) return usage.cost;
  const { source: _source, breakdown: _breakdown, ...cost } = priced;
  usage.cost = cost;
  return usage.cost;
}
