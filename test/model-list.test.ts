import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Agent,
  ConfigError,
  ModelNotAllowedError,
  getCacheFilePath,
  getModelFromCatalog,
  getModelsForProvider,
  resolveModel,
  setModels,
} from "../src/index.ts";
import { resetModels } from "../src/config/models.ts";
import { getScheduler, resetSchedulers } from "../src/scheduler/scheduler.ts";
import { readDeliveries, readRun } from "../src/scheduler/store.ts";
import { isRetryableRun } from "../src/utils/retry.ts";

afterEach(() => {
  resetModels();
  resetSchedulers();
});

// A models list with the given `provider/model` strings (grouped by provider, defaults = the first one).
function list(...full: string[]) {
  const providers: Record<string, { models: string[] }> = {};
  for (const m of full) {
    const slash = m.indexOf("/");
    (providers[m.slice(0, slash)] ??= { models: [] }).models.push(m.slice(slash + 1));
  }
  return { default: { model: full[0]!, sub_agent_model: full[0]! }, providers };
}

// A fetch that fails the test when any request is sent: a refused model must never reach the network.
const noNetwork = (async () => {
  throw new Error("a request was sent");
}) as unknown as typeof fetch;

const cfg = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  apiKey: "k",
  baseUrl: "https://example.test/v1",
  fetch: noNetwork,
  runRetries: 0,
  ...extra,
});

describe("resolveModel", () => {
  test("without a list nothing is restricted", () => {
    expect(resolveModel("openai/gpt-6-sol").modelId).toBe("gpt-6-sol");
  });

  test("each way of naming a model is checked against provider/id", () => {
    setModels(list("google/gemini-3.5-flash", "openrouter/z-ai/glm-4.7", "groq/some-model"));
    expect(resolveModel("google/gemini-3.5-flash").modelId).toBe("gemini-3.5-flash");
    expect(resolveModel("gemini/gemini-3.5-flash").provider.id).toBe("google"); // alias of google
    expect(resolveModel("gemini-3.5-flash").provider.id).toBe("google"); // bare id routed by the catalog
    expect(resolveModel({ provider: "google", id: "gemini-3.5-flash" } as never).modelId).toBe("gemini-3.5-flash");
    expect(resolveModel("openrouter/z-ai/glm-4.7").modelId).toBe("z-ai/glm-4.7"); // OpenRouter keeps its own slash
    expect(resolveModel("groq/some-model").provider.id).toBe("groq"); // custom prefix
    for (const refused of [
      "google/gemini-3.5-flash-lite",
      "openai/gpt-6-sol",
      "openrouter/z-ai/glm-4.5-air",
      "groq/other-model",
      "gemini-3.5-flash-lite",
      "anthropic/claude-sonnet-5",
    ])
      expect(() => resolveModel(refused)).toThrow(ModelNotAllowedError);
  });

  test("the error names the model and lists what is available", () => {
    setModels(list("google/gemini-3.5-flash", "groq/a"));
    try {
      resolveModel("openai/gpt-6-sol");
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as ModelNotAllowedError;
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.name).toBe("ModelNotAllowedError");
      expect(err.message).toBe('[Agent Accelerator] Model "openai/gpt-6-sol" is not available. Available: google/gemini-3.5-flash, groq/a.');
      expect(err.model).toBe("openai/gpt-6-sol");
      expect(err.allowed).toEqual(["google/gemini-3.5-flash", "groq/a"]);
      expect(err.retryable).toBe(false);
      expect(isRetryableRun(err)).toBe(false);
    }
  });
});

