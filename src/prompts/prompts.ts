/**
 * The prompts the SDK itself puts in front of the model, kept as `.md` files in this folder so they can be read,
 * copied and replaced. `DEFAULT_PROMPTS` holds the shipped text; `AgentConfig.prompts` overrides single entries per
 * Agent. Keeping the original is recommended: it is what the SDK was tested with, and a good starting point (and the
 * reference) for writing your own. `{{name}}` marks a value the SDK fills in at use time.
 */
import { readFileSync } from "node:fs";
import { ConfigError } from "../types/errors.ts";

/** One entry per prompt file: its public name and the file that holds the default text. */
const FILES = {
  reasoningDirective: "reasoning-directive.md",
  structuredOutput: "structured-output.md",
  additionalContext: "additional-context.md",
  toolBridge: "tool-bridge.md",
  toolTruncatedArguments: "tool-truncated-arguments.md",
  toolNotFound: "tool-not-found.md",
  toolSchemaError: "tool-schema-error.md",
  toolRepeatBlocked: "tool-repeat-blocked.md",
  toolInterrupted: "tool-interrupted.md",
  workerReplied: "worker-replied.md",
  workerFailed: "worker-failed.md",
  subagentsTool: "subagents-tool.md",
  scheduledActionsTool: "scheduled-actions-tool.md",
} as const;

/** The name of one SDK prompt (see `DEFAULT_PROMPTS`). */
export type PromptName = keyof typeof FILES;

/** The text of every prompt, by name. */
export type Prompts = Record<PromptName, string>;

/** Per-Agent replacements for single prompts (`AgentConfig.prompts`); every other prompt keeps its default. */
export type PromptOverrides = Partial<Prompts>;

// Reads one prompt file without its final newline; in: DEFAULT_PROMPTS at load, out: the default text.
function readPrompt(file: string): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), "utf8").replace(/\n$/, "");
}

/**
 * The prompts as shipped. Placeholders (`{{name}}`) are filled in by the SDK: `reasoningDirective` none;
 * `structuredOutput` `{{schema}}`; `additionalContext` `{{context}}`; `toolTruncatedArguments`, `toolRepeatBlocked`
 * `{{tool}}`; `toolNotFound` `{{tool}}`, `{{suggestion}}`; `toolSchemaError` `{{tool}}`, `{{detail}}`, `{{keys}}`,
 * `{{expected}}`; `toolInterrupted` `{{tool}}`, `{{id}}`; `workerReplied` `{{id}}`, `{{text}}`; `workerFailed` `{{id}}`,
 * `{{reason}}`; `subagentsTool` `{{TOOLS}}`, `{{LIMIT}}`; `scheduledActionsTool` `{{TOOLS}}`.
 */
export const DEFAULT_PROMPTS: Readonly<Prompts> = Object.freeze(
  Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, readPrompt(file)])) as Prompts
);

/** Defaults with `overrides` applied. Throws a `ConfigError` for an unknown name or an empty or non-string text. */
export function resolvePrompts(overrides?: PromptOverrides): Prompts {
  const out: Prompts = { ...DEFAULT_PROMPTS };
  if (overrides === undefined) return out;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new ConfigError(
      '[Agent Accelerator] Invalid prompts: expected an object like { reasoningDirective: "..." } (see DEFAULT_PROMPTS for the names).'
    );
  }
  for (const [name, text] of Object.entries(overrides)) {
    if (text === undefined) continue;
    if (!Object.hasOwn(FILES, name)) {
      throw new ConfigError(
        `[Agent Accelerator] Unknown prompt "${name}". Valid names: ${Object.keys(FILES).join(", ")}.`
      );
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new ConfigError(`[Agent Accelerator] Invalid prompt "${name}": expected a non-empty string.`);
    }
    out[name as PromptName] = text;
  }
  return out;
}

/** Fills `{{name}}` markers in a prompt from `values`; a marker with no value is left as written. */
export function fillPrompt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole
  );
}
