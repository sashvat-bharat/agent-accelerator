import { Agent } from "./agent.ts";
import type { AgentConfig } from "../types/agent.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { agentToTool } from "./delegation.ts";
import { getSubModel, getModel } from "../utils/env.ts";

/** AgentConfig alias for a delegated worker agent. */
export interface SubAgentConfig extends AgentConfig {}

/**
 * Canonical env-based construction (Q-56): builds an `Agent` reading
 * `MODEL`/`SUB_AGENT_MODEL` only for the fields the caller omits, via
 * `getModel()`/`getSubModel()`. Explicit config always wins; constructing an
 * `Agent` with an explicit `model` reads no env for routing. The static
 * `Agent.fromEnv()` (attached below without touching `agent.ts`, owned by
 * another audit lane) delegates here.
 */
export function agentFromEnv(
  config?: Omit<AgentConfig, "model"> & { model?: AgentConfig["model"] }
): Agent {
  return new Agent({
    ...config,
    model: config?.model ?? getModel() ?? getSubModel(),
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
 * It inherits 100% of the capabilities of Agent, defaults to SUB_AGENT_MODEL,
 * and provides .asTool() and .toTool() for seamless registration into parent agents.
 *
 * Model fallback chain (Q-56, canonical): explicit `config.model` ??
 * `SUB_AGENT_MODEL` (`getSubModel()`) ?? `MODEL` (`getModel()`). Missing
 * everything throws. Constructing any `Agent`/`SubAgent` with an explicit
 * `model` reads no env for routing.
 *
 * Q-47 decomposition boundary: this class stays a thin wrapper. The run/stream
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
   * Creates a delegated worker, defaulting to `SUB_AGENT_MODEL` or `MODEL`
   * when `model` is omitted, and retaining short-lived cache state by default.
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
    const resolvedModel =
      config.model ??
      getSubModel() ??
      getModel();

    if (!resolvedModel) {
      throw new Error(
        `[Agent Accelerator] SubAgent '${config.name || "subagent"}' requires a model. ` +
        `Specify 'model' in SubAgent config, or set SUB_AGENT_MODEL or MODEL in environment variables.`
      );
    }

    super({
      ...config,
      model: resolvedModel,
      cache: config.cache ?? { retention: "short" },
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

// Q-56: `Agent.fromEnv()` static without touching `agent.ts` (owned by
// another lane). Wired at module load; typed via the declaration below so
// `Agent.fromEnv({...})` typechecks wherever this module is imported.
declare module "./agent.ts" {
  namespace Agent {
    /**
     * Builds an `Agent` from env (`MODEL`/`SUB_AGENT_MODEL`) for omitted
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
