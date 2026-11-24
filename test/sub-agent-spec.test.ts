import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, setConfigs, setModels } from "../src/index.ts";
import { resetModels } from "../src/config/models.ts";
import { SETTING_KEYS } from "../src/config/settings.ts";
import { buildSubAgentConfig, isWorkerConfig } from "../src/agent/worker.ts";
import { sseFrame } from "./helpers.ts";

beforeEach(() => resetModels());
afterEach(() => resetModels());

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
// A final chat answer, as JSON or as a stream, whichever the request asked for.
const answer = (text: string, body: any): Response =>
  body.stream
    ? new Response(
        sseFrame({ id: "r", choices: [{ delta: { content: text } }] }) +
          sseFrame({ id: "r", choices: [{ delta: {}, finish_reason: "stop" }], usage: USAGE }) +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    : new Response(
        JSON.stringify({ id: "r", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: USAGE }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
// A reply that calls one tool, as JSON or as a stream.
const callTool = (name: string, args: Record<string, unknown>, body: any): Response => {
  const call = { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } };
  return body.stream
    ? new Response(
        sseFrame({ id: "r", choices: [{ delta: { tool_calls: [{ index: 0, ...call }] } }] }) +
          sseFrame({ id: "r", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: USAGE }) +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    : new Response(
        JSON.stringify({
          id: "r",
          choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [call] } }],
          usage: USAGE,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
};
const hasToolResult = (body: any): boolean => body.messages.some((m: any) => m.role === "tool");

type Seen = { model: string; url: string; auth: string | undefined };
// A fetch where the lead model "p" calls the tool `toolName` once, then answers "done"; any other model answers "found it". Records who was called.
const scripted = (toolName: string): { fn: typeof fetch; seen: Seen[] } => {
  const seen: Seen[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ model: body.model, url: String(url), auth: headers.authorization });
    if (body.model !== "p") return answer("found it", body);
    return hasToolResult(body) ? answer("done", body) : callTool(toolName, { task: "find it" }, body);
  }) as unknown as typeof fetch;
  return { fn, seen };
};

const lead = { model: "groq/p", apiKey: "k", baseUrl: "https://example.test/v1" };
const researcher = { name: "researcher", description: "Finds facts.", instructions: "Find facts." };

describe("a sub-agent written as data: the model", () => {
  it("becomes a tool and runs on dynamicSubagents.model when it names none", async () => {
    const { fn, seen } = scripted("researcher");
    const parent = new Agent({ ...lead, dynamicSubagents: { enabled: false, model: "groq/w" }, subagents: [researcher], fetch: fn });
    expect(parent.tools.researcher!.description).toBe("Finds facts.");
    const res = await parent.run("go");
    expect(res.text).toBe("done");
    expect(seen.map((s) => s.model)).toEqual(["p", "w", "p"]);
  });

  it("runs on the saved or default worker model (sub_agent_model), not the main model, when nothing else is set", async () => {
    setModels({ default: { model: "groq/p", sub_agent_model: "groq/w" }, providers: { groq: { models: ["p", "w"] } } });
    const { fn, seen } = scripted("researcher");
    const parent = new Agent({ ...lead, subagents: [researcher], fetch: fn });
    await parent.run("go");
    expect(seen.map((s) => s.model)).toEqual(["p", "w", "p"]);
  });

  it("uses its own model when it names one", async () => {
    const { fn, seen } = scripted("researcher");
    const parent = new Agent({
      ...lead,
      dynamicSubagents: { enabled: false, model: "groq/w" },
      subagents: [{ ...researcher, model: "groq/x" }],
      fetch: fn,
    });
    await parent.run("go");
    expect(seen.map((s) => s.model)).toEqual(["p", "x", "p"]);
  });

  it("fails at construction, naming the entry, when it has no model and no worker model exists", () => {
    expect(() => new Agent({ ...lead, subagents: [researcher] })).toThrow(/subagents\[0\] \("researcher"\) has no model and no worker model is set/);
    expect(() => new Agent({ ...lead, subagents: [researcher] })).toThrow(/setModels\(\) or setSubAgentModel\(\)/);
  });
});

describe("a sub-agent written as data: bad entries", () => {
  const worker = { ...lead, dynamicSubagents: { enabled: false, model: "groq/w" } };
  const message = (entry: unknown): string => {
    try {
      new Agent({ ...worker, subagents: [entry as never] });
    } catch (e) {
      expect((e as Error).name).toBe("ConfigError");
      return (e as Error).message;
    }
    throw new Error("expected a ConfigError");
  };

  it("refuses a key it does not take, so a setting is never silently dropped", () => {
    expect(message({ ...researcher, thinking: "high" })).toMatch(/subagents\[0\] has unknown key "thinking": a sub-agent written as data takes name, description, instructions, model and tools/);
  });

  it("refuses a missing or empty name, description or instructions, and says which", () => {
    expect(message({ name: "a", description: "d" })).toMatch(/subagents\[0\] needs a non-empty instructions/);
    expect(message({ ...researcher, description: "  " })).toMatch(/needs a non-empty description/);
    expect(message({ ...researcher, name: "" })).toMatch(/needs a non-empty name/);
  });

  it("refuses an empty model instead of falling back to the main model", () => {
    expect(message({ ...researcher, model: " " })).toMatch(/has an empty model/);
  });

  it("refuses an entry that is not an object, with the position", () => {
    expect(message(null)).toMatch(/subagents\[0\] must be an Agent/);
    expect(message("researcher")).toMatch(/subagents\[0\] must be an Agent/);
  });
});

