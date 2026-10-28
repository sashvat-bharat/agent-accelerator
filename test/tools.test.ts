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

describe("truncated-argument marker vs. a real `raw` parameter", () => {
  it("executes a tool whose only parameter is named `raw`, and still refuses truncated streams", async () => {
    const { executeToolCalls, tool, z, parseStreamedToolArguments } = await import("../src/index.ts");
    const { isTruncatedToolCall } = await import("../src/tools/executor.ts");
    let ran: unknown;
    const run_shell = tool({
      description: "Runs a command",
      input: z.object({ raw: z.string() }),
      execute: async ({ raw }) => {
        ran = raw;
        return "done";
      },
    });
    const ok = await executeToolCalls({
      tools: { run_shell },
      toolCalls: [{ id: "c1", name: "run_shell", arguments: { raw: "ls -la" } }],
    });
    expect(ok[0]!.isError).toBe(false);
    expect(ran).toBe("ls -la");

    const truncatedArgs = parseStreamedToolArguments('{"raw": "ls -', "");
    expect(isTruncatedToolCall({ id: "c2", name: "run_shell", arguments: truncatedArgs })).toBe(true);
    const bad = await executeToolCalls({
      tools: { run_shell },
      toolCalls: [{ id: "c2", name: "run_shell", arguments: truncatedArgs }],
    });
    expect(bad[0]!.isError).toBe(true);
    expect(String(bad[0]!.result)).toContain("truncated");
    expect(ran).toBe("ls -la"); // not executed again
  });
});

describe("tool result hygiene", () => {
  const run = async (execute: () => unknown, extra: object = {}) => {
    const t = tool({ description: "t", input: z.object({}), execute: execute as any, ...extra });
    const [r] = await executeToolCalls({ tools: { t }, toolCalls: [{ id: "c", name: "t", arguments: {} }] });
    return r!;
  };

  it("caps oversized STRUCTURED results (not just strings) with the usual marker", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `row-${i}` }));
    const r = await run(() => rows);
    expect(r.isError).toBe(false);
    expect(typeof r.result).toBe("string");
    expect((r.result as string).length).toBeLessThan(20_100);
    expect(r.result as string).toContain("[Truncated: showing 20000 of");
  });

  it("honors a per-tool maxResultChars for structured results, and leaves small objects as objects", async () => {
    const small = await run(() => ({ ok: true, items: [1, 2, 3] }));
    expect(small.result).toEqual({ ok: true, items: [1, 2, 3] });
    const capped = await run(() => ({ blob: "x".repeat(500) }), { maxResultChars: 100 });
    expect(typeof capped.result).toBe("string");
    expect(capped.result as string).toContain("[Truncated: showing 100 of");
  });

  it("strips stacks and absolute paths from errors nested anywhere in a result", async () => {
    const boom = new Error("failed reading /home/deploy/app/secrets.env");
    const r = await run(() => ({ status: "partial", errors: [{ source: "db", error: boom }] }));
    const text = JSON.stringify(r.result);
    expect(text).not.toContain("/home/deploy");
    expect(text).not.toContain("secrets.env");
    expect(text).not.toContain('"stack"');
    expect(text).toContain("[redacted-path]");
    expect((r.result as any).errors[0].error.name).toBe("Error");
  });
});

describe("tool-name collisions fail at construction", () => {
  it("throws ConfigError from `new Agent` instead of failing mid-run", async () => {
    const { Agent, ConfigError } = await import("../src/index.ts");
    const mk = () => tool({ description: "d", input: z.object({}), execute: async () => "x" });
    expect(() => new Agent({ model: "google/gemini-3.5-flash-lite", apiKey: "k", tools: { getUser: mk(), get_user: mk() } })).toThrow(ConfigError);
    expect(() => new Agent({ model: "google/gemini-3.5-flash-lite", apiKey: "k", tools: { getUser: mk(), other: mk() } })).not.toThrow();
  });
});

