import { afterEach, describe, it, expect } from "bun:test";
import { z } from "zod";
import { Agent, tool, ConfigError, ModelNotAllowedError, ModelProvider, telemetryBus, setModels } from "../src/index.ts";
import { resetModels } from "../src/config/models.ts";

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

  it("drops the developer's top-level key, base URL and headers when the model moves to another provider", () => {
    const conn = { apiKey: "sk-openai", baseUrl: "https://example.test/v1", headers: { "x-gateway-key": "g-1" } };
    const top = base({ model: "openai/gpt-5.5", ...conn });
    const same = Agent.fromConfig({ model: "openai/gpt-5.5-mini" }, top);
    expect([same.apiKey, same.baseUrl, same.customHeaders]).toEqual([conn.apiKey, conn.baseUrl, conn.headers]);
    for (const model of ["openrouter/openai/gpt-5.5", "groq/llama-3.3-70b-versatile"]) {
      const other = Agent.fromConfig({ model }, top);
      expect([other.apiKey, other.baseUrl, other.customHeaders]).toEqual([undefined, undefined, undefined]);
    }
    // A model helper's own key is dropped too, and the top-level one is no longer there to fall back to.
    const both = base({ ...conn, model: { model: "openai/gpt-5.5", apiKey: "sk-helper" } });
    const moved = Agent.fromConfig({ model: "google/gemini-3.5-flash" }, both);
    expect([moved.apiKey, moved.baseUrl, moved.customHeaders]).toEqual([undefined, undefined, undefined]);
    expect((top as { apiKey?: string }).apiKey).toBe("sk-openai"); // the developer's config is not changed
  });

  it("counts gemini/ and google/ as one provider, and a bare model id as an unknown one", () => {
    const google = base({ model: "google/gemini-3.5-flash", apiKey: "g-key" });
    expect(Agent.fromConfig({ model: "gemini/gemini-3.5-flash-lite" }, google).apiKey).toBe("g-key");
    expect(Agent.fromConfig({ model: "gemini/gemini-3.5-flash" }, base({ model: "google/x", apiKey: "g" })).apiKey).toBe("g");
    // Where a bare id goes depends on the catalog, which can change before the run: the key is not risked.
    expect(Agent.fromConfig({ model: "gpt-5.5-mini" }, base({ model: "openai/gpt-5.5", apiKey: "k" })).apiKey).toBeUndefined();
    expect(Agent.fromConfig({ model: "openai/gpt-5.5" }, base({ model: "gpt-5.5", apiKey: "k" })).apiKey).toBeUndefined();
  });

  it("finds a tool by its key or by the name the model sees", () => {
    const tools = { lookup: mk("search_docs"), a: mk("b"), b: mk("c") };
    const byName = Agent.fromConfig({ tools: ["search_docs"] }, base({ tools }));
    expect(Object.keys(byName.tools)).toEqual(["lookup"]);
    expect(byName.toConfig().tools).toEqual(["lookup"]); // the round trip still uses the keys
    expect(Object.keys(Agent.fromConfig({ tools: ["lookup", "search_docs"] }, base({ tools })).tools)).toEqual(["lookup"]);
    expect(Object.keys(Agent.fromConfig({ tools: ["b"] }, base({ tools })).tools)).toEqual(["b"]); // a key wins over a name
    expect(Object.keys(Agent.fromConfig({ tools: ["c"] }, base({ tools })).tools)).toEqual(["b"]);
  });
});

describe("the program's model list (setModels)", () => {
  const list = (models: string[], def = "groq/llama-3.3-70b-versatile") => ({
    default: { model: def, sub_agent_model: def },
    providers: { groq: { models }, openai: { models: ["gpt-5.5"] } },
  });
  const allowed = ["llama-3.3-70b-versatile", "openai/gpt-oss-20b"];
  afterEach(() => resetModels());

  it("a model inside the list works, in the constructor and through fromConfig", () => {
    setModels(list(allowed));
    expect(() => new Agent(base())).not.toThrow();
    const agent = Agent.fromConfig({ model: "groq/openai/gpt-oss-20b" }, base());
    expect(agent.modelStringOrSpec).toBe("groq/openai/gpt-oss-20b");
  });

  it("a model outside the list is refused with the available ones named", () => {
    setModels(list(allowed));
    const edit = () => Agent.fromConfig({ model: "openai/gpt-6" }, base());
    expect(edit).toThrow(ModelNotAllowedError);
    expect(edit).toThrow(/Model "openai\/gpt-6" is not available\. Available: groq\/llama-3\.3-70b-versatile, groq\/openai\/gpt-oss-20b, openai\/gpt-5\.5\./);
    expect(() => new Agent(base({ model: "openai/gpt-6" }))).toThrow(ConfigError);
  });

  it("an edit without a model keeps the base model, which must be allowed too", () => {
    setModels(list(allowed));
    expect(() => Agent.fromConfig({ instructions: "x" }, base({ model: "openai/gpt-6" }))).toThrow(ModelNotAllowedError);
  });

  it("a model helper counts by the model it names", () => {
    setModels(list(allowed));
    expect(() => new Agent({ ...base(), model: ModelProvider.OpenAI("gpt-5.5") })).not.toThrow();
    expect(() => new Agent({ ...base(), model: ModelProvider.OpenAI("gpt-6") })).toThrow(ModelNotAllowedError);
  });

  it("a base with no model counts the program's default model when it keeps or drops the key", () => {
    setModels(list(allowed));
    const noModel = { ...base({ apiKey: "groq-key" }), model: undefined };
    expect(Agent.fromConfig({ model: "groq/openai/gpt-oss-20b" }, noModel).apiKey).toBe("groq-key");
    expect(Agent.fromConfig({ model: "openai/gpt-5.5" }, noModel).apiKey).toBeUndefined();
  });

  it("allowedModels was removed and says what to use instead", () => {
    expect(() => new Agent(base({ allowedModels: ["groq/x"] }))).toThrow(/allowedModels was removed.*setModels/);
  });

  it("a fork keeps the rule", () => {
    setModels(list(allowed));
    const agent = new Agent(base());
    expect(() => agent.fork("child")).not.toThrow();
    setModels(list(["other"], "groq/other"));
    expect(() => agent.fork("child2")).toThrow(ModelNotAllowedError);
  });
});
