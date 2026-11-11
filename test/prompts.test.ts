import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { Agent, tool, DEFAULT_PROMPTS, ConfigError, executeToolCalls } from "../src/index.ts";
import { fillPrompt, resolvePrompts } from "../src/prompts/prompts.ts";
import { ensureToolPairing } from "../src/agent/loop.ts";
import { AgentContext } from "../src/agent/context.ts";
import { augmentSystemPromptWithStructuredOutput } from "../src/providers.ts";
import { OpenRouterChatCompletionsProvider } from "../src/providers/openrouter.ts";
import { OpenAICompatibleChatProvider } from "../src/providers/openai-compat.ts";

const GOOGLE = "google/gemini-3.5-flash-lite";
const interaction = (id = "v1_t") => ({
  id,
  object: "interaction",
  status: "completed",
  steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }],
  usage: { total_tokens: 3, total_input_tokens: 1, total_output_tokens: 2 },
});
function recorder() {
  const bodies: any[] = [];
  const fn = (async (_u: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(interaction()), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

describe("DEFAULT_PROMPTS and resolvePrompts", () => {
  it("ships every prompt as non-empty text without a trailing newline, frozen", () => {
    const names = Object.keys(DEFAULT_PROMPTS);
    expect(names.length).toBe(13);
    for (const n of names) {
      const text = (DEFAULT_PROMPTS as Record<string, string>)[n]!;
      expect(text.length).toBeGreaterThan(0);
      expect(text.endsWith("\n")).toBe(false);
    }
    expect(Object.isFrozen(DEFAULT_PROMPTS)).toBe(true);
    expect(DEFAULT_PROMPTS.subagentsTool).toContain("{{TOOLS}}");
  });

  // The shipped text is pinned exactly: an editor or formatter that reflows a prompt file changes what the model sees (and the prompt cache), so it must fail here.
  it("pins the shipped text of the short prompts exactly", () => {
    expect(DEFAULT_PROMPTS.reasoningDirective).toBe(
      "[Reasoning Directive]\n\n1. Use internal reasoning strictly for private planning and step-by-step thinking.\n2. Never attempt to execute tools or output final user deliverables inside reasoning.\n3. Once your reasoning is complete, output your final response or function calls directly in the standard response output."
    );
    expect(DEFAULT_PROMPTS.structuredOutput).toBe(
      "Return ONLY valid JSON matching this JSON Schema, with no markdown fences, no commentary, no extra text.\nSchema: {{schema}}"
    );
    expect(DEFAULT_PROMPTS.additionalContext).toBe("[Additional Context]\n{{context}}");
    expect(DEFAULT_PROMPTS.toolBridge).toBe("I have processed the tool results.");
    expect(DEFAULT_PROMPTS.toolTruncatedArguments).toBe(
      "Error: Tool '{{tool}}' arguments are truncated or incomplete and could not be parsed. Call the tool again with the complete JSON arguments. Do not explain the error, just retry the call."
    );
    expect(DEFAULT_PROMPTS.toolNotFound).toBe("Error: Tool '{{tool}}' not found.{{suggestion}}");
    expect(DEFAULT_PROMPTS.toolSchemaError).toBe(
      "Schema validation error for tool '{{tool}}': {{detail}} Received argument keys: [{{keys}}].{{expected}} Fix the arguments and call the tool again with corrected JSON. Do not explain the error, just retry the call."
    );
    expect(DEFAULT_PROMPTS.toolRepeatBlocked).toBe(
      "repeat_blocked: Tool '{{tool}}' was called again with identical arguments. The previous result is already available; reuse it or call the tool with different arguments."
    );
    expect(DEFAULT_PROMPTS.toolInterrupted).toBe(
      "Error: tool_call '{{tool}}' ({{id}}) has no result because the run was interrupted before it completed (recovered by ensureToolPairing). It may have partially executed: check the tool trace before repeating side-effecting work."
    );
    expect(DEFAULT_PROMPTS.workerReplied).toBe("[worker {{id}}] replied:\n{{text}}");
    expect(DEFAULT_PROMPTS.workerFailed).toBe("[worker {{id}}] failed: {{reason}}");
  });

  it("applies overrides per name and rejects unknown names, empty texts and non-objects with a ConfigError", () => {
    expect(resolvePrompts({ toolBridge: "OK." }).toolBridge).toBe("OK.");
    expect(resolvePrompts({ toolBridge: "OK." }).toolNotFound).toBe(DEFAULT_PROMPTS.toolNotFound);
    expect(() => resolvePrompts({ reasoningDirectiv: "x" } as any)).toThrow(/Unknown prompt "reasoningDirectiv".*reasoningDirective/);
    expect(() => resolvePrompts({ toolBridge: "  " })).toThrow(ConfigError);
    expect(() => resolvePrompts("x" as any)).toThrow(ConfigError);
    expect(() => new Agent({ model: GOOGLE, apiKey: "k", prompts: { nope: "x" } as any })).toThrow(ConfigError);
  });

  it("fillPrompt fills known markers (even with $ in the value) and leaves unknown ones as written", () => {
    expect(fillPrompt("a {{x}} b {{y}} c {{x}}", { x: "$&" })).toBe("a $& b {{y}} c $&");
  });
});

describe("overriding a prompt changes exactly what the model sees", () => {
  it("reasoningDirective is in the system instruction instead of the default", async () => {
    const { fn, bodies } = recorder();
    await new Agent({
      model: GOOGLE, apiKey: "k", fetch: fn, thinkingLevel: "low", instructions: "BASE",
      prompts: { reasoningDirective: "[My Directive] think quietly." },
    }).run("hi");
    expect(bodies[0].system_instruction).toBe("BASE\n\n[My Directive] think quietly.");
    const def = recorder();
    await new Agent({ model: GOOGLE, apiKey: "k", fetch: def.fn, thinkingLevel: "low", instructions: "BASE" }).run("hi");
    expect(def.bodies[0].system_instruction).toBe(`BASE\n\n${DEFAULT_PROMPTS.reasoningDirective}`);
  });

  it("additionalContext is the prefix of the user turn", async () => {
    const { fn, bodies } = recorder();
    await new Agent({ model: GOOGLE, apiKey: "k", fetch: fn, prompts: { additionalContext: "<ctx>{{context}}</ctx>" } }).run("hi", {
      additionalContext: "facts",
    });
    expect(bodies[0].input).toBe("<ctx>facts</ctx>\n\nhi");
  });

  it("tool refusals: not found, truncated arguments and schema errors use the override; repeat_blocked keeps its code", async () => {
    const t = tool({ name: "t", description: "d", input: z.object({ a: z.number() }), execute: () => "x" });
    const prompts = {
      toolTruncatedArguments: "CUT {{tool}}",
      toolNotFound: "NOPE {{tool}}{{suggestion}}",
      toolSchemaError: "BAD {{tool}} | {{detail}} | [{{keys}}]{{expected}}",
    };
    const [a, b, c] = await executeToolCalls({
      tools: { t },
      prompts: { ...DEFAULT_PROMPTS, ...prompts },
      toolCalls: [
        { id: "1", name: "t", arguments: { __truncated_raw: "{" } },
        { id: "2", name: "tt", arguments: {} },
        { id: "3", name: "t", arguments: { a: "x" } },
      ],
    });
    expect(a!.result).toBe("CUT t");
    expect(b!.result).toBe("NOPE tt Did you mean 't'?");
    expect(String(c!.result)).toMatch(/^BAD t \| [\s\S]+ \| \[a\]$/); // a tool built from `input` alone has no `parameters`, so {{expected}} is empty
    // Without overrides the old texts are unchanged.
    const [d] = await executeToolCalls({ tools: { t }, toolCalls: [{ id: "4", name: "zzz", arguments: {} }] });
    expect(d!.result).toBe("Error: Tool 'zzz' not found.");
  });

  it("the interrupted-call placeholder and the structured-output instruction use their override", () => {
    const ctx = new AgentContext("s");
    ctx.messages.push({ role: "user", content: "go" }, { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "send", arguments: {} }] });
    ensureToolPairing(ctx, { ...DEFAULT_PROMPTS, toolInterrupted: "LOST {{tool}} {{id}}" });
    expect((ctx.messages[2]!.content as any[])[0].result).toBe("LOST send c1");
    const spec = { name: "o", schema: { type: "object" } } as any;
    expect(augmentSystemPromptWithStructuredOutput("S", spec, "JSON for {{schema}}")).toBe('S\n\n[Structured Output]\nJSON for {"type":"object"}');
    expect(augmentSystemPromptWithStructuredOutput("S", spec)).toContain("Return ONLY valid JSON");
  });

  it("the bridge message between a tool result and the next user turn uses the override on OpenRouter and compatible endpoints", async () => {
    const history = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "t", arguments: {} }] },
      { role: "tool", name: "t", content: [{ type: "tool_result", id: "c1", name: "t", result: "r" }] },
      { role: "user", content: "next" },
    ] as any;
    const sse = () => new Response('data: {"id":"x","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    const plain = () => new Response(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
    for (const [provider, model] of [[new OpenRouterChatCompletionsProvider(), "a/b"], [new OpenAICompatibleChatProvider("groq", { baseUrl: "https://x/v1" }), "m"]] as const) {
      let body: any;
      const fetchImpl = (async (_u: string, init: any) => ((body = JSON.parse(init.body)), provider instanceof OpenRouterChatCompletionsProvider ? sse() : plain())) as unknown as typeof fetch;
      await provider.generate(model, { messages: history }, { apiKey: "k", fetch: fetchImpl, prompts: { structuredOutput: "x", toolBridge: "BRIDGE" } });
      expect(body.messages.some((m: any) => m.role === "assistant" && m.content === "BRIDGE")).toBe(true);
      await provider.generate(model, { messages: history }, { apiKey: "k", fetch: fetchImpl });
      expect(body.messages.some((m: any) => m.content === "I have processed the tool results.")).toBe(true);
    }
  });
});

