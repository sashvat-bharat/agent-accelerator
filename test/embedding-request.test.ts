import { describe, it, expect } from "bun:test";
import { getEmbeddingModel, cosineSimilarity, ValidationError } from "../src/index.ts";
import type { EmbeddingOptions } from "../src/index.ts";
import { resolveEmbeddingRequest } from "../src/embedding/request.ts";
import { priceEmbeddingUsage } from "../src/embedding/pricing.ts";

const def = (m: string) => getEmbeddingModel(m)!;
const check = (model: string, rest: Omit<EmbeddingOptions, "model">) => resolveEmbeddingRequest({ model, ...rest }, def(model));
const problemsOf = (model: string, rest: Omit<EmbeddingOptions, "model">): string => {
  try {
    check(model, rest);
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as Error).message;
  }
  throw new Error("expected a ValidationError");
};
const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("embedding request checks", () => {
  it("turns strings, parts and { parts } into lists of parts, one list per vector", () => {
    const { request } = check("google/gemini-embedding-2", {
      input: ["a", { type: "image", image: PNG }, { parts: [{ type: "text", text: "caption" }, { type: "image", image: PNG }] }],
    });
    expect(request.items.map((p) => p.length)).toEqual([1, 1, 2]);
    expect([...request.kinds].sort()).toEqual(["image", "text"]);
    expect(check("openai/text-embedding-3-small", { input: "one" }).request.items).toEqual([[{ type: "text", text: "one" }]]);
  });

  it("lists every problem in one error", () => {
    const msg = problemsOf("openai/text-embedding-3-small", {
      input: ["", { type: "image", image: PNG }, { parts: [] }, 5 as never],
      dimensions: 0,
    });
    expect(msg).toContain("(5 problems)");
    expect(msg).toContain("input[0]: text is empty.");
    expect(msg).toContain("input[1]: openai/text-embedding-3-small cannot read image. It reads: text.");
    expect(msg).toContain("input[2]: has no parts.");
    expect(msg).toContain("input[3]: expected a string");
    expect(msg).toContain("dimensions: must be a whole number above 0");
  });

  it("needs an input, and a single-kind model cannot combine parts", () => {
    expect(problemsOf("openai/text-embedding-3-small", { input: [] })).toContain("input: required");
    expect(problemsOf("openai/text-embedding-3-small", { input: undefined as never })).toContain("input: required");
    expect(
      problemsOf("google/gemini-embedding-001", { input: { parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } })
    ).toContain("cannot combine several parts");
  });

  it("checks the per-vector limits and the media is present", () => {
    const seven = { parts: Array.from({ length: 7 }, () => ({ type: "image" as const, image: PNG })) };
    expect(problemsOf("google/gemini-embedding-2", { input: seven })).toContain("7 images; this model takes at most 6");
    const pdfs = { parts: [{ type: "file" as const, file: "a.pdf" }, { type: "file" as const, file: "b.pdf" }] };
    expect(problemsOf("google/gemini-embedding-2", { input: pdfs })).toContain("2 PDFs; this model takes at most 1");
    expect(problemsOf("google/gemini-embedding-2", { input: { type: "image", image: "" } })).toContain("the image is missing");
    expect(check("google/gemini-embedding-2", { input: { type: "file", file: "a.pdf" } }).request.kinds.has("pdf")).toBe(true);
  });

  it("checks the vector length against the model", () => {
    expect(check("openai/text-embedding-3-small", { input: "a", dimensions: 256 }).request.dimensions).toBe(256);
    expect(problemsOf("google/gemini-embedding-2", { input: "a", dimensions: 64 })).toContain("outside what google/gemini-embedding-2 makes (128 to 3072; recommended 768, 1536, 3072)");
    expect(problemsOf("google/gemini-embedding-2", { input: "a", dimensions: 4096 })).toContain("outside");
    expect(problemsOf("openai/text-embedding-ada-002", { input: "a", dimensions: 512 })).toContain("always makes 1536 numbers");
    expect(check("openai/text-embedding-ada-002", { input: "a", dimensions: 1536 }).request.dimensions).toBeUndefined(); // its own length: nothing to send
    expect(problemsOf("openai/text-embedding-3-small", { input: "a", dimensions: 1.5 })).toContain("whole number");
  });

  it("drops a task a model has no control for, with a warning, and rejects an unknown task", () => {
    const { request, warnings } = check("openai/text-embedding-3-small", { input: "a", task: "search_query" });
    expect(request.task).toBeUndefined();
    expect(warnings).toEqual([expect.objectContaining({ capability: "task", requested: "search_query" })]);
    expect(check("google/gemini-embedding-2", { input: "a", task: "clustering" }).request.task).toBe("clustering");
    expect(problemsOf("google/gemini-embedding-2", { input: "a", task: "nope" as never })).toContain('task: "nope" is not one of');
  });

  it("keeps a title only for a Google search_document", () => {
    expect(check("google/gemini-embedding-001", { input: "a", task: "search_document", title: " Doc " }).request.title).toBe("Doc");
    const other = check("google/gemini-embedding-001", { input: "a", task: "search_query", title: "Doc" });
    expect(other.request.title).toBeUndefined();
    expect(other.warnings[0]!.reason).toContain('only with task "search_document"');
    const openai = check("openai/text-embedding-3-small", { input: "a", task: "search_document", title: "Doc" });
    expect(openai.warnings.map((w) => w.capability)).toEqual(["task", "title"]);
    expect(problemsOf("google/gemini-embedding-2", { input: "a", title: "  " })).toContain("title: must be a non-empty string");
  });
});

