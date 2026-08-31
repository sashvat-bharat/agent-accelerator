import { Skill, type SkillDefinition } from "../types/skill.ts";

/**
 * Defines a new Skill with instructions and tools
 */
export function defineSkill(definition: SkillDefinition): Skill {
  return new Skill(definition);
}
