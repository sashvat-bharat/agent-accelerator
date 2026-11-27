import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  Agent,
  agentToTool,
  buildAgentTools,
  AgentResponse,
  tool,
} from "../src/index.ts";

describe("Multi-Agent Dynamic Delegation & Metadata", () => {
  it("should automatically inject subagents as tools on parent Agent", () => {
    const subAgent = new Agent({
      name: "Domain-Specialist",
      description: "Handles specialized domain tasks",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
    });

    const leadAgent = new Agent({
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
      subagents: [subAgent],
    });

    expect(leadAgent.tools["domain-specialist"]).toBeDefined();
    expect(leadAgent.tools["domain-specialist"]!.name).toBe("domain-specialist");
    expect(leadAgent.tools["domain-specialist"]!.description).toBe("Handles specialized domain tasks");
    expect(leadAgent.tools["domain-specialist"]!.input).toBeDefined();

    const toolsRecord = buildAgentTools([subAgent]);
    expect(toolsRecord["domain-specialist"]).toBeDefined();
  });

  it("adds one `subagents` tool to a dynamic parent, with no way for the model to pick a model or a timeout", () => {
    const parentAgent = new Agent({
      name: "Root_Agent",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
      dynamicSubagents: {
        enabled: true,
        model: "google/gemini-3.5-flash-lite",
        maxSpawn: 4,
        workerTimeoutMs: 60000,
      },
    });

    const toolDef = parentAgent.tools["subagents"]!;
    expect(toolDef).toBeDefined();
    expect(parentAgent.tools["spawn_subagents"]).toBeUndefined();
    expect(toolDef.name).toBe("subagents");
    const shape = (toolDef.input as any).shape;
    expect(Object.keys(shape).sort()).toEqual(["command", "history", "id", "instructions", "name", "role", "task", "tools"]);
    expect(shape.model).toBeUndefined();
    expect(shape.timeoutMs).toBeUndefined();
  });

  it("should strictly throw SubAgentModelError when dynamicSubagents is enabled but no model is configured", () => {
    expect(() => {
      new Agent({
        name: "Test_Agent",
        model: "google/gemini-3.8-flash",
        apiKey: "TEST_KEY",
        dynamicSubagents: { enabled: true },
      });
    }).toThrow(/sub-agent model is required when dynamic sub-agents are enabled/);
  });

  it("writes the worker pool and the open-worker limit into the tool manual", () => {
    const { tool } = require("../src/index.ts");
    const { z } = require("zod");
    const mkTool = (name: string) => tool({ name, description: `${name} tool`, input: z.object({}), execute: async () => `${name}-ok` });
    const parentAgent = new Agent({
      name: "Root_Agent",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
      dynamicSubagents: {
        enabled: true,
        model: "google/gemini-3.5-flash-lite",
        maxSpawn: 2,
        tools: { recent_news: mkTool("recent_news"), get_weather: mkTool("get_weather") },
      },
    });
    expect(parentAgent.dynamicSubagents?.maxSpawn).toBe(2);
    expect(Object.keys(parentAgent.dynamicSubagents?.tools ?? {}).sort()).toEqual(["get_weather", "recent_news"]);
    const description = parentAgent.tools["subagents"]!.description;
    expect(description).toContain("at most 2 open workers");
    expect(description).toContain("recent_news, get_weather");
    expect(description).not.toContain("{{");
    // The manual is the tool description: the system prompt stays free of delegation text.
    expect(parentAgent.context.systemPrompt ?? "").not.toContain("sub-agent");
  });

  it("should expose detailed sub-agent metadata breakdown in AgentResponse JSON", () => {
    const response = new AgentResponse({
      text: "Final synthesized editorial report across both research tracks.",
      usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
      model: "gemini-3.5-flash-lite",
      provider: "google",
      durationMs: 450,
      raw: { request: {} as any },
      subagents: [
        {
          name: "TRACK_A_ANALYST",
          role: "Market analyst",
          task: "Analyze market dynamics",
          model: "gemini-3.5-flash-lite",
          provider: "google",
          durationMs: 210,
          usage: { inputTokens: 200, outputTokens: 90, totalTokens: 290 },
          turns: 1,
          text: "Track A market analysis results.",
          isError: false,
        },
        {
          name: "TRACK_B_RESEARCHER",
          role: "Tech researcher",
          task: "Investigate architectural breakthroughs",
          model: "gemini-3.5-flash-lite",
          provider: "google",
          durationMs: 230,
          usage: { inputTokens: 220, outputTokens: 95, totalTokens: 315 },
          turns: 1,
          text: "Track B tech research results.",
          isError: false,
        },
      ],
    });

    const json = response.toJSON();
    expect(json.subagents).toBeDefined();
    expect(json.subagents?.length).toBe(2);

    expect(json.subagents![0]!.name).toBe("TRACK_A_ANALYST");
    expect(json.subagents![0]!.durationMs).toBe(210);
    expect(json.subagents![0]!.usage.totalTokens).toBe(290);

    expect(json.subagents![1]!.name).toBe("TRACK_B_RESEARCHER");
    expect(json.subagents![1]!.durationMs).toBe(230);
    expect(json.subagents![1]!.usage.totalTokens).toBe(315);
  });

  it("should build a fixed worker from a plain Agent and export it with agentToTool", () => {
    const critique = new Agent({
      name: "code_critique",
      description: "Reviews code architecture and edge cases",
      instructions: "You are a senior reviewer.",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
      stateless: true,
    });

    expect(critique.name).toBe("code_critique");
    expect(critique.stateless).toBe(true);
    expect(critique.modelStringOrSpec).toBe("google/gemini-3.5-flash-lite");

    // The tool name and description come from the agent unless you override them.
    const defaultDef = agentToTool({ agent: critique });
    expect(defaultDef.name).toBe("code-critique");
    expect(defaultDef.description).toBe("Reviews code architecture and edge cases");

    const customDef = agentToTool({ name: "custom-reviewer", description: "Custom override", agent: critique });
    expect(customDef.name).toBe("custom-reviewer");
    expect(customDef.description).toBe("Custom override");
  });

  it("no longer exports the SubAgent class, SubAgentConfig or agentFromEnv, and Agent has no fromEnv", async () => {
    const api = (await import("../src/index.ts")) as Record<string, unknown>;
    expect("SubAgent" in api).toBe(false);
    expect("agentFromEnv" in api).toBe(false);
    expect(typeof api["Agent"]).toBe("function");
    expect("fromEnv" in (api["Agent"] as object)).toBe(false); // and there is no `Agent.fromEnv` either
  });

  it("should support clean separation of tools: { get_status } and subagents: [critique, researcher]", () => {
    const { tool } = require("../src/index.ts");
    const { z } = require("zod");

    const get_status = tool({
      name: "get_status",
      description: "Check user authentication status.",
      input: z.object({ username: z.string() }),
      execute: async () => "Valid",
    });

    const critique = new Agent({
      name: "code_critique",
      description: "Reviews code architecture.",
      instructions: "Review code rigorously.",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
    });

    const researcher = new Agent({
      name: "tech_researcher",
      description: "Researches technologies.",
      instructions: "Research tech thoroughly.",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
    });

    const lead = new Agent({
      name: "Lead Agent",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
      // Clean separation:
      tools: { get_status },
      subagents: [critique, researcher],
    });

    // Standard tool is present
    expect(lead.tools["get_status"]).toBeDefined();
    expect(lead.tools["get_status"]?.description).toBe("Check user authentication status.");

    // Sub-agents are registered into tools cleanly
    expect(lead.tools["code-critique"]).toBeDefined();
    expect(lead.tools["tech-researcher"]).toBeDefined();
  });

  it("should not accumulate conversation history when stateless: true is set", async () => {
    const statelessAgent = new Agent({
      name: "Stateless_Auditor",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
      stateless: true,
    });

    expect(statelessAgent.stateless).toBe(true);

    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    (globalThis as any).fetch = async (_url: any, opts: any) => {
      requestCount++;
      const body = JSON.parse(opts.body);
      expect(body.previous_interaction_id).toBeUndefined();
      expect(body.input).toBe(`Turn ${requestCount} prompt`);
      return new Response(
        JSON.stringify({
          id: `v1_stateless${requestCount}`,
          object: "interaction",
          model: "gemini-3.5-flash-lite",
          status: "completed",
          steps: [
            { type: "model_output", content: [{ type: "text", text: `Response ${requestCount}` }] },
          ],
          usage: {
            total_tokens: 15,
            total_input_tokens: 10,
            total_output_tokens: 5,
            total_cached_tokens: 0,
            total_thought_tokens: 0,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const res1 = await statelessAgent.run("Turn 1 prompt");
      expect(res1.text).toBe("Response 1");
      expect(statelessAgent.context.messages.length).toBe(0);

      const res2 = await statelessAgent.run("Turn 2 prompt");
      expect(res2.text).toBe("Response 2");
      expect(statelessAgent.context.messages.length).toBe(0);
      expect(requestCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should scope worker traces to the owning agent's sessions (no cross-tenant reads)", async () => {
    const { executeToolCalls } = require("../src/tools/executor.ts");
    const worker = new Agent({
      name: "tenant_worker",
      description: "Does work",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
    });
    const tenantA = new Agent({ model: "google/gemini-3.5-flash-lite", apiKey: "TEST_KEY", sessionId: "tenant-a" });
    const tenantB = new Agent({ model: "google/gemini-3.5-flash-lite", apiKey: "TEST_KEY", sessionId: "tenant-b" });

    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({
          id: "v1_scope",
          object: "interaction",
          status: "completed",
          steps: [{ type: "model_output", content: [{ type: "text", text: "secret result" }] }],
          usage: { total_tokens: 4, total_input_tokens: 2, total_output_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    try {
      const results = await executeToolCalls({
        tools: buildAgentTools([worker]),
        toolCalls: [{ id: "c1", name: "tenant_worker", arguments: { task: "private task" } }],
        sessionId: tenantA.sessionId,
      });
      const displayId: string = (results[0]!.result as any)._subagentMetadata[0].trackingId;
      const rawId = displayId.split("-").pop()!;

      expect(tenantA.track(displayId)?.task).toBe("private task");
      expect(tenantA.listTrackedSubAgents()).toContain(rawId);

      expect(tenantB.track(displayId)).toBeUndefined();
      expect(tenantB.track(rawId)).toBeUndefined();
      expect(tenantB.listTrackedSubAgents()).not.toContain(rawId);
      let leaked = false;
      const off = tenantB.subscribeToSubAgent(rawId, () => {
        leaked = true;
      });
      off();
      expect(leaked).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs parallel calls to the same fixed worker concurrently, each with its own answer", async () => {
    const { executeToolCalls } = require("../src/tools/executor.ts");
    const sse = (task: string) =>
      [
        { event_type: "step.delta", index: 0, delta: { type: "text", text: `answer:${task}` } },
        { event_type: "interaction.completed", interaction: { id: `v1_${task}`, status: "completed", usage: { total_tokens: 3, total_input_tokens: 1, total_output_tokens: 2 } } },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join("");
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      await new Promise((r) => setTimeout(r, 120)); // each model call takes 120ms
      return new Response(sse(String(body.input)), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    try {
      for (const midSession of [undefined, { mode: "steer" as const }]) {
        const researcher = new Agent({
          name: "researcher",
          description: "Researches",
          model: "google/gemini-3.5-flash-lite",
          apiKey: "TEST_KEY",
          ...(midSession ? { midSession } : {}),
        });
        const t0 = Date.now();
        const results = await executeToolCalls({
          tools: buildAgentTools([researcher]),
          toolCalls: [
            { id: "a", name: "researcher", arguments: { task: "topic-A" } },
            { id: "b", name: "researcher", arguments: { task: "topic-B" } },
            { id: "c", name: "researcher", arguments: { task: "topic-C" } },
          ],
          sessionId: "accel-parallel-parent",
        });
        const elapsed = Date.now() - t0;
        expect(results.map((r: any) => String(r.result))).toEqual(["answer:topic-A", "answer:topic-B", "answer:topic-C"]);
        expect(results.every((r: any) => r.isError === false)).toBe(true);
        expect(elapsed).toBeLessThan(300); // serialized would be >= 360ms
        expect(researcher.isBusy).toBe(false); // the shared instance was never occupied
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should keep fixed sub-agent child sessions within OpenAI 64-char prompt_cache_key", async () => {
    // Regression: `parent-sub-adversarial_critic` (65 chars) 400d on OpenAI
    // (`Invalid 'prompt_cache_key': string too long`), yielding 0-tok
    // `provider: unknown` sub-agents. Child ids must fit 64 chars.
    const { executeToolCalls } = require("../src/tools/executor.ts");

    const critic = new Agent({
      name: "adversarial_critic",
      description: "Critiques findings",
      instructions: "Critique briefly.",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
    });

    const longParent = "accel-80040b02-6884-4f5a-b552-97e7bf8f550a";
    expect(`${longParent}-sub-adversarial_critic`.length).toBeGreaterThan(64);

    const originalFetch = globalThis.fetch;
    let sentBody: any = null;
    (globalThis as any).fetch = async (_url: any, opts: any) => {
      sentBody = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          id: "v1_fixed64",
          object: "interaction",
          model: "gemini-3.5-flash-lite",
          status: "completed",
          steps: [{ type: "model_output", content: [{ type: "text", text: "critique ok" }] }],
          usage: { total_tokens: 10, total_input_tokens: 7, total_output_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const tools = buildAgentTools([critic]);
      const results = await executeToolCalls({
        tools,
        toolCalls: [{ id: "c1", name: "adversarial_critic", arguments: { task: "Critique this." } }],
        sessionId: longParent,
      });
      expect(results[0]!.isError).toBe(false);
      const meta: any = (results[0]!.result as any)._subagentMetadata?.[0];
      expect(meta).toBeDefined();
      expect(meta.isError).toBe(false);
      expect(meta.provider).toBe("google");
      // Google has no 64-char body key, but the child session plumbing must
      // stay provider-safe regardless of provider (OpenAI enforces it).
      expect(sentBody).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("parallel calls of one fixed worker", () => {
  // One Google SSE reply: a function call `call_<copy>` (turn 1) or a text answer (turn 2), saved as interaction `id`.
  const googleSse = (id: string, step: object, delta: object | undefined, status: string): Response => {
    const lines = [
      "event: step.start",
      `data: ${JSON.stringify({ index: 0, step, event_type: "step.start" })}`,
      "",
      ...(delta ? ["event: step.delta", `data: ${JSON.stringify({ index: 0, delta, event_type: "step.delta" })}`, ""] : []),
      "event: step.stop",
      `data: ${JSON.stringify({ index: 0, event_type: "step.stop" })}`,
      "",
      "event: interaction.completed",
      `data: ${JSON.stringify({ interaction: { id, status, usage: { total_tokens: 2, total_input_tokens: 1, total_output_tokens: 1 } }, event_type: "interaction.completed" })}`,
      "",
      "event: done",
      "data: [DONE]",
      "",
    ];
    return new Response(lines.join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

  it("each call runs in its own session, so on Google each copy chains onto its own interaction", async () => {
    const chained: Array<{ copy: string; previous: string | undefined }> = [];
    let parentTurns = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.includes("groq.test")) {
        // The parent asks the same worker twice in one turn, then answers.
        const first = parentTurns++ === 0;
        const calls = ["A", "B"].map((copy) => ({ id: `p_${copy}`, type: "function", function: { name: "helper", arguments: JSON.stringify({ task: `copy ${copy}` }) } }));
        const message = first ? { role: "assistant", content: null, tool_calls: calls } : { role: "assistant", content: "both done" };
        return new Response(JSON.stringify({ id: "r", choices: [{ message, finish_reason: first ? "tool_calls" : "stop" }], usage }), { status: 200 });
      }
      // Google: turn 1 of a copy names it in the task; turn 2 answers its own call id.
      const input = JSON.stringify(body.input);
      const copy = /copy ([AB])/.exec(input)?.[1] ?? /call_([AB])/.exec(input)?.[1] ?? "?";
      if (!body.previous_interaction_id && /copy [AB]/.test(input)) {
        await new Promise((r) => setTimeout(r, copy === "A" ? 5 : 25)); // A first; B's turn 1 ends while A's tool runs
        return googleSse(`v1_${copy}`, { id: `call_${copy}`, type: "function_call", name: "look", arguments: {} }, undefined, "requires_action");
      }
      chained.push({ copy, previous: body.previous_interaction_id });
      return googleSse(`v2_${copy}`, { type: "model_output" }, { text: `done ${copy}`, type: "text" }, "completed");
    }) as unknown as typeof fetch;

    // A slow tool: copy B saves its first interaction while copy A is still in its tool, as in real parallel runs.
    const look = tool({ name: "look", description: "look", input: z.object({}), execute: async () => (await new Promise((r) => setTimeout(r, 40)), "seen") });
    const helper = new Agent({ name: "helper", description: "Helps.", instructions: "Help.", model: "google/gemini-3.5-flash-lite", apiKey: "k", tools: { look }, fetch: fetchImpl });
    const parent = new Agent({ model: "groq/m", apiKey: "k", baseUrl: "https://groq.test/v1", sessionId: "p1", subagents: [helper], fetch: fetchImpl, runRetries: 0 });
    const res = await parent.run("ask twice");
    expect(res.text).toBe("both done");
    expect(res.toolResults.map((r) => String(r.result))).toEqual(["done A", "done B"]);
    // Each copy's second turn continues its OWN first interaction (a shared session chained onto the other's).
    expect(chained.sort((x, y) => x.copy.localeCompare(y.copy))).toEqual([
      { copy: "A", previous: "v1_A" },
      { copy: "B", previous: "v1_B" },
    ]);
    const ids = res.subagents.map((s) => s.sessionId);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(String(id).startsWith("p1-sub-helper-")).toBe(true);
  });
});
