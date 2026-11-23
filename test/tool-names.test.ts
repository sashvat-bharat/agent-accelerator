import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { Agent, tool, fauxProvider, assertValidToolName, ConfigError } from "../src/index.ts";

const echo = tool({ description: "echo", input: z.object({}), execute: async () => "ECHO-RAN" });

// The model asks for `name`, then answers; returns what the run recorded for that one call.
async function callByName(name: string) {
  const faux = fauxProvider([{ toolCalls: [{ name, arguments: {} }] }, "done"]);
  const res = await new Agent({ ...faux.config, tools: { echo }, runRetries: 0 }).run("go");
  return res.toolResults[0]!;
}

describe("a tool name the model chooses is looked up among the agent's own tools", () => {
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
    it(`"${name}" is an unknown tool, not an inherited member of Object`, async () => {
      const r = await callByName(name);
      expect(r.isError).toBe(true);
      expect(String(r.result)).toContain("not found");
      expect(String(r.result)).not.toContain("execute is not a function");
    });
  }

  it("a real tool is still found, and a near miss still gets a suggestion", async () => {
    expect(String((await callByName("echo")).result)).toBe("ECHO-RAN");
    expect(String((await callByName("Echo")).result)).toBe("ECHO-RAN"); // case-insensitive
    expect(String((await callByName("ecoh")).result)).toContain("Did you mean 'echo'");
  });

  it("a tool may be called `constructor`: its own entry wins over the inherited one", async () => {
    const own = tool({ description: "own", input: z.object({}), execute: async () => "OWN-RAN" });
    const faux = fauxProvider([{ toolCalls: [{ name: "constructor", arguments: {} }] }, "done"]);
    const res = await new Agent({ ...faux.config, tools: { constructor: own }, runRetries: 0 }).run("go");
    expect(String(res.toolResults[0]!.result)).toBe("OWN-RAN");
  });
});

describe("tool names that cannot be registered", () => {
  it("`__proto__` is refused (it would set the prototype of the tool list, not add a tool)", () => {
    expect(() => assertValidToolName("__proto__")).toThrow(ConfigError);
    expect(() => tool({ name: "__proto__", description: "x", input: z.object({}), execute: async () => "" })).toThrow(
      /__proto__/
    );
  });

  it("ordinary names, including ones that look like built-ins, are still fine", () => {
    for (const ok of ["constructor", "toString", "get_status", "a-b", "__init__"]) {
      expect(() => assertValidToolName(ok)).not.toThrow();
    }
  });
});
