import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigError, SettingNotEditableError, getConfigs, setConfig, setConfigs, setHome } from "../src/index.ts";
import { getSetting, parseConfigs, resetConfigs } from "../src/config/settings.ts";
import { isRetryableRun } from "../src/utils/retry.ts";

// Every test works in its own home, so the user's configs.json never lands in the repo.
let home = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-"));
  setHome(home);
});
afterEach(() => {
  resetConfigs();
  setHome(undefined);
  fs.rmSync(home, { recursive: true, force: true });
});

// The message of the ConfigError a bad configs value throws.
const problems = (json: unknown): string => {
  try {
    parseConfigs(json);
  } catch (e) {
    expect((e as Error).name).toBe("ConfigError");
    return (e as Error).message;
  }
  throw new Error("expected a ConfigError");
};

const full = () => ({
  values: {
    usage_limit: { max_cost_usd: 5 },
    scheduled_action_budget: { max_total_tokens: 100000 },
    concurrency: { max_requests: 8, per_provider: { google: 4 } },
    catalog_refresh: "off",
    catalog_cache_dir: "/tmp/cache",
    models_dev_sha256: "A".repeat(64),
    base_urls: { OpenAI: "https://host.test/v1", ollama: "http://localhost:11434/v1" },
    openrouter: { order: ["a", "b"], allow_fallbacks: false, sort: "price", data_collection: "deny", user: "u1", zdr: true },
    compat: { no_stream_options: true },
  },
  editable: ["concurrency", "catalog_refresh"],
});

describe("parseConfigs", () => {
  test("accepts every setting and cleans the values", () => {
    const p = parseConfigs(full());
    expect(p.values.models_dev_sha256).toBe("a".repeat(64));
    expect(p.values.base_urls).toEqual({ openai: "https://host.test/v1", ollama: "http://localhost:11434/v1" });
    expect([...p.editable]).toEqual(["concurrency", "catalog_refresh"]);
    expect(Object.isFrozen(p.values)).toBe(true);
    expect(Object.isFrozen((p.values.concurrency as any).per_provider)).toBe(true);
  });

  test("an empty object is valid: nothing set, nothing editable", () => {
    const p = parseConfigs({});
    expect(p.values).toEqual({});
    expect(p.editable.size).toBe(0);
  });

  test("shape problems", () => {
    expect(problems(null)).toContain("expected an object");
    expect(problems({ other: 1 })).toContain('unknown key "other"');
    expect(problems({ values: [] })).toContain("values: expected an object");
    expect(problems({ editable: "x" })).toContain("editable: expected a list");
  });

  test("unknown settings, in values and in editable", () => {
    const msg = problems({ values: { nope: 1 }, editable: ["nope", "concurrency", "concurrency", 5] });
    expect(msg).toContain("values.nope: unknown setting");
    expect(msg).toContain('editable[0]: "nope" is not a known setting');
    expect(msg).toContain('"concurrency" is listed twice');
    expect(msg).toContain("editable[3]: 5 is not a known setting");
  });

  test("bad values name the setting and the rule", () => {
    const bad = (key: string, value: unknown, text: string) => expect(problems({ values: { [key]: value } })).toContain(text);
    bad("usage_limit", {}, "usage_limit: set at least one of");
    bad("usage_limit", { max_cost_usd: 0 }, "usage_limit.max_cost_usd must be a number greater than 0");
    bad("usage_limit", { cost: 1 }, 'unknown key "cost"');
    bad("concurrency", { max_requests: 1.5 }, "concurrency.max_requests must be a whole number");
    bad("concurrency", { per_provider: { a: 0 } }, "concurrency.per_provider must be an object");
    bad("catalog_refresh", "maybe", 'must be "on" or "off"');
    bad("catalog_cache_dir", " ", "non-empty folder path");
    bad("models_dev_sha256", "abc", "64 hex characters");
    bad("base_urls", { x: "ftp://h" }, "base_urls.x must be an http(s) URL");
    bad("base_urls", { x: "not a url" }, "base_urls.x must be an http(s) URL");
    bad("openrouter", { sort: "cheap" }, "openrouter.sort must be one of: price, throughput, latency");
    bad("openrouter", { order: [] }, "openrouter.order must be a non-empty list");
    bad("openrouter", { zdr: "yes" }, "openrouter.zdr must be true or false");
    bad("compat", { no_session_headers: 1 }, "compat.no_session_headers must be true or false");
  });

  test("every problem is reported in one error, counted", () => {
    expect(problems({ values: { catalog_refresh: 1, nope: 1 }, x: 1 })).toMatch(/\(3 problems\)/);
  });
});

