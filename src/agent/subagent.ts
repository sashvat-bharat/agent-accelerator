import { Agent } from "./agent.ts";
import type { AgentConfig } from "../types/agent.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { agentToTool } from "./delegation.ts";
import { resolveSubAgentModel } from "./worker.ts";

/** AgentConfig alias for a delegated worker agent. */
export interface SubAgentConfig extends AgentConfig {}

/** Builds an `Agent` whose model is the saved choice or the program's default when the caller names none; the same as `Agent.fromEnv`. */
export function agentFromEnv(config?: Omit<AgentConfig, "model"> & { model?: AgentConfig["model"] }): Agent {
  return Agent.fromEnv(config);
}

/**
 * SubAgent is a specialized Agent designed for modular delegation,
 * evaluation, reviewing, or parallel task execution.
 *
 * A thin wrapper that receives no new features: a plain `Agent` exposed via `agentToTool()`/`buildAgentTools()` (or
 * `subagents: [...]`) does the same without subclassing.
 *
 * It inherits 100% of the capabilities of Agent, defaults to the saved or default worker model,
 * and provides .asTool() and .toTool() for seamless registration into parent agents.
 *
 * Model fallback chain (canonical): explicit `config.model` ??
 * saved or default worker model ?? saved or default main model. Missing
 * everything throws. Constructing any `Agent`/`SubAgent` with an explicit
 * `model` reads no env for routing.
 *
 * Decomposition boundary: this class stays a thin wrapper. The run/stream
 * loops live in `agent.ts`/`loop.ts`, spawning in `delegation.ts`
 * (`agentToTool`), and model parsing in `utils/session.ts` (`parseModelRef`).
 * No loop, transport, or formatting logic is duplicated here.
 *
 * @example
 * ```ts
 * const researcher = new SubAgent({
 *   name: "researcher",
 *   model: "google/gemini-3.5-flash-lite",
 *   instructions: "Return only sourced findings.",
 * });
 * const lead = new Agent({ model, subagents: [researcher] });
 * ```
 */
export class SubAgent extends Agent {
  /**
   * Creates a delegated worker, defaulting to the saved or default worker / main model
   * when `model` is omitted.
   *
   * @param config Worker configuration. It accepts the same options as `Agent`
   * and can be registered with a parent via `subagents`.
   *
   * @example
   * ```ts
   * const researcher = new SubAgent({
   *   name: "researcher",
   *   model: "google/gemini-3.5-flash-lite",
   *   instructions: "Return only sourced findings.",
   * });
   *
   * const lead = new Agent({ model, subagents: [researcher] });
   * const result = await researcher.run("Find the relevant facts");
   * ```
   */
  constructor(config: SubAgentConfig) {
    // Unified model chain (shared with Agent): explicit > saved or default worker model > saved or default main model.
    const resolvedModel = resolveSubAgentModel(config);

    super({
      ...config,
      model: resolvedModel,
    });
  }

  /**
   * Converts this SubAgent instance into a standard ToolDefinition for parent agent tool execution.
   * @example `const research = researcher.asTool("research");`
   */
  asTool(nameOverride?: string, descriptionOverride?: string): ToolDefinition {
    return agentToTool({
      name: nameOverride || this.name,
      description: descriptionOverride || this.description,
      agent: this,
    });
  }

  /** Fluent alias for `.asTool()`. @example `const research = researcher.toTool();` */
  toTool(nameOverride?: string, descriptionOverride?: string): ToolDefinition {
    return this.asTool(nameOverride, descriptionOverride);
  }
}
