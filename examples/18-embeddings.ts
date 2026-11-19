/**
 * Agent Accelerator - Embeddings
 *
 * One function turns text into vectors with a known embedding model (`listEmbeddingModels()`), and you search by meaning:
 *
 *   1. Embed documents and a question (one `task` option works on every model), then rank the documents with `cosineSimilarity`.
 *   2. A list gives one vector per item, in order, with usage and cost.
 *   3. Ask for something the model cannot do: a wrong value is ONE error that lists every problem.
 *   4. A control the model does not have (a task on OpenAI) is dropped with one warning, not an error.
 *   5. The same code runs on Google, OpenAI and OpenRouter.
 *   6. Vectors of different lengths are not comparable: `cosineSimilarity` says so.
 *
 * It also works as a smoke check: it asserts these contracts and exits with code 1 (one line on stderr) if one stops holding.
 *
 * Run:  bun run examples/18-embeddings.ts                   (offline: a scripted stand-in for the providers, no key, no cost)
 *       bun run examples/18-embeddings.ts --live <model>    (a REAL embedding model, e.g. google/gemini-embedding-2; costs money,
 *                                                           except OpenRouter's free ones, e.g. openrouter/nvidia/nemotron-3.5-embed-1b:free)
 * The offline run keeps its own home in ./.agent-accel/demo-embeddings/ (gitignored; wiped at the start), so it never touches your
 * real model catalog.
 *
 * Note: this example does not import `_shared.ts`, because that file sets the model list for the live examples.
 */

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
  fail(new Error("--live needs a model, e.g. --live google/gemini-embedding-2"));

// The scripted providers: a toy "embedding" that counts a few words, so similar sentences get similar vectors.
const WORDS = ["cat", "purr", "dog", "bark", "rust", "borrow", "compiler", "pet"];
const toy = (text: string): number[] => WORDS.map((w) => (text.toLowerCase().includes(w) ? 1 : 0) + 0.01);
// The text of an item as the Google adapter sends it (the task words in front are not part of the meaning).
const bare = (t: string): string => t.replace(/^(task: [^|]*\| query: |title: [^|]*\| text: )/, "");
// biome-ignore lint/suspicious/noExplicitAny: request bodies are read loosely in this demo
const requests: Array<{ url: string; body: any }> = [];
const offline = (async (url: string, init?: { body?: string }) => {
  if (url.endsWith("/embeddings/models"))
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "nvidia/nemotron-3.5-embed-1b:free",
            context_length: 32768,
            architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
            pricing: { prompt: "0" },
          },
        ],
      }),
      { status: 200 }
    );
  const body = JSON.parse(init?.body ?? "{}");
  requests.push({ url, body });
  if (url.includes(":batchEmbedContents")) {
    const texts = body.requests.map((r: { content: { parts: Array<{ text: string }> } }) =>
      bare(r.content.parts[0]!.text)
    );
    return new Response(
      JSON.stringify({
        embeddings: texts.map((t: string) => ({ values: toy(t) })),
        usageMetadata: {
          promptTokenCount: texts.length * 6,
          promptTokenDetails: [{ modality: "TEXT", tokenCount: texts.length * 6 }],
        },
      }),
      { status: 200 }
    );
  }
  const texts: string[] = body.input;
  return new Response(
    JSON.stringify({
      data: texts.map((t, index) => ({ object: "embedding", index, embedding: toy(t) })),
      usage: {
        prompt_tokens: texts.length * 6,
        total_tokens: texts.length * 6,
        ...(url.includes("openrouter") ? { cost: 0 } : {}),
      },
    }),
    { status: 200 }
  );
}) as unknown as typeof fetch;
const conn = live ? {} : { apiKey: "demo-key", fetch: offline };

const DOCS = ["Cats purr when they are content.", "Dogs bark at strangers.", "Rust has a borrow checker."];

async function main(): Promise<void> {
  if (!live) {
    const demo = path.resolve(".agent-accel", "demo-embeddings");
    fs.rmSync(demo, { recursive: true, force: true });
    setHome(demo);
  }
  const MODEL = live ?? "google/gemini-embedding-2";

  head("1. Search by meaning");
  const docs = await generateEmbedding({ ...conn, model: MODEL, input: DOCS, task: "search_document" });
  const question = await generateEmbedding({ ...conn, model: MODEL, input: "Which pet purrs?", task: "search_query" });
  const scores = docs.vectors.map((v) => cosineSimilarity(question.vector, v));
  DOCS.forEach((d, i) => console.log(`${scores[i]!.toFixed(3)}  ${d}`));
  check(
    scores.indexOf(Math.max(...scores)) === 0,
    "the cat sentence is the closest to the question about a purring pet"
  );

  head("2. A list gives one vector per item, in order");
  check(
    docs.vectors.length === DOCS.length,
    `${DOCS.length} items in, ${docs.vectors.length} vectors out (${docs.dimensions} numbers each)`
  );
  console.log("usage:", docs.usage.inputTokens, "tokens, cost $", docs.usage.cost?.totalCost ?? "unknown");

  if (live) {
    console.log(`\n${Y}Live run done: the offline contracts below are skipped.${R}`);
    return;
  }

  head("3. A value the model cannot do is one clear error");
  try {
    await generateEmbedding({ ...conn, model: MODEL, input: ["", { type: "image", image: "x" }], dimensions: 64 });
    fail(new Error("contract broken: bad input was accepted"));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    console.log(`${Y}${err.message}${R}`);
    check(/text is empty/.test(err.message) && /outside what/.test(err.message), "one error lists every problem");
  }

  head("4. A control the model does not have is dropped with a warning");
  const warnings: string[] = [];
  const off = telemetryBus.onEvent((e) => {
    if (e.code === "provider_warning") warnings.push(e.message);
  });
  await generateEmbedding({ ...conn, model: "openai/text-embedding-3-small", input: "x", task: "search_query" });
  off();
  check(
    requests.at(-1)!.body.task === undefined && requests.at(-1)!.body.input_type === undefined,
    "the task never reaches OpenAI"
  );
  check(warnings.length === 1, "exactly one provider_warning");

  head("5. The same code on Google, OpenAI and OpenRouter");
  for (const model of [
    "google/gemini-embedding-001",
    "openai/text-embedding-3-small",
    "openrouter/nvidia/nemotron-3.5-embed-1b:free",
  ]) {
    const r = await generateEmbedding({ ...conn, model, input: DOCS });
    check(r.vectors.length === 3 && r.vectors[0]!.length === WORDS.length, `${model}: one vector per item`);
  }
  check(listEmbeddingModels("openrouter").length === 1, "OpenRouter's list was read once and is now known");

  head("6. Vectors of different lengths cannot be compared");
  try {
    cosineSimilarity([1, 2, 3], [1, 2]);
    fail(new Error("contract broken: two lengths were compared"));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    console.log(`${Y}${err.message}${R}`);
  }
  console.log(`\n${G}All contracts hold.${R}`);
}

main().catch(fail);
