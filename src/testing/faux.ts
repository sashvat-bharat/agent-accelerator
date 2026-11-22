/**
 * `fauxProvider`: a scripted stand-in for a model, for testing your own agents with no network and no cost. It is a `fetch`
 * that speaks the OpenAI-compatible chat wire, so an Agent built with `faux.config` runs through the REAL adapter (history
 * building, streaming, tool-call parsing, usage, retries) and only the model's answers are scripted. Each call to the
 * model uses the next step of the script.
 */
import { ConfigError } from "../types/errors.ts";

/** One tool call the scripted model makes. */
export interface FauxToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  /** Defaults to `call_faux_<call number>_<index>`. */
  id?: string;
}

/** One scripted answer of the model. */
export interface FauxReply {
  text?: string;
  /** Reasoning shown as `thinking`. */
  thinking?: string;
  toolCalls?: FauxToolCall[];
  /** Token counts reported for the call; the defaults are about a quarter of the characters sent and written. */
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
  /** A provider-reported cost in USD, as OpenRouter sends it. */
  cost?: number;
  /** Overrides `stop` / `tool_calls` (`"length"`, `"content_filter"` ...). */
  finishReason?: string;
  /** Answers with an HTTP error instead (`status` default 500). A 429 may carry `retryAfterSeconds`. */
  error?: { status?: number; message?: string; retryAfterSeconds?: number };
  /** Waits this long before answering (aborts cleanly when the run is interrupted). */
  delayMs?: number;
}

/** What a function step is told about the call it answers. */
export interface FauxRequest {
  /** 1-based number of this model call. */
  number: number;
  /** True when the Agent asked for a stream. */
  stream: boolean;
  /** The parsed request body (`model`, `messages`, `tools` ...). */
  // biome-ignore lint/suspicious/noExplicitAny: the body is the provider's JSON, read by the test
  body: any;
  /** Text of the last user message. */
  lastUserText: string;
  /** Names of the tools offered to the model. */
  toolNames: string[];
}

/** A step of the script: text, a reply object, or a function that decides from the request. */
export type FauxStep =
  | string
  | FauxReply
  | ((request: FauxRequest) => string | FauxReply | Promise<string | FauxReply>);

/** Options of `fauxProvider`. */
export interface FauxProviderOptions {
  /** Provider prefix of the model string. Default `"faux"` (the model is `faux/faux-model`). */
  prefix?: string;
  /** When the script runs out, answer with its last step again instead of failing. Default false. */
  repeatLast?: boolean;
}

/** What `fauxProvider` returns. */
export interface FauxProvider {
  /** Spread into `new Agent({ ...faux.config, ... })`: the model, a key, a base URL and the scripted `fetch`. */
  config: { model: string; apiKey: string; baseUrl: string; fetch: typeof fetch };
  /** The scripted `fetch` (the same one as in `config`). */
  fetch: typeof fetch;
  /** Every model call so far, in order. */
  calls: FauxRequest[];
  /** Scripted steps not used yet. */
  readonly remaining: number;
  /** Adds steps to the end of the script. */
  push(...steps: FauxStep[]): void;
  /** Forgets the recorded calls and starts the script again from its first step. */
  reset(): void;
}

// Whole tokens for a text, about a quarter of its characters, at least 1; in: the default usage, out: a count.
const tokensOf = (chars: number): number => Math.max(1, Math.ceil(chars / 4));

// The text of one message content (a string, or the text parts of a part list); in: lastUserText, out: a string.
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) =>
      p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
        ? (p as { text: string }).text
        : ""
    )
    .join("");
}

// Waits `ms`, rejecting with an AbortError as soon as `signal` aborts; in: a reply with delayMs, out: nothing.
function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

// The usage block of a reply: the given counts, else estimates from the request and the answer; in: both response builders, out: an OpenAI usage object.
function usageOf(reply: FauxReply, request: FauxRequest): Record<string, unknown> {
  const sent = JSON.stringify(request.body.messages ?? "").length;
  const written =
    (reply.text ?? "").length + (reply.thinking ?? "").length + JSON.stringify(reply.toolCalls ?? []).length;
  const input = reply.usage?.inputTokens ?? tokensOf(sent);
  const output = reply.usage?.outputTokens ?? tokensOf(written);
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(reply.usage?.cachedTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: reply.usage.cachedTokens } }
      : {}),
    ...(reply.cost !== undefined ? { cost: reply.cost } : {}),
  };
}

// The tool calls of a reply as OpenAI `tool_calls`; in: both response builders, out: the wire list.
function wireCalls(
  reply: FauxReply,
  n: number
): Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> {
  return (reply.toolCalls ?? []).map((c, i) => ({
    id: c.id ?? `call_faux_${n}_${i}`,
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }));
}

