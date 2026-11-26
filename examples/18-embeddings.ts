// Embeddings: one function turns text into vectors with a known embedding model (`listEmbeddingModels()`), and you search by meaning.
//
//   1. Embed documents and a question (one `task` option works on every model), then rank the documents with `cosineSimilarity`.
//   2. A list gives one vector per item, in order, with usage and cost.
//   3. Ask for something the model cannot do: a wrong value is ONE error that lists every problem.
//   4. A control the model does not have (a task on OpenAI) is dropped with one warning, not an error.
//   5. The same code runs on Google, OpenAI and OpenRouter.
//   6. Vectors of different lengths are not comparable: `cosineSimilarity` says so.
//
// It also works as a smoke check: it asserts these contracts and exits with code 1 if one stops holding.
//
// Run: bun run examples/18-embeddings.ts                  (offline: scripted providers, no key, no cost)
//      bun run examples/18-embeddings.ts --live <model>   (a REAL embedding model, e.g. google/gemini-embedding-2; costs money,
//                                                          except OpenRouter's free ones, e.g. openrouter/nvidia/nemotron-3.5-embed-1b:free)
// The offline run keeps its own home in .agent-accel/demo-embeddings/ (gitignored, wiped at the start), so it never touches
// your real model catalog.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ValidationError,
  cosineSimilarity,
  generateEmbedding,
  listEmbeddingModels,
  setHome,
  telemetryBus,
} from "agent-accelerator";
import { check, fail, liveModel } from "./_helpers";
import { WORDS, offline, requests } from "./offline/embedding";

const live = liveModel("google/gemini-embedding-2");
const conn = live ? {} : { apiKey: "demo-key", fetch: offline };
const MODEL = live ?? "google/gemini-embedding-2";
const DOCS = ["Cats purr when they are content.", "Dogs bark at strangers.", "Rust has a borrow checker."];

async function main(): Promise<void> {
  if (!live) {
    const demo = path.resolve(".agent-accel", "demo-embeddings");
    fs.rmSync(demo, { recursive: true, force: true }); // the demo owns this folder
    setHome(demo);
  }

  console.log("1. Search by meaning");
  const docs = await generateEmbedding({ ...conn, model: MODEL, input: DOCS, task: "search_document" });
  const question = await generateEmbedding({ ...conn, model: MODEL, input: "Which pet purrs?", task: "search_query" });
  const scores = docs.vectors.map((v) => cosineSimilarity(question.vector, v));
  DOCS.forEach((d, i) => console.log(`${scores[i]!.toFixed(3)}  ${d}`));
  check(
    scores.indexOf(Math.max(...scores)) === 0,
    "the cat sentence is the closest to the question about a purring pet"
  );

  console.log("\n2. A list gives one vector per item, in order");
  check(
    docs.vectors.length === DOCS.length,
    `${DOCS.length} items in, ${docs.vectors.length} vectors out (${docs.dimensions} numbers each)`
  );
  console.log("usage:", docs.usage.inputTokens, "tokens, cost $", docs.usage.cost?.totalCost ?? "unknown");

  if (live) return console.log("\nLive run done: the offline contracts below are skipped.");

  console.log("\n3. A value the model cannot do is one clear error");
  try {
    await generateEmbedding({ ...conn, model: MODEL, input: ["", { type: "image", image: "x" }], dimensions: 64 });
    fail(new Error("contract broken: bad input was accepted"));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    console.log(err.message);
    check(/text is empty/.test(err.message) && /outside what/.test(err.message), "one error lists every problem");
  }

  console.log("\n4. A control the model does not have is dropped with a warning");
  const warnings: string[] = [];
  const off = telemetryBus.onEvent((e) => e.code === "provider_warning" && warnings.push(e.message));
  await generateEmbedding({ ...conn, model: "openai/text-embedding-3-small", input: "x", task: "search_query" });
  off();
  check(
    requests.at(-1)!.body.task === undefined && requests.at(-1)!.body.input_type === undefined,
    "the task never reaches OpenAI"
  );
  check(warnings.length === 1, "exactly one provider_warning");

  console.log("\n5. The same code on Google, OpenAI and OpenRouter");
  for (const model of [
    "google/gemini-embedding-001",
    "openai/text-embedding-3-small",
    "openrouter/nvidia/nemotron-3.5-embed-1b:free",
  ]) {
    const r = await generateEmbedding({ ...conn, model, input: DOCS });
    check(r.vectors.length === 3 && r.vectors[0]!.length === WORDS.length, `${model}: one vector per item`);
  }
  check(listEmbeddingModels("openrouter").length === 1, "OpenRouter's list was read once and is now known");

  console.log("\n6. Vectors of different lengths cannot be compared");
  try {
    cosineSimilarity([1, 2, 3], [1, 2]);
    fail(new Error("contract broken: two lengths were compared"));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    console.log(err.message);
  }
  console.log("\nAll contracts hold.");
}

main().catch(fail);
