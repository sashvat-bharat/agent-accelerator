import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { Agent, tool, ConfigError, ModelProvider, telemetryBus } from "../src/index.ts";

// The RSI building blocks: an agent may edit only model, instructions and tools. Everything else is the developer's.
const mk = (name: string) =>
  tool({ name, description: `the ${name} tool`, input: z.object({}), execute: async () => name });
const POOL = { search: mk("search"), write: mk("write"), delete_all: mk("delete_all") };
const base = (extra: Record<string, unknown> = {}) => ({
  model: "groq/llama-3.3-70b-versatile",
  instructions: "v1",
  tools: POOL,
  maxTurns: 7,
  budget: { maxCostUsd: 1 },
  cache: "1h" as const,
  ...extra,
});
const warnings = async (fn: () => void): Promise<{ code: string; data: any }[]> => {
  const seen: { code: string; data: any }[] = [];
  const off = telemetryBus.onEvent((e) => seen.push({ code: e.code, data: e.data }));
  try {
    fn();
  } finally {
    off();
  }
  return seen.filter((e) => e.code === "config.not_editable");
};

describe("Agent.toConfig()", () => {
  it("is plain JSON: the model string, the instructions and the names of the developer's tools", () => {
    const agent = new Agent(base());
    const cfg = agent.toConfig();
    expect(cfg).toEqual({ model: "groq/llama-3.3-70b-versatile", instructions: "v1", tools: ["search", "write", "delete_all"] });
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(cfg);
  });

  it("never carries a key, and lists neither the built-in delegation tools nor the other settings", () => {
    const agent = new Agent({
      ...base({ apiKey: "sk-top-level" }),
      model: { ...ModelProvider.OpenAI("gpt-5.5"), apiKey: "sk-secret" },
      dynamicSubagents: { enabled: true, model: "groq/llama-3.3-70b-versatile" },
    });
    const cfg = agent.toConfig();
    expect(JSON.stringify(cfg)).not.toContain("sk-");
    expect(cfg.tools).toEqual(["search", "write", "delete_all"]); // no "subagents"
    expect(Object.keys(cfg).sort()).toEqual(["instructions", "model", "tools"]);
  });

  it("reports the edited instructions of a live agent", () => {
    const agent = new Agent(base());
    agent.instructions = "v2";
    expect(agent.toConfig().instructions).toBe("v2");
  });
});

