// A fake Anthropic Messages API for the mocked tests: realistic response headers and bodies (every documented usage field, request ids,
// rate-limit headers, SSE with event lines and pings) and a request validator that rejects what the real API rejects (docs:
// create-a-message, tool-use, steering-thinking, structure-outputs, errors; API version 2026-10-21), so a passing test means the
// adapter's request would be accepted, not only that it looks right. Error texts quoted from the docs are verbatim; the others approximate.

export const MODEL = "claude-sonnet-5-5";
export const API_KEY = "sk-ant-api03-TESTKEY-not-real";
export const BASE = "https://api.anthropic.com/v1";

// Models that reject forced tool use / thinking "enabled" (docs: steering-thinking matrix, create-a-message).
const NO_FORCED_TOOLS = new Set(["claude-fable-5-2", "claude-mythos-5-2", "claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);
const ALWAYS_THINKING = new Set(["claude-fable-5-2", "claude-mythos-5-2", "claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5-5"]);

let counter = 0;
/** A deterministic-looking provider id: msg_01..., toolu_01..., req_011C... */
export const pid = (prefix: string): string => prefix + "_01" + String(++counter).padStart(2, "0") + "ABCdefGHIjklMNOpqrSTUvwx".slice(0, 20);

/** The response headers Anthropic sends on every reply (docs: api-overview, rate-limits). */
export function anthropicHeaders(extra: Record<string, string> = {}, contentType = "application/json"): Record<string, string> {
  return {
    "content-type": contentType,
    "request-id": "req_011CVr7pJqKmWx4nBd2LsYhE",
    "anthropic-organization-id": "3a6b1d22-5d1f-4a0e-9a57-0c8f7d9c2b11",
    "anthropic-workspace-id": "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ",
    "anthropic-ratelimit-requests-limit": "4000",
    "anthropic-ratelimit-requests-remaining": "3999",
    "anthropic-ratelimit-requests-reset": "2026-11-16T09:31:00Z",
    "anthropic-ratelimit-tokens-limit": "2400000",
    "anthropic-ratelimit-tokens-remaining": "2398000",
    "anthropic-ratelimit-tokens-reset": "2026-11-16T09:31:00Z",
    "anthropic-ratelimit-input-tokens-limit": "2000000",
    "anthropic-ratelimit-input-tokens-remaining": "1999000",
    "anthropic-ratelimit-input-tokens-reset": "2026-11-16T09:31:00Z",
    "anthropic-ratelimit-output-tokens-limit": "400000",
    "anthropic-ratelimit-output-tokens-remaining": "399000",
    "anthropic-ratelimit-output-tokens-reset": "2026-11-16T09:31:00Z",
    date: "Mon, 16 Nov 2026 09:30:12 GMT",
    server: "cloudflare",
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    ...extra,
  };
}

/** The full usage object of a 200 reply (docs: create-a-message "Usage"). */
export function usageObject(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input_tokens: 25,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    output_tokens: 15,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    speed: "standard",
    inference_geo: "global",
    ...o,
  };
}

/** A complete non-streaming Message (docs: create-a-message response). */
export function messageObject(o: { content?: unknown[]; stop_reason?: string; usage?: Record<string, unknown>; model?: string } = {}): Record<string, unknown> {
  return {
    id: pid("msg"),
    type: "message",
    role: "assistant",
    model: o.model ?? MODEL,
    content: o.content ?? [{ type: "text", text: "Hello! How can I help?", citations: null }],
    stop_reason: o.stop_reason ?? "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    diagnostics: null,
    usage: usageObject(o.usage),
  };
}

/** A JSON reply with the realistic header set. */
export function jsonReply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: anthropicHeaders(headers) });
}

/** An error reply in Anthropic's shape (docs: errors). */
export function errorReply(status: number, type: string, message: string, extra: { headers?: Record<string, string>; details?: Record<string, unknown> } = {}): Response {
  return jsonReply(
    { type: "error", error: { type, message, ...(extra.details ? { details: extra.details } : {}) }, request_id: "req_011CVr7pJqKmWx4nBd2LsYhE" },
    status,
    extra.headers
  );
}

