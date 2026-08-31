import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Skill } from "../types/skill.ts";
import type { ToolDefinition } from "../types/tool.ts";

export interface LoadSkillOptions {
  tools?: Record<string, ToolDefinition>;
}

/**
 * Parses markdown frontmatter YAML and body
 */
function parseMarkdownWithFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const frontmatter: Record<string, string> = {};
  let body = content;

  if (content.startsWith("---")) {
    const endIdx = content.indexOf("\n---", 3);
    if (endIdx !== -1) {
      const rawYaml = content.slice(3, endIdx).trim();
      body = content.slice(endIdx + 4).trim();

      const lines = rawYaml.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        // Find first colon not inside quotes
        let colonIdx = -1;
        let inSingle = false;
        let inDouble = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === "'" && !inDouble) inSingle = !inSingle;
          else if (ch === '"' && !inSingle) inDouble = !inDouble;
          else if (ch === ":" && !inSingle && !inDouble) { colonIdx = i; break; }
        }
        if (colonIdx !== -1) {
          const key = line.slice(0, colonIdx).trim();
          let val = line.slice(colonIdx + 1).trim();
          // Handle array like [a, b] or quoted string with colon inside
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          // Strip inline comments not inside quotes (simplistic)
          // Keep value as-is if it contains : inside quotes, already handled
          if (key) {
            frontmatter[key] = val;
          }
        }
      }
    }
  }

  return { frontmatter, body };
}

/**
 * Loads a Skill from a SKILL.md file or directory containing SKILL.md
 */
export async function loadSkill(
  filePathOrDir: string,
  options?: LoadSkillOptions
): Promise<Skill> {
  let targetPath = filePathOrDir;
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      targetPath = path.join(targetPath, "SKILL.md");
    }
  } catch (err) {
    if (!targetPath.endsWith(".md")) {
      targetPath = `${targetPath}/SKILL.md`;
    }
  }

  const content = await fs.readFile(targetPath, "utf-8");
  const { frontmatter, body } = parseMarkdownWithFrontmatter(content);

  const name = frontmatter.name || path.basename(path.dirname(targetPath)) || "Skill";
  const description = frontmatter.description || `Skill for ${name}`;

  return new Skill({
    name,
    description,
    instructions: body,
    tools: options?.tools ?? {},
    metadata: {
      name,
      description,
      version: frontmatter.version,
      author: frontmatter.author,
      ...frontmatter,
    },
  });
}