describe("Agent.fromConfig(editable, base)", () => {
  it("applies model, instructions and tools; the developer's other settings stay", () => {
    const agent = Agent.fromConfig({ model: "groq/openai/gpt-oss-20b", instructions: "v2", tools: ["search"] }, base());
    expect(agent.modelStringOrSpec).toBe("groq/openai/gpt-oss-20b");
    expect(agent.instructions).toBe("v2");
    expect(Object.keys(agent.tools)).toEqual(["search"]);
    expect(agent.maxTurns).toBe(7);
    expect(agent.budget).toEqual({ maxCostUsd: 1 });
    expect(agent.cache).toBe("1h");
  });

  it("an empty edit changes nothing, and a missing field keeps the base value (all tools stay)", () => {
    const agent = Agent.fromConfig({ instructions: "only this" }, base());
    expect(agent.modelStringOrSpec).toBe("groq/llama-3.3-70b-versatile");
    expect(Object.keys(agent.tools).sort()).toEqual(["delete_all", "search", "write"]);
    expect(Agent.fromConfig({}, base()).instructions).toBe("v1");
  });

  it("round trip: toConfig -> JSON -> fromConfig rebuilds the same agent", () => {
    const a = new Agent(base());
    const saved = JSON.parse(JSON.stringify({ ...a.toConfig(), instructions: "improved" }));
    const b = Agent.fromConfig(saved, base());
    expect(b.toConfig()).toEqual({ ...a.toConfig(), instructions: "improved" });
  });

  it("tools can be an empty list", () => {
    expect(Object.keys(Agent.fromConfig({ tools: [] }, base()).tools)).toEqual([]);
  });

  it("other fields are ignored with ONE warning that names them; they cannot raise a limit", async () => {
    let agent!: Agent;
    const seen = await warnings(() => {
      agent = Agent.fromConfig({ instructions: "v2", maxTurns: 999, budget: { maxCostUsd: 1e6 }, limits: { maxTotalTokens: 1e9 }, cache: "12h" } as never, base());
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.data.fields).toEqual(["maxTurns", "budget", "limits", "cache"]);
    expect(agent.maxTurns).toBe(7);
    expect(agent.budget).toEqual({ maxCostUsd: 1 });
    expect(agent.cache).toBe("1h");
    expect(agent.instructions).toBe("v2");
  });

  it("an editable with only allowed fields (or undefined ones) warns about nothing", async () => {
    expect(await warnings(() => void Agent.fromConfig({ instructions: "x", model: undefined, tools: undefined }, base()))).toHaveLength(0);
  });

  it("a tool name that is not in the developer's pool throws, listing the available ones", () => {
    expect(() => Agent.fromConfig({ tools: ["search", "rm_rf"] }, base())).toThrow(ConfigError);
    expect(() => Agent.fromConfig({ tools: ["rm_rf"] }, base())).toThrow(/"rm_rf".*Available: "search", "write", "delete_all"/);
    expect(() => Agent.fromConfig({ tools: ["toString"] }, base())).toThrow(/Unknown tool/); // not an inherited property either
    expect(() => Agent.fromConfig({ tools: ["x"] }, { model: "groq/llama-3.3-70b-versatile" })).toThrow(/Available: none/);
  });

  it("wrong types throw a readable ConfigError instead of building a broken agent", () => {
    for (const bad of [{ model: "" }, { model: 5 }, { instructions: 5 }, { tools: "search" }, { tools: [1] }] as never[]) {
      expect(() => Agent.fromConfig(bad, base())).toThrow(ConfigError);
    }
    expect(() => Agent.fromConfig(null as never, base())).toThrow(ConfigError);
    expect(() => Agent.fromConfig([] as never, base())).toThrow(ConfigError);
  });

  it("does not touch the base config or the agent it came from", () => {
    const b = base();
    const a = new Agent(b);
    Agent.fromConfig({ instructions: "v2", tools: ["search"] }, b);
    expect(b.instructions).toBe("v1");
    expect(Object.keys(b.tools)).toEqual(["search", "write", "delete_all"]);
    expect(a.instructions).toBe("v1");
  });

  it("keeps the model helper's key for the same provider, and drops it for another one", () => {
    const withKey = { ...base(), model: { model: "openai/gpt-5.5", apiKey: "sk-openai", baseUrl: "https://example.test/v1" } };
    const same = Agent.fromConfig({ model: "openai/gpt-5.5-mini" }, withKey);
    expect(same.apiKey).toBe("sk-openai");
    expect(same.baseUrl).toBe("https://example.test/v1");
    const other = Agent.fromConfig({ model: "google/gemini-3.5-flash" }, withKey);
    expect(other.apiKey).toBeUndefined();
    expect(other.baseUrl).toBeUndefined();
    expect(JSON.stringify(other.toConfig())).not.toContain("sk-openai");
  });
});

describe("allowedModels", () => {
  const allowed = ["groq/llama-3.3-70b-versatile", "groq/openai/gpt-oss-20b"];

  it("a model inside the list works, in the constructor and through fromConfig", () => {
    expect(() => new Agent(base({ allowedModels: allowed }))).not.toThrow();
    const agent = Agent.fromConfig({ model: "groq/openai/gpt-oss-20b" }, base({ allowedModels: allowed }));
    expect(agent.modelStringOrSpec).toBe("groq/openai/gpt-oss-20b");
  });

  it("a model outside the list is refused with the allowed ones named", () => {
    expect(() => Agent.fromConfig({ model: "openai/gpt-5.5" }, base({ allowedModels: allowed }))).toThrow(
      /"openai\/gpt-5\.5" is not in allowedModels\. Allowed: "groq\/llama-3\.3-70b-versatile", "groq\/openai\/gpt-oss-20b"/
    );
    expect(() => new Agent(base({ model: "openai/gpt-5.5", allowedModels: allowed }))).toThrow(ConfigError);
  });

  it("an edit without a model keeps the base model, which must be allowed too", () => {
    expect(() => Agent.fromConfig({ instructions: "x" }, base({ model: "openai/gpt-5.5", allowedModels: allowed }))).toThrow(ConfigError);
  });

  it("entries are compared as written, and a model helper counts by its model string", () => {
    expect(() => Agent.fromConfig({ model: "llama-3.3-70b-versatile" }, base({ allowedModels: allowed }))).toThrow(ConfigError);
    expect(() => new Agent({ ...base({ allowedModels: ["openai/gpt-5.5"] }), model: ModelProvider.OpenAI("gpt-5.5") })).not.toThrow();
  });

  it("an invalid list is a ConfigError, not a silent allow-all", () => {
    for (const bad of [[], "groq/x", [1], [""]] as never[]) {
      expect(() => new Agent(base({ allowedModels: bad }))).toThrow(/Invalid allowedModels/);
    }
  });

  it("a fork keeps the rule", () => {
    const agent = new Agent(base({ allowedModels: allowed }));
    expect(() => agent.fork("child")).not.toThrow();
    expect((agent as any).forkConfig.allowedModels).toEqual(allowed);
  });
});
