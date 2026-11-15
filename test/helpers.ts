// Shared fixtures for the mocked-fetch tests: SSE frames, JSON and chat replies, a `fetch` stub that records request
// bodies, a one-shot JSON `fetch` stub, and a `console.warn` capture. Tests import what they need from here.

/** One server-sent-events frame carrying `o` as JSON. */
export const sseFrame = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

/** A streaming response made of the given SSE text. */
export const sseResponse = (body: string): Response =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });

/** An OpenAI-compatible chat completion that answers `text` and stops, with a small usage block. */
export const chatReply = (text = "Brief done."): Response =>
  new Response(
    JSON.stringify({
      id: "c",
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200 }
  );

/** A `fetch` stub that parses each JSON request body, records it in `calls` and answers with `handler(callNumber, body)`. */
export function mockFetch(handler: (n: number, body: any) => Response | Promise<Response>) {
  const calls: any[] = [];
  const fn = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return handler(calls.length, body);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** Replaces the global `fetch` with a stub answering every call with `body` as JSON (a string is sent as is). */
export function mockFetchOnce(body: unknown, init?: { status?: number; headers?: Record<string, string> }): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  (globalThis as any).fetch = async (_url: unknown, _req: unknown) =>
    new Response(text, {
      status: init?.status ?? 200,
      statusText: init?.status === 400 ? "Bad Request" : "OK",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
}

/** Collects what is written with `console.warn` until `restore()` is called. */
export function captureWarnings(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.warn = orig;
    },
  };
}