/** SSE text for the events, each as "event: <type>" + "data: <json>" (docs: streaming-messages). */
export function sseText(events: Array<Record<string, unknown>>): string {
  return events.map((e) => "event: " + e["type"] + "\ndata: " + JSON.stringify(e) + "\n\n").join("");
}

/** A streaming reply; the body may also be raw text so a test can cut it anywhere. */
export function sseReply(events: Array<Record<string, unknown>> | string, headers: Record<string, string> = {}): Response {
  return new Response(typeof events === "string" ? events : sseText(events), { status: 200, headers: anthropicHeaders(headers, "text/event-stream; charset=utf-8") });
}

/** message_start event with the usage a real stream opens with (output_tokens starts at 1-2). */
export const messageStart = (usage: Record<string, unknown> = {}, model = MODEL) => ({
  type: "message_start",
  message: { id: pid("msg"), type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1, ...usage } },
});
export const blockStart = (index: number, content_block: Record<string, unknown>) => ({ type: "content_block_start", index, content_block });
export const blockDelta = (index: number, delta: Record<string, unknown>) => ({ type: "content_block_delta", index, delta });
export const blockStop = (index: number) => ({ type: "content_block_stop", index });
export const messageDelta = (stop_reason: string, usage: Record<string, unknown> = { output_tokens: 15 }) => ({ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage });
export const messageStop = { type: "message_stop" } as const;
export const ping = { type: "ping" } as const;

/** A whole text stream: start, ping, text deltas, stop. */
export function textStream(parts: string[], usage: Record<string, unknown> = { output_tokens: 15 }): Array<Record<string, unknown>> {
  return [
    messageStart(),
    blockStart(0, { type: "text", text: "" }),
    ping,
    ...parts.map((t) => blockDelta(0, { type: "text_delta", text: t })),
    blockStop(0),
    messageDelta("end_turn", usage),
    messageStop,
  ];
}

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const bad = (message: string, status = 400, type = "invalid_request_error"): Response => errorReply(status, type, message);

// Walks a schema: every object must be closed (additionalProperties: false) for strict tools and output_config.format.
function firstOpenObject(node: unknown, path = "schema"): string | undefined {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const r = firstOpenObject(node[i], path + "[" + i + "]");
      if (r) return r;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  const o = node as Record<string, unknown>;
  if ((o["type"] === "object" || o["properties"]) && o["additionalProperties"] !== false) return path;
  for (const k of ["minimum", "maximum", "minLength", "maxLength", "multipleOf"]) if (k in o) return path + "." + k;
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object") {
      const r = firstOpenObject(v, path + "." + k);
      if (r) return r;
    }
  }
  return undefined;
}

/** Thinking blocks the fake server issued, by signature: a replayed block must match one exactly (docs: "cannot be modified"). */
export const issuedThinking = new Map<string, string>();
/** Issues a thinking block the way the API does (a signature bound to the text). */
export function thinkingBlock(thinking: string, signature = "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds" + issuedThinking.size): Record<string, unknown> {
  issuedThinking.set(signature, thinking);
  return { type: "thinking", thinking, signature };
}

/**
 * The checks the real API makes before it answers. Returns an error Response, or undefined when the request is acceptable.
 * Text of the 400s that the docs quote is verbatim.
 */
