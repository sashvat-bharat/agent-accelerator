import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Agent,
  ModelNotAllowedError,
  getConfigs,
  setConfig,
  setConfigs,
  setHome,
  setModel,
  setModels,
  setSubAgentModel,
  telemetryBus,
} from "../src/index.ts";
import { getSetting, resetConfigs } from "../src/config/settings.ts";
import { chosenModel, chosenSubAgentModel, resetModels } from "../src/config/models.ts";
import { invalidateUserFile } from "../src/config/user-file.ts";

let home = "";
let events: Array<{ code: string; data: any }> = [];
let off: () => void;

beforeEach(() => {
  home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "userconf-")), "home"); // the home itself does not exist yet
  setHome(home);
  events = [];
  off = telemetryBus.onEvent((e) => events.push({ code: e.code, data: e.data }));
});
afterEach(() => {
  off();
  resetConfigs();
  resetModels();
  setHome(undefined);
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

const file = () => path.join(home, "configs.json");
const written = () => JSON.parse(fs.readFileSync(file(), "utf8"));
// What a restart does: forget what this process read and read the file again.
const restart = () => invalidateUserFile();
const codes = () => events.map((e) => e.code);

const models = () => ({
  default: { model: "groq/main", sub_agent_model: "groq/worker" },
  providers: { groq: { models: ["main", "worker", "other"] } },
});

describe("configs.json", () => {
  test("reading creates nothing", () => {
    setConfigs({ editable: ["concurrency"] });
    expect(getConfigs()).toEqual({ concurrency: null });
    expect(fs.existsSync(home)).toBe(false);
  });

  test("the first write creates the home and a file with a version", () => {
    setConfig("concurrency", { max_requests: 2 });
    expect(written()).toEqual({ version: 1, concurrency: { max_requests: 2 } });
    expect((fs.statSync(file()).mode & 0o777).toString(8)).toBe("600");
    expect(fs.readdirSync(home).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("a saved value survives a restart; null removes it from the file", () => {
    setConfig("concurrency", { max_requests: 2 });
    setConfig("catalog_refresh", "off");
    restart();
    expect(getSetting("concurrency")).toEqual({ max_requests: 2 });
    expect(getSetting("catalog_refresh")).toBe("off");
    setConfig("concurrency", null);
    expect(written()).toEqual({ version: 1, catalog_refresh: "off" });
  });

  test("a hand edit is read at the next start", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ concurrency: { max_requests: 5 } })); // no version: counts as 1
    expect(getSetting("concurrency")).toEqual({ max_requests: 5 });
  });

  test("a hand edit of a hidden key is ignored with a warning and the developer's value wins", () => {
    setConfigs({ values: { usage_limit: { max_cost_usd: 5 } }, editable: ["concurrency"] });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: 1, usage_limit: { max_cost_usd: 1000 }, concurrency: { max_requests: 3 } }));
    expect(getSetting("usage_limit")).toEqual({ max_cost_usd: 5 });
    expect(getSetting("concurrency")).toEqual({ max_requests: 3 }); // the allowed key still loads
    const w = events.filter((e) => e.code === "config.file_ignored_key");
    expect(w.map((e) => [e.data.key, e.data.reason])).toEqual([["usage_limit", "hidden"]]);
    getSetting("usage_limit");
    expect(events.filter((e) => e.code === "config.file_ignored_key").length).toBe(1); // reported once
  });

  test("a file loaded before the policy is checked when the policy arrives", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: 1, concurrency: { max_requests: 3 } }));
    expect(getSetting("concurrency")).toEqual({ max_requests: 3 }); // no policy yet: everything editable
    setConfigs({ values: { concurrency: { max_requests: 8 } }, editable: [] });
    expect(getSetting("concurrency")).toEqual({ max_requests: 8 });
    expect(events.some((e) => e.code === "config.file_ignored_key" && e.data.reason === "hidden")).toBe(true);
  });

  test("unknown keys and invalid values are ignored with a warning, the rest loads", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: 1, nope: 1, catalog_refresh: "maybe", concurrency: { max_requests: 4 } }));
    expect(getSetting("concurrency")).toEqual({ max_requests: 4 });
    expect(getSetting("catalog_refresh")).toBeUndefined();
    expect(events.filter((e) => e.code === "config.file_ignored_key").map((e) => e.data.reason).sort()).toEqual(["invalid", "unknown"]);
  });

  test("unknown keys are kept when the file is rewritten", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: 1, future_setting: { a: 1 } }));
    setConfig("concurrency", { max_requests: 2 });
    expect(written()).toEqual({ version: 1, future_setting: { a: 1 }, concurrency: { max_requests: 2 } });
  });

  test("a corrupt file is set aside, reported, and defaults apply", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file(), "{ not json");
    expect(getSetting("concurrency")).toBeUndefined();
    expect(codes()).toContain("config.file_invalid");
    expect(fs.readdirSync(home).some((f) => f.startsWith("configs.json.corrupt-"))).toBe(true);
    setConfig("concurrency", { max_requests: 2 }); // writing works again
    expect(written().concurrency).toEqual({ max_requests: 2 });
  });

  test("a damaged file is restored from its backup", () => {
    setConfig("concurrency", { max_requests: 2 });
    setConfig("catalog_refresh", "on"); // the previous version is now configs.json.bak
    fs.writeFileSync(file(), "garbage");
    restart();
    expect(getSetting("concurrency")).toEqual({ max_requests: 2 });
    expect(codes()).toContain("config.file_restored");
    expect(written().version).toBe(1); // the good text is back in place
  });

  test("a file of another version is ignored", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: 2, concurrency: { max_requests: 9 } }));
    expect(getSetting("concurrency")).toBeUndefined();
    expect(events.find((e) => e.code === "config.file_invalid")?.data.reason).toBe("version");
    expect(fs.existsSync(file())).toBe(true); // not renamed: it is a newer format, not damage
  });

  test("a failed write reports a ConfigError and changes nothing", () => {
    fs.mkdirSync(path.dirname(home), { recursive: true });
    fs.writeFileSync(home, "a file where the home folder should be");
    expect(() => setConfig("concurrency", { max_requests: 2 })).toThrow(/Could not save/);
    expect(getSetting("concurrency")).toBeUndefined();
  });

  test("a change by another process is not lost", () => {
    setConfig("concurrency", { max_requests: 2 });
    // another process saves a different key while this one still holds the old copy in memory
    const body = written();
    fs.writeFileSync(file(), JSON.stringify({ ...body, catalog_refresh: "off" }));
    setConfig("compat", { no_stream_options: true });
    expect(written()).toEqual({ version: 1, concurrency: { max_requests: 2 }, catalog_refresh: "off", compat: { no_stream_options: true } });
  });
});

