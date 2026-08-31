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
});
