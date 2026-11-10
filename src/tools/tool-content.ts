/**
 * A tool result made of text and media. A tool returns `toolContent([...])` when the model should SEE a file (a chart
 * image, a scanned page, a recording) and not only read text about it. The brand is a private Symbol, so only the
 * tool's own code can produce it: JSON a tool fetched from the web can never become media for the provider.
 */
import type { ContentPart } from "../types/message.ts";

/** Parts a tool may return: plain strings (text) and the usual text, image, audio, video and file parts. */
export type ToolContentPart = string | Extract<ContentPart, { type: "text" | "image" | "audio" | "video" | "file" }>;

const TOOL_CONTENT_BRAND: unique symbol = Symbol("agent-accelerator.tool-content") as never;

/** What `toolContent` returns; the executor turns it into a tool result with `parts`. */
export interface ToolContent {
  readonly parts: ToolContentPart[];
  readonly [TOOL_CONTENT_BRAND]: true;
}

/**
 * Wraps text and media for a tool's return value, e.g.
 * `return toolContent(["instrument.jpg", { type: "image", image: bytes, mimeType: "image/jpeg" }])`.
 * Media may be bytes, a data URL, a path or a URL (the tool's own code is trusted with these). Google passes the media
 * to the model inside the function result; other providers get the text only, with one warning.
 */
export function toolContent(parts: ToolContentPart[]): ToolContent {
  return { parts: [...parts], [TOOL_CONTENT_BRAND]: true };
}

/** True only for values made by {@link toolContent}. */
export function isToolContent(value: unknown): value is ToolContent {
  return !!value && typeof value === "object" && (value as Record<symbol, unknown>)[TOOL_CONTENT_BRAND] === true;
}
