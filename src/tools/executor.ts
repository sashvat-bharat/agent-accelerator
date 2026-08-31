import type {
  ToolDefinition,
  ToolCallRecord,
  ToolResultRecord,
  ToolExecutionContext,
} from "../types/tool.ts";

export interface ExecuteToolsOptions {
  tools: Record<string, ToolDefinition>;
  toolCalls: ToolCallRecord[];
  agentName?: string;
  parallel?: boolean;
  signal?: AbortSignal;
}

/**
 * Executes one or more tool calls in parallel or sequence, handling errors safely
 */
export async function executeToolCalls(
  options: ExecuteToolsOptions
): Promise<ToolResultRecord[]> {
  const { tools, toolCalls, agentName, parallel = true, signal } = options;

  const runSingle = async (call: ToolCallRecord): Promise<ToolResultRecord> => {
    const startTime = Date.now();
    const toolDef = tools[call.name];

    if (!toolDef) {
      return {
        id: call.id,
        name: call.name,
        result: `Error: Tool '${call.name}' not found.`,
        isError: true,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      if (signal?.aborted) {
        throw new Error("Tool execution aborted");
      }

      const context: ToolExecutionContext = {
        toolCallId: call.id,
        agentName,
        signal,
      };

      // Validate input if Zod schema is provided
      let parsedInput = call.arguments;
      if (toolDef.input && typeof (toolDef.input as any).safeParse === "function") {
        const parseRes = (toolDef.input as any).safeParse(call.arguments);
        if (!parseRes.success) {
          return {
            id: call.id,
            name: call.name,
            result: `Schema validation error: ${parseRes.error.message}`,
            isError: true,
            durationMs: Date.now() - startTime,
          };
        }
        parsedInput = parseRes.data;
      }

      const rawResult = await toolDef.execute(parsedInput, context);

      return {
        id: call.id,
        name: call.name,
        result: rawResult !== undefined ? rawResult : "Success",
        isError: false,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        id: call.id,
        name: call.name,
        result: `Error executing ${call.name}: ${err?.message || String(err)}`,
        isError: true,
        durationMs: Date.now() - startTime,
      };
    }
  };

  if (parallel && toolCalls.length > 1) {
    const results = await Promise.all(toolCalls.map((tc) => runSingle(tc)));
    return results;
  }

  const results: ToolResultRecord[] = [];
  for (const tc of toolCalls) {
    results.push(await runSingle(tc));
  }
  return results;
}