export function validateRequest(url: string, init: RequestInit): Response | undefined {
  if (!url.endsWith("/v1/messages")) return bad("Not found: " + url, 404, "not_found_error");
  if (init.method !== "POST") return bad("Method not allowed", 405, "invalid_request_error");
  const h = new Headers(init.headers as Record<string, string>);
  if (!h.get("x-api-key") && !h.get("authorization")) return bad("x-api-key header is required", 401, "authentication_error");
  if (h.get("x-api-key") && h.get("x-api-key") !== API_KEY) return bad("invalid x-api-key", 401, "authentication_error");
  if (!h.get("anthropic-version")) return bad("anthropic-version: header is required");
  if (!(h.get("content-type") ?? "").includes("application/json")) return bad("Content-Type must be application/json");
  let b: Record<string, any>;
  try {
    b = JSON.parse(String(init.body));
  } catch {
    return bad("Request body must be valid JSON");
  }
  const model = String(b["model"] ?? "");
  if (!model) return bad("model: Field required");
  if (!Number.isInteger(b["max_tokens"]) || b["max_tokens"] < 0) return bad("max_tokens: Field required");
  for (const k of ["temperature", "top_p", "top_k"]) if (k in b) return bad(k + ": Extra inputs are not permitted");
  if ("output_format" in b) return bad("output_format: Extra inputs are not permitted");
  if (!Array.isArray(b["messages"]) || b["messages"].length === 0) return bad("messages: Field required");
  if (b["system"] !== undefined && typeof b["system"] !== "string" && !Array.isArray(b["system"])) return bad("system: must be a string or an array of text blocks");
  const th = b["thinking"];
  if (th) {
    if (th.type === "enabled") return bad('"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.');
    if (th.type === "disabled" && ALWAYS_THINKING.has(model)) return bad('"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.');
    if (th.type === "disabled" && model === "claude-sonnet-5-5") return bad('To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}.');
    if (th.type === "between_tools" && model !== "claude-sonnet-5-5") return bad('"thinking.type.between_tools" is not supported for this model.');
    if (!["adaptive", "disabled", "between_tools"].includes(th.type)) return bad("thinking.type: invalid");
    if (th.display !== undefined && !["summarized", "omitted"].includes(th.display)) return bad("thinking.display: invalid");
  }
  const effort = b["output_config"]?.effort;
  if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) return bad("output_config.effort: invalid");
  if (b["output_config"]?.format) {
    const f = b["output_config"].format;
    if (f.type !== "json_schema" || typeof f.schema !== "object") return bad("output_config.format: must be {type: json_schema, schema}");
    if ("name" in f || "strict" in f) return bad("output_config.format: Extra inputs are not permitted");
    const open = firstOpenObject(f.schema);
    if (open) return bad("output_config.format.schema: unsupported (" + open + "): objects need additionalProperties: false and no numeric/length constraints");
  }
  if (b["service_tier"] !== undefined && !["auto", "standard_only"].includes(b["service_tier"])) return bad("service_tier: invalid");
  const cc = b["cache_control"];
  if (cc && (cc.type !== "ephemeral" || (cc.ttl !== undefined && !["5m", "1h"].includes(cc.ttl)))) return bad("cache_control: invalid");
  const tools: any[] = b["tools"] ?? [];
  const names = new Set<string>();
  for (const t of tools) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(t.name))) return bad("tools: invalid name " + t.name);
    if (t.input_schema?.type !== "object") return bad("tools." + t.name + ".input_schema.type: must be object");
    if (t.strict === true) {
      const open = firstOpenObject(t.input_schema, "input_schema");
      if (open) return bad("tools." + t.name + ": strict schema unsupported at " + open);
    }
    names.add(t.name);
  }
  const tc = b["tool_choice"];
  if (tc) {
    if (!["auto", "any", "tool", "none"].includes(tc.type)) return bad("tool_choice.type: invalid");
    if ((tc.type === "any" || tc.type === "tool") && NO_FORCED_TOOLS.has(model)) return bad('tool_choice: type "tool" and "any" are not supported for this model.');
    if (tc.type === "tool" && !names.has(tc.name)) return bad("tool_choice.name: unknown tool " + tc.name);
    if (!tools.length) return bad("tool_choice: tools must be provided");
  }
  const msgs: any[] = b["messages"];
  if (msgs[0].role !== "user") return bad("messages.0.role: the first message must use the user role");
  if (msgs[msgs.length - 1].role !== "user") return bad("This model does not support assistant message prefill. The conversation must end with a user message.");
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "user" && m.role !== "assistant") return bad("messages." + i + ".role: must be user or assistant");
    if (i > 0 && msgs[i - 1].role === m.role) return bad("messages." + i + ": roles must alternate between user and assistant");
    const blocks: any[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (!Array.isArray(blocks) || blocks.length === 0) return bad("messages." + i + ".content: must not be empty");
    let seenOther = false;
    blocks.forEach(() => {});
    for (let j = 0; j < blocks.length; j++) {
      const k = blocks[j];
      const at = "messages." + i + ".content." + j;
      if (k.type === "text" && (!k.text || !String(k.text).trim())) return bad(at + ".text: text content blocks must be non-empty");
      if (k.type === "tool_result") {
        if (m.role !== "user") return bad(at + ": tool_result belongs in a user message");
        if (seenOther) return bad(at + ": tool_result blocks must come first in the user message content");
        if (!ID_RE.test(String(k.tool_use_id))) return bad(at + ".tool_use_id: invalid id");
      } else seenOther = true;
      if (k.type === "tool_use") {
        if (m.role !== "assistant") return bad(at + ": tool_use belongs in an assistant message");
        if (!ID_RE.test(String(k.id)) || String(k.id).length > 64) return bad(at + ".id: String should match pattern '^[a-zA-Z0-9_-]+$'");
        if (!k.input || typeof k.input !== "object" || Array.isArray(k.input)) return bad(at + ".input: must be an object");
      }
      if (k.type === "thinking" && (typeof k.signature !== "string" || !k.signature)) return bad(at + ".signature: Field required");
      if (k.type === "image" || k.type === "document") {
        const s = k.source ?? {};
        if (!["base64", "url", "text", "content", "file"].includes(s.type)) return bad(at + ".source.type: invalid");
        if (k.type === "image" && s.type === "base64" && !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(s.media_type)) return bad(at + ".source.media_type: unsupported image type");
        if (k.type === "document" && s.type === "base64" && s.media_type !== "application/pdf") return bad(at + ".source.media_type: must be application/pdf");
      }
    }
    // Every tool_use must be answered by a tool_result in the very next user message.
    const uses = blocks.filter((k) => k.type === "tool_use").map((k) => k.id);
    if (uses.length) {
      const next = msgs[i + 1];
      const results: any[] = next && Array.isArray(next.content) ? next.content.filter((k: any) => k.type === "tool_result") : [];
      const ids = results.map((r) => r.tool_use_id);
      const missing = uses.filter((id) => !ids.includes(id));
      if (missing.length) return bad("messages." + (i + 1) + ": tool_use ids were found without tool_result blocks immediately after: " + missing.join(", ") + ". Each tool_use block must have a corresponding tool_result block in the next message.");
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      const prevUses: string[] = i > 0 && Array.isArray(msgs[i - 1].content) ? msgs[i - 1].content.filter((k: any) => k.type === "tool_use").map((k: any) => k.id) : [];
      for (const k of m.content) if (k.type === "tool_result" && !prevUses.includes(k.tool_use_id)) return bad("messages." + i + ": unexpected tool_use_id found in tool_result blocks: " + k.tool_use_id + ". Each tool_result block must have a corresponding tool_use block in the previous message.");
    }
    // The latest assistant message's thinking blocks must be the ones the API issued, unmodified.
    if (m.role === "assistant" && i === msgs.length - 2) {
      for (const k of blocks) {
        if (k.type === "thinking" && issuedThinking.get(k.signature) !== k.thinking) return bad("messages." + i + ".content: thinking or redacted_thinking blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.");
      }
    }
  }
  return undefined;
}

export interface Call {
  url: string;
  init: RequestInit;
  headers: Headers;
  body: any;
}

/**
 * A fetch stub that validates every request like the real API, records it, and answers with the next scripted reply
 * (a Response, or a function of the call number and body). An invalid request gets the 400 the API would send.
 */
export function anthropicApi(script: Array<Response | ((n: number, body: any) => Response)>): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const invalid = validateRequest(String(url), init);
    const headers = new Headers(init.headers as Record<string, string>);
    calls.push({ url: String(url), init, headers, body: JSON.parse(String(init.body)) });
    if (invalid) return invalid;
    const next = script[Math.min(calls.length - 1, script.length - 1)]!;
    return typeof next === "function" ? next(calls.length, calls[calls.length - 1]!.body) : next.clone();
  }) as unknown as typeof fetch;
  return { fn, calls };
}
