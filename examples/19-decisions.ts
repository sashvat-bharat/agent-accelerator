/**
 * Agent Accelerator - Decisions
 *
 * One function asks typed questions about an input and gets probabilities back, not text:
 *
 *   1. Ask a yes/no, a choice and a rating in ONE call: the input is paid for once. Route on `confidence`, fail closed.
 *   2. Every answer has a type: check `answer.type` before reading `noul`, `choice` or `score`.
 *   3. A request the model cannot take is ONE error that lists every problem, before any network call.
 *   4. The same code runs on Google, OpenAI and OpenRouter (the SDK writes each provider's own request).
 *   5. A declined question is a `refusal`; the other answers stay.
 *   6. The cost is the provider's report or the table's price, never a made-up $0.
 *
 * It also works as a smoke check: it asserts these contracts and exits with code 1 (one line on stderr) if one stops holding.
 *
 * Run:  bun run examples/19-decisions.ts                   (offline: a scripted stand-in for the providers, no key, no cost)
 *       bun run examples/19-decisions.ts --live <model>    (a REAL decision model, e.g. google/gemini-decision-1; costs money,
 *                                                          except OpenRouter's free ones, e.g. openrouter/perplexity/pplx-decider-flash-v1.3:free)
 * The offline run keeps its own home in ./.agent-accel/demo-decisions/ (gitignored; wiped at the start), so it never touches your
 * real model catalog.
 *
 * Note: this example does not import `_shared.ts`, because that file sets the model list for the live examples.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type DecisionQuestion,
  ValidationError,
  generateDecision,
  listDecisionModels,
  setHome,
} from "agent-accelerator";

const C = "\x1b[36m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const R = "\x1b[0m";
const head = (t: string) => console.log(`\n${C}━━━ ${t} ━━━${R}`);

// One-line failure report, like `fail` in _shared.ts (which this example does not import).
const fail = (err: unknown): never => {
  console.error(`\n✖ ${(err as { message?: string } | undefined)?.message ?? err}\n`);
  process.exit(1);
};
const check = (ok: boolean, what: string): void => {
  if (!ok) fail(new Error(`contract broken: ${what}`));
  console.log(`${G}✓${R} ${what}`);
};

const live = process.argv.includes("--live") ? process.argv[process.argv.indexOf("--live") + 1] : undefined;
if (process.argv.includes("--live") && !live)
  fail(new Error("--live needs a model, e.g. --live google/gemini-decision-1"));

// The scripted providers: a toy "model" that answers from a few words in the input. Each wire has its own shape.
type Q = { type: string; instructions: string; criteria?: unknown; name?: string; choices?: Array<{ value: string }> };
const has = (text: string, w: string): boolean => text.toLowerCase().includes(w);
// One answer in the shared (Google/OpenRouter) shape.
function answer(text: string, q: Q): Record<string, unknown> {
  if (has(q.instructions, "decline")) return { type: "refusal" };
  if (q.type === "noul") return { type: "noul", noul: has(text, "charged twice") ? 0.97 : 0.04 };
  if (q.type === "choice") {
    const names = Object.keys(q.criteria as Record<string, string>);
    const top = has(text, "charged") ? "billing" : names[0]!;
    const rest = (1 - 0.9) / (names.length - 1);
    return {
      type: "choice",
      choice: top,
      probabilities: Object.fromEntries(names.map((n) => [n, n === top ? 0.9 : rest])),
      confidence: 0.9,
    };
  }
  return {
    type: "score",
    score: 1.7,
    probabilities: { "0": 0.05, "1": 0.25, "2": 0.7 },
    legend: { "0": "Low", "1": "Medium", "2": "High" },
    confidence: 0.7,
  };
}
// biome-ignore lint/suspicious/noExplicitAny: request bodies are read loosely in this demo
const requests: Array<{ url: string; body: any }> = [];
const offline = (async (url: string, init?: { body?: string }) => {
  if (url.includes("/models?"))
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "perplexity/pplx-decider-flash-v1.3:free",
            context_length: 262144,
            architecture: { input_modalities: ["text", "image"], output_modalities: ["decisions"] },
            pricing: { prompt: "0" },
            endpoints: ["/api/alpha/decisions"],
          },
        ],
      }),
      { status: 200 }
    );
  const body = JSON.parse(init?.body ?? "{}");
  requests.push({ url, body });
  if (url.includes("openai.com")) {
    // OpenAI: an ARRAY of questions in, an ARRAY of answers out (predicate, probabilities as lists).
    const text: string = typeof body.input === "string" ? body.input : "";
    const answers = (body.questions as Q[]).map((q) => {
      const a = answer(text, {
        type: q.type === "predicate" ? "noul" : q.type,
        instructions: q.instructions,
        criteria: Object.fromEntries((q.choices ?? []).map((c) => [c.value, ""])),
      });
      if (a["type"] === "refusal") return { type: "refusal", name: q.name };
      if (q.type === "predicate") return { type: "predicate", name: q.name, probability: a["noul"] };
      const probs = a["probabilities"] as Record<string, number>;
      const list = Object.entries(probs).map(([value, probability]) => ({ value, label: value, probability }));
      return { ...a, name: q.name, probabilities: list };
    });
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 40, output_tokens: 3, total_tokens: 43 } }), {
      status: 200,
    });
  }
  // Google and OpenRouter: a map of questions in, a map of answers out.
  const text: string = typeof (body.input ?? body.state) === "string" ? (body.input ?? body.state) : "";
  const answers = Object.fromEntries(
    Object.entries(body.questions as Record<string, Q>).map(([k, q]) => [k, answer(text, q)])
  );
  const usage = url.includes("openrouter")
    ? { input_tokens: 40, output_tokens: 3, cost: 0 }
    : { total_input_tokens: 40, total_output_tokens: 0, total_tokens: 40 };
  return new Response(JSON.stringify({ answers, usage }), { status: 200 });
}) as unknown as typeof fetch;
const conn = live ? {} : { apiKey: "demo-key", fetch: offline };

const TICKET = "I was charged twice for my order and I will cancel if nobody helps today.";
const questions = {
  upset: { type: "noul", instructions: "Is the customer upset?" },
  dept: {
    type: "choice",
    instructions: "Which department should handle this?",
    criteria: { billing: "Payments and refunds.", technical: "Problems using the product.", other: "" },
  },
  urgency: { type: "score", instructions: "How urgent is this?", criteria: ["Low", "Medium", "High"] },
} satisfies Record<string, DecisionQuestion>;

async function main(): Promise<void> {
  if (!live) {
    const demo = path.resolve(".agent-accel", "demo-decisions");
    fs.rmSync(demo, { recursive: true, force: true });
    setHome(demo);
  }
  const MODEL = live ?? "google/gemini-decision-1";

  head("1. Three questions, one call");
  const r = await generateDecision({ ...conn, model: MODEL, input: TICKET, questions });
  const dept = r.answers["dept"];
  const route = dept?.type === "choice" && dept.confidence > 0.8 ? dept.choice : "human_review"; // fail closed
  console.log(JSON.stringify(r.answers));
  console.log(
    "routed to:",
    route,
    "| usage:",
    r.usage.inputTokens,
    "tokens, cost $",
    r.usage.cost?.totalCost ?? "unknown"
  );
  check(Object.keys(r.answers).length === 3, "one answer per question");
  if (!live) check(requests.length === 1, "one provider request for all the questions");

  head("2. Every answer has a type");
  const upset = r.answers["upset"];
  const urgency = r.answers["urgency"];
  check(upset?.type === "noul" && upset.noul >= 0 && upset.noul <= 1, "a yes/no is a probability of yes");
  check(
    urgency?.type === "score" && Object.keys(urgency.legend).length === 3,
    "a score has probabilities per level and a legend from your criteria"
  );

  if (live) {
    console.log(`\n${Y}Live run done: the offline contracts below are skipped.${R}`);
    return;
  }

  head("3. A request the model cannot take is one clear error");
  try {
    await generateDecision({
      ...conn,
      model: "openai/gpt-6-luna",
      input: [{ type: "audio", audio: "call.mp3" }],
      questions: { "bad name": { type: "choice", instructions: "x", criteria: { only: "" } } },
    });
    fail(new Error("contract broken: a bad request was accepted"));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    console.log(`${Y}${err.message}${R}`);
    check(/cannot read audio/.test(err.message) && /name must be/.test(err.message), "one error lists every problem");
  }

  head("4. The same code on Google, OpenAI and OpenRouter");
  for (const model of [
    "google/gemini-decision-1",
    "openai/gpt-6-luna",
    "openrouter/perplexity/pplx-decider-flash-v1.3:free",
  ]) {
    const x = await generateDecision({ ...conn, model, input: TICKET, questions });
    const d = x.answers["dept"];
    check(
      d?.type === "choice" && d.choice === "billing" && x.answers["upset"]?.type === "noul",
      `${model}: same answers`
    );
  }
  check(
    requests.some((q) => Array.isArray(q.body.questions) && q.body.questions[0].type === "predicate"),
    "OpenAI got its own wire (predicate)"
  );
  check(listDecisionModels("openrouter").length === 1, "OpenRouter's list was read once and is now known");

  head("5. A declined question is a refusal; the others stay");
  const refused = await generateDecision({
    ...conn,
    model: MODEL,
    input: TICKET,
    questions: { ...questions, dept: { ...questions.dept, instructions: "Please decline this one." } },
  });
  check(
    refused.answers["dept"]?.type === "refusal" && refused.answers["upset"]?.type === "noul",
    "refusal passes through"
  );

  head("6. The cost is reported or priced, never a made-up $0");
  check(r.usage.cost?.totalCost === 0.000004, "Google: 40 tokens at $0.10 per 1M = 4 micro-USD");
  const viaRouter = await generateDecision({
    ...conn,
    model: "openrouter/perplexity/pplx-decider-flash-v1.3:free",
    input: TICKET,
    questions,
  });
  check(viaRouter.usage.cost?.totalCost === 0, "OpenRouter: the reported cost (a free model reports 0)");
  console.log(`\n${G}All contracts hold.${R}`);
}

main().catch(fail);
