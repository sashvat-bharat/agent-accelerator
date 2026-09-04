import { describe, it, expect } from "bun:test";
import {
  Agent,
  agentToTool,
  buildAgentTools,
  createSubagentSpawnTool,
  AgentResponse,
} from "../src/index.ts";

describe("Multi-Agent Dynamic Orchestration & Metadata", () => {
  it("should convert sub-agents into callable tool definitions", () => {
    const subAgent = new Agent({
      name: "Domain_Specialist",
      description: "Handles specialized domain tasks",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
    });

    const agentTool = agentToTool(subAgent);
    expect(agentTool.name).toBe("domain_specialist");
    expect(agentTool.description).toBe("Handles specialized domain tasks");
    expect(agentTool.input).toBeDefined();

    const toolsRecord = buildAgentTools([subAgent]);
    expect(toolsRecord["domain_specialist"]).toBeDefined();
  });

  it("should create a generic domain-agnostic subagent spawn tool", () => {
    const parentAgent = new Agent({
      name: "Root_Orchestrator",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "TEST_KEY",
      SubAgentModel: "google/gemini-3.5-flash-lite",
      subagents: true,
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

  it("should strictly throw SubAgentModelError when EnableSubagents is true but SubAgentModel is missing", () => {
    const { SubAgentModelError } = require("../src/index.ts");
    const prevEnv = process.env.SUB_AGENT_MODEL;
    delete process.env.SUB_AGENT_MODEL;

    try {
      expect(() => {
        new Agent({
          name: "Test_Orchestrator",
          model: "google/gemini-3.8-flash",
          apiKey: "TEST_KEY",
          EnableSubagents: true,
        });
      }).toThrow(/SubAgentModel is required when EnableSubagents is true/);
    } finally {
      if (prevEnv) process.env.SUB_AGENT_MODEL = prevEnv;
    }
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
});