// A plain JSON chat completion for a reply; in: a non-streaming call, out: the Response.
function jsonResponse(reply: FauxReply, request: FauxRequest): Response {
  const calls = wireCalls(reply, request.number);
  return new Response(
    JSON.stringify({
      id: `faux-${request.number}`,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: reply.text ?? null,
            ...(reply.thinking ? { reasoning: reply.thinking } : {}),
            ...(calls.length > 0 ? { tool_calls: calls } : {}),
          },
          finish_reason: calls.length > 0 ? "tool_calls" : (reply.finishReason ?? "stop"),
        },
      ],
      usage: usageOf(reply, request),
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

// The text cut into small pieces so a stream really delivers several deltas; in: sseResponse, out: the pieces.
function pieces(text: string): string[] {
  return text.match(/[\s\S]{1,12}/g) ?? [];
}

// A server-sent-events chat completion for a reply (thinking, text pieces, tool calls, then finish + usage); in: a streaming call, out: the Response.
function sseResponse(reply: FauxReply, request: FauxRequest): Response {
  const id = `faux-${request.number}`;
  const frame = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
  const chunk = (delta: Record<string, unknown>, finish?: string, usage?: unknown): string =>
    frame({
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      ...(usage ? { usage } : {}),
    });
  let body = chunk({ role: "assistant" });
  if (reply.thinking) for (const p of pieces(reply.thinking)) body += chunk({ reasoning: p });
  if (reply.text) for (const p of pieces(reply.text)) body += chunk({ content: p });
  const calls = wireCalls(reply, request.number);
  calls.forEach((c, index) => {
    body += chunk({
      tool_calls: [{ index, id: c.id, type: "function", function: { name: c.function.name, arguments: "" } }],
    });
    body += chunk({ tool_calls: [{ index, function: { arguments: c.function.arguments } }] });
  });
  body += chunk({}, calls.length > 0 ? "tool_calls" : (reply.finishReason ?? "stop"), usageOf(reply, request));
  body += "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// An HTTP error response for a reply with `error`; in: a scripted failure, out: the Response.
function errorResponse(error: NonNullable<FauxReply["error"]>): Response {
  const status = error.status ?? 500;
  return new Response(JSON.stringify({ error: { message: error.message ?? `faux provider error ${status}` } }), {
    status,
    headers: {
      "content-type": "application/json",
      ...(error.retryAfterSeconds !== undefined ? { "retry-after": String(error.retryAfterSeconds) } : {}),
    },
  });
}

/**
 * Builds a scripted model for tests: no network, no key, no cost. `steps` are the model's answers in order (a string is a text
 * answer, an object a `FauxReply`, a function decides from the request). Use it as
 * `new Agent({ ...faux.config })`; `faux.calls` records what the model was sent. The Agent runs through the real
 * OpenAI-compatible adapter, so streaming, tool calls, usage and error handling behave as in production. When the script
 * runs out the next call fails with a `ProviderError` (or repeats the last step with `repeatLast: true`).
 *
 * @example `const faux = fauxProvider(["Hello!"]); const res = await new Agent({ ...faux.config }).run("hi"); // res.text === "Hello!"`
 */
export function fauxProvider(steps: FauxStep[], options: FauxProviderOptions = {}): FauxProvider {
  const prefix = (options.prefix ?? "faux").trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(prefix))
    throw new ConfigError('[Agent Accelerator] fauxProvider: prefix must be letters, digits, "_" or "-".');
  const script: FauxStep[] = [...steps];
  const calls: FauxRequest[] = [];
  let used = 0;
  const fakeFetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    // biome-ignore lint/suspicious/noExplicitAny: the body is the provider's JSON
    const body: any = JSON.parse(String(init?.body ?? "{}"));
    const messages: Array<{ role?: string; content?: unknown }> = Array.isArray(body.messages) ? body.messages : [];
    const request: FauxRequest = {
      number: calls.length + 1,
      stream: body.stream === true,
      body,
      lastUserText: textOf([...messages].reverse().find((m) => m.role === "user")?.content),
      toolNames: Array.isArray(body.tools)
        ? body.tools.map((t: { function?: { name?: string } }) => t.function?.name ?? "")
        : [],
    };
    calls.push(request);
    const index = used < script.length ? used++ : options.repeatLast && script.length > 0 ? script.length - 1 : -1;
    if (index < 0)
      return errorResponse({
        status: 400,
        message: `faux provider: no scripted reply left for call ${request.number} (the script has ${script.length}). Add a step or use repeatLast.`,
      });
    const step = script[index]!;
    const resolved = typeof step === "function" ? await step(request) : step;
    const reply: FauxReply = typeof resolved === "string" ? { text: resolved } : resolved;
    if (reply.delayMs) await wait(reply.delayMs, init?.signal);
    if (reply.error) return errorResponse(reply.error);
    return request.stream ? sseResponse(reply, request) : jsonResponse(reply, request);
  }) as unknown as typeof fetch;
  return {
    config: { model: `${prefix}/faux-model`, apiKey: "faux", baseUrl: "https://faux.test/v1", fetch: fakeFetch },
    fetch: fakeFetch,
    calls,
    get remaining() {
      return Math.max(0, script.length - used);
    },
    push(...more: FauxStep[]) {
      script.push(...more);
    },
    reset() {
      calls.length = 0;
      used = 0;
    },
  };
}
