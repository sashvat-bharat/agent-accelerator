import { Agent } from "./agent.ts";
import type { AgentConfig } from "../types/agent.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { agentToTool } from "./delegation.ts";
import { getSubModel, getModel } from "../utils/env.ts";

export interface SubAgentConfig extends AgentConfig {}

/**
 * SubAgent is a specialized Agent designed for modular delegation,
 * evaluation, reviewing, or parallel task execution.
 *
 * It inherits 100% of the capabilities of Agent, defaults to SUB_AGENT_MODEL,
 * and provides .asTool() and .toTool() for seamless registration into parent agents.
 */
export class SubAgent extends Agent {
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
   */
  asTool(nameOverride?: string, descriptionOverride?: string): ToolDefinition {
    return agentToTool({
      name: nameOverride || this.name,
      description: descriptionOverride || this.description,
      agent: this,
    });
  }

  /**
   * Fluent alias for .asTool()
   */
  toTool(nameOverride?: string, descriptionOverride?: string): ToolDefinition {
    return this.asTool(nameOverride, descriptionOverride);
  }
}