describe("setModel / setSubAgentModel", () => {
  test("with a list: only listed models, saved in the file", () => {
    setModels(models());
    setModel("groq/other");
    setSubAgentModel("groq/main");
    expect(written()).toEqual({ version: 1, model: "groq/other", sub_agent_model: "groq/main" });
    expect(() => setModel("groq/nope")).toThrow(ModelNotAllowedError);
    expect(() => setSubAgentModel("openai/gpt-6")).toThrow(ModelNotAllowedError);
    expect(written().model).toBe("groq/other"); // a refused choice saves nothing
  });

  test("a bad id is a ConfigError", () => {
    expect(() => setModel("")).toThrow(/setModel expects/);
    expect(() => setSubAgentModel(5 as never)).toThrow(/setSubAgentModel expects/);
    expect(fs.existsSync(home)).toBe(false);
  });

  test("without a list any id is accepted", () => {
    setModel("anything/goes");
    expect(chosenModel()).toBe("anything/goes");
  });

  test("the choice is the saved one, else the program's default, else nothing", () => {
    expect(chosenModel()).toBeUndefined();
    setModels(models());
    expect(chosenModel()).toBe("groq/main");
    expect(chosenSubAgentModel()).toBe("groq/worker");
    setModel("groq/other");
    expect(chosenModel()).toBe("groq/other");
    expect(chosenSubAgentModel()).toBe("groq/worker");
    restart();
    expect(chosenModel()).toBe("groq/other"); // survives a restart
  });

  test("a saved model that left the list is ignored with a warning", () => {
    setModels(models());
    setModel("groq/other");
    setModels({ default: { model: "groq/main", sub_agent_model: "groq/main" }, providers: { groq: { models: ["main"] } } });
    expect(chosenModel()).toBe("groq/main");
    expect(events.filter((e) => e.code === "config.saved_model_ignored").length).toBe(1);
    chosenModel();
    expect(events.filter((e) => e.code === "config.saved_model_ignored").length).toBe(1); // once
  });

  test("an Agent without a model uses the choice; an explicit model wins", () => {
    setModels(models());
    setModel("groq/other");
    const base = { apiKey: "k", baseUrl: "https://example.test/v1" };
    expect(new Agent(base).modelStringOrSpec).toBe("groq/other");
    expect(new Agent({ ...base, model: "groq/main" }).modelStringOrSpec).toBe("groq/main");
    expect(new Agent({ ...base, dynamicSubagents: { enabled: true } }).subagentModel).toBe("groq/worker");
    setSubAgentModel("groq/other");
    expect(new Agent({ ...base, dynamicSubagents: { enabled: true } }).subagentModel).toBe("groq/other");
  });
});

describe("crash safety", () => {
  test("a process killed while saving leaves a valid file and the next save works", async () => {
    const script = path.join(path.dirname(home), "writer.ts");
    fs.writeFileSync(
      script,
      `import { setConfig } from ${JSON.stringify(path.resolve("src/index.ts"))};
       process.stdout.write("ready\\n");
       for (let i = 1; ; i++) setConfig("concurrency", { max_requests: 1 + (i % 50) });`
    );
    for (let round = 0; round < 4; round++) {
      const child = Bun.spawn(["bun", script], { env: { ...process.env, AGENT_ACCEL_HOME: home, AGENT_CATALOG_REFRESH: "off" }, stdout: "pipe", stderr: "ignore" });
      const reader = child.stdout.getReader();
      await reader.read(); // the child is running
      await new Promise((r) => setTimeout(r, 60 + round * 40));
      child.kill("SIGKILL");
      await child.exited;
      if (fs.existsSync(file())) {
        const body = written(); // never a torn file
        expect(body.version).toBe(1);
        expect(body.concurrency.max_requests).toBeGreaterThanOrEqual(1);
      }
    }
    restart();
    const t0 = Date.now();
    setConfig("catalog_refresh", "on"); // a mutex or temp file left by the killed writer must not block this
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(written().catalog_refresh).toBe("on");
    expect(getConfigs().concurrency).toBeDefined();
  });
});
