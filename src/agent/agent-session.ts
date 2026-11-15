/**
 * Restoring an Agent from a saved session snapshot (`Agent.importSession`): validates the messages, checks the models
 * against the allowed list, moves the agent to the snapshot's session folder and puts back its conversation, config,
 * traces, run marks and usage.
 */
import type { Agent } from "./agent.ts";
import type { ThinkingLevel } from "../types/core.ts";
import { SessionLoadError } from "../types/errors.ts";
import { assertModelAllowed } from "../config/models.ts";
import { resolveModelUnchecked } from "../providers/registry.ts";
import { unregisterSessionFolder } from "../telemetry-file.ts";
import { clearInteractionChains } from "../providers/google.ts";
import { clearSessionRouting } from "../providers.ts";
import { findInvalidMessage, telemetryBus, type PersistedAgentSession } from "../session/store.ts";
import { isLocalPathInput } from "../utils/safe-io.ts";
import type { SubAgentTrace } from "./delegation.ts";

// Throws ModelNotAllowedError when `model` resolves to a model outside the program's list (`setModels`); a model that cannot be resolved at all is left to the run, which reports it; in: the Agent constructor and importSessionInto, out: nothing or the error.
export function checkModelAllowed(model: unknown): void {
  if (!model) return;
  let resolved: ReturnType<typeof resolveModelUnchecked>;
  try {
    resolved = resolveModelUnchecked(model as string);
  } catch {
    return;
  }
  assertModelAllowed(resolved.provider.id, resolved.modelId);
}

/** A type with its `readonly` markers removed (the typed view the import assigns through). */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

// The loaded session may reference local files (`image: "/home/me/x.png"`) that the next turn would read and upload; without a `fileAccess.roots` policy that is silent, so warn once; in: importSessionInto, out: a `session.local_media_paths` event.
/**
 * A loaded session may reference local files (`image: "/home/me/x.png"`)
 * that the next turn would read and upload. Without a `fileAccess.roots`
 * policy that is silent, so surface it once on the telemetry bus.
 */
function warnOnLocalMediaPaths(agent: Agent, messages: ReadonlyArray<{ content?: unknown }>): void {
  if (agent.fileAccess?.roots) return; // enforced every turn by the loop
  const paths: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as Array<Record<string, unknown>>) {
      const key = ["image", "audio", "video", "file"].find((k) => k === part?.type);
      const value = key ? part[key] : undefined;
      if (isLocalPathInput(value) && !value.startsWith("media/")) paths.push(value);
    }
  }
  if (paths.length === 0) return;
  try {
    telemetryBus.emitWarning(
      "session.local_media_paths",
      `[Agent Accelerator] Imported session references ${paths.length} local file path(s) that will be read and sent to the provider on the next turn. Set fileAccess.roots to restrict them.`,
      { count: paths.length, examples: paths.slice(0, 3) }
    );
  } catch {}
}

export function importSessionInto(agent: Agent, data?: PersistedAgentSession | null): void {
  if (!data) return;
  const badIndex = findInvalidMessage(data.messages ?? []);
  if (badIndex !== -1) {
    throw new SessionLoadError(
      `[Agent Accelerator] Cannot import session: messages[${badIndex}] is not a valid message (expected role system|user|assistant|tool and string or part-array content).`
    );
  }
  warnOnLocalMediaPaths(agent, data.messages ?? []);
  checkModelAllowed(data.model); // an imported session may not smuggle in a model outside the list
  checkModelAllowed(data.subagentModel);
  const prevSid = agent.sessionId;
  const self: Writable<Agent> = agent; // the restored fields are read-only for callers; this typed view lets the import assign them
  if (data.sessionId) self.sessionId = data.sessionId;
  if (agent.sessionId !== prevSid) {
    try {
      agent.lockSessionFolder();
    } catch (err) {
      self.sessionId = prevSid; // the session belongs to another process: keep ours untouched
      throw err;
    }
    unregisterSessionFolder(prevSid);
    agent.registerTelemetryFolder();
  }
  if (data.parentSessionId) agent.parentSessionId = data.parentSessionId;
  if (data.subagents && typeof data.subagents === "object") {
    try {
      agent.subagentTraces = JSON.parse(JSON.stringify(data.subagents));
    } catch {
      agent.subagentTraces = { ...data.subagents } as unknown as Record<string, SubAgentTrace>;
    }
  }
  if (data.model) self.modelStringOrSpec = data.model;
  if (data.thinkingLevel) {
    const lvl = String(data.thinkingLevel) as ThinkingLevel;
    self.thinkingConfig =
      lvl === "none"
        ? { enabled: false, level: "none", budgetTokens: 0 }
        : lvl === "dynamic"
          ? { enabled: true, level: "dynamic", budgetTokens: -1 }
          : { enabled: true, level: lvl };
  }
  if (typeof data.instructions === "string") agent.instructions = data.instructions;
  if (data.cache) self.cache = data.cache;
  if (data.subagentModel) {
    self.subagentModel = data.subagentModel;
    const dyn = agent.dynamicSubagents;
    if (dyn) dyn.model = data.subagentModel;
  }
  try {
    agent.context.messages = Array.isArray(data.messages)
      ? typeof structuredClone === "function"
        ? structuredClone(data.messages)
        : JSON.parse(JSON.stringify(data.messages))
      : [];
  } catch {
    agent.context.messages = Array.isArray(data.messages) ? [...data.messages] : [];
  }
  agent.context.thoughtSignatures = [];
  agent.runMarks.splice(
    0,
    agent.runMarks.length,
    ...(data.runs ?? []).filter((r) => r.i < agent.context.messages.length)
  );
  agent.restoreUsage(data.usage);
  if (data.systemPrompt) {
    agent.context.systemPrompt = data.systemPrompt;
  } else {
    agent.context.systemPrompt = agent.getFullInstructions();
  }
  // Importing a snapshot invalidates prior provider chaining/routing
  // for both the previous and the restored session.
  try {
    clearInteractionChains(prevSid);
  } catch {}
  try {
    clearSessionRouting(prevSid);
  } catch {}
  try {
    clearInteractionChains(agent.sessionId);
  } catch {}
  try {
    clearSessionRouting(agent.sessionId);
  } catch {}
}
