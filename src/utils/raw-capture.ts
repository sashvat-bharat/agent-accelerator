import type { ProviderRawData } from "../types/model.ts";

/** How much of the wire exchange `AgentResponse.raw` keeps (see `AgentConfig.captureRaw`). */
export type CaptureRawMode = false | "redacted" | true;

function byteLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function toolNames(tools: unknown): string[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const names = tools
    .map((t) => (t as { name?: unknown; function?: { name?: unknown } })?.name ?? (t as { function?: { name?: unknown } })?.function?.name)
    .filter((n): n is string => typeof n === "string");
  return names.length > 0 ? names : undefined;
}

/** Body summary that keeps the audit-useful shape and none of the content. */
function summarizeRequestBody(body: unknown): unknown {
  if (body === null || body === undefined) return body;
  const b = (typeof body === "object" ? body : {}) as Record<string, unknown>;
  const items = Array.isArray(b["messages"]) ? b["messages"] : Array.isArray(b["input"]) ? b["input"] : undefined;
  return {
    redacted: true,
    bytes: byteLength(body),
    ...(typeof b["model"] === "string" ? { model: b["model"] } : {}),
    ...(items ? { items: items.length } : {}),
    ...(toolNames(b["tools"]) ? { tools: toolNames(b["tools"]) } : {}),
    ...(b["stream"] === true ? { stream: true } : {}),
  };
}

function summarizeResponseBody(body: unknown): unknown {
  if (body === null || body === undefined) return body;
  const b = (typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    redacted: true,
    bytes: byteLength(body),
    ...(typeof b["id"] === "string" ? { id: b["id"] } : {}),
    ...(typeof b["status"] === "string" ? { status: b["status"] } : {}),
  };
}

/**
 * Applies the `captureRaw` policy to a provider audit record.
 * - `true`: keep everything (headers are always redacted by the adapters).
 * - `"redacted"` (default): keep URL, method, headers and status, but replace
 *   request/response BODIES with a content-free summary. Prompts, files and
 *   model output never leak through `response.raw` / `toJSON()` into logs.
 * - `false`: keep only URL, method and HTTP status.
 */
export function applyCaptureRaw(raw: ProviderRawData | undefined, mode: CaptureRawMode | undefined): ProviderRawData | undefined {
  if (!raw || mode === true) return raw;
  const redactedMode = mode !== false; // undefined -> default "redacted"
  const request = raw.request
    ? {
        url: raw.request.url,
        method: raw.request.method,
        headers: redactedMode ? raw.request.headers : {},
        body: redactedMode ? summarizeRequestBody(raw.request.body) : null,
      }
    : raw.request;
  const response = raw.response
    ? {
        status: raw.response.status,
        statusText: raw.response.statusText,
        headers: redactedMode ? raw.response.headers : {},
        body: redactedMode ? summarizeResponseBody(raw.response.body) : null,
      }
    : undefined;
  return { request, ...(response ? { response } : {}) } as ProviderRawData;
}
