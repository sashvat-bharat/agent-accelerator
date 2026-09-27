import { z } from "zod";
import { tool } from "../tools/tool.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { Message } from "../types/message.ts";
import { normalizeMediaInput } from "./media.ts";
import { base64ToBytes } from "./base64.ts";
import { escapeXml } from "./serialization.ts";
import { getModelFromCatalog } from "../models/catalog.ts";

/**
 * Client-side document conversion (anydoc engine).
 *
 * Converts PDF, Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, and CSV
 * inputs into Markdown text, so models WITHOUT native document parsing can
 * still read them. Models WITH native support should keep using it — this is
 * an explicit opt-in escape hatch, never an automatic fallback.
 *
 * The `@firecrawl/anydoc` package is an OPTIONAL peer dependency and is only
 * ever loaded via dynamic import, so installs without it (and browser bundles)
 * are unaffected. Importing this module alone never touches native code.
 */

/** Default cap for converted Markdown length (chars) — bounds context usage. */
export const DEFAULT_DOCUMENT_MAX_CHARS = 100_000;

/** Maximum bytes fetched from a remote document URL. */
export const MAX_DOCUMENT_FETCH_BYTES = 50_000_000;

const EXTENSION_TO_FORMAT: Record<string, string> = {
  pdf: "pdf",
  doc: "doc",
  docx: "docx",
  docm: "docm",
  ppt: "ppt",
  pps: "pps",
  pot: "pot",
  pptx: "pptx",
  pptm: "pptm",
  ppsx: "ppsx",
  ppsm: "ppsm",
  xls: "xls",
  xlsx: "xlsx",
  xlsm: "xlsm",
  xlsb: "xlsb",
  odt: "odt",
  ods: "ods",
  odp: "odp",
  rtf: "rtf",
  epub: "epub",
  csv: "csv",
};

const MIME_TO_FORMAT: Record<string, string> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "application/epub+zip": "epub",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
};

/** Thrown when a document cannot be converted (anydoc codes pass through). */
export class DocumentConversionError extends Error {
  readonly code: string;
  readonly file?: string;

  /**
   * Creates a conversion failure carrying the engine's error code.
   *
   * @param code anydoc `ConvertErrorCode` (`needsOcr`, `encrypted`, …) or
   * `missing_dependency` / `io` / `conversion_failed` for wrapper-level faults.
   * @param message Human-readable one-liner (already prefixed).
   * @param file Optional file label (path, URL, or display name).
   */
  constructor(code: string, message: string, file?: string) {
    super(message);
    this.name = "DocumentConversionError";
    this.code = code;
    if (file !== undefined) this.file = file;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DocumentConversionError);
    }
  }
}

/** Options accepted by {@link convertDocumentToMarkdown} / {@link convertDocumentInput}. */
export interface ConvertDocumentOptions {
  /** Display name / format hint (e.g. `"data.csv"`). Required for extension-less bytes. */
  filename?: string;
  /** Explicit format override (`"pdf" | "docx" | "xlsx" | "csv" | …`). Wins over inference. */
  format?: string;
  /** MIME hint used when no filename is available. */
  mimeType?: string;
  /** Maximum Markdown chars returned (default {@link DEFAULT_DOCUMENT_MAX_CHARS}). */
  maxChars?: number;
  /** Abort signal honored by the remote-fetch leg. */
  signal?: AbortSignal;
}

/** Normalized conversion result (pre-XML-envelope). */
export interface ConvertedDocument {
  markdown: string;
  name: string;
  format: string;
  truncated: boolean;
}

function missingDependencyError(): DocumentConversionError {
  return new DocumentConversionError(
    "missing_dependency",
    "[Agent Accelerator] Document conversion needs the optional peer '@firecrawl/anydoc'. Install it with: bun add @firecrawl/anydoc"
  );
}

type AnyDocModule = typeof import("@firecrawl/anydoc");

let anydocModule: AnyDocModule | undefined;
let anydocMissing = false;

/** Loads the optional anydoc engine (dynamic import only — never bundled). */
async function loadAnydoc(): Promise<AnyDocModule> {
  if (anydocModule) return anydocModule;
  if (anydocMissing) throw missingDependencyError();
  try {
    anydocModule = await import("@firecrawl/anydoc");
    return anydocModule;
  } catch {
    anydocMissing = true;
    throw missingDependencyError();
  }
}

/**
 * True when the optional conversion engine can be loaded.
 *
 * @example `if (await isAnydocAvailable()) { … }`
 */
