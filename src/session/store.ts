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
import type { TokenUsage, ThinkingLevel, CacheConfig } from "../types/core.ts";
import type { AgentResponse } from "../types/response.ts";
import { base64ToBytes } from "../utils/base64.ts";
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
  const mediaDir = path.join(sessionDir, "media");
  try {
    fs.rmSync(mediaDir, { recursive: true, force: true });
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
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(path.join(mediaDir, file), bytes);
      } catch {
        continue;
      }
      p[key] = `media/${file}`;
      if (mimeType) p.mimeType = mimeType;
      wrote.push(`media/${file}`);
    }
  }

  // No embedded bytes: don't leave an empty media/ behind.
  if (!hasBinary) {
    try {
      fs.rmSync(mediaDir, { recursive: true, force: true });
    } catch {}
  }
  return { messages: cloned, wrote };
}

/**
 * Resolves `media/…` relative refs to absolute paths anchored at the session
 * folder, so a resumed session runs from any cwd. Absolute paths, URLs, and
 * non-media strings pass through untouched.
 */
export function resolveMediaPaths(messages: Message[], sessionDir: string): Message[] {
  const cloned = cloneMessages(messages);
  for (const msg of cloned) {
    if (!Array.isArray((msg as Message).content)) continue;
    for (const part of (msg as Message).content as ContentPart[]) {
      const p: any = part as any;
      if (!p || typeof p.type !== "string") continue;
      if (!(MEDIA_PART_KEYS as readonly string[]).includes(p.type)) continue;
      const v = p[p.type] as unknown;
      if (typeof v === "string" && (v === "media" || v.startsWith("media/"))) {
        p[p.type] = path.join(sessionDir, v);
      }
    }
  }
  return cloned;
}

/** `<rootDir>/<sessionId>` — one folder per session. */
export function sessionDirFor(rootDir: string, sessionId: string): string {
  return path.join(path.resolve(rootDir), sessionId);
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
    fs.writeFileSync(path.join(sessionDir, "session.json"), serializeSession(data) + "\n", "utf8");
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