describe("embedding prices", () => {
  const kinds = (...k: Array<"text" | "image" | "audio" | "video" | "pdf">) => new Set(k);
  const tokens = (inputTokens: number, inputDetails?: object) => ({ inputTokens, outputTokens: 0, totalTokens: inputTokens, ...(inputDetails ? { inputDetails } : {}) });

  it("prices text tokens at the text rate in micro-USD", () => {
    expect(priceEmbeddingUsage(def("openai/text-embedding-3-small"), tokens(1000), { kinds: kinds("text") })).toEqual({
      inputCost: 0.00002,
      outputCost: 0,
      totalCost: 0.00002,
    });
    expect(priceEmbeddingUsage(def("openai/text-embedding-3-large"), tokens(7), { kinds: kinds("text") })!.totalCost).toBe(0.000001); // 0.91 micro-USD, rounded to whole micro-USD like every price in the SDK
  });

  it("prices each kind at its own rate when the provider splits the tokens", () => {
    const g = def("google/gemini-embedding-2");
    // 100 text at $0.20, 258 image at $0.45, 10 audio at $6.50 per 1M
    const cost = priceEmbeddingUsage(g, tokens(368, { textTokens: 100, imageTokens: 258, audioTokens: 10 }), { kinds: kinds("text", "image", "audio") })!;
    expect(cost.totalCost).toBe(0.000201); // 20 + 116.1 + 65 micro-USD, rounded
    // without a text count, the rest of the input is text
    expect(priceEmbeddingUsage(g, tokens(358, { imageTokens: 258 }), { kinds: kinds("text", "image") })!.totalCost).toBe(0.000136);
  });

  it("stays unknown instead of guessing", () => {
    const g = def("google/gemini-embedding-2");
    expect(priceEmbeddingUsage(g, tokens(0), { kinds: kinds("text") })).toBeUndefined(); // no usage reported
    expect(priceEmbeddingUsage(g, tokens(300), { kinds: kinds("image") })).toBeUndefined(); // media with no per-kind split
    expect(priceEmbeddingUsage(g, tokens(300, { videoTokens: 300 }), { kinds: kinds("video") })!.totalCost).toBe(0.0036);
    expect(priceEmbeddingUsage(def("google/gemini-embedding-001"), tokens(10, { imageTokens: 10 }), { kinds: kinds("text") })).toBeUndefined(); // a rate the table lacks
    const noPrice = { ...def("openai/text-embedding-3-small"), prices: undefined };
    expect(priceEmbeddingUsage(noPrice, tokens(10), { kinds: kinds("text") })).toBeUndefined();
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for the same direction, 0 for unrelated, -1 for opposite, whatever the length", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 12);
    expect(cosineSimilarity(new Float32Array([3, 4]), [3, 4])).toBeCloseTo(1, 6); // any array-like
  });

  it("refuses vectors that cannot be compared", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow("same length");
    expect(() => cosineSimilarity([0, 0], [1, 1])).toThrow("not all zeros");
    expect(() => cosineSimilarity([], [])).toThrow(ValidationError);
  });
});
