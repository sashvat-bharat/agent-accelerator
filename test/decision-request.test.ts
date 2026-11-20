import { describe, it, expect } from "bun:test";
import { ValidationError } from "../src/index.ts";
import { getDecisionModel, type DecisionModelInfo } from "../src/models/decision-models.ts";
import { resolveDecisionRequest } from "../src/decision/request.ts";
import type { DecisionOptions } from "../src/index.ts";

const google = getDecisionModel("google/gemini-decision-1")!;
const openai = getDecisionModel("openai/gpt-6-luna")!;

// Resolves a request and returns the ValidationError text it raises (or "" when it is valid).
function problem(opts: Partial<DecisionOptions>, def: DecisionModelInfo = google): string {
  try {
    resolveDecisionRequest({ model: def.model, input: "x", questions: { q: { type: "noul", instructions: "Is it?" } }, ...opts } as DecisionOptions, def);
    return "";
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as Error).message;
  }
}

describe("resolveDecisionRequest", () => {
  it("turns a valid request into text and media parts and final questions", () => {
    const r = resolveDecisionRequest(
      {
        model: google.model,
        input: [
          "The order:",
          { type: "json", json: { id: 8821, tier: "Gold" } },
          { type: "image", image: "photo.png" },
        ],
        questions: {
          a: { type: "noul", instructions: ["Is ", { type: "text", text: "it" }, " fine in ", { type: "json", json: { k: 1 } }, "?"] },
          b: { type: "choice", instructions: "Which?", criteria: { billing: "Payments.", other: "" } },
          c: { type: "score", instructions: "How bad?", criteria: ["low", "high"] },
        },
      },
      google
    );
    expect(r.input).toEqual([
      { type: "text", text: "The order:" },
      { type: "text", text: '{"id":8821,"tier":"Gold"}' }, // JSON is serialized to text
      { type: "image", image: "photo.png" },
    ]);
    expect([...r.kinds].sort()).toEqual(["image", "text"]);
    expect(r.questions["a"]).toEqual({ type: "noul", instructions: 'Is it fine in {"k":1}?' }); // joined in order, no separator
    expect(r.questions["b"]).toEqual({ type: "choice", instructions: "Which?", criteria: { billing: "Payments.", other: "" } });
    expect(r.questions["c"]).toEqual({ type: "score", instructions: "How bad?", criteria: ["low", "high"] });
  });

  it("keeps noul criteria", () => {
    const r = resolveDecisionRequest(
      { model: google.model, input: "x", questions: { q: { type: "noul", instructions: "Defect?", criteria: { true: "Broken.", false: "Preference." } } } },
      google
    );
    expect(r.questions["q"]).toMatchObject({ criteria: { true: "Broken.", false: "Preference." } });
  });

  it("lists every problem at once", () => {
    const msg = problem({
      input: [],
      questions: {
        "bad name": { type: "noul", instructions: "ok" },
        ok1: { type: "yesno" as never, instructions: "ok" },
        ok2: { type: "choice", instructions: " ", criteria: { only: "one" } },
        ok3: { type: "score", instructions: "x", criteria: ["one"] },
      },
    });
    expect(msg).toContain("(6 problems)"); // input, name, type, blank instructions, one option, one level
    expect(msg).toContain("input: required");
    expect(msg).toContain("questions.ok2.instructions: required");
    expect(msg).toContain("questions.ok2.criteria: a choice needs at least 2 options");
    expect(msg).toContain("questions.ok3.criteria: a score needs at least 2 levels");
  });

  it("checks names, types, instructions, criteria and counts", () => {
    expect(problem({ questions: { "a b": { type: "noul", instructions: "x" } } })).toContain('questions.a b: the name must be 1 to 64 characters');
    expect(problem({ questions: { ["x".repeat(65)]: { type: "noul", instructions: "x" } } })).toContain("the name must be");
    expect(problem({ questions: { q: { type: "box" as never, instructions: "x" } } })).toContain('"box" is not one of: noul, choice, score');
    expect(problem({ questions: { q: { type: "noul", instructions: "  " } } })).toContain("questions.q.instructions: required");
    expect(problem({ questions: { q: { type: "noul", instructions: "x", criteria: { maybe: "?" } as never } } })).toContain('unknown key "maybe"');
    expect(problem({ questions: { q: { type: "choice", instructions: "x", criteria: { one: "" } } } })).toContain("at least 2 options");
    expect(problem({ questions: { q: { type: "choice", instructions: "x", criteria: { " a": "", b: "" } } } })).toContain("must not start or end with a space");
    expect(problem({ questions: { q: { type: "choice", instructions: "x", criteria: { "a\nb": "", b: "" } } } })).toContain("control characters");
    expect(problem({ questions: { q: { type: "choice", instructions: "x", criteria: { a: 1 as never, b: "" } } } })).toContain("the description must be a string");
    expect(problem({ questions: { q: { type: "score", instructions: "x", criteria: ["only"] } } })).toContain("at least 2 levels");
    expect(problem({ questions: { q: { type: "score", instructions: "x", criteria: ["a", " "] } } })).toContain("a level needs a non-empty description");
    expect(problem({ questions: {} })).toContain("questions: required");
  });

  it("checks the model's own limits", () => {
    const many = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`q${i}`, { type: "noul" as const, instructions: "x" }]));
    expect(problem({ questions: many }, openai)).toContain("401 questions; this model takes at most 400");
    expect(problem({ questions: many }, google)).toBe(""); // Google takes 1000
    const levels = Array.from({ length: 11 }, (_, i) => `l${i}`);
    expect(problem({ questions: { q: { type: "score", instructions: "x", criteria: levels } } }, openai)).toContain("11 levels; this model takes at most 10");
    expect(problem({ questions: { q: { type: "score", instructions: "x", criteria: levels } } }, google)).toBe("");
  });

  it("checks the input kinds against what the model reads", () => {
    expect(problem({ input: { type: "audio", audio: "a.mp3" } }, google)).toBe("");
    const msg = problem({ input: [{ type: "text", text: "hi" }, { type: "audio", audio: "a.mp3" }, { type: "video", video: "v.mp4" }] }, openai);
    expect(msg).toContain("input[1]: openai/gpt-6-luna cannot read audio. It reads: text, image.");
    expect(msg).toContain("input[2]: openai/gpt-6-luna cannot read video");
    expect(problem({ input: { type: "image", image: "" } as never })).toContain("the image is missing");
    expect(problem({ input: { type: "text", text: " " } })).toContain("text is empty");
    expect(problem({ input: { type: "sticker" } as never })).toContain('unknown part type "sticker"');
    expect(problem({ input: 42 as never })).toContain("expected a string or a part");
    expect(problem({ input: "" })).toContain("input: required");
  });
});
