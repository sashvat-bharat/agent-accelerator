import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, imageTool, ConfigError, ValidationError } from "../src/index.ts";
import { toolContent } from "../src/tools/tool-content.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const OR = "openrouter/openai/gpt-image-2.6-flare";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "accel-imgtool-"));

const imageFetch = (calls: any[]) =>
  (async (_u: string, init: any) => {
    calls.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ data: [{ b64_json: Buffer.from(PNG).toString("base64"), media_type: "image/png" }], usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105, cost: 0.25 } }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;

// A groq-style chat model that calls make_image with each arguments object in turn, then answers.
function chatFetch(argsList: unknown[]) {
  let n = 0;
  return (async () => {
    const i = n++;
    const body =
      i < argsList.length
        ? { finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "make_image", arguments: JSON.stringify(argsList[i]) } }] } }
        : { finish_reason: "stop", message: { role: "assistant", content: "Done." } };
    return new Response(JSON.stringify({ id: "r", choices: [body], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}
const agentWith = (tools: any, argsList: unknown[]) =>
  new Agent({ model: "groq/p", apiKey: "k", baseUrl: "https://chat.test/v1", fetch: chatFetch(argsList), tools: { make_image: tools }, stateless: true, runRetries: 0, instructions: "x" });

describe("imageTool", () => {
  it("makes the picture, saves it under dir, tells the model the path, and counts the spend", async () => {
    const dir = tmp();
    const calls: any[] = [];
    const agent = agentWith(imageTool({ model: OR, dir, defaults: { apiKey: "k", fetch: imageFetch(calls), quality: "low" } }), [{ prompt: "A red fox in snow" }]);
    const res = await agent.run("draw");
    const file = path.join(dir, "a-red-fox-in-snow-1.png");
    expect(fs.readFileSync(file)).toEqual(Buffer.from(PNG));
    expect(JSON.stringify(res.toolResults)).toContain(file);
    expect(calls[0]).toMatchObject({ model: "openai/gpt-image-2.6-flare", prompt: "A red fox in snow", quality: "low" });
    const report = agent.usageReport();
    expect(report.workers).toHaveLength(1);
    expect(report.workers[0]).toMatchObject({ name: "make_image", role: "image", model: OR.replace("openrouter/", "openrouter/") });
    expect(report.total.cost.totalUsd).toBeGreaterThanOrEqual(0.25); // the picture's $0.25 is in the total
    expect(report.workers[0]!.cost.totalUsd).toBeCloseTo(0.25, 6);
  });

  it("never overwrites: a second picture with the same prompt gets the next number", async () => {
    const dir = tmp();
    const agent = agentWith(imageTool({ model: OR, dir, defaults: { apiKey: "k", fetch: imageFetch([]) } }), [{ prompt: "Logo" }, { prompt: "Logo" }]);
    await agent.run("draw twice");
    expect(fs.readdirSync(dir).sort()).toEqual(["logo-1.png", "logo-2.png"]);
  });

  it("the LLM sets only what `allow` lists, as enums of what the model accepts", async () => {
    const t = imageTool({ model: OR, allow: ["aspectRatio"], defaults: { apiKey: "k", fetch: imageFetch([]) } });
    const props = (t.parameters ?? (await import("../src/tools/schema.ts")).zodToJsonSchema(t.input as never)) as any;
    expect(Object.keys(props.properties).sort()).toEqual(["aspectRatio", "prompt"]);
    expect(props.properties.aspectRatio.enum).toContain("21:9");
    const plain = imageTool({ model: OR });
    expect(Object.keys((await import("../src/tools/schema.ts")).zodToJsonSchema(plain.input as never).properties as object)).toEqual(["prompt"]);
  });

  it("stops at maxImages: the model is told, and nothing more is requested or paid", async () => {
    const dir = tmp();
    const calls: any[] = [];
    const agent = agentWith(imageTool({ model: OR, dir, maxImages: 1, defaults: { apiKey: "k", fetch: imageFetch(calls) } }), [{ prompt: "one" }, { prompt: "two" }]);
    const res = await agent.run("draw two");
    expect(calls).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual(["one-1.png"]);
    expect(JSON.stringify(res.toolResults)).toContain("limit");
  });

  it("show: true returns the pictures to the model as media next to the path", async () => {
    const t = imageTool({ model: OR, dir: tmp(), show: true, defaults: { apiKey: "k", fetch: imageFetch([]) } });
    const out = (await t.execute({ prompt: "x" }, { toolCallId: "c", log: () => {}, stop: () => { throw new Error("stop"); } })) as any;
    expect(out).toEqual(toolContent([expect.stringContaining("Saved: "), { type: "image", image: PNG, mimeType: "image/png" }]) as any);
  });

  it("fails at creation for a wrong setup, before any paid run", () => {
    expect(() => imageTool({ model: "openai/gpt-image-1" })).toThrow(ConfigError);
    expect(() => imageTool({ model: "google/gemini-3.1-flash-lite-image", allow: ["quality"] })).toThrow(/no quality/);
    expect(() => imageTool({ model: OR, defaults: { aspectRatio: "9:1" } })).toThrow(ValidationError);
    expect(() => imageTool({ model: OR, maxImages: 0 })).toThrow(ConfigError);
  });
});
