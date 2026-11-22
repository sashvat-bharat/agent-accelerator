/**
 * The hooks of an Agent (`AgentConfig.hooks`): the check done at construction and the two hooks the loops call
 * (`beforeRequest`, `onYield`). The two tool hooks (`beforeTool`, `afterTool`) run inside the executor.
 */
import type { AgentHooks, HookContext } from "../types/agent.ts";
import type { ContentPart, Message } from "../types/message.ts";
import { ConfigError } from "../types/errors.ts";
import { telemetryBus } from "../telemetry.ts";

const HOOK_NAMES = ["beforeTool", "afterTool", "beforeRequest", "onYield"] as const;

/** Checks `AgentConfig.hooks` (an object whose known keys are functions; an unknown key is a `ConfigError`) and returns a copy, or undefined when there are no hooks. */
export function resolveHooks(raw: unknown): AgentHooks | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new ConfigError(
      `[Agent Accelerator] Invalid hooks: expected an object like { beforeTool, afterTool, beforeRequest, onYield }.`
    );
  const out: Record<string, unknown> = {};
  for (const [key, fn] of Object.entries(raw)) {
    if (!(HOOK_NAMES as readonly string[]).includes(key))
      throw new ConfigError(`[Agent Accelerator] Unknown hook "${key}". Valid hooks: ${HOOK_NAMES.join(", ")}.`);
    if (fn === undefined) continue;
    if (typeof fn !== "function")
      throw new ConfigError(`[Agent Accelerator] Invalid hook "${key}": expected a function.`);
    out[key] = fn;
  }
  return Object.keys(out).length > 0 ? (out as AgentHooks) : undefined;
}

/** The context a hook gets for a model turn of a loop. */
export function hookContext(
  config: { agentName?: string; runOptions?: { sessionId?: string }; options?: { sessionId?: string } },
  signal: AbortSignal | undefined,
  turn: number
): HookContext {
  return {
    agentName: config.agentName,
    sessionId: config.runOptions?.sessionId || config.options?.sessionId,
    signal,
    turn,
  };
}

/** Runs `beforeRequest`: the messages (and system prompt) to send this turn, the run's own history untouched. The hook gets a shallow copy of the list; a returned `messages` must be an array. */
export async function applyBeforeRequest(
  hooks: AgentHooks | undefined,
  ctx: HookContext,
  context: { systemPrompt?: string; messages: Message[] }
): Promise<{ systemPrompt?: string; messages: Message[] }> {
  if (!hooks?.beforeRequest) return { systemPrompt: context.systemPrompt, messages: context.messages };
  const decision = await hooks.beforeRequest([...context.messages], ctx);
  if (!decision) return { systemPrompt: context.systemPrompt, messages: context.messages };
  if (decision.messages !== undefined && !Array.isArray(decision.messages))
    throw new ConfigError("[Agent Accelerator] The beforeRequest hook must return { messages: Message[] } (an array).");
  if (decision.systemPrompt !== undefined && typeof decision.systemPrompt !== "string")
    throw new ConfigError("[Agent Accelerator] The beforeRequest hook returned a systemPrompt that is not a string.");
  return {
    systemPrompt: decision.systemPrompt ?? context.systemPrompt,
    messages: decision.messages ?? context.messages,
  };
}

/** Runs `onYield` after a final answer: the user message to go on with, or undefined to end the run. */
export async function applyOnYield(
  hooks: AgentHooks | undefined,
  ctx: HookContext,
  turn: { text: string; thinking?: string; turns: number }
): Promise<string | ContentPart[] | undefined> {
  if (!hooks?.onYield) return undefined;
  const decision = await hooks.onYield(turn, ctx);
  if (!decision || decision.continue === undefined) return undefined;
  const next = decision.continue;
  if (!(typeof next === "string" ? next.trim() : Array.isArray(next) && next.length > 0))
    throw new ConfigError("[Agent Accelerator] The onYield hook must return { continue } with a non-empty message.");
  telemetryBus.emit({
    code: "agent.yield_continued",
    message: `[Agent Accelerator] onYield continued the run after turn ${turn.turns}.`,
    data: { agentName: ctx.agentName, sessionId: ctx.sessionId, turns: turn.turns },
  });
  return next;
}