describe("setConfigs / getSetting", () => {
  test("a failed setConfigs keeps what was set before", () => {
    setConfigs(full());
    expect(() => setConfigs({ values: { catalog_refresh: "x" } })).toThrow("Invalid configs");
    expect(getSetting("catalog_refresh")).toBe("off");
  });

  test("a hidden setting has only the developer's value", () => {
    setConfigs(full());
    expect(getSetting("usage_limit")).toEqual({ max_cost_usd: 5 });
    expect(getSetting("compat")).toEqual({ no_stream_options: true });
    expect(getSetting("openrouter")).toMatchObject({ sort: "price" });
  });

  test("an unset setting is undefined (the built-in default)", () => {
    setConfigs({});
    expect(getSetting("catalog_refresh")).toBeUndefined();
  });
});

describe("getConfigs / setConfig", () => {
  test("only editable settings are visible, null when not set", () => {
    setConfigs({ values: { concurrency: { max_requests: 8 }, usage_limit: { max_cost_usd: 5 } }, editable: ["concurrency", "catalog_refresh"] });
    expect(getConfigs()).toEqual({ concurrency: { max_requests: 8 }, catalog_refresh: null });
    expect("usage_limit" in getConfigs()).toBe(false);
  });

  test("the user's value wins over the developer's for an editable setting, and null gives the developer's back", () => {
    setConfigs(full());
    setConfig("concurrency", { max_requests: 2 });
    expect(getSetting("concurrency")).toEqual({ max_requests: 2 });
    expect(getConfigs().concurrency).toEqual({ max_requests: 2 });
    setConfig("concurrency", null);
    expect(getSetting("concurrency")).toEqual({ max_requests: 8, per_provider: { google: 4 } });
    setConfig("catalog_refresh", "on");
    setConfig("catalog_refresh", undefined);
    expect(getSetting("catalog_refresh")).toBe("off");
  });

  test("a hidden setting cannot be changed: typed error, nothing changes", () => {
    setConfigs(full());
    try {
      setConfig("usage_limit", { max_cost_usd: 1000 });
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SettingNotEditableError);
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as SettingNotEditableError).key).toBe("usage_limit");
      expect((e as Error).message).toContain('"usage_limit" is not editable');
      expect(isRetryableRun(e)).toBe(false);
    }
    expect(getSetting("usage_limit")).toEqual({ max_cost_usd: 5 });
  });

  test("an unknown key and a bad value are ConfigErrors that name the problem", () => {
    setConfigs(full());
    expect(() => setConfig("nope", 1)).toThrow(/Unknown setting "nope"/);
    expect(() => setConfig("concurrency", { max_requests: 0 })).toThrow(/Invalid value for concurrency: concurrency\.max_requests/);
    expect(getSetting("concurrency")).toEqual({ max_requests: 8, per_provider: { google: 4 } });
  });

  test("a user value is ignored once its setting becomes hidden", () => {
    setConfigs(full());
    setConfig("concurrency", { max_requests: 2 });
    setConfigs({ values: { concurrency: { max_requests: 8 } }, editable: [] });
    expect(getSetting("concurrency")).toEqual({ max_requests: 8 });
    expect(getConfigs()).toEqual({});
  });

  test("without setConfigs every setting is editable", () => {
    expect(Object.keys(getConfigs()).length).toBe(9);
    setConfig("usage_limit", { max_cost_usd: 3 });
    expect(getSetting("usage_limit")).toEqual({ max_cost_usd: 3 });
  });

  test("the returned values cannot be changed", () => {
    setConfigs(full());
    setConfig("concurrency", { max_requests: 2 });
    expect(() => {
      (getConfigs().concurrency as any).max_requests = 99;
    }).toThrow();
  });
});
