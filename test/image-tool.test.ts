import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, imageTool, ConfigError, ValidationError, BudgetExceededError, loadSessionDir } from "../src/index.ts";
import { sessionDirFor } from "../src/session/store.ts";
import { generateImage, imagePriceSource } from "../src/image/generate.ts";
import { sseFrame } from "./helpers.ts";
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

describe("imageTool: the pictures are the agent's spending", () => {
  // A chat model that asks for all these pictures in ONE turn, then answers; it answers "Done." once it has tool results.
  const batchChat = (argsList: unknown[]) =>
    (async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      const asked = body.messages.some((m: any) => m.role === "tool");
      const calls = argsList.map((a, i) => ({ id: `call_${i}`, type: "function", function: { name: "make_image", arguments: JSON.stringify(a) } }));
      const done = asked || argsList.length === 0;
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (body.stream) {
        const delta = done ? { content: "Done." } : { tool_calls: calls.map((c, index) => ({ index, ...c })) };
        return new Response(
          sseFrame({ id: "r", choices: [{ delta }] }) + sseFrame({ id: "r", choices: [{ delta: {}, finish_reason: done ? "stop" : "tool_calls" }], usage }) + "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      const choice = done
        ? { finish_reason: "stop", message: { role: "assistant", content: "Done." } }
        : { finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: calls } };
      return new Response(JSON.stringify({ id: "r", choices: [choice], usage }), { status: 200 });
    }) as unknown as typeof fetch;
  // Two pictures asked in one turn, made one after the other ($0.25 each, reported by the provider).
  const twoInOneTurn = (calls: any[], extra: Record<string, unknown>) => {
    const make = imageTool({ model: OR, dir: tmp(), defaults: { apiKey: "k", fetch: imageFetch(calls) } });
    make.maxConcurrency = 1;
    return new Agent({ model: "groq/p", apiKey: "k", baseUrl: "https://chat.test/v1", fetch: batchChat([{ prompt: "a" }, { prompt: "b" }]), tools: { make_image: make }, stateless: true, runRetries: 0, ...extra });
  };

  it("counts toward usageLimit: the next picture is refused and the run ends", async () => {
    const calls: any[] = [];
    const agent = twoInOneTurn(calls, { usageLimit: { maxCostUsd: 0.2 } });
    const err = await agent.run("draw two").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(calls).toHaveLength(1); // the second picture was never requested
    expect(agent.usageReport().workers[0]!.cost.totalUsd).toBeCloseTo(0.25, 6);
  });

  it("counts toward the run budget the same way", async () => {
    const calls: any[] = [];
    const agent = twoInOneTurn(calls, { budget: { maxCostUsd: 0.2 } });
    expect(await agent.run("draw two").catch((e: unknown) => e)).toBeInstanceOf(BudgetExceededError);
    expect(calls).toHaveLength(1);
  });

  it("is saved with the session, comes back on import, and starts the chat cap after a restart", async () => {
    const root = tmp();
    const config = (extra: Record<string, unknown> = {}) => ({
      model: "groq/p",
      apiKey: "k",
      baseUrl: "https://chat.test/v1",
      sessionId: "s1",
      persist: { dir: root },
      runRetries: 0,
      tools: { make_image: imageTool({ model: OR, dir: tmp(), defaults: { apiKey: "k", fetch: imageFetch([]) } }) },
      fetch: batchChat([{ prompt: "a" }]),
      ...extra,
    });
    await new Agent(config()).run("draw");
    const saved = loadSessionDir(sessionDirFor(root, "s1"))!.session;
    expect(saved.fixedUsage).toEqual([expect.objectContaining({ id: "make_image", role: "image", status: "fixed" })]);
    const restored = new Agent(config());
    restored.importSession(saved);
    const lines = restored.usageReport().workers.filter((w) => w.role === "image");
    expect(lines).toHaveLength(1); // back on the tool's own line, not a second one beside it
    const line = lines[0]!;
    expect(line.cost.totalUsd).toBeCloseTo(0.25, 6);
    expect(line.cost.source).toBe("provider");
    // A cap below what the saved session already spent stops the next run before any request.
    let requests = 0;
    const capped = new Agent(config({ usageLimit: { maxCostUsd: 0.2 }, fetch: (async () => (requests++, new Response("{}"))) as unknown as typeof fetch }));
    expect(await capped.run("again").catch((e: unknown) => e)).toBeInstanceOf(BudgetExceededError);
    expect(requests).toBe(0);
  });

  it("one tool object given to two agents: each counts only its own pictures", async () => {
    const make = imageTool({ model: OR, dir: tmp(), defaults: { apiKey: "k", fetch: imageFetch([]) } });
    const a = agentWith(make, [{ prompt: "a" }]);
    const b = agentWith(make, []);
    await a.run("draw");
    await b.run("nothing");
    expect(a.usageReport().workers[0]!.cost.totalUsd).toBeCloseTo(0.25, 6);
    expect(b.usageReport().workers[0]!.turns).toBe(0);
  });

  it("a fixed worker's pictures are listed and saved under it", async () => {
    const root = tmp();
    const helper = new Agent({
      name: "artist",
      description: "Draws.",
      instructions: "Draw.",
      model: "groq/h",
      apiKey: "k",
      baseUrl: "https://helper.test/v1",
      fetch: batchChat([{ prompt: "a" }]),
      tools: { make_image: imageTool({ model: OR, dir: tmp(), defaults: { apiKey: "k", fetch: imageFetch([]) } }) },
    });
    const leadFetch = (async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      const asked = body.messages.some((m: any) => m.role === "tool");
      const choice = asked
        ? { finish_reason: "stop", message: { role: "assistant", content: "ok" } }
        : { finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "artist", arguments: JSON.stringify({ task: "draw" }) } }] } };
      return new Response(JSON.stringify({ id: "r", choices: [choice], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const lead = new Agent({ model: "groq/p", apiKey: "k", baseUrl: "https://lead.test/v1", fetch: leadFetch, subagents: [helper], sessionId: "lead", persist: { dir: root }, runRetries: 0 });
    await lead.run("ask the artist");
    const artist = lead.usageReport().workers.find((w) => w.name === "artist")!;
    expect(artist.workers.find((w) => w.role === "image")!.cost.totalUsd).toBeCloseTo(0.25, 6);
    expect(lead.usageReport().total.cost.totalUsd).toBeCloseTo(0.25, 6); // the chat models are unpriced
    const saved = loadSessionDir(sessionDirFor(root, "lead"))!.session.fixedUsage!;
    expect(saved[0]!.workers).toEqual([expect.objectContaining({ id: "make_image", role: "image" })]);
  });

  it("a worker started with agent.workers lists its pictures, live, closed and after a restart", async () => {
    const root = tmp();
    const make = imageTool({ model: OR, dir: tmp(), defaults: { apiKey: "k", fetch: imageFetch([]) } });
    const config = { model: "groq/p", apiKey: "k", baseUrl: "https://chat.test/v1", fetch: batchChat([{ prompt: "a" }]), sessionId: "boss", persist: { dir: root }, runRetries: 0, dynamicSubagents: { model: "groq/w", tools: { make_image: make } } };
    const boss = new Agent(config);
    const info = await boss.workers.spawn({ name: "painter", instructions: "Paint.", task: "paint", tools: ["make_image"] });
    const pictures = (agent: Agent) => agent.usageReport().workers.find((w) => w.name === "painter")!.workers.find((w) => w.role === "image");
    expect(pictures(boss)!.cost.totalUsd).toBeCloseTo(0.25, 6);
    boss.workers.close(info.id);
    expect(pictures(boss)!.cost.totalUsd).toBeCloseTo(0.25, 6);
    const later = new Agent(config); // a restart: the closed worker is read from its saved session
    expect(pictures(later)!.cost.totalUsd).toBeCloseTo(0.25, 6);
    expect(later.usageReport().total.cost.totalUsd).toBeCloseTo(0.25, 6);
  });

  it("says where a picture's price came from: the provider's reported cost or the price table", async () => {
    const reported = await generateImage({ model: OR, prompt: "x", apiKey: "k", fetch: imageFetch([]) });
    expect(imagePriceSource(reported)).toBe("provider");
    const unreported = (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG).toString("base64"), media_type: "image/png" }], usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105 } }), { status: 200 })) as unknown as typeof fetch;
    const tabled = await generateImage({ model: OR, prompt: "x", apiKey: "k", fetch: unreported });
    expect(tabled.usage.cost?.totalCost).toBeGreaterThan(0);
    expect(imagePriceSource(tabled)).toBe("catalog");
  });
});
