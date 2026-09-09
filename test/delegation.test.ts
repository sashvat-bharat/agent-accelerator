import { describe, it, expect } from "bun:test";
import {
  Agent,
  SubAgent,
  buildAgentTools,
  createSubagentSpawnTool,
  AgentResponse,
} from "../src/index.ts";

describe("Multi-Agent Dynamic Delegation & Metadata", () => {
  it("should automatically inject subagents as tools on parent Agent", () => {
    const subAgent = new SubAgent({
      name: "Domain_Specialist",
      description: "Handles specialized domain tasks",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
    });

    const leadAgent = new Agent({
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
      subagents: [subAgent],
    });

    expect(leadAgent.tools["domain_specialist"]).toBeDefined();
    expect(leadAgent.tools["domain_specialist"]!.name).toBe("domain_specialist");
    expect(leadAgent.tools["domain_specialist"]!.description).toBe("Handles specialized domain tasks");
    expect(leadAgent.tools["domain_specialist"]!.input).toBeDefined();

    const toolsRecord = buildAgentTools([subAgent]);
    expect(toolsRecord["domain_specialist"]).toBeDefined();
  });

  it("should create a generic domain-agnostic subagent spawn tool", () => {
    const parentAgent = new Agent({
      name: "Root_Agent",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
      dynamicSubagents: {
        enabled: true,
        model: "google/gemini-3.5-flash-lite",
        maxSpawn: 4,
        timeout: 60000,
      },
    });

    expect(parentAgent.tools["spawn_subagents"]).toBeDefined();
    const toolDef = createSubagentSpawnTool(parentAgent);
    expect(toolDef.name).toBe("spawn_subagents");
    // Ensure LLM cannot choose model (model property removed from schema)
    const taskShape = (toolDef.input as any)?.shape?.tasks?.element?.shape ?? {};
    expect(taskShape.model).toBeUndefined();
    expect(taskShape.name).toBeDefined();
    expect(taskShape.task).toBeDefined();
    expect(taskShape.instructions).toBeDefined();
  });

  it("should strictly throw SubAgentModelError when dynamicSubagents is enabled but no model is configured", () => {
    const { SubAgentModelError } = require("../src/index.ts");
    const prevEnv = process.env.SUB_AGENT_MODEL;
    delete process.env.SUB_AGENT_MODEL;

    try {
      expect(() => {
        new Agent({
          name: "Test_Agent",
          model: "google/gemini-3.8-flash",
          apiKey: "TEST_KEY",
          dynamicSubagents: { enabled: true },
        });
      }).toThrow(/sub-agent model is required when dynamic sub-agents are enabled/);
    } finally {
      if (prevEnv) process.env.SUB_AGENT_MODEL = prevEnv;
    }
  });

  it("should enforce maxSpawn, grant only requested pool tools, and keep workers stateless", async () => {
    const { tool } = require("../src/index.ts");
    const { z } = require("zod");
    const calls: string[] = [];
    const mkTool = (name: string) =>
      tool({ name, description: `${name} tool`, input: z.object({}), execute: async () => { calls.push(name); return `${name}-ok`; } });
    const parentAgent = new Agent({
      name: "Root_Agent",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
      dynamicSubagents: {
        enabled: true,
        model: "google/gemini-3.5-flash-lite",
        maxSpawn: 2,
        tools: { recent_news: mkTool("recent_news"), get_weather: mkTool("get_weather") },
        timeout: 0,
      },
    });
    expect(parentAgent.dynamicSubagents?.maxSpawn).toBe(2);
    expect(Object.keys(parentAgent.dynamicSubagents?.tools ?? {}).sort()).toEqual(["get_weather", "recent_news"]);
    const spawn = parentAgent.tools["spawn_subagents"] as any;
    expect(spawn).toBeDefined();
    expect(JSON.stringify(spawn.description)).toContain("at most 2 sub-agent(s)");
    const taskShape = (spawn.input as any)?.shape?.tasks?.element?.shape ?? {};
    expect(taskShape.model).toBeUndefined();
    expect(taskShape.tools).toBeDefined();
    expect(taskShape.timeoutMs).toBeDefined();
    // maxSpawn is enforced at the schema level: 3 tasks with maxSpawn 2 must fail parsing
    let threw = false;
    try {
      (spawn.input as any).parse({ tasks: [{ task: "a" }, { task: "b" }, { task: "c" }] });
    } catch { threw = true; }
    expect(threw).toBe(true);
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

  it("should instantiate a SubAgent with smart defaults and tool export capabilities", () => {
    const { SubAgent } = require("../src/index.ts");

    const critique = new SubAgent({
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

    // Verify .asTool() and .toTool()
    const asToolDef = critique.asTool();
    expect(asToolDef.name).toBe("code_critique");
    expect(asToolDef.description).toBe("Reviews code architecture and edge cases");

    const customToolDef = critique.toTool("custom_reviewer", "Custom override");
    expect(customToolDef.name).toBe("custom_reviewer");
    expect(customToolDef.description).toBe("Custom override");
  });

  it("should throw when SubAgent has no model in config and no env variable", () => {
    const { SubAgent } = require("../src/index.ts");
    const prevSub = process.env.SUB_AGENT_MODEL;
    const prevModel = process.env.MODEL;
    delete process.env.SUB_AGENT_MODEL;
    delete process.env.MODEL;
    try {
      expect(() => {
        new SubAgent({
          name: "no_model_sub",
          instructions: "Test instructions",
        });
      }).toThrow(/requires a model/i);
    } finally {
      if (prevSub) process.env.SUB_AGENT_MODEL = prevSub;
      if (prevModel) process.env.MODEL = prevModel;
    }
  });

  it("should support clean separation of tools: { get_status } and subagents: [critique, researcher]", () => {
    const { SubAgent, tool, z } = require("../src/index.ts");

    const get_status = tool({
      name: "get_status",
      description: "Check user authentication status.",
      input: z.object({ username: z.string() }),
      execute: async () => "Valid",
    });

    const critique = new SubAgent({
      name: "code_critique",
      description: "Reviews code architecture.",
      instructions: "Review code rigorously.",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
    });

    const researcher = new SubAgent({
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
    expect(lead.tools["code_critique"]).toBeDefined();
    expect(lead.tools["tech_researcher"]).toBeDefined();
  });

  it("should not accumulate conversation history when stateless: true is set", async () => {
    const { SubAgent } = require("../src/index.ts");

    const statelessAgent = new SubAgent({
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
      // In Google payload, contents contains messages:
      expect(body.contents.length).toBe(1); // strictly 1 turn!
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: `Response ${requestCount}` }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    try {
      const res1 = await statelessAgent.run("Turn 1 prompt");
      expect(res1.text).toBe("Response 1");
      // Immediately after execution, stateless agent resets context messages
      expect(statelessAgent.context.messages.length).toBe(0);

      const res2 = await statelessAgent.run("Turn 2 prompt");
      expect(res2.text).toBe("Response 2");
      expect(statelessAgent.context.messages.length).toBe(0);
      expect(requestCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
