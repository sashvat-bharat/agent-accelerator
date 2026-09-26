import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveDocumentFormat,
  truncateMarkdown,
  buildDocumentXml,
  DocumentConversionError,
  convert_document_to_markdown,
  modelSupportsFileInput,
  isAnydocAvailable,
  DEFAULT_DOCUMENT_MAX_CHARS,
} from "../src/utils/documents.ts";

const ANYDOC = await isAnydocAvailable();

describe("document format inference (engine-free)", () => {
  it("prefers the explicit format override", () => {
    expect(resolveDocumentFormat({ filename: "data.txt", format: "CSV" })).toBe("csv");
    expect(resolveDocumentFormat({ format: "  xlsx " })).toBe("xlsx");
  });

  it("infers from filename extensions", () => {
    expect(resolveDocumentFormat({ filename: "report.pdf" })).toBe("pdf");
    expect(resolveDocumentFormat({ filename: "report.docx" })).toBe("docx");
    expect(resolveDocumentFormat({ filename: "sheet.xlsx" })).toBe("xlsx");
    expect(resolveDocumentFormat({ filename: "data.csv" })).toBe("csv");
    expect(resolveDocumentFormat({ filename: "slides.pptx" })).toBe("pptx");
    expect(resolveDocumentFormat({ filename: "https://x.test/f/2024ltr.pdf?dl=1" })).toBe("pdf");
  });

  it("infers from MIME types", () => {
    expect(resolveDocumentFormat({ mimeType: "application/pdf" })).toBe("pdf");
    expect(resolveDocumentFormat({ mimeType: "text/csv; charset=utf-8" })).toBe("csv");
    expect(
      resolveDocumentFormat({
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
    ).toBe("xlsx");
  });

  it("returns undefined when nothing resolves", () => {
    expect(resolveDocumentFormat({})).toBeUndefined();
    expect(resolveDocumentFormat({ filename: "notes.txt" })).toBeUndefined();
  });
});

describe("document XML envelope + truncation (engine-free)", () => {
  it("escapes names, destinations, and markdown content", () => {
    const xml = buildDocumentXml('a"b.pdf', "https://x/?a=1&b=2", "# T & <tag>");
    expect(xml).toBe(
      '<Document name="a&quot;b.pdf" destination="https://x/?a=1&amp;b=2">\n# T &amp; &lt;tag&gt;\n</Document>'
    );
  });

  it("truncates with a visible marker, passes short text through", () => {
    const short = truncateMarkdown("hello", 100);
    expect(short).toEqual({ text: "hello", truncated: false });
    const long = truncateMarkdown("abcdefghij", 4);
    expect(long.truncated).toBe(true);
    expect(long.text.startsWith("abcd")).toBe(true);
    expect(long.text).toContain("[Truncated:");
  });

  it("DocumentConversionError carries code + file", () => {
    const err = new DocumentConversionError("needsOcr", "msg", "scan.pdf");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DocumentConversionError");
    expect(err.code).toBe("needsOcr");
    expect(err.file).toBe("scan.pdf");
  });

  it("built-in tool is registered under its snake_case name with format docs", () => {
    expect(convert_document_to_markdown.name).toBe("convert_document_to_markdown");
    expect(convert_document_to_markdown.description).toContain(".pdf");
    expect(convert_document_to_markdown.description).toContain("Excel");
    expect(convert_document_to_markdown.description).toContain("CSV");
    expect(convert_document_to_markdown.description).toContain("<Document");
    const parsed = (convert_document_to_markdown.input as any).safeParse({
      destination: "./report.xlsx",
    });
    expect(parsed.success).toBe(true);
    expect((convert_document_to_markdown.input as any).safeParse({}).success).toBe(false);
  });

  it("unknown models count as file-capable (provider decides)", () => {
    expect(modelSupportsFileInput("nope", "unknown-model-xyz-123")).toBe(true);
  });
});

describe.skipIf(!ANYDOC)("document conversion integration (anydoc installed)", () => {
  it("converts a CSV file to Markdown", async () => {
    const { convertDocumentToMarkdown } = await import("../src/utils/documents.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accel-doc-"));
    const csv = path.join(dir, "data.csv");
    fs.writeFileSync(csv, "name,price\napples,1.2\npears,2.3\n");
    const md = await convertDocumentToMarkdown(csv);
    expect(md).toContain("apples");
    expect(md).toContain("price");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("built-in tool wraps converted Markdown in the Document envelope", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accel-doc-"));
    const csv = path.join(dir, "data.csv");
    fs.writeFileSync(csv, "name,price\napples,1.2\n");
    const out = (await convert_document_to_markdown.execute(
      { destination: csv },
      { toolCallId: "t1" }
    )) as string;
    expect(out.startsWith('<Document name="data.csv"')).toBe(true);
    expect(out).toContain("apples");
    expect(out.endsWith("</Document>")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns an Error string (not a throw) for missing files", async () => {
    const out = (await convert_document_to_markdown.execute(
      { destination: "/nope/missing.pdf" },
      { toolCallId: "t2" }
    )) as string;
    expect(out.startsWith("Error:")).toBe(true);
  });
});
