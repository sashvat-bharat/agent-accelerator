import { clampCacheKey } from "./cache.ts";
import type { ThinkingLevel } from "../types/core.ts";
import type { MidSessionMode } from "../types/agent.ts";
import type { AgentConfig } from "../types/agent.ts";
import type { ModelSpec } from "../types/model.ts";
import type { ModelProviderInstance } from "../providers/registry.ts";
import type { ContentPart } from "../types/message.ts";
import { ConfigError } from "../types/errors.ts";

/**
 * Creates or formats a unique session ID for prompt caching affinity (clamped to 64 chars like agent-accel)
 */
/**
 * Creates a unique, provider-safe session ID for cache affinity.
 *
 * @example `const sessionId = createSessionId("checkout");`
 */
export function createSessionId(prefix = "accel"): string {
  let id: string;
  try {
    const webCrypto =
      (globalThis as any)?.crypto ?? (typeof crypto !== "undefined" ? crypto : undefined);
    if (webCrypto && typeof webCrypto.randomUUID === "function") {
      id = `${prefix}-${webCrypto.randomUUID()}`;
    } else {
      throw new Error("no randomUUID");
    }
  } catch {
    // Fallback — still clamp
    id = `${prefix}-${Math.random().toString(36).slice(2, 11)}-${Date.now().toString(36)}`;
  }
  return clampCacheKey(id) || id;
}

/**
 * Short stable hash (FNV-1a, 8 hex chars) for embedding parent lineage
 * into truncated child session IDs without extra dependencies.
 */
