/**
 * The model-facing `subagents` tool: one flat tool with a `command` field (`spawn | message | close | list`), a thin
 * wrapper over `agent.workers`. The tool manual lives in `src/prompts/subagents-tool.md`, not in code. Results are plain text with one
 * header line naming the worker; the branded envelope under them carries usage and lineage to the loop.
 */
import { z } from "zod";
import type { Agent } from "./agent.ts";
import { tool } from "../tools/tool.ts";
import { makeSubagentResult } from "../tools/subagent-result.ts";
import { ValidationError } from "../types/errors.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { WorkerReply } from "./workers.ts";
import { fillPrompt, type Prompts } from "../prompts/prompts.ts";

const COMMANDS = ["spawn", "message", "close", "list"] as const;

// One worker reply as the model sees it: a header line naming the worker, then its text; in: a WorkerReply, out: the branded result.
function asResult(reply: WorkerReply, prompts: Prompts): ReturnType<typeof makeSubagentResult> {
  const text = reply.error
    ? fillPrompt(prompts.workerFailed, { id: reply.id, reason: reply.error })
    : fillPrompt(prompts.workerReplied, { id: reply.id, text: reply.text });
  return makeSubagentResult(text, [reply.metadata]);
}

/** Builds the `subagents` tool for `agent`; its description is the manual with the worker pool and the open-worker limit filled in. */
export function createSubagentsTool(agent: Agent): ToolDefinition {
  const poolNames = Object.keys(agent.dynamicSubagents?.tools ?? {});
  const max = agent.dynamicSubagents?.maxSpawn ?? Infinity;
  return tool({
    name: "subagents",
    description: fillPrompt(agent.prompts.subagentsTool, {
      LIMIT: Number.isFinite(max)
        ? `You can have at most ${max} open workers. Close the ones you are done with.`
        : "There is no limit on open workers. Close the ones you are done with: each one keeps its whole conversation.",
      TOOLS: poolNames.length > 0 ? poolNames.join(", ") : "none (omit tools)",
    }),
    input: z.object({
      command: z.enum(COMMANDS),
      id: z.string().optional().describe("The worker's full id (message, close)."),
      name: z.string().optional().describe('Short label for a new worker, e.g. "researcher" (spawn).'),
      role: z.string().optional().describe("Short persona for the worker (spawn)."),
      instructions: z.string().optional().describe("The worker's own system prompt (spawn)."),
      task: z.string().optional().describe("The assignment (spawn) or the next message to the worker (message)."),
      tools: z
        .array(z.string())
        .optional()
        .describe(`Worker tools to grant, from: ${poolNames.join(", ") || "none"} (spawn).`),
      history: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "How many of the first finished turns of this conversation to copy into the worker; 0 or omitted = none (spawn)."
        ),
    }),
    execute: async (a, ctx) => {
      const opts = { signal: ctx.signal, callId: ctx.toolCallId, onSubagentEvent: ctx.onSubagentEvent };
      const need = (field: "id" | "name" | "task"): string => {
        const value = a[field];
        if (!value?.trim()) {
          const example =
            a.command === "spawn"
              ? { command: "spawn", name: "researcher", task: "Do the work." }
              : { command: a.command, id: "researcher-1a2b3c4d", task: "Next question." };
          throw new ValidationError(`${a.command} needs "${field}". Example: ${JSON.stringify(example)}`);
        }
        return value;
      };
      try {
        switch (a.command) {
          case "spawn":
            return asResult(
              await agent.workers.spawn(
                {
                  name: need("name"),
                  role: a.role,
                  instructions: a.instructions,
                  task: need("task"),
                  tools: a.tools,
                  history: a.history,
                },
                opts
              ),
              agent.prompts
            );
          case "message":
            return asResult(await agent.workers.message(need("id"), need("task"), opts), agent.prompts);
          case "close":
            return `Worker ${agent.workers.close(need("id")).id} closed.`;
          case "list":
            return describeWorkers(agent);
        }
      } catch (err) {
        // A bad request is feedback for the model; anything else (budget, configuration) is a real failure.
        if (err instanceof ValidationError) return `Error: ${err.message}`;
        throw err;
      }
    },
  });
}

// The `list` answer: the open workers and the conversation turns `history` can copy; in: the agent's registry, out: plain text for the model.
function describeWorkers(agent: Agent): string {
  const workers = agent.workers.list();
  const turns = agent.workers.turns();
  const open =
    workers.length === 0
      ? "none"
      : workers
          .map(
            (w) =>
              `- ${w.id} (${w.name}${w.role ? `, ${w.role}` : ""}) tools: ${w.tools.join(", ") || "none"}${w.busy ? " [busy]" : ""}`
          )
          .join("\n");
  const copyable = turns.length === 0 ? "none yet" : turns.map((t) => `${t.n}. ${t.prompt}`).join("\n");
  return `Open workers:\n${open}\n\nFinished turns of this conversation (history: N copies turns 1 to N):\n${copyable}`;
}
