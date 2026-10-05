/**
 * Agent Accelerator - Structured Outputs (real run)
 *
 * Constrains the final answer to a JSON Schema on every provider:
 * - Google Interactions: response_format{type:text,mime_type:application/json,schema}
 * - OpenAI Responses: text.format{type:json_schema,name,schema,strict}
 * - OpenRouter / Compat Chat Completions: response_format{type:json_schema,json_schema}
 *
 * What this runs for real:
 *  1. Zod schema -> validated `res.parsed` (+ raw `res.text`).
 *  2. Plain JSON Schema (no Zod) -> same wire, JSON-parse only.
 *  3. Explicit `{ name, schema, strict }` + streaming deltas.
 *
 * Run: bun examples/13-structured-output.ts
 * Needs: MODEL + provider key (see .env.example). Costs live tokens.
 * Switch providers with zero code change:
 *   MODEL="openai/gpt-4o" / "openrouter/openai/gpt-4o" / "groq/llama-3.3-70b-versatile"
 */

import { Agent, z } from "agent-accelerator";
import { fail } from "./_shared.ts";

const MODEL = process.env.MODEL || "google/gemini-3.5-flash-lite";

console.log("\x1b[1;36m━━━ Structured Outputs ━━━\x1b[0m");
console.log(`Model: ${MODEL}\n`);

// ---------------------------------------------------------------------------
// 1. Zod schema: full validation (JSON parse + safeParse)
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[1] Zod schema — validated res.parsed\x1b[0m");

const Weather = z.object({
  city: z.string().describe("City name"),
  tempC: z.number().describe("Current temperature in Celsius"),
  condition: z.enum(["sunny", "cloudy", "rain"]).describe("One-word condition"),
});

const zodStrict = new Agent({
  name: "Weather",
  instructions: "Extract the weather as JSON. Return ONLY the object.",
  model: MODEL,
  output: Weather,
});

const zodRes = await zodStrict
  .run("Paris weather: 21C and sunny. Return the object.")
  .catch(fail);

console.log("text:  ", zodRes.text.trim().slice(0, 200));
console.log("parsed:", JSON.stringify(zodRes.parsed));
console.log(`\x1b[90mturns: ${zodRes.turns} • usage: ↑${zodRes.usage.inputTokens} ↓${zodRes.usage.outputTokens}\x1b[0m`);
console.log(`\x1b[90mwire keys: ${Object.keys((zodRes.raw.request.body as object) ?? {}).join(", ")}\x1b[0m\n`);

// ---------------------------------------------------------------------------
// 2. Plain JSON Schema: no Zod dependency, JSON-parse only
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[2] JSON Schema — no Zod, same wire\x1b[0m");

const jsonAgent = new Agent({
  name: "Extractor",
  instructions: "Extract the recipe name and ingredient count as JSON. Return ONLY the object.",
  model: MODEL,
  output: {
    type: "object",
    properties: {
      recipe_name: { type: "string" },
      ingredient_count: { type: "integer" },
    },
    required: ["recipe_name", "ingredient_count"],
  },
});

const jsonRes = await jsonAgent
  .run("Chocolate chip cookies with 9 ingredients. Return the object.")
  .catch(fail);

console.log("text:  ", jsonRes.text.trim().slice(0, 200));
console.log("parsed:", JSON.stringify(jsonRes.parsed));
console.log(`\x1b[90mturns: ${jsonRes.turns} • usage: ↑${jsonRes.usage.inputTokens} ↓${jsonRes.usage.outputTokens}\x1b[0m\n`);

// ---------------------------------------------------------------------------
// 3. Explicit { name, schema, strict } + streaming
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[3] Explicit form + streaming deltas\x1b[0m");

const streamAgent = new Agent({
  name: "Streamer",
  instructions: "Return the sentiment as JSON. Return ONLY the object.",
  model: MODEL,
  output: {
    name: "feedback",
    strict: true,
    schema: z.object({
      sentiment: z.enum(["positive", "neutral", "negative"]),
      summary: z.string(),
    }),
  },
});

let streamed = "";
const streamRes = await streamAgent
  .run("The new UI is incredibly intuitive. Return the object.", {
    stream: true,
    onDelta: (d) => {
      streamed += d;
      process.stdout.write(d);
    },
  })
  .catch(fail);

console.log(`\nparsed: ${JSON.stringify(streamRes.parsed)}`);
console.log(`\x1b[90mstreamed ${streamed.length} chars • turns: ${streamRes.turns}\x1b[0m`);
console.log(`\x1b[90mtoJSON has parsed: ${"parsed" in streamRes.toJSON()}\x1b[0m\n`);

// ---------------------------------------------------------------------------
// 4. Mismatch surfaces as ValidationError (strict-fail, partial attached)
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[4] Validation failure (strict-fail demo)\x1b[0m");
console.log("\x1b[90mTip: wire-enforced schemas rarely mismatch. To see the error path, request prose while demanding JSON.\x1b[0m");

const strictAgent = new Agent({
  name: "Strict",
  instructions: "You always answer in prose.",
  model: MODEL,
  output: z.object({ city: z.string() }),
});

try {
  const maybe = await strictAgent.run("Write a haiku about the sea (no JSON).");
  console.log("parsed:", JSON.stringify(maybe.parsed));
} catch (err: unknown) {
  const partial = (err as { partial?: { text?: string } }).partial;
  console.log(`\x1b[31m${(err as Error).name}: ${(err as Error).message.slice(0, 120)}\x1b[0m`);
  if (partial?.text) console.log(`\x1b[90mpartial text: ${partial.text.slice(0, 120)}\x1b[0m`);
}

console.log("\n\x1b[1;32m✔ Structured outputs finished. res.parsed is validated JSON on every provider.\x1b[0m");
