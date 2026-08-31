import type { ToolDefinition } from "./tool.ts";

export interface SkillMetadata {
  name: string;
  description: string;
  version?: string;
  author?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface SkillDefinition {
  name: string;
  description: string;
  instructions?: string;
  tools?: Record<string, ToolDefinition> | ToolDefinition[];
  metadata?: SkillMetadata;
}

export class Skill {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tools: Record<string, ToolDefinition>;
  readonly metadata: SkillMetadata;

  constructor(definition: SkillDefinition) {
    this.name = definition.name;
    this.description = definition.description;
    this.instructions = definition.instructions ?? "";
    this.metadata = definition.metadata ?? {
      name: definition.name,
      description: definition.description,
    };

    if (Array.isArray(definition.tools)) {
      this.tools = {};
      for (const t of definition.tools) {
        if (t.name) {
          this.tools[t.name] = t;
        }
      }
    } else {
      this.tools = definition.tools ?? {};
    }
  }
}