describe("tool failure trace and partial progress", () => {
  const collect = async (defn: ReturnType<typeof tool>, args: Record<string, unknown> = {}) => {
    const { telemetryBus } = await import("../src/index.ts");
    const events: Array<{ code: string; data: any }> = [];
    const off = telemetryBus.onEvent((e) => { if (e.code.startsWith("tool.")) events.push({ code: e.code, data: e.data }); });
    try {
      const [r] = await executeToolCalls({
        tools: { t: defn },
        toolCalls: [{ id: "c1", name: "t", arguments: args }],
        agentName: "mailer",
        sessionId: "s1",
      });
      return { r: r!, events };
    } finally {
      off();
    }
  };

  it("reports what finished before the failure (4 of 5 mails) and traces every phase", async () => {
    const sendMails = tool({
      name: "t",
      description: "send mails",
      input: z.object({}),
      execute: async (_a, ctx) => {
        const sent: string[] = [];
        for (const to of ["a", "b", "c", "d", "e"]) {
          if (to === "e") throw Object.assign(new Error("SMTP 550 mailbox unavailable"), { code: "EMAIL_REJECTED", status: 550 });
          sent.push(to);
          ctx.emit?.({ type: "progress", sent: [...sent], remaining: ["e"] });
        }
      },
    });
    const { r, events } = await collect(sendMails);
    expect(r.isError).toBe(true);
    const text = String(r.result);
    expect(text.startsWith("Error executing t: SMTP 550 mailbox unavailable\n")).toBe(true);
    const details = JSON.parse(text.split("\n")[1]!);
    expect(details.error).toEqual({ name: "Error", code: "EMAIL_REJECTED", status: 550 });
    expect(details.attempts).toBe(1);
    expect(details.progress.sent).toEqual(["a", "b", "c", "d"]);
    expect(details.hint).toContain("do not repeat");
    expect(events.map((e) => e.code)).toEqual([
      "tool.call_started", "tool.attempt_started",
      "tool.progress", "tool.progress", "tool.progress", "tool.progress",
      "tool.attempt_failed", "tool.call_failed",
    ]);
    const failed = events.at(-1)!.data;
    expect(failed.error.code).toBe("EMAIL_REJECTED");
    expect(failed.error.stack).toContain("SMTP 550");
    expect(failed.progress.sent).toHaveLength(4);
    expect(failed.sessionId).toBe("s1");
    expect(failed.agentName).toBe("mailer");
  });

  it("prefers progress carried on the thrown ToolError", async () => {
    const { ToolError } = await import("../src/index.ts");
    const { r } = await collect(tool({
      name: "t", description: "d", input: z.object({}),
      execute: () => { throw new ToolError("halfway", { context: { progress: { done: 2 } } }); },
    }));
    expect(JSON.parse(String(r.result).split("\n")[1]!).progress).toEqual({ done: 2 });
  });

  it("marks timeouts, keeps the call_started trace, and redacts only credentials on the bus", async () => {
    const { r, events } = await collect(tool({
      name: "t", description: "d", input: z.object({}), timeoutMs: 10,
      execute: async () => { await new Promise((res) => setTimeout(res, 100)); },
    }));
    expect(JSON.parse(String(r.result).split("\n")[1]!).timedOut).toBe(true);
    expect(events.some((e) => e.code === "tool.call_timed_out")).toBe(true);

    const leak = await collect(tool({
      name: "t", description: "d", input: z.object({}),
      execute: () => { throw new Error("connect postgres://admin:hunter2@db/x failed reading /home/deploy/a.env"); },
    }));
    expect(String(leak.r.result)).not.toContain("hunter2");
    expect(String(leak.r.result)).toContain("[redacted-path]");
    const busMsg = leak.events.at(-1)!.data.error.message as string;
    expect(busMsg).not.toContain("hunter2");
    expect(busMsg).toContain("/home/deploy/a.env");
  });

  it("emits call_succeeded and call_blocked for the other outcomes", async () => {
    const ok = await collect(tool({ name: "t", description: "d", input: z.object({}), execute: () => "fine" }));
    expect(ok.events.map((e) => e.code)).toEqual(["tool.call_started", "tool.attempt_started", "tool.call_succeeded"]);
    const bad = await collect(tool({ name: "t", description: "d", input: z.object({ n: z.number() }), execute: () => 1 }), { n: "x" });
    expect(bad.events.map((e) => e.code)).toEqual(["tool.call_blocked"]);
    expect(bad.events[0]!.data.reason).toBe("schema_validation");
  });
});