describe("a sub-agent written as data: what it takes from its parent", () => {
  it("sends the parent's key only to the parent's own provider", async () => {
    setConfigs({
      values: { catalog_refresh: "off", base_urls: { groq: "https://groq.test/v1", other: "https://other.test/v1" } },
      editable: [...SETTING_KEYS],
    });
    const { fn, seen } = scripted("researcher");
    const parent = new Agent({
      model: "groq/p",
      apiKey: "parent-key",
      env: { OTHER_API_KEY: "other-key" },
      subagents: [
        { ...researcher, model: "other/x" },
        { name: "same", description: "Same provider.", instructions: "Help.", model: "groq/w" },
      ],
      fetch: fn,
    });
    await parent.run("go");
    expect(seen.map((s) => [s.model, s.url.startsWith("https://other.test") ? "other" : "groq", s.auth])).toEqual([
      ["p", "groq", "Bearer parent-key"],
      ["x", "other", "Bearer other-key"],
      ["p", "groq", "Bearer parent-key"],
    ]);
    const same = scripted("same");
    const second = new Agent({ model: "groq/p", apiKey: "parent-key", subagents: [{ name: "same", description: "d", instructions: "i", model: "groq/w" }], fetch: same.fn });
    await second.run("go");
    expect(same.seen.map((s) => [s.model, s.auth])).toEqual([
      ["p", "Bearer parent-key"],
      ["w", "Bearer parent-key"],
      ["p", "Bearer parent-key"],
    ]);
  });

  it("is built with the parent's limits, hooks, fetch and file policy, and counts as an SDK-built worker", () => {
    const { fn } = scripted("researcher");
    const beforeTool = async () => undefined;
    const parent = new Agent({
      ...lead,
      fetch: fn,
      fileAccess: { roots: ["/srv/media"] },
      limits: { maxTurns: 3 },
      hooks: { beforeTool },
      dynamicSubagents: { enabled: false, model: "groq/w" },
    });
    const config = buildSubAgentConfig(parent, researcher, 0);
    expect(config.fetch).toBe(fn);
    expect(config.fileAccess).toEqual({ roots: ["/srv/media"] });
    expect(config.limits?.maxTurns).toBe(3);
    expect(config.hooks?.beforeTool).toBeDefined();
    expect(config.model).toBe("groq/w");
    expect(config.thinking).toBeUndefined();
    expect(isWorkerConfig(config)).toBe(true);
  });
});

describe("a sub-agent written as data: reports", () => {
  it("is listed in usageReport() as a fixed worker under its name, and the total matches the response", async () => {
    const { fn } = scripted("researcher");
    const parent = new Agent({ ...lead, dynamicSubagents: { enabled: false, model: "groq/w" }, subagents: [researcher], fetch: fn });
    const res = await parent.run("go");
    expect(res.usage.totalTokens).toBe(3 * 15);
    const report = parent.usageReport();
    expect(report.workers.map((w) => [w.id, w.status, w.turns])).toEqual([["researcher", "fixed", 1]]);
    expect(report.total.turns).toBe(3);
    expect(res.subagents.map((s) => s.name)).toEqual(["researcher"]);
  });

  it("keeps working when its parent is itself a fixed worker (each call forks the parent and reuses the built sub-agent)", async () => {
    const models: string[] = [];
    const fn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      models.push(body.model);
      if (body.model === "w") return answer("found it", body);
      if (hasToolResult(body)) return answer(body.model === "p" ? "done" : "middle done", body);
      return callTool(body.model === "p" ? "middle" : "researcher", { task: "go on" }, body);
    }) as unknown as typeof fetch;
    const common = { apiKey: "k", baseUrl: "https://example.test/v1", fetch: fn };
    const middle = new Agent({
      ...common,
      name: "middle",
      description: "Hands the work on.",
      model: "groq/m",
      dynamicSubagents: { enabled: false, model: "groq/w" },
      subagents: [researcher],
    });
    const top = new Agent({ ...common, model: "groq/p", subagents: [middle] });
    const res = await top.run("go");
    expect(res.text).toBe("done");
    expect(models).toEqual(["p", "m", "w", "m", "p"]);
    const report = top.usageReport();
    expect(report.workers.map((w) => [w.id, w.status])).toEqual([["middle", "fixed"]]);
    expect(report.workers[0]!.workers.map((w) => [w.id, w.status, w.turns])).toEqual([["researcher", "fixed", 1]]);
    expect(report.total.turns).toBe(5);
  });

  it("mixes with an Agent and the { name, description, agent } form", () => {
    const plain = new Agent({ name: "plain", description: "A plain one.", model: "groq/w", apiKey: "k", baseUrl: "https://example.test/v1" });
    const wrapped = new Agent({ model: "groq/w", apiKey: "k", baseUrl: "https://example.test/v1" });
    const parent = new Agent({
      ...lead,
      dynamicSubagents: { enabled: false, model: "groq/w" },
      subagents: [plain, { name: "wrapped", description: "Wrapped.", agent: wrapped }, researcher],
    });
    expect(Object.keys(parent.tools).sort()).toEqual(["plain", "researcher", "wrapped"]);
  });
});
