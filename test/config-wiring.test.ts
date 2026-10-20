import { describe, it, expect, afterEach } from "bun:test";
import { Agent, tool, z, telemetryBus, clearInteractionChains, clearSessionRouting, clearEmittedWarnings } from "../src/index.ts";

const ORIGINAL_WARN = console.warn;
afterEach(() => {
  console.warn = ORIGINAL_WARN;
  clearInteractionChains();
  clearSessionRouting();
});

const GOOGLE_MODEL = "google/gemini-3.5-flash-lite";
const textInteraction = (id = "v1_t") => ({
  id,
  object: "interaction",
  status: "completed",
  steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }],
  usage: { total_tokens: 3, total_input_tokens: 1, total_output_tokens: 2 },
});
const chat = (text = "ok") => ({
  id: "c",
  choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

/** A `fetch` double that records parsed bodies/headers and replies from `reply`. */
function recorder(reply: (n: number, body: any) => Response) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fn = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    return reply(calls.length, body);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("canonical option names are honored", () => {
  it("`thinking` wins over `thinkingLevel`, and accepts { level }", () => {
    expect(new Agent({ model: GOOGLE_MODEL, apiKey: "k", thinking: "low", thinkingLevel: "high" }).thinkingConfig?.level).toBe("low");
    expect(new Agent({ model: GOOGLE_MODEL, apiKey: "k", thinking: { level: "medium" } }).thinkingConfig?.level).toBe("medium");
    expect(new Agent({ model: GOOGLE_MODEL, apiKey: "k", thinkingLevel: "high" }).thinkingConfig?.level).toBe("high");
  });

  it("per-run `thinking` reaches the request", async () => {
    const { fn, calls } = recorder(() => new Response(JSON.stringify(textInteraction()), { status: 200 }));
    const agent = new Agent({ model: GOOGLE_MODEL, apiKey: "k", fetch: fn });
    await agent.run("hi", { thinking: "minimal" });
    expect(calls[0]!.body.generation_config.thinking_level).toBe("minimal");
  });

  it("`midSession.whenBusy` wins over legacy `mode`", () => {
    expect(new Agent({ model: GOOGLE_MODEL, apiKey: "k", midSession: { whenBusy: "steer", mode: "queue" } }).midSessionMode).toBe("steer");
    expect(new Agent({ model: GOOGLE_MODEL, apiKey: "k", midSession: { mode: "queue" } }).midSessionMode).toBe("queue");
    expect(new Agent({ model: GOOGLE_MODEL, apiKey: "k" }).midSessionMode).toBe("auto");
  });

  it("`workerTimeoutMs` / `modelMaySetTimeout` map to the worker timeout", () => {
    const dyn = (d: object) =>
      new Agent({ model: GOOGLE_MODEL, apiKey: "k", dynamicSubagents: { model: GOOGLE_MODEL, ...d } }).dynamicSubagents!.timeout;
    expect(dyn({ workerTimeoutMs: 1234 })).toBe(1234);
    expect(dyn({ timeout: 99 })).toBe(99);
    expect(dyn({ modelMaySetTimeout: true })).toBe(-1);
    expect(dyn({})).toBe(0);
  });

  it("`googleTier: paid` keeps a chained interaction alive past the free 23h gate", async () => {
    const run = async (googleTier?: "paid") => {
      clearInteractionChains();
      clearSessionRouting();
      const { fn, calls } = recorder((n) => new Response(JSON.stringify(textInteraction(`v1_${n}`)), { status: 200 }));
      const agent = new Agent({ model: GOOGLE_MODEL, apiKey: "k", fetch: fn, ...(googleTier ? { googleTier } : {}) });
      await agent.run("one");
      const realNow = Date.now;
      (Date as any).now = () => realNow() + 24 * 3600 * 1000;
      try {
        await agent.run("two");
      } finally {
        (Date as any).now = realNow;
      }
      return calls[1]!.body.previous_interaction_id as string | undefined;
    };
    expect(await run()).toBeUndefined(); // free tier: chain expired locally -> reseeded
    expect(await run("paid")).toBe("v1_1"); // paid tier: still chained
  });
});

describe("generation + call controls are forwarded", () => {
  const groq = (extra: object = {}, fn?: typeof fetch) =>
    new Agent({ model: "groq/llama-3.3-70b-versatile", apiKey: "k", baseUrl: "https://api.groq.com/openai/v1", ...(fn ? { fetch: fn } : {}), ...extra });

  it("Chat Completions: sampling/maxOutputTokens/stop/seed, with per-run overrides merged per key", async () => {
    const { fn, calls } = recorder(() => new Response(JSON.stringify(chat()), { status: 200 }));
    const agent = groq({ sampling: { temperature: 0.2, topP: 0.9 }, maxOutputTokens: 100, stop: "END", seed: 7 }, fn);
    await agent.run("hi");
    expect(calls[0]!.body).toMatchObject({ temperature: 0.2, top_p: 0.9, max_tokens: 100, stop: ["END"], seed: 7 });
    await agent.run("again", { maxOutputTokens: 50, sampling: { temperature: 0.5 } });
    expect(calls[1]!.body).toMatchObject({ temperature: 0.5, top_p: 0.9, max_tokens: 50, stop: ["END"], seed: 7 });
  });

  it("sends none of them when unset (strict endpoints stay untouched)", async () => {
    const { fn, calls } = recorder(() => new Response(JSON.stringify(chat()), { status: 200 }));
    await groq({}, fn).run("hi");
    for (const k of ["temperature", "top_p", "max_tokens", "stop", "seed"]) expect(calls[0]!.body[k]).toBeUndefined();
  });

  it("Google: max_output_tokens is sent; stop and seed warn on the bus instead of vanishing", async () => {
    clearEmittedWarnings();
    console.warn = () => {};
    const seen: string[] = [];
    const off = telemetryBus.onEvent((e) => e.code === "provider_warning" && seen.push(e.data?.capability));
    try {
      const { fn, calls } = recorder(() => new Response(JSON.stringify(textInteraction()), { status: 200 }));
      await new Agent({ model: GOOGLE_MODEL, apiKey: "k", fetch: fn, maxOutputTokens: 77, stop: ["X"], seed: 3 }).run("hi");
      expect(calls[0]!.body.generation_config.max_output_tokens).toBe(77);
      expect(JSON.stringify(calls[0]!.body)).not.toContain('"seed"');
      expect(seen).toContain("stop sequences");
      expect(seen).toContain("seed");
    } finally {
      off();
    }
  });

  it("OpenAI Responses: max_output_tokens + temperature are sent", async () => {
    const { fn, calls } = recorder(
      () => new Response(JSON.stringify({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200 })
    );
    await new Agent({ model: "openai/gpt-4o", apiKey: "k", fetch: fn, maxOutputTokens: 64, sampling: { temperature: 0.1 } }).run("hi");
    expect(calls[0]!.body).toMatchObject({ max_output_tokens: 64, temperature: 0.1 });
  });

  it("`toolChoice: required` forces the FIRST turn only, so the run can still finish", async () => {
    const lookup = tool({ description: "lookup", input: z.object({}), execute: async () => "found" });
    const { fn, calls } = recorder((n) =>
      n === 1
        ? new Response(JSON.stringify({ ...textInteraction("v1_a"), status: "requires_action", steps: [{ type: "function_call", id: "call_1", name: "lookup", arguments: {} }] }), { status: 200 })
        : new Response(JSON.stringify(textInteraction("v1_b")), { status: 200 })
    );
    const res = await new Agent({ model: GOOGLE_MODEL, apiKey: "k", fetch: fn, tools: { lookup }, toolChoice: "required" }).run("go");
    expect(res.text).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.generation_config.tool_choice).toEqual({ allowed_tools: { mode: "any", tools: ["lookup"] } });
    expect(calls[1]!.body.generation_config?.tool_choice).toBeUndefined();
  });

  it("`toolChoice: { tool }` pins a function; `none` holds for every turn", async () => {
    const lookup = tool({ description: "lookup", input: z.object({}), execute: async () => "found" });
    const { fn, calls } = recorder(() => new Response(JSON.stringify(textInteraction()), { status: 200 }));
    await new Agent({ model: GOOGLE_MODEL, apiKey: "k", fetch: fn, tools: { lookup }, toolChoice: { tool: "lookup" } }).run("go");
    expect(calls[0]!.body.generation_config.tool_choice).toEqual({ allowed_tools: { mode: "any", tools: ["lookup"] } });
    const second = recorder(() => new Response(JSON.stringify(textInteraction()), { status: 200 }));
    await new Agent({ model: GOOGLE_MODEL, apiKey: "k", fetch: second.fn, tools: { lookup } }).run("go", { toolChoice: "none" });
    expect(second.calls[0]!.body.generation_config.tool_choice).toEqual({ allowed_tools: { mode: "none" } });
  });

  it("`retry.maxRetries: 0` disables retries; the default retries a 503", async () => {
    const run = async (retry?: { maxRetries: number }) => {
      let n = 0;
      const fn = (async () => {
        n++;
        return n === 1 ? new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 }) : new Response(JSON.stringify(chat()), { status: 200 });
      }) as unknown as typeof fetch;
      const outcome = await groq({ ...(retry ? { retry: { ...retry, maxDelayMs: 10 } } : { retry: { maxDelayMs: 10 } }) }, fn).run("hi").then(() => "ok", () => "failed");
      return { outcome, n };
    };
    expect(await run({ maxRetries: 0 })).toEqual({ outcome: "failed", n: 1 });
    expect(await run()).toEqual({ outcome: "ok", n: 2 });
  });

  it("`env` supplies the API key without touching process.env", async () => {
    const { fn, calls } = recorder(() => new Response(JSON.stringify(chat()), { status: 200 }));
    const agent = new Agent({ model: "groq/llama-3.3-70b-versatile", baseUrl: "https://api.groq.com/openai/v1", env: { GROQ_API_KEY: "from-env-option" }, fetch: fn });
    await agent.run("hi");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer from-env-option");
  });
});

