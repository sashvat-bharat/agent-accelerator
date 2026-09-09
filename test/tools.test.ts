import { describe, it, expect } from "bun:test";
import { tool, toStandardToolDeclarations, zodToJsonSchema, executeToolCalls, z } from "../src/index.ts";

describe("Tools & Parallel Execution", () => {
  it("should convert Zod schemas to OpenAPI JSON Schema", () => {
    const testTool = tool({
      name: "calculate_sum",
      description: "Adds two numbers together",
      input: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      execute: ({ a, b }) => a + b,
    });

    const declarations = toStandardToolDeclarations([testTool]);
    expect(declarations.length).toBe(1);
    expect(declarations[0]!.name).toBe("calculate_sum");
    expect(declarations[0]!.description).toBe("Adds two numbers together");
    expect(declarations[0]!.parameters.type).toBe("object");
    expect((declarations[0]!.parameters.properties as any).a.type).toBe("number");
    expect((declarations[0]!.parameters.properties as any).b.type).toBe("number");
  });

  it("should execute tools correctly with schema validation", async () => {
    const userTool = tool({
      name: "get_user",
      description: "Gets user info",
      input: z.object({
        username: z.string(),
      }),
      execute: async ({ username }) => {
        return { username, role: "admin" };
      },
    });

    const results = await executeToolCalls({
      tools: { get_user: userTool },
      toolCalls: [
        {
          id: "call_1",
          name: "get_user",
          arguments: { username: "Alice" },
        },
      ],
    });

    expect(results.length).toBe(1);
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.result).toEqual({ username: "Alice", role: "admin" });
  });

  it("should execute multiple tool calls in parallel", async () => {
    const order: number[] = [];

    const toolA = tool({
      name: "task_a",
      description: "First task",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
        return "Done A";
      },
    });

    const toolB = tool({
      name: "task_b",
      description: "Second task",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(2);
        return "Done B";
      },
    });

    const results = await executeToolCalls({
      tools: { task_a: toolA, task_b: toolB },
      toolCalls: [
        { id: "call_a", name: "task_a", arguments: {} },
        { id: "call_b", name: "task_b", arguments: {} },
      ],
      parallel: true,
    });

    expect(results.length).toBe(2);
    expect(results[0]!.result).toBe("Done A");
    expect(results[1]!.result).toBe("Done B");
    // Tool B finishes faster than Tool A
    expect(order).toEqual([2, 1]);
  });

  it("should time out a tool when timeoutMs is positive", async () => {
    const slowTool = tool({
      name: "slow_tool",
      description: "Deliberately slow tool",
      timeoutMs: 10,
      execute: async (_input, ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(ctx.signal?.aborted).toBe(true);
        return "too late";
      },
    });

    const results = await executeToolCalls({
      tools: { slow_tool: slowTool },
      toolCalls: [{ id: "timeout", name: "slow_tool", arguments: {} }],
    });

    expect(results[0]!.isError).toBe(true);
    expect(String(results[0]!.result)).toContain("timed out after 10ms");
  });

  it("should report integer millisecond tool durations", async () => {
    const fastTool = tool({
      name: "fast_tool",
      description: "A fast tool",
      execute: () => "ok",
    });

    const results = await executeToolCalls({
      tools: { fast_tool: fastTool },
      toolCalls: [{ id: "integer_duration", name: "fast_tool", arguments: {} }],
    });

    expect(results[0]!.isError).toBe(false);
    expect(Number.isInteger(results[0]!.durationMs)).toBe(true);
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(1);
  });

  it("should retry transient failures up to maxTries", async () => {
    let attempts = 0;
    const flakyTool = tool({
      name: "flaky_tool",
      description: "Fails once with a transient error",
      maxTries: "2",
      execute: async () => {
        attempts++;
        if (attempts === 1) {
          const error: any = new Error("temporary outage");
          error.status = 503;
          throw error;
        }
        return "ok";
      },
    });

    const results = await executeToolCalls({
      tools: { flaky_tool: flakyTool },
      toolCalls: [{ id: "retry", name: "flaky_tool", arguments: {} }],
    });

    expect(attempts).toBe(2);
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.result).toBe("ok");
  });

  it("should recover namespace and camel-case tool names and suggest close names", async () => {
    const searchTool = tool({
      name: "web_search",
      description: "Searches the web",
      execute: async () => "found",
    });

    const recovered = await executeToolCalls({
      tools: { web_search: searchTool },
      toolCalls: [{ id: "alias", name: "functions.webSearch", arguments: {} }],
    });
    expect(recovered[0]!.isError).toBe(false);
    expect(recovered[0]!.name).toBe("web_search");

    const suggested = await executeToolCalls({
      tools: { web_search: searchTool },
      toolCalls: [{ id: "typo", name: "web_sarch", arguments: {} }],
    });
    expect(suggested[0]!.isError).toBe(true);
    expect(String(suggested[0]!.result)).toContain("Did you mean 'web_search'?");
  });

  it("should enforce per-tool concurrency limits", async () => {
    let active = 0;
    let peak = 0;
    const limitedTool = tool({
      name: "limited",
      description: "A concurrency-limited tool",
      maxConcurrency: 2,
      execute: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return "ok";
      },
    });

    const results = await executeToolCalls({
      tools: { limited: limitedTool },
      toolCalls: Array.from({ length: 6 }, (_, i) => ({ id: `limited_${i}`, name: "limited", arguments: {} })),
      parallel: true,
    });

    expect(results).toHaveLength(6);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(peak).toBe(2);
  });

  it("should safely serialize circular, bigint, error, and binary results", async () => {
    const circular: any = { label: "root" };
    circular.self = circular;
    const complexTool = tool({
      name: "complex",
      description: "Returns complex data",
      execute: async () => ({ circular, count: 2n, error: new Error("broken"), bytes: new Uint8Array([1, 2, 3]) }),
    });

    const results = await executeToolCalls({
      tools: { complex: complexTool },
      toolCalls: [{ id: "complex", name: "complex", arguments: {} }],
    });
    const result: any = results[0]!.result;
    expect(result.circular.self).toBe("[Circular]");
    expect(result.count).toBe("2n");
    expect(result.error.message).toBe("broken");
    expect(result.bytes.type).toBe("Uint8Array");
  });
});
