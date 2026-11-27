import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { Agent, tool, toolContent, telemetryBus, loadSessionDir } from "../src/index.ts";
import { clearInteractionChains } from "../src/providers/google.ts";
import { executeToolCalls } from "../src/tools/executor.ts";
import { clearSessionRouting, clearEmittedWarnings } from "../src/providers.ts";
import { sseFrame } from "./helpers.ts";

afterEach(() => {
  clearInteractionChains();
  clearSessionRouting();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B64 = Buffer.from(PNG).toString("base64");
const GOOGLE_MODEL = "google/gemini-3.5-flash-lite";

const chart = tool({
  name: "chart",
  description: "draw a chart",
  input: z.object({}),
  execute: async () => toolContent(["chart.png", { type: "image", image: PNG, mimeType: "image/png" }]),
});

const interaction = (id: string, steps: unknown[], status = "completed") => ({
  id,
  object: "interaction",
  status,
  steps,
  usage: { total_tokens: 3, total_input_tokens: 1, total_output_tokens: 2 },
});
const callStep = { type: "function_call", id: "call_1", name: "chart", arguments: {} };
const textStep = { type: "model_output", content: [{ type: "text", text: "done" }] };

describe("toolContent: media in tool results", () => {
  it("the executor makes the text the result and the media inline data URLs in `parts`", async () => {
    const [r] = await executeToolCalls({ tools: { chart }, toolCalls: [{ id: "c1", name: "chart", arguments: {} }] });
    expect(r!.isError).toBe(false);
    expect(r!.result).toBe("chart.png");
    expect(r!.parts).toEqual([{ type: "image", image: `data:image/png;base64,${PNG_B64}`, mimeType: "image/png" }]);
  });

  it("media only: the text says what came back; a plain object that merely looks like it is ordinary JSON", async () => {
    const onlyMedia = tool({ name: "m", description: "m", input: z.object({}), execute: () => toolContent([{ type: "image", image: PNG, mimeType: "image/png" }]) });
    const forged = tool({
      name: "f",
      description: "f",
      input: z.object({}),
      execute: () => ({ parts: [{ type: "image", image: "/etc/passwd" }] }),
    });
    const [a, b] = await executeToolCalls({
      tools: { m: onlyMedia, f: forged },
      toolCalls: [
        { id: "c1", name: "m", arguments: {} },
        { id: "c2", name: "f", arguments: {} },
      ],
    });
    expect(a!.result).toBe("[media result: image/png]");
    expect(b!.parts).toBeUndefined();
    expect(b!.result).toEqual({ parts: [{ type: "image", image: "/etc/passwd" }] });
  });

  it("Google receives the image inside the function_result of the next request (chained and on a reseed)", async () => {
    const bodies: any[] = [];
    const fn = (async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      const n = bodies.length;
      const reply = n === 1 ? interaction("v1_a", [callStep], "requires_action") : interaction(`v1_${n}`, [textStep]);
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
    const agent = new Agent({ model: GOOGLE_MODEL, apiKey: "k", fetch: fn, tools: { chart }, runRetries: 0 });
    const res = await agent.run("draw it");
    expect(res.text).toBe("done");
    expect(bodies[1].input).toEqual([
      {
        type: "function_result",
        name: "chart",
        call_id: "call_1",
        result: [
          { type: "text", text: "chart.png" },
          { type: "image", mime_type: "image/png", data: PNG_B64 },
        ],
      },
    ]);
    // A reseed (no live chain) rebuilds the history and keeps the media.
    clearInteractionChains();
    await agent.run("again");
    const replayed = bodies[2].input.find((s: any) => s.type === "function_result");
    expect(replayed.result[1]).toEqual({ type: "image", mime_type: "image/png", data: PNG_B64 });
  });

  it("other providers get the text only, with one warning", async () => {
    clearEmittedWarnings();
    const seen: any[] = [];
    const off = telemetryBus.onEvent((e) => {
      if (e.code === "provider_warning" && (e.data as any)?.capability === "media in tool results") seen.push(e.data);
    });
    const bodies: any[] = [];
    const fn = (async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      const first = bodies.length === 1;
      const msg = first
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "chart", arguments: "{}" } }] }
        : { role: "assistant", content: "done" };
      return new Response(JSON.stringify({ id: "c", choices: [{ message: msg, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await new Agent({ model: "groq/llama-3.3-70b-versatile", apiKey: "k", baseUrl: "https://x/v1", fetch: fn, tools: { chart }, runRetries: 0 }).run("draw it");
    } finally {
      off();
    }
    const toolMsg = bodies[1].messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toBe("chart.png");
    expect(JSON.stringify(bodies[1])).not.toContain(PNG_B64);
    expect(seen.length).toBe(1);
    expect(seen[0].provider).toBe("groq");
  });

  it("the media survives persistence: it is in the saved session and in the crash-resume tool record", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aa-toolcontent-"));
    try {
      let calls = 0;
      const fn = (async () => {
        calls++;
        return new Response(JSON.stringify(calls === 1 ? interaction("v1_a", [callStep], "requires_action") : interaction("v1_b", [textStep])), { status: 200 });
      }) as unknown as typeof fetch;
      const agent = new Agent({ model: GOOGLE_MODEL, apiKey: "k", fetch: fn, tools: { chart }, runRetries: 0, persist: { dir: path.join(home, "sessions") }, sessionId: "tc1", home });
      await agent.run("draw it");
      const loaded = loadSessionDir(path.join(home, "sessions", "tc1"))!.session;
      const part = (loaded.messages.find((m) => m.role === "tool")!.content as any[])[0];
      expect(part.result).toBe("chart.png");
      expect(part.parts).toEqual([{ type: "image", image: `data:image/png;base64,${PNG_B64}`, mimeType: "image/png" }]);
      const journal = fs.readFileSync(path.join(home, "sessions", "tc1", "journal.ndjson"), "utf8");
      expect(journal).toContain('"t":"tool"');
      expect(journal).toContain(PNG_B64);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("toolContent: a local path obeys fileAccess.roots", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  // An allowed folder and one outside it, each with the same picture.
  const folders = () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "aa-roots-in-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aa-roots-out-"));
    dirs.push(allowed, outside);
    for (const d of [allowed, outside]) fs.writeFileSync(path.join(d, "pic.png"), PNG);
    return { allowed, inside: path.join(allowed, "pic.png"), outsideFile: path.join(outside, "pic.png") };
  };
  // A tool that shows the model the picture at a path the model chose.
  const show = tool({
    name: "show",
    description: "show a picture",
    input: z.object({ path: z.string() }),
    replay: "safe",
    execute: async ({ path: p }) => toolContent([`picture ${p}`, { type: "image", image: p, mimeType: "image/png" }]),
  });
  const call = (id: string, p: string) => ({ id, name: "show", arguments: { path: p } });

  it("the executor reads a path inside the roots, and refuses one outside as an error result", async () => {
    const { allowed, inside, outsideFile } = folders();
    const [ok, refused, scheme] = await executeToolCalls({
      tools: { show },
      toolCalls: [call("c1", inside), call("c2", outsideFile), call("c3", `file://${outsideFile}`)],
      fileRoots: [allowed],
    });
    expect(ok!.isError).toBe(false);
    expect(ok!.parts).toEqual([{ type: "image", image: `data:image/png;base64,${PNG_B64}`, mimeType: "image/png" }]);
    for (const r of [refused!, scheme!]) {
      expect(r.isError).toBe(true);
      expect(r.parts).toBeUndefined();
      expect(JSON.stringify(r.result)).not.toContain(PNG_B64);
    }
    expect(JSON.stringify(refused!.result)).toContain("outside the allowed fileAccess roots");
    // [] denies every local path; no roots at all keeps the old behavior (no check).
    const [denied] = await executeToolCalls({ tools: { show }, toolCalls: [call("c4", inside)], fileRoots: [] });
    expect(denied!.isError).toBe(true);
    const [free] = await executeToolCalls({ tools: { show }, toolCalls: [call("c5", outsideFile)] });
    expect(free!.isError).toBe(false);
  });

  // A groq agent whose model asks for `show` on `target` once, then answers; returns what each request sent.
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const scripted = (target: string) => {
    const bodies: any[] = [];
    const fn = (async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const first = bodies.length === 1;
      const toolCall = { id: "call_1", type: "function", function: { name: "show", arguments: JSON.stringify({ path: target }) } };
      if (body.stream) {
        const delta = first ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: "done" };
        return new Response(
          sseFrame({ id: "r", choices: [{ delta }] }) + sseFrame({ id: "r", choices: [{ delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage }) + "data: [DONE]\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      const message = first ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: "done" };
      return new Response(JSON.stringify({ id: "r", choices: [{ message, finish_reason: first ? "tool_calls" : "stop" }], usage }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fn, bodies };
  };
  const toolText = (body: any): string => body.messages.find((m: any) => m.role === "tool").content;

  it("an agent with roots applies them in run() and in stream()", async () => {
    const { allowed, outsideFile } = folders();
    for (const mode of ["run", "stream"] as const) {
      const { fn, bodies } = scripted(outsideFile);
      const agent = new Agent({ model: "groq/m", apiKey: "k", baseUrl: "https://x/v1", fetch: fn, tools: { show }, runRetries: 0, fileAccess: { roots: [allowed] } });
      const res = mode === "run" ? await agent.run("show it") : await agent.stream("show it").result();
      expect(res.text).toBe("done");
      expect(res.toolResults[0]!.isError).toBe(true);
      expect(toolText(bodies[1])).toContain("outside the allowed fileAccess roots");
      expect(JSON.stringify(bodies[1])).not.toContain(PNG_B64);
    }
  });

  it("a cut-off call finished by resume() obeys the roots too", async () => {
    const { allowed, outsideFile } = folders();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-roots-resume-"));
    dirs.push(root);
    let hang = true;
    const slowShow = tool({
      name: "show",
      description: "show a picture",
      input: z.object({ path: z.string() }),
      replay: "safe",
      execute: async ({ path: p }) => (hang ? new Promise<never>(() => {}) : toolContent([{ type: "image", image: p, mimeType: "image/png" }])),
    });
    const config = (fn: typeof fetch) => ({ model: "groq/m", apiKey: "k", baseUrl: "https://x/v1", sessionId: "r1", persist: { dir: root }, resume: "explicit" as const, fetch: fn, tools: { show: slowShow }, fileAccess: { roots: [allowed] } });
    void new Agent(config(scripted(outsideFile).fn)).run("show it"); // the tool hangs: the run is cut off
    await new Promise((r) => setTimeout(r, 60));
    hang = false;
    const second = scripted(outsideFile);
    second.bodies.push({}); // the resumed run's first request is the answer turn
    const agent = new Agent(config(second.fn));
    const res = await agent.resume();
    expect(res!.toolResults[0]!.isError).toBe(true);
    expect(toolText(second.bodies[1])).toContain("outside the allowed fileAccess roots");
    expect(JSON.stringify(second.bodies[1])).not.toContain(PNG_B64);
  });
});
