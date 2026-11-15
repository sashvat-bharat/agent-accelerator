import { afterEach, describe, expect, test } from "bun:test";
import { listModels, parseModels, resetModels, setModels } from "../src/config/models.ts";
import * as sdk from "../src/index.ts";

afterEach(() => resetModels());

const valid = () => ({
  default: { model: "google/gemini-4-argon", sub_agent_model: "openrouter/meta/muse-ember" },
  providers: {
    google: { models: ["gemini-4-argon", "gemini-4-carbon"] },
    anthropic: { models: ["claude-opus-5-5"] },
    openrouter: { models: ["meta/muse-ember", "liquid/lfm-3-1.7b:free"] },
  },
});

// The message of the ConfigError a bad value throws.
const problems = (json: unknown): string => {
  try {
    parseModels(json);
  } catch (e) {
    expect((e as Error).name).toBe("ConfigError");
    return (e as Error).message;
  }
  throw new Error("expected a ConfigError");
};

describe("parseModels", () => {
  test("joins provider and id, keeps OpenRouter's own slash, keeps the defaults", () => {
    const list = parseModels(valid());
    expect(list.default).toEqual({ model: "google/gemini-4-argon", sub_agent_model: "openrouter/meta/muse-ember" });
    expect(list.models.map((m) => m.model)).toEqual([
      "google/gemini-4-argon",
      "google/gemini-4-carbon",
      "anthropic/claude-opus-5-5",
      "openrouter/meta/muse-ember",
      "openrouter/liquid/lfm-3-1.7b:free",
    ]);
    expect(list.models[3]).toEqual({ provider: "openrouter", id: "meta/muse-ember", model: "openrouter/meta/muse-ember" });
  });

  test("the result is deeply frozen and detached from the input", () => {
    const input = valid();
    const list = parseModels(input);
    expect(Object.isFrozen(list)).toBe(true);
    expect(Object.isFrozen(list.models)).toBe(true);
    expect(Object.isFrozen(list.models[0])).toBe(true);
    expect(Object.isFrozen(list.default)).toBe(true);
    input.providers.google.models.push("gemini-4-hydrogen");
    expect(list.models.length).toBe(5);
  });

  test("not an object, missing parts", () => {
    expect(problems(null)).toContain("expected an object");
    expect(problems({})).toMatch(/providers: required.*default: required/);
    expect(problems({ ...valid(), providers: {} })).toContain("providers: required");
  });

  test("unknown keys are refused at every level", () => {
    const j: any = valid();
    j.extra = 1;
    j.default.fallback = "x";
    j.providers.google.name = "G";
    const msg = problems(j);
    expect(msg).toContain('models: unknown key "extra"');
    expect(msg).toContain('default: unknown key "fallback"');
    expect(msg).toContain('providers.google: unknown key "name"');
  });

  test("a provider with no models, empty and non-string entries", () => {
    const j: any = valid();
    j.providers.openai = { models: [] };
    j.providers.groq = {};
    j.providers.google.models.push("", 5);
    const msg = problems(j);
    expect(msg).toContain("providers.openai.models: required, a non-empty list");
    expect(msg).toContain("providers.groq.models: required");
    expect(msg).toContain("providers.google.models[2]: expected a non-empty string");
    expect(msg).toContain("providers.google.models[3]: expected a non-empty string");
  });

  test("wildcards, a repeated provider prefix and duplicates", () => {
    const j: any = valid();
    j.providers.google.models.push("gemini-4-*", "google/gemini-4-hydrogen", "gemini-4-argon");
    const msg = problems(j);
    expect(msg).toContain("has a wildcard");
    expect(msg).toContain('starts with "google/"');
    expect(msg).toContain('"gemini-4-argon" is listed twice');
  });

  test("a bad provider name", () => {
    const j: any = valid();
    j.providers["bad name"] = { models: ["x"] };
    expect(problems(j)).toContain("not a provider name");
  });

  test("the defaults must be in the list, written as provider/model", () => {
    const j: any = valid();
    j.default = { model: "openrouter/recursive/flint-v1.0:free", sub_agent_model: "gemini-4-argon" };
    const msg = problems(j);
    expect(msg).toContain('default.model: "openrouter/recursive/flint-v1.0:free" is not in the list');
    expect(msg).toContain('default.sub_agent_model: "gemini-4-argon" is not in the list');
    expect(problems({ ...valid(), default: { model: "google/gemini-4-argon" } })).toContain("default.sub_agent_model: required");
    expect(problems({ ...valid(), default: undefined })).toContain("default: required");
  });

  test("every problem is reported in one error, counted", () => {
    const msg = problems({ default: {}, providers: { google: { models: [""] } } });
    expect(msg).toMatch(/\(3 problems\)/);
  });
});

describe("setModels / listModels", () => {
  test("nothing is listed until setModels is called", () => {
    expect(listModels()).toBeUndefined();
  });

  test("setModels stores the list, listModels returns it, the barrel exports both", () => {
    sdk.setModels(valid());
    expect(sdk.listModels()!.models.length).toBe(5);
    expect(sdk.listModels()!.default.model).toBe("google/gemini-4-argon");
  });

  test("a failed setModels keeps the previous list", () => {
    setModels(valid());
    expect(() => setModels({ default: {}, providers: {} })).toThrow("Invalid models config");
    expect(listModels()!.models.length).toBe(5);
  });

  test("calling it again replaces the list", () => {
    setModels(valid());
    setModels({ default: { model: "openai/gpt-6-astra", sub_agent_model: "openai/gpt-6-astra" }, providers: { openai: { models: ["gpt-6-astra"] } } });
    expect(listModels()!.models.map((m) => m.model)).toEqual(["openai/gpt-6-astra"]);
  });

  test("the returned list cannot be changed", () => {
    setModels(valid());
    expect(() => {
      (listModels()!.models as any).push({});
    }).toThrow();
    expect(() => {
      (listModels()!.default as any).model = "x";
    }).toThrow();
  });
});
