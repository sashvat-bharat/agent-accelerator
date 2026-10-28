/**
 * The two model-facing tools of scheduled actions: `scheduled_actions` (one
 * flat tool with a `command` field, a thin wrapper over the developer
 * functions) and `get_datetime`. The tool manual lives in
 * `scheduled-actions.md`, not in code.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Agent } from "../agent/agent.ts";
import { tool } from "../tools/tool.ts";
import { ToolError } from "../types/errors.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { ScheduledActionInput, ScheduledActionPatch } from "../types/scheduler.ts";
import {
  createScheduledAction,
  getScheduler,
  killScheduledAction,
  listScheduledActions,
  runScheduledAction,
  skipScheduledAction,
  updateScheduledAction,
  validateInput,
} from "./scheduler.ts";
import { readRun } from "./store.ts";
import { formatDatetime } from "./time.ts";

const COMMANDS = ["create", "list", "get", "update", "kill", "run_now", "skip"] as const;

let manual: string | undefined;
/** Read on first use (not at import), so a program that never enables scheduling never touches the file. */
function loadManual(): string {
  return (manual ??= readFileSync(new URL("./scheduled-actions.md", import.meta.url), "utf8"));
}

/** Returns the machine's local date and time. Exported for any agent; auto-registered with the scheduling tools. */
export const getDatetimeTool: ToolDefinition = tool({
  name: "get_datetime",
  description:
    'Returns the machine\'s current local date and time, e.g. "Monday, 26 October, 03:55:31 PM, 2026" (no timezone). Call it before scheduling anything.',
  input: z.object({}),
  repeatable: true,
  execute: () => formatDatetime(new Date()),
});

const scheduledActionSchema = z.object({
  name: z.string().optional().describe("Human label."),
  id: z.string().optional().describe("Lowercase kebab-case slug, max 48 chars (create only)."),
  timeToDeliver: z.string().optional().describe('"DD:HH:MM" - DD days from today, HH:MM on a 12-hour clock.'),
  meridiem: z.enum(["AM", "PM"]).optional(),
  startCookingInAdvance: z.string().optional().describe('Duration "DD:HH:MM" before delivery when the run starts.'),
  repeatEvery: z.string().optional().describe('Duration "DD:HH:MM" between deliveries. Omit to run once.'),
  retries: z.number().optional().describe("Extra attempts if a run fails."),
});

const describedId = "Full action id including its 6-character suffix (get, update, kill, run_now, skip).";

/** Builds the `scheduled_actions` tool for `agent`; its description is the manual with the worker pool filled in. */
export function createScheduledActionsTool(agent: Agent): ToolDefinition {
  const home = agent.home;
  const poolTools = agent.dynamicSubagents?.tools ?? {};
  const poolNames = Object.keys(poolTools);
  const example = (): string =>
    JSON.stringify({
      command: "create",
      instructions: "You write a short, sourced AI research brief.",
      task: "Summarize the most important AI news of the last day in 5 bullets.",
      ...(poolNames[0] ? { tools: [poolNames[0]] } : {}),
      scheduled_action: {
        name: "Daily AI Research Brief",
        id: "daily-ai-brief",
        timeToDeliver: "01:07:00",
        meridiem: "AM",
        startCookingInAdvance: "00:00:30",
        repeatEvery: "01:00:00",
      },
    });

  return tool({
    name: "scheduled_actions",
    description: loadManual().replace("{{TOOLS}}", poolNames.length > 0 ? poolNames.join(", ") : "none (omit tools)"),
    input: z.object({
      command: z.enum(COMMANDS),
      id: z.string().optional().describe(describedId),
      role: z.string().optional().describe("Short persona for the worker."),
      instructions: z.string().optional().describe("The worker's system prompt (create, update)."),
      task: z.string().optional().describe("The concrete assignment for every run (create, update)."),
      tools: z.array(z.string()).optional().describe(`Worker tools to grant, from: ${poolNames.join(", ") || "none"}.`),
      timeoutMs: z.number().optional().describe("Per-run time limit in ms (> 0)."),
      scheduled_action: scheduledActionSchema.optional(),
      force: z.boolean().optional().describe("kill: abort a run that is cooking. Ask the user first."),
      purge: z.boolean().optional().describe("kill: also delete past run files."),
    }),
    execute: async (a) => {
      const sa = a.scheduled_action ?? {};
      const needId = (): string => {
        const id = a.id ?? sa.id;
        if (!id) {
          throw new ToolError(`${a.command} needs "id" (the full id including its 6-character suffix; see list). Example: ${JSON.stringify({ command: a.command, id: "daily-ai-brief-d64aj2" })}`);
        }
        return id;
      };

      switch (a.command) {
        case "create": {
          const input = { role: a.role, instructions: a.instructions, task: a.task, tools: a.tools, timeoutMs: a.timeoutMs, scheduled_action: sa } as ScheduledActionInput;
          const problems = validateInput(input, poolTools, getScheduler(home).now(), { requireLead: true });
          if (problems.length > 0) {
            throw new ToolError(
              `create has ${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems.map((p, i) => `(${i + 1}) ${p}`).join(" ")} Valid example: ${example()}`
            );
          }
          return createScheduledAction(agent, input);
        }
        case "list":
          return listScheduledActions({ home });
        case "get": {
          const id = needId();
          const rec = listScheduledActions({ home }).find((t) => t.id === id);
          if (!rec) throw new ToolError(`No scheduled action with id "${id}". Use list to see the ids.`);
          const run = rec.lastRun ? readRun(home, rec.lastRun.file) : undefined;
          return { ...rec, ...(run ? { latestResult: run.body } : {}) };
        }
        case "update": {
          const id = needId();
          const { id: _ignored, ...schedule } = sa;
          const patch: ScheduledActionPatch = {
            role: a.role,
            instructions: a.instructions,
            task: a.task,
            tools: a.tools,
            timeoutMs: a.timeoutMs,
            scheduled_action: schedule,
          };
          const changes = [a.role, a.instructions, a.task, a.tools, a.timeoutMs, ...Object.values(schedule)];
          if (changes.every((v) => v === undefined)) {
            throw new ToolError(`update needs at least one field to change. Example: ${JSON.stringify({ command: "update", id, task: "The new assignment." })}`);
          }
          return updateScheduledAction(id, patch, { home });
        }
        case "kill":
          return killScheduledAction(needId(), { home, force: a.force, purge: a.purge });
        case "run_now":
          return runScheduledAction(needId(), { home });
        case "skip":
          return skipScheduledAction(needId(), { home });
        default:
          throw new ToolError(`Unknown command ${JSON.stringify((a as { command?: unknown }).command)}. Use one of: ${COMMANDS.join(", ")}.`);
      }
    },
  });
}