describe("every path that picks a model", () => {
  test("the constructor refuses the main model and the worker model", () => {
    setModels(list("groq/main", "groq/worker"));
    expect(() => new Agent(cfg("groq/main"))).not.toThrow();
    expect(() => new Agent(cfg("groq/nope"))).toThrow(ModelNotAllowedError);
    expect(() => new Agent(cfg("groq/main", { dynamicSubagents: { enabled: true, model: "groq/worker" } }))).not.toThrow();
    expect(() => new Agent(cfg("groq/main", { dynamicSubagents: { enabled: true, model: "groq/nope" } }))).toThrow(ModelNotAllowedError);
    expect(() => new Agent(cfg("groq/main", { dynamicSubagents: { enabled: false, allowScheduledActions: true, model: "groq/nope" } }))).toThrow(
      ModelNotAllowedError
    );
    expect(() => new Agent(cfg("groq/main", { subagentModel: "groq/nope", dynamicSubagents: { enabled: true } }))).toThrow(ModelNotAllowedError);
  });

  test("a run that starts after the list changed is refused before any request", async () => {
    setModels(list("groq/main"));
    const agent = new Agent(cfg("groq/main"));
    setModels(list("groq/other"));
    await expect(agent.run("hi")).rejects.toBeInstanceOf(ModelNotAllowedError);
    expect(() => agent.stream("hi")).toThrow(ModelNotAllowedError);
    expect(agent.context.messages.length).toBe(0); // nothing was added to the conversation
  });

  test("a refused run is not retried", async () => {
    setModels(list("groq/main"));
    const agent = new Agent(cfg("groq/main", { runRetries: 3 }));
    setModels(list("groq/other"));
    const t0 = Date.now();
    await expect(agent.run("hi")).rejects.toBeInstanceOf(ModelNotAllowedError);
    expect(Date.now() - t0).toBeLessThan(1_000); // the first retry would wait 5 s
  });

  test("importSession refuses a session saved with another model, and changes nothing", () => {
    setModels(list("groq/main"));
    const agent = new Agent(cfg("groq/main"));
    const saved = agent.exportSession();
    expect(() => agent.importSession({ ...saved, model: "openai/gpt-6-sol", messages: [{ role: "user", content: "x" }] })).toThrow(ModelNotAllowedError);
    expect(() => agent.importSession({ ...saved, subagentModel: "openai/gpt-6-sol" })).toThrow(ModelNotAllowedError);
    expect(agent.modelStringOrSpec).toBe("groq/main");
    expect(agent.context.messages.length).toBe(0);
    expect(() => agent.importSession({ ...saved, model: "groq/main" })).not.toThrow();
  });

  test("fromConfig refuses a model outside the list", () => {
    setModels(list("groq/main", "groq/second"));
    expect(Agent.fromConfig({ model: "groq/second" }, cfg("groq/main") as never).modelStringOrSpec).toBe("groq/second");
    expect(() => Agent.fromConfig({ model: "groq/nope" }, cfg("groq/main") as never)).toThrow(ModelNotAllowedError);
  });

  test("a chat worker whose model left the list fails to spawn", async () => {
    setModels(list("groq/main", "groq/worker"));
    const agent = new Agent(cfg("groq/main", { dynamicSubagents: { enabled: true, model: "groq/worker" } }));
    setModels(list("groq/main"));
    await expect(agent.workers.spawn({ name: "w", task: "t" })).rejects.toBeInstanceOf(ModelNotAllowedError);
    expect(agent.workers.list()).toEqual([]);
  });

  test("a scheduled run whose model left the list is recorded as failed, without a request", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "models-sched-"));
    try {
      setModels(list("groq/main", "groq/worker"));
      resetSchedulers();
      const s = getScheduler(home);
      s.tickMs = 3_600_000;
      s.now = () => new Date(2026, 10, 15, 10, 0, 0);
      const agent = new Agent(
        cfg("groq/main", { name: "Main", home, dynamicSubagents: { enabled: false, model: "groq/worker", allowScheduledActions: true } })
      );
      const rec = agent.scheduled.create({
        instructions: "i",
        task: "t",
        scheduled_action: { name: "N", id: "n", timeToDeliver: "00:07:00", meridiem: "PM", startCookingInAdvance: "00:00:10" },
      });
      setModels(list("groq/main"));
      agent.scheduled.run(rec.id);
      await Promise.all([...s.running.values()].map((r) => r.done));
      const delivery = readDeliveries(home)[0]!;
      expect(delivery.status).toBe("failed");
      expect(readRun(home, delivery.file)!.body).toContain('Model "groq/worker" is not available');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the catalog read-time filter", () => {
  test("only listed models are shown, and clearing the list brings them back", () => {
    const all = getModelsForProvider("google").length;
    expect(all).toBeGreaterThan(2);
    expect(getModelFromCatalog("google", "gemini-3.5-flash-lite")).toBeDefined();
    setModels(list("google/gemini-3.5-flash"));
    expect(getModelsForProvider("google").map((m) => m.id)).toEqual(["gemini-3.5-flash"]);
    expect(getModelFromCatalog("google", "gemini-3.5-flash")?.pricing?.inputPerMillion).toBeGreaterThan(0);
    expect(getModelFromCatalog("google", "gemini-3.5-flash-lite")).toBeUndefined();
    expect(getModelsForProvider("openai")).toEqual([]); // a provider with no listed model shows none
    resetModels();
    expect(getModelsForProvider("google").length).toBe(all);
  });

  test("a listed model the catalog does not know is allowed, with an unknown price", () => {
    setModels(list("google/gemini-9-unreleased"));
    const resolved = resolveModel("google/gemini-9-unreleased");
    expect(resolved.modelId).toBe("gemini-9-unreleased");
    expect(getModelFromCatalog("google", "gemini-9-unreleased")).toBeUndefined();
    expect(resolved.provider.getModel("gemini-9-unreleased")?.pricing).toEqual({}); // generic spec: no price, never $0 made up
  });

  test("the cache files are never rewritten by the filter", () => {
    const file = getCacheFilePath("google");
    const before = fs.statSync(file);
    setModels(list("google/gemini-3.5-flash"));
    getModelsForProvider("google");
    getModelFromCatalog("google", "gemini-3.5-flash");
    resetModels();
    const after = fs.statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });
});
