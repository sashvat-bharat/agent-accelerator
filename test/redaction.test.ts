import { describe, it, expect, afterEach } from "bun:test";
import { Agent, createExplicitCache, type StreamEvent } from "../src/index.ts";
import { redactedHeaders } from "../src/providers/shared.ts";
import { applyCaptureRaw } from "../src/utils/raw-capture.ts";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("header redaction (central deny-list)", () => {
  it("redacts credential-bearing header NAMES beyond Authorization", () => {
    const out = redactedHeaders({
      Authorization: "Bearer abc",
      "x-api-key": "k1",
      "api-key": "k2",
      "cf-aig-authorization": "k3",
      "X-Goog-Api-Key": "k4",
      Cookie: "sid=1",
      "Content-Type": "application/json",
      "x-session-id": "sess-1",
    });
    for (const h of ["Authorization", "x-api-key", "api-key", "cf-aig-authorization", "X-Goog-Api-Key", "Cookie"]) {
      expect(out[h]).toBe("[REDACTED]");
    }
    expect(out["Content-Type"]).toBe("application/json");
    expect(out["x-session-id"]).toBe("sess-1");
  });

  it("redacts credential-looking VALUES but not ordinary words containing 'sk-'", () => {
    const out = redactedHeaders({
      "x-forwarded-note": "token sk-abcdefghij1234",
      "x-weird": "AIzaSyA-1234567890abcdef",
      "X-Title": "Task-Manager",
      "User-Agent": "Disk-Cache/1.0",
    });
    expect(out["x-forwarded-note"]).toBe("[REDACTED]");
    expect(out["x-weird"]).toBe("[REDACTED]");
    expect(out["X-Title"]).toBe("Task-Manager");
    expect(out["User-Agent"]).toBe("Disk-Cache/1.0");
  });
});

describe("captureRaw policy", () => {
  const raw = {
    request: {
      url: "https://x.test/v1/chat",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "[REDACTED]" },
      body: { model: "m", messages: [{ role: "user", content: "TOP SECRET PROMPT" }], tools: [{ type: "function", function: { name: "lookup" } }], stream: true },
    },
    response: { status: 200, statusText: "OK", headers: { "x-id": "1" }, body: { id: "resp_1", status: "completed", output: "TOP SECRET ANSWER" } },
  };

  it("redacted (default): keeps shape, drops content", () => {
    const out = applyCaptureRaw(raw as any, undefined)!;
    const text = JSON.stringify(out);
    expect(text).not.toContain("TOP SECRET");
    expect(out.request.url).toBe("https://x.test/v1/chat");
    expect(out.request.body).toMatchObject({ redacted: true, model: "m", items: 1, tools: ["lookup"], stream: true });
    expect(out.response?.status).toBe(200);
    expect(out.response?.body).toMatchObject({ redacted: true, id: "resp_1", status: "completed" });
  });

  it("true keeps everything; false keeps only url/method/status", () => {
    expect(applyCaptureRaw(raw as any, true)).toBe(raw as any);
    const min = applyCaptureRaw(raw as any, false)!;
    expect(min.request.body).toBeNull();
    expect(min.request.headers).toEqual({});
    expect(min.response?.body).toBeNull();
    expect(min.response?.status).toBe(200);
  });
});

describe("AgentResponse.raw end to end", () => {
  const interaction = {
    id: "v1_r",
    object: "interaction",
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text: "TOP SECRET ANSWER" }] }],
    usage: { total_tokens: 3, total_input_tokens: 1, total_output_tokens: 2 },
  };
  const fetchOk = (async () => new Response(JSON.stringify(interaction), { status: 200 })) as unknown as typeof fetch;

  it("default response.raw carries no prompt or answer text", async () => {
    const res = await new Agent({ model: "google/gemini-3.5-flash-lite", apiKey: "k", fetch: fetchOk }).run("TOP SECRET PROMPT");
    expect(res.text).toBe("TOP SECRET ANSWER");
    const json = JSON.stringify(res.toJSON().raw);
    expect(json).not.toContain("TOP SECRET PROMPT");
    expect(json).not.toContain("TOP SECRET ANSWER");
    expect(res.raw.request.body).toMatchObject({ redacted: true, model: "gemini-3.5-flash-lite" });
  });

  it("captureRaw: true restores full bodies for debugging", async () => {
    const res = await new Agent({ model: "google/gemini-3.5-flash-lite", apiKey: "k", fetch: fetchOk, captureRaw: true }).run("TOP SECRET PROMPT");
    expect(JSON.stringify(res.raw.request.body)).toContain("TOP SECRET PROMPT");
  });

  it("the streamed `start` event is redacted by the same policy", async () => {
    const sse = (e: object) => `data: ${JSON.stringify(e)}\n\n`;
    const body = sse({ event_type: "step.delta", index: 0, delta: { type: "text", text: "hi" } }) + sse({ event_type: "interaction.completed", interaction: { id: "v1_s", status: "completed", usage: { total_tokens: 3, total_input_tokens: 1, total_output_tokens: 2 } } });
    const fn = (async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch;
    const stream = new Agent({ model: "google/gemini-3.5-flash-lite", apiKey: "k", fetch: fn }).stream("TOP SECRET PROMPT");
    const events: StreamEvent[] = [];
    for await (const e of stream) events.push(e);
    const start = events.find((e) => e.type === "start");
    expect(start?.raw).toBeDefined();
    expect(JSON.stringify(start!.raw)).not.toContain("TOP SECRET PROMPT");
  });
});

describe("createExplicitCache", () => {
  it("sends the API key in a header, never in the URL", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    (globalThis as any).fetch = async (url: string, init: any) => {
      seen = { url, headers: init.headers };
      return new Response(JSON.stringify({ name: "cachedContents/1", model: "m", createTime: "", updateTime: "", expireTime: "" }), { status: 200 });
    };
    await createExplicitCache({ model: "gemini-3.5-flash-lite", apiKey: "SECRET-KEY-123" });
    expect(seen!.url).not.toContain("SECRET-KEY-123");
    expect(seen!.url).not.toContain("key=");
    expect(seen!.headers["x-goog-api-key"]).toBe("SECRET-KEY-123");
  });
});