export function hashSessionPart(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * System-generated 32-char TrackingID for one sub-agent (lowercase hex, no
 * dashes). Surfaced as the suffix in `SUBAGENT-NAME-{TrackingID}` display ids
 * so `agent.track(id)` can address one worker among many concurrent ones.
 */
export function createTrackingId(): string {
  try {
    const c = (globalThis as any)?.crypto;
    if (c && typeof c.randomUUID === "function") {
      return String(c.randomUUID()).replace(/-/g, "").slice(0, 32);
    }
  } catch {}
  try {
    const nodeCrypto: any = (globalThis as any)?.process?.getBuiltinModule?.("node:crypto") ?? null;
    if (nodeCrypto?.randomUUID) {
      return String(nodeCrypto.randomUUID()).replace(/-/g, "").slice(0, 32);
    }
  } catch {}
  let out = "";
  while (out.length < 32) out += Math.random().toString(16).slice(2);
  return out.slice(0, 32);
}

/**
 * Monotonic clock for measuring durations (Q-42). Uses `performance.now()`
 * when available, falling back to `Date.now()`. Differences on the same
 * clock are valid durations; never treat the value as wall-clock epoch.
 *
 * @example `const start = nowMs(); ...; const durationMs = nowMs() - start;`
 */
export function nowMs(): number {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch {}
  return Date.now();
}

function random32Hex(): string {
  try {
    const c = (globalThis as any)?.crypto;
    if (c && typeof c.randomUUID === "function") {
      return String(c.randomUUID()).replace(/-/g, "").slice(0, 32);
    }
  } catch {}
  let out = "";
  while (out.length < 32) out += Math.random().toString(16).slice(2);
  return out.slice(0, 32);
}

/**
 * New stable run id: 32 lowercase hex chars (crypto.randomUUID, no dashes) (Q-42).
 * Opaque lineage token attached via `(metadata as any).runId`.
 */
export function newRunId(): string {
  return random32Hex();
}

/**
 * New stable turn id: 32 lowercase hex chars (crypto.randomUUID, no dashes) (Q-42).
 * Opaque lineage token attached via `(metadata as any).turnId`.
 */
export function newTurnId(): string {
  return random32Hex();
}

/**
 * Single canonical prompt preview (Q-49): merges the former
 * `previewPrompt` (agent.ts) / `steerPreview` (loop.ts) duplicates.
 * Bounded to 500 chars, display-only. Other modules own their copies;
 * new code should import this one.
 *
 * @example `previewPrompt("hello")`
 */
export function previewPrompt(prompt: string | ContentPart[]): string {
  if (typeof prompt === "string") return prompt.slice(0, 500);
  try {
    const texts = (prompt as ContentPart[])
      .filter((p) => (p as { type?: unknown }).type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("\n");
    return (texts || "[multipart]").slice(0, 500);
  } catch {
    return "[multipart]";
  }
}

/** Parsed model reference returned by {@link parseModelRef} (Q-48). */
export interface ParsedModelRef {
  provider: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  thinking?: ThinkingLevel;
}

function splitModelString(raw: string): { provider: string; modelId: string } {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return { provider: "openrouter", modelId: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash).toLowerCase(),
    modelId: trimmed.slice(slash + 1),
  };
}

function isModelProviderInstance(v: unknown): v is ModelProviderInstance {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r["model"] === "string" && (r["model"] as string).length > 0;
}

function isModelSpec(v: unknown): v is ModelSpec {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r["provider"] === "string" && typeof r["id"] === "string";
}

/**
 * Single model-ref parser (Q-48). Table-driven, no env sniffing:
 * - string `"provider/model"` → split on first `/`; bare ids default to `openrouter`.
 * - `ModelProviderInstance` (`{ model, apiKey?, baseUrl?, thinkingLevel? }`) → parse `model`, passthrough creds.
 * - `ModelSpec` (`{ provider, id }`) → direct mapping.
 *
 * @example `parseModelRef("google/gemini-3.5-flash-lite")`
 */
export function parseModelRef(input: string | ModelSpec | ModelProviderInstance): ParsedModelRef {
  if (typeof input === "string") {
    if (!input.trim()) throw new ConfigError("parseModelRef: model string must be non-empty.");
    const { provider, modelId } = splitModelString(input);
    return { provider, modelId };
  }
  if (isModelProviderInstance(input)) {
    const { provider, modelId } = splitModelString(input.model);
    const out: ParsedModelRef = { provider, modelId };
    if (input.apiKey !== undefined) out.apiKey = input.apiKey;
    if (input.baseUrl !== undefined) out.baseUrl = input.baseUrl;
    if (input.thinkingLevel !== undefined) out.thinking = input.thinkingLevel;
    return out;
  }
  if (isModelSpec(input)) {
    return { provider: String(input.provider), modelId: String(input.id) };
  }
  throw new ConfigError("parseModelRef: expected string | ModelSpec | ModelProviderInstance.");
}

/** Validated, readonly agent configuration returned by {@link resolveAgentConfig} (Q-32). */
export interface ResolvedAgentConfig {
  readonly model: NonNullable<AgentConfig["model"]>;
  readonly thinkingLevel?: ThinkingLevel;
  readonly maxTurns: number;
  readonly midSession: { readonly mode: MidSessionMode; readonly maxQueued: number };
  readonly toolNames: readonly string[];
}

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "none",
  "dynamic",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const VALID_MIDSESSION_MODES: readonly MidSessionMode[] = ["steer", "queue", "auto"];

/** Local name normalization mirroring `normalizeToolName` (no import cycle, Q-32). */
function normalizeConfigToolName(name: string): string {
  return name
    .trim()
    .replace(/^(?:functions?|tools?)\./i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

/**
 * Single config resolution (Q-32). Validates `model`, `thinkingLevel`,
 * `maxTurns`, `midSession`, and tool-name collisions, collecting EVERY issue
 * and throwing one `ConfigError` listing all of them. Not wired into `Agent`
 * (other owner) — call it from setup paths that want fail-fast validation.
 *
 * @example `const cfg = resolveAgentConfig({ model, maxTurns: 10 });`
 */
export function resolveAgentConfig(config: AgentConfig): Readonly<ResolvedAgentConfig> {
  const issues: string[] = [];
  const cfg = (config ?? {}) as AgentConfig;

  let model: NonNullable<AgentConfig["model"]> | undefined;
  const rawModel = cfg.model;
  if (typeof rawModel === "string") {
    if (rawModel.trim()) model = rawModel;
    else issues.push("model: must be a non-empty string | ModelSpec | ModelProviderInstance.");
  } else if (rawModel && typeof rawModel === "object") {
    model = rawModel as NonNullable<AgentConfig["model"]>;
  } else {
    issues.push("model: is required (string | ModelSpec | ModelProviderInstance).");
  }

  let thinkingLevel: ThinkingLevel | undefined;
  if (cfg.thinkingLevel !== undefined) {
    if ((VALID_THINKING_LEVELS as readonly string[]).includes(cfg.thinkingLevel)) {
      thinkingLevel = cfg.thinkingLevel;
    } else {
      issues.push(
        `thinkingLevel: invalid '${cfg.thinkingLevel}'. Expected one of: ${VALID_THINKING_LEVELS.join(", ")}.`
      );
    }
  }

  let maxTurns = Infinity;
  if (cfg.maxTurns !== undefined) {
    const m = cfg.maxTurns;
    if (m === 0) {
      maxTurns = Infinity;
    } else if (m === Infinity) {
      maxTurns = Infinity;
    } else if (typeof m === "number" && Number.isFinite(m) && m >= 1) {
      maxTurns = Math.floor(m);
    } else {
      issues.push(`maxTurns: must be finite >= 1 or Infinity (0/omitted means unlimited). Received: ${String(m)}.`);
    }
  }

  let mode: MidSessionMode = "auto";
  if (cfg.midSession?.mode !== undefined) {
    if ((VALID_MIDSESSION_MODES as readonly string[]).includes(cfg.midSession.mode as string)) {
      mode = cfg.midSession.mode as MidSessionMode;
    } else {
      issues.push(
        `midSession.mode: invalid '${String(cfg.midSession.mode)}'. Expected one of: ${VALID_MIDSESSION_MODES.join(", ")}.`
      );
    }
  }
  let maxQueued = 20;
  if (cfg.midSession?.maxQueued !== undefined) {
    const q = cfg.midSession.maxQueued;
    if (typeof q === "number" && Number.isFinite(q) && Math.floor(q) === q && q >= 0) {
      maxQueued = q;
    } else {
      issues.push(`midSession.maxQueued: must be an integer >= 0. Received: ${String(q)}.`);
    }
  }

  const toolNames: string[] = [];
  const tools = cfg.tools;
  if (tools !== undefined) {
    const entries: Array<[string, string]> = [];
    if (Array.isArray(tools)) {
      for (const def of tools) {
        const declared = (def as { name?: unknown })?.name;
        if (typeof declared === "string" && declared.trim()) {
          toolNames.push(declared);
          entries.push([declared, declared]);
        } else {
          issues.push("tools: array entries must declare a non-empty `name`.");
        }
      }
    } else if (tools && typeof tools === "object") {
      for (const [key, def] of Object.entries(tools)) {
        toolNames.push(key);
        const declared = (def as { name?: unknown })?.name;
        entries.push([key, typeof declared === "string" && declared ? declared : key]);
      }
    } else {
      issues.push("tools: must be a record or array of ToolDefinitions.");
    }
    const seen = new Map<string, string>();
    for (const [key, declared] of entries) {
      for (const candidate of new Set([key, declared])) {
        const normalized = normalizeConfigToolName(String(candidate));
        const prev = seen.get(normalized);
        if (prev !== undefined && prev !== key) {
          issues.push(
            `tools: name collision: '${prev}' and '${key}' both normalize to '${normalized}'. Rename one tool.`
          );
        } else if (prev === undefined) {
          seen.set(normalized, key);
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new ConfigError(`Invalid Agent config (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${issues.join(" ")}`);
  }
  return {
    model: model as NonNullable<AgentConfig["model"]>,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    maxTurns,
    midSession: { mode, maxQueued },
    toolNames,
  };
}