export async function isAnydocAvailable(): Promise<boolean> {
  if (anydocModule) return true;
  try {
    await import("@firecrawl/anydoc");
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves an anydoc format name from explicit, filename, or MIME hints.
 *
 * @example `resolveDocumentFormat({ filename: "data.csv" }) // "csv"`
 */
export function resolveDocumentFormat(opts: {
  filename?: string;
  format?: string;
  mimeType?: string;
}): string | undefined {
  if (opts.format && opts.format.trim()) return opts.format.trim().toLowerCase();
  if (opts.filename) {
    const clean = opts.filename.split("?")[0]!.split("#")[0]!;
    const ext = clean.split(".").pop()?.toLowerCase();
    if (ext) {
      const mapped = EXTENSION_TO_FORMAT[ext];
      if (mapped) return mapped;
    }
  }
  if (opts.mimeType) {
    const mime = opts.mimeType.split(";")[0]!.trim().toLowerCase();
    const mapped = MIME_TO_FORMAT[mime];
    if (mapped) return mapped;
  }
  return undefined;
}

/**
 * Truncates converted Markdown to a char budget with a visible marker.
 *
 * @example `truncateMarkdown(md, 1000)`
 */
export function truncateMarkdown(markdown: string, maxChars?: number): { text: string; truncated: boolean } {
  const limit = maxChars && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_DOCUMENT_MAX_CHARS;
  if (markdown.length <= limit) return { text: markdown, truncated: false };
  return {
    text:
      `${markdown.slice(0, limit)}\n\n[Truncated: showing ${limit} of ${markdown.length} chars. Pass a larger maxChars to read more.]`,
    truncated: true,
  };
}

/**
 * Wraps converted Markdown in the canonical `<Document>` envelope.
 *
 * @example `buildDocumentXml("report.pdf", "./report.pdf", md)`
 */
export function buildDocumentXml(name: string, destination: string, markdown: string): string {
  return `<Document name="${escapeXml(name)}" destination="${escapeXml(destination)}">\n${escapeXml(markdown)}\n</Document>`;
}

/** Wire format accepted by `toMarkdownBytes` (the engine's `Format` enum, by query). */
type AnyDocWireFormat = Parameters<AnyDocModule["toMarkdownBytes"]>[1];

/**
 * Canonicalizes an inferred format name through the engine
 * (`pptm` → `pptx`, `.csv` → `csv`). Unknown names pass through untouched —
 * the engine validates and rejects with a coded error.
 */
function canonicalizeFormat(
  anydoc: AnyDocModule,
  name: string | undefined
): Exclude<AnyDocWireFormat, undefined> {
  if (!name) return null;
  try {
    const canonical: unknown = anydoc.formatFromExtension(name.startsWith(".") ? name : `.${name}`);
    if (typeof canonical === "string" && canonical) {
      return canonical as Exclude<AnyDocWireFormat, undefined>;
    }
  } catch {
    // fall through to the raw name
  }
  return name as unknown as Exclude<AnyDocWireFormat, undefined>;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

/** True for plausible local paths (excludes URLs, data URLs, and raw base64). */
function looksLikePath(value: string): boolean {
  if (!value || value.length > 4096) return false;
  if (isHttpUrl(value) || isDataUrl(value)) return false;
  if (value.includes("\n") || value.includes("\0")) return false;
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 100 && value.length % 4 === 0) return false;
  return true;
}

function basenameOf(value: string): string {
  const clean = value.split("?")[0]!.split("#")[0]!;
  const parts = clean.split(/[\\/]/);
  return parts.pop() || clean;
}

function toDocumentConversionError(err: unknown, file?: string): DocumentConversionError {
  if (err instanceof DocumentConversionError) return err;
  const code = (err as { code?: unknown })?.code;
  const detail = err instanceof Error ? err.message : String(err);
  const where = file ? ` "${file}"` : "";
  if (typeof code === "string" && code) {
    const hints: Record<string, string> = {
      needsOcr: " The document has scanned/image-only pages, which need OCR (not enabled).",
      encrypted: " The document is password-protected.",
      unsupported:
        " Pass an explicit format (e.g. format: \"csv\") or filename so the format can be determined.",
    };
    const hint = hints[code] ?? "";
    return new DocumentConversionError(
      code,
      `[Agent Accelerator] Could not convert document${where} (${code}): ${detail}.${hint}`,
      file
    );
  }
  return new DocumentConversionError(
    "conversion_failed",
    `[Agent Accelerator] Could not convert document${where}: ${detail}.`,
    file
  );
}

/**
 * Converts a document destination to normalized Markdown + metadata.
 *
 * Accepts a local file path (read by the engine directly), an http(s) URL
 * (fetched first, capped at {@link MAX_DOCUMENT_FETCH_BYTES}), a data URL,
 * raw base64, or binary bytes. Throws {@link DocumentConversionError} — the
 * built-in tool converts these into model-readable `Error: …` strings instead.
 */
export async function convertDocumentInput(
  input: string | Uint8Array | ArrayBuffer,
  opts: ConvertDocumentOptions = {}
): Promise<ConvertedDocument> {
  const anydoc = await loadAnydoc();
  const filenameOpt = opts.filename?.trim() || undefined;

  try {
    // Remote URL leg: fetch bytes first (anydoc reads files, not URLs).
    if (typeof input === "string" && isHttpUrl(input)) {
      const res = await fetch(input, { signal: opts.signal });
      if (!res.ok) {
        throw new DocumentConversionError(
          "io",
          `[Agent Accelerator] Could not download document "${input}" (HTTP ${res.status} ${res.statusText}).`,
          input
        );
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_DOCUMENT_FETCH_BYTES) {
        throw new DocumentConversionError(
          "resourceLimit",
          `[Agent Accelerator] Remote document "${input}" is ${(buf.byteLength / 1_000_000).toFixed(1)} MB, over the ${MAX_DOCUMENT_FETCH_BYTES / 1_000_000} MB fetch cap.`,
          input
        );
      }
      const name = filenameOpt || basenameOf(input);
      const inferred = resolveDocumentFormat({
        filename: name,
        format: opts.format,
        mimeType: res.headers.get("content-type") || opts.mimeType,
      });
      let wire = canonicalizeFormat(anydoc, inferred);
      if (!wire) {
        try {
          wire = anydoc.formatFromBytes(buf);
        } catch {
          wire = null;
        }
      }
      if (!wire) {
        throw new DocumentConversionError(
          "unsupported",
          `[Agent Accelerator] Could not determine the format of "${input}". Pass filename (e.g. "data.csv") or format explicitly.`,
          input
        );
      }
      const markdown = await anydoc.toMarkdownBytes(buf, wire);
      const { text, truncated } = truncateMarkdown(markdown, opts.maxChars);
      return { markdown: text, name, format: String(wire), truncated };
    }

    // Local path leg: the engine reads + detects from the path itself.
    if (typeof input === "string" && looksLikePath(input)) {
      const name = filenameOpt || basenameOf(input);
      const markdown = await anydoc.toMarkdown(input);
      const inferred = resolveDocumentFormat({ filename: name, format: opts.format });
      const format = String(canonicalizeFormat(anydoc, inferred) ?? inferred ?? "unknown");
      const { text, truncated } = truncateMarkdown(markdown, opts.maxChars);
      return { markdown: text, name, format, truncated };
    }

    // Bytes / data URL / base64 leg: normalize first, format must resolve.
    const normalized = await normalizeMediaInput(input, opts.mimeType);
    const name = filenameOpt || "document";
    const inferred = resolveDocumentFormat({
      filename: opts.filename,
      format: opts.format,
      mimeType: normalized.mimeType,
    });
    const bytes = base64ToBytes(normalized.base64Data);
    let wire = canonicalizeFormat(anydoc, inferred);
    if (!wire) {
      try {
        wire = anydoc.formatFromBytes(bytes);
      } catch {
        wire = null;
      }
    }
    if (!wire) {
      throw new DocumentConversionError(
        "unsupported",
        `[Agent Accelerator] Could not determine the document format. Pass filename (e.g. "data.csv") or format explicitly.`,
        name
      );
    }
    const markdown = await anydoc.toMarkdownBytes(bytes, wire);
    const { text, truncated } = truncateMarkdown(markdown, opts.maxChars);
    return { markdown: text, name, format: String(wire), truncated };
  } catch (err) {
    const label =
      typeof input === "string" && (isHttpUrl(input) || (looksLikePath(input) && input.length < 1024))
        ? input
        : (opts.filename ?? "document");
    throw toDocumentConversionError(err, label);
  }
}

/**
 * Converts a document to Markdown text. Explicit dev-facing primitive —
 * throws {@link DocumentConversionError} on failure.
 *
 * @example `const md = await convertDocumentToMarkdown("./report.xlsx");`
 */
export async function convertDocumentToMarkdown(
  input: string | Uint8Array | ArrayBuffer,
  opts: ConvertDocumentOptions = {}
): Promise<string> {
  const doc = await convertDocumentInput(input, opts);
  return doc.markdown;
}

/**
 * True when the model can receive `file` parts natively (catalog `pdf` input).
 * Unknown models count as capable — the provider verdict stands, matching
 * `assertModalitiesSupported`.
 *
 * @example `modelSupportsFileInput("google", "gemini-3.5-flash-lite")`
 */
export function modelSupportsFileInput(providerId: string, modelId: string): boolean {
  try {
    const spec = getModelFromCatalog(providerId, modelId);
    if (!spec) return true;
    return spec.modalities?.input?.includes("pdf") ?? true;
  } catch {
    return true;
  }
}

/**
 * Implements `bypassInputFileModality`: rewrites `file` parts to `<Document>`
 * Markdown text when the model lacks native support. Idempotent (converted
 * parts are plain text afterwards) and persistent in history for prefix-cache
 * stability. Conversion failures degrade to a readable placeholder so the run
 * continues.
 */
export async function preprocessFilePartsForBypass(
  messages: Message[],
  opts: { providerId: string; modelId: string; signal?: AbortSignal; maxChars?: number }
): Promise<void> {
  if (modelSupportsFileInput(opts.providerId, opts.modelId)) return;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (let i = 0; i < m.content.length; i++) {
      const part = m.content[i];
      if (!part || (part as { type?: unknown }).type !== "file") continue;
      const raw = (part as { file?: unknown; filename?: unknown; mimeType?: unknown }).file as
        | string
        | Uint8Array
        | ArrayBuffer;
      const filename =
        typeof (part as { filename?: unknown }).filename === "string"
          ? ((part as { filename?: string }).filename as string)
          : undefined;
      const mimeType =
        typeof (part as { mimeType?: unknown }).mimeType === "string"
          ? ((part as { mimeType?: string }).mimeType as string)
          : undefined;
      const display = filename || "document";
      try {
        const doc = await convertDocumentInput(raw, {
          filename,
          mimeType,
          maxChars: opts.maxChars,
          signal: opts.signal,
        });
        const destination =
          filename ||
          (typeof raw === "string" && (isHttpUrl(raw) || (looksLikePath(raw) && raw.length < 1024))
            ? raw
            : doc.name);
        m.content[i] = { type: "text", text: buildDocumentXml(doc.name, destination, doc.markdown) };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        m.content[i] = { type: "text", text: `[Document "${display}" could not be read: ${reason}]` };
      }
    }
  }
}

/**
 * Built-in model-callable document converter. Register it and move on:
 *
 * @example
 * ```ts
 * import { convert_document_to_markdown } from "agent-accelerator";
 * const agent = new Agent({ model, tools: { convert_document_to_markdown } });
 * ```
 */
export const convert_document_to_markdown: ToolDefinition = tool({
  name: "convert_document_to_markdown",
  description:
    "Convert a document file to Markdown text. Call this when the user provides a document file path or URL, or asks about the contents of a document. " +
    "Supported formats: PDF (.pdf), Word (.doc, .docx, .docm), PowerPoint (.ppt, .pps, .pot, .pptx, .pptm, .ppsx, .ppsm), " +
    "Excel (.xls, .xlsx, .xlsm, .xlsb), OpenDocument (.odt, .ods, .odp), RTF (.rtf), EPUB (.epub), CSV (.csv). " +
    "Returns the content wrapped in <Document name destination> tags. Do not use for images, audio, or video.",
  input: z.object({
    destination: z
      .string()
      .min(1)
      .describe("Local file path or http(s) URL of the document to convert."),
    format: z
      .string()
      .optional()
      .describe(
        "Explicit format override, e.g. 'pdf', 'docx', 'xlsx', 'csv'. Inferred from the destination when omitted."
      ),
    maxChars: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum Markdown characters to return (default 100000). Excess is truncated with a marker."),
  }),
  timeoutMs: 60_000,
  execute: async ({ destination, format, maxChars }, ctx) => {
    const dest = String(destination ?? "").trim();
    if (!dest) {
      return "Error: convert_document_to_markdown needs a non-empty destination (local file path or http(s) URL).";
    }
    try {
      const doc = await convertDocumentInput(dest, { format, maxChars, signal: ctx?.signal });
      return buildDocumentXml(doc.name, dest, doc.markdown);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `Error: ${detail}`;
    }
  },
});