describe("the tool manuals and worker headers are prompts too", () => {
  const ctx = { toolCallId: "call_1", log: () => {}, stop: (): never => { throw new Error("stop"); } } as any;
  const handler = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body);
    const text = `w:${body.messages.at(-1).content}`;
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    return body.stream
      ? new Response(`data: ${JSON.stringify({ id: "r", choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ id: "r", choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify({ id: "r", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  it("subagentsTool and the worker headers change; the scheduled tool manual fills its own tools", async () => {
    const parent = new Agent({
      model: "groq/p", apiKey: "k", baseUrl: "https://x/v1", fetch: handler, sessionId: "pp",
      dynamicSubagents: { model: "groq/w", allowScheduledActions: true, tools: { lookup: tool({ description: "d", input: z.object({}), execute: () => "x" }) } },
      prompts: {
        subagentsTool: "MY SUBAGENTS MANUAL. Tools: {{TOOLS}}. {{LIMIT}}",
        scheduledActionsTool: "MY SCHEDULER MANUAL. Tools: {{TOOLS}}.",
        workerReplied: "<{{id}}>{{text}}</{{id}}>",
        workerFailed: "FAILED {{id}}: {{reason}}",
      },
    });
    expect(parent.tools["subagents"]!.description).toBe("MY SUBAGENTS MANUAL. Tools: lookup. There is no limit on open workers. Close the ones you are done with: each one keeps its whole conversation.");
    expect(parent.tools["scheduled_actions"]!.description).toBe("MY SCHEDULER MANUAL. Tools: lookup.");
    const out = String(await parent.tools["subagents"]!.execute({ command: "spawn", name: "r", task: "hello" }, ctx));
    expect(out).toMatch(/^<r-[0-9a-f]{8}>w:hello<\/r-[0-9a-f]{8}>$/);
  });

  it("workers inherit the overrides", () => {
    const parent = new Agent({
      model: "groq/p", apiKey: "k", baseUrl: "https://x/v1", fetch: handler,
      dynamicSubagents: { model: "groq/w" }, prompts: { toolBridge: "INHERITED" },
    });
    expect(parent.inheritableConfig().prompts).toEqual({ toolBridge: "INHERITED" });
  });
});
