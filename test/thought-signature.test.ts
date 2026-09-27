import { describe, expect, test, afterEach } from "bun:test";
import { OpenAICompatibleChatProvider } from "../src/index.ts";

const SIG =
  "EvUCCvICARFNMg/41s9sgoOmB9q2scThMsvdj+j55/83oQo2aw0YIMW+KwweMjRQ4viuSnMRjn7UxfkV91wU9oA32nw6IpYTcmRu9ljJtXhMGbYgXMMHzJli+u60aU8Sj4l9RYliVxDtvuwqd31sK7RHoQv795ttw7Q/0D//Xa4Gf+rdazyYkOGURQFhaPaUqpZJv+vhWk4KChczMVkIxJ+uQ99ajHxoTygW07rZx2gTxhrZZX8aVcNJ7021Cvv1d90T8nGVw+Pwuh0Z9tRVEqoydaOiEEwrTbon250akXj6ze6NYQa86dhEvVPFmGpssyQzHQ33GnDdoqJTMCtVdvpxChiON0IhR2gYHgZcVTGNYWvxhD0wEVDG2myf+NxeADJwnHSB7Kz3zMWuZidIPktS+qkC34OCbki30QIh6wYJ2eMi/AkIBzQGUO8p5G2Fbi5/DTj8Ur62OoYP2Tb6UUz1NgqRDSz2xEcS46w8z9wqLr39BL+sxA==";

describe("Gemini thought_signature via OpenAI-compat", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("generate() captures extra_content.google.thought_signature", async () => {
    const provider = new OpenAICompatibleChatProvider("compat");
    (globalThis as any).fetch = async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-sig",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "spawn_subagents", arguments: '{"tasks":[]}' },
                    extra_content: { google: { thought_signature: SIG } },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const res = await provider.generate(
      "gemini-3.6-flash",
      { messages: [{ role: "user", content: "hi" }] },
      { apiKey: "test-key" }
    );
    expect(res.toolCalls?.length).toBe(1);
    expect(res.toolCalls![0].thoughtSignature).toBe(SIG);
  });

  test("buildPayload replays signature on Turn 2 (prevents 400)", async () => {
    const provider = new OpenAICompatibleChatProvider("compat");
    let replayedBody: any = null;
    (globalThis as any).fetch = async (_url: string, init: any) => {
      replayedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-2",
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    await provider.generate(
      "gemini-3.6-flash",
      {
        systemPrompt: "sys",
        messages: [
          { role: "user", content: "do it" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "call_1",
                name: "spawn_subagents",
                arguments: { tasks: [] },
                thoughtSignature: SIG,
              } as any,
            ],
          },
          {
            role: "tool",
            content: [{ type: "tool_result", id: "call_1", name: "spawn_subagents", result: "ok" } as any],
          },
        ],
      },
      { apiKey: "test-key" }
    );

    const assistant = replayedBody.messages.find((m: any) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant.tool_calls?.length).toBe(1);
    expect(assistant.tool_calls[0].extra_content?.google?.thought_signature).toBe(SIG);
  });

  test("stream() captures signature from delta.tool_calls", async () => {
    const provider = new OpenAICompatibleChatProvider("compat");
    const chunks = [
      `data: {"id":"c1","choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"spawn_subagents","arguments":"{\\"tasks\\":[]}"},"extra_content":{"google":{"thought_signature":"${SIG}"}}}]}}]}\n\n`,
      `data: {"id":"c1","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
      "data: [DONE]\n\n",
    ];
    (globalThis as any).fetch = async () => {
      const stream = new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const s = provider.stream(
      "gemini-3.6-flash",
      { messages: [{ role: "user", content: "hi" }] },
      { apiKey: "test-key" }
    );
    for await (const _ of s) {
    }
    const final = await s.result();
    expect(final.toolCalls?.length).toBe(1);
    expect(final.toolCalls![0].thoughtSignature).toBe(SIG);
  });

  test("no signature → no extra_content (plain OpenAI unaffected)", async () => {
    const provider = new OpenAICompatibleChatProvider("compat");
    let body: any = null;
    (globalThis as any).fetch = async (_u: string, init: any) => {
      body = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          id: "c",
          choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    await provider.generate(
      "gpt-4o",
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_call", id: "c1", name: "t", arguments: {} } as any],
          },
        ],
      },
      { apiKey: "k" }
    );
    expect(body.messages[0].tool_calls[0].extra_content).toBeUndefined();
  });
});
