import { Agent } from "./agent.ts";
import type { AgentConfig } from "../types/agent.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { agentToTool } from "./delegation.ts";
import { resolveSubAgentModel } from "./worker.ts";
import { chosenModel, chosenSubAgentModel } from "../config/models.ts";

/** AgentConfig alias for a delegated worker agent. */
export interface SubAgentConfig extends AgentConfig {}

/**
 * Builds an `Agent` whose model is the saved choice or the program's default (see `setModels` / `setModel`) when the
 * caller names none. Explicit config always wins. The static
 * `Agent.fromEnv()` (attached below without touching `agent.ts`, owned by
 * another audit lane) delegates here.
 */
export function agentFromEnv(config?: Omit<AgentConfig, "model"> & { model?: AgentConfig["model"] }): Agent {
  return new Agent({
    ...config,
    model: config?.model ?? chosenModel() ?? chosenSubAgentModel(),
  } as AgentConfig);
}

/**
 * SubAgent is a specialized Agent designed for modular delegation,
 * evaluation, reviewing, or parallel task execution.
 *
 * @deprecated Prefer composing a plain `Agent` and exposing it via
 * `agentToTool()`/`buildAgentTools()` (or `subagents: [...]`) instead of
 * subclassing. `SubAgent` stays for compat and receives no new features.
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

// `Agent.fromEnv()` static without touching `agent.ts` (owned by
// another lane). Wired at module load; typed via the declaration below so
// `Agent.fromEnv({...})` typechecks wherever this module is imported.
declare module "./agent.ts" {
  namespace Agent {
    /**
     * Builds an `Agent` with the saved or default model (`setModels` / `setModel`) for omitted
     * fields. Explicit config always wins. See `agentFromEnv`.
     */
    function fromEnv(
      config?: Omit<import("../types/agent.ts").AgentConfig, "model"> & {
        model?: import("../types/agent.ts").AgentConfig["model"];
      }
    ): Agent;
  }
}

try {
  const Ctor = Agent as unknown as {
    fromEnv?: (config?: SubAgentConfig) => Agent;
  };
  if (typeof Ctor.fromEnv !== "function") {
    Ctor.fromEnv = (config?: SubAgentConfig) => agentFromEnv(config);
  }
} catch {
  // why: static attachment must never break module load (host may freeze Agent).
}
