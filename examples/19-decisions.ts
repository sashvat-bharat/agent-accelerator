// Decisions: one function asks typed questions about an input and gets probabilities back, not text.
//
//   1. Ask a yes/no, a choice and a rating in ONE call: the input is paid for once. Route on `confidence`, fail closed.
//   2. Every answer has a type: check `answer.type` before reading `noul`, `choice` or `score`.
//   3. A request the model cannot take is ONE error that lists every problem, before any network call.
//   4. The same code runs on Google, OpenAI and OpenRouter (the SDK writes each provider's own request).
//   5. A declined question is a `refusal`; the other answers stay.
//   6. The cost is the provider's report or the table's price, never a made-up $0.
//
// It also works as a smoke check: it asserts these contracts and exits with code 1 if one stops holding.
//
// Run: bun run examples/19-decisions.ts                  (offline: scripted providers, no key, no cost)
//      bun run examples/19-decisions.ts --live <model>   (a REAL decision model, e.g. google/gemini-decision-1; costs money, except
//                                                         OpenRouter's free ones, e.g. openrouter/perplexity/pplx-decider-flash-v1.3:free)
// The offline run keeps its own home in .agent-accel/demo-decisions/ (gitignored, wiped at the start), so it never touches
// your real model catalog.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type DecisionQuestion,
  ValidationError,
  generateDecision,
  listDecisionModels,
  setHome,
} from "agent-accelerator";
import { check, fail, liveModel } from "./_helpers";
import { offline, requests } from "./offline/decision";

const live = liveModel("google/gemini-decision-1");
const conn = live ? {} : { apiKey: "demo-key", fetch: offline };
const MODEL = live ?? "google/gemini-decision-1";

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
    fs.rmSync(demo, { recursive: true, force: true }); // the demo owns this folder
    setHome(demo);
  }

  console.log("1. Three questions, one call");
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

  console.log("\n2. Every answer has a type");
  const upset = r.answers["upset"];
  const urgency = r.answers["urgency"];
  check(upset?.type === "noul" && upset.noul >= 0 && upset.noul <= 1, "a yes/no is a probability of yes");
  check(
    urgency?.type === "score" && Object.keys(urgency.legend).length === 3,
    "a score has probabilities per level and a legend from your criteria"
  );

  if (live) return console.log("\nLive run done: the offline contracts below are skipped.");

  console.log("\n3. A request the model cannot take is one clear error");
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
    console.log(err.message);
    check(/cannot read audio/.test(err.message) && /name must be/.test(err.message), "one error lists every problem");
  }

  console.log("\n4. The same code on Google, OpenAI and OpenRouter");
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

  console.log("\n5. A declined question is a refusal; the others stay");
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

  console.log("\n6. The cost is reported or priced, never a made-up $0");
  check(r.usage.cost?.totalCost === 0.000004, "Google: 40 tokens at $0.10 per 1M = 4 micro-USD");
  const viaRouter = await generateDecision({
    ...conn,
    model: "openrouter/perplexity/pplx-decider-flash-v1.3:free",
    input: TICKET,
    questions,
  });
  check(viaRouter.usage.cost?.totalCost === 0, "OpenRouter: the reported cost (a free model reports 0)");
  console.log("\nAll contracts hold. Models you can use:", listDecisionModels().length);
}

main().catch(fail);