describe("budgets, limits and worker inheritance are enforced", () => {
  const callTurn = (id: string, args: object = {}, name = "lookup") => ({
    ...textInteraction(id),
    status: "requires_action",
    steps: [{ type: "function_call", id: `call_${id}`, name, arguments: args }],
  });
  const lookup = tool({ description: "lookup", input: z.object({ n: z.number().optional() }), execute: async () => "found" });

  it("budget.maxTotalTokens stops the run mid-way and carries partial usage; counters reset per run", async () => {
    let n = 0;
    const { fn, calls } = recorder(() => {
      n++;
      // The first run keeps calling the tool (3 tokens/turn); later runs just answer.
      return new Response(JSON.stringify(n <= 2 ? callTurn(`v1_${n}`, { n }) : textInteraction(`v1_${n}`)), { status: 200 });
    });
    const agent = new Agent({ model: GOOGLE_MODEL, apiKey: "k", fetch: fn, tools: { lookup }, budget: { maxTotalTokens: 5 } });
    const err: any = await agent.run("go").then(() => null, (e) => e);
    expect(err?.code).toBe("budget_exceeded");
    expect(calls).toHaveLength(2); // turn 2 pushed usage to 6 > 5 -> no third request
    expect(err.partial.turns).toBe(2);
    // A fresh run starts from zero again.
    clearInteractionChains();
    const ok = await agent.run("simple");
    expect(ok.text).toBe("ok");
  });

  it("limits.maxTotalTokens is enforced too", async () => {
    let n = 0;
    const { fn } = recorder(() => new Response(JSON.stringify(callTurn(`v1_${++n}`, { n })), { status: 200 }));
    const err: any = await new Agent({ model: GOOGLE_MODEL, apiKey: "k", fetch: fn, tools: { lookup }, limits: { maxTotalTokens: 5 } })
      .run("go")
      .then(() => null, (e) => e);
    expect(err?.code).toBe("budget_exceeded");
    expect(String(err.message)).toContain("limits.maxTotalTokens");
  });

  const workerSse = () =>
    new Response(
      [
        { event_type: "interaction.created", interaction: { id: "v1_w" } },
        { event_type: "step.delta", index: 0, delta: { type: "text", text: "hi" } },
        { event_type: "interaction.completed", interaction: { id: "v1_w", status: "completed", usage: { total_tokens: 3, total_input_tokens: 1, total_output_tokens: 2 } } },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join(""),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );

  it("dynamic workers inherit the parent's fetch, and their usage counts against the parent's budget", async () => {
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = () => {
      throw new Error("global fetch must not be used: workers inherit the parent's fetch");
    };
    try {
      const { fn, calls } = recorder((n) => {
        if (n === 1) {
          return new Response(
            JSON.stringify(callTurn("v1_p1", { tasks: [{ name: "WORKER", instructions: "Be brief.", task: "say hi" }] }, "spawn_subagents")),
            { status: 200 }
          );
        }
        if (n === 2) return workerSse(); // the worker streams (SSE); 3 tokens
        return new Response(JSON.stringify(textInteraction(`v1_${n}`)), { status: 200 }); // parent turn 2: 3 tokens
      });
      const make = (budget?: { maxTotalTokens: number }) =>
        new Agent({
          model: GOOGLE_MODEL,
          apiKey: "k",
          fetch: fn,
          dynamicSubagents: { model: GOOGLE_MODEL },
          ...(budget ? { budget } : {}),
        });
      // 3 (parent) + 3 (worker) + 3 (parent turn 2) = 9 total.
      const ok = await make({ maxTotalTokens: 100 }).run("delegate");
      expect(ok.subagents).toHaveLength(1);
      expect(ok.subagents[0]!.usage.totalTokens).toBe(3);
      expect(calls).toHaveLength(3); // every request, parent AND worker, went through the injected fetch
      clearInteractionChains();
      calls.length = 0;
      const err: any = await make({ maxTotalTokens: 8 }).run("delegate").then(() => null, (e) => e);
      expect(err?.code).toBe("budget_exceeded"); // only trips if the worker's 3 tokens were counted
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("workers inherit run limits, retry, env, fetch, tier and fileAccess via inheritableConfig()", () => {
    const fn = (async () => new Response("{}")) as unknown as typeof fetch;
    const parent = new Agent({
      model: GOOGLE_MODEL,
      apiKey: "k",
      fetch: fn,
      env: { X: "1" },
      retry: { maxRetries: 0 },
      googleTier: "paid",
      fileAccess: { roots: ["/tmp"] },
      limits: { maxToolCallsPerRun: 3, maxTotalTokens: 1000 },
    });
    const inherited = parent.inheritableConfig();
    expect(inherited.fetch).toBe(fn);
    expect(inherited.env).toEqual({ X: "1" });
    expect(inherited.retry).toEqual({ maxRetries: 0 });
    expect(inherited.googleTier).toBe("paid");
    expect(inherited.fileAccess).toEqual({ roots: ["/tmp"] });
    expect(inherited.limits).toMatchObject({ maxToolCallsPerRun: 3, maxTotalTokens: 1000 });
  });

  it("placeholder options warn instead of being silently ignored", () => {
    const codes: string[] = [];
    const off = telemetryBus.onEvent((e) => e.code === "config.unsupported_option" && codes.push(e.data?.option));
    try {
      new Agent({ model: GOOGLE_MODEL, apiKey: "k", hooks: {}, logger: {} });
      expect(codes.sort()).toEqual(["hooks", "logger"]);
    } finally {
      off();
    }
  });
});
