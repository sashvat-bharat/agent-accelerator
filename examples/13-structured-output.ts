// Structured output: the final answer follows a schema, and `res.parsed` is validated JSON on every provider.
// Run: bun run examples/13-structured-output.ts
import { Agent } from "agent-accelerator";
import { z } from "zod";
import { fail, MODEL } from "./_shared";

// 1. A Zod schema: the answer is validated, `res.parsed` is the object.
const Weather = z.object({
  city: z.string(),
  tempC: z.number().describe("Temperature in Celsius"),
  condition: z.enum(["sunny", "cloudy", "rain"]),
});
const weather = new Agent({ model: MODEL, instructions: "Extract the weather as JSON.", output: Weather });
const a = await weather.run("Paris weather: 21C and sunny.").catch(fail);
console.log("zod:", a.parsed);

// 2. A plain JSON Schema: no Zod needed, the answer is only parsed.
const extractor = new Agent({
  model: MODEL,
  instructions: "Extract the recipe name and ingredient count as JSON.",
  output: {
    type: "object",
    properties: { recipe_name: { type: "string" }, ingredient_count: { type: "integer" } },
    required: ["recipe_name", "ingredient_count"],
  },
});
const b = await extractor.run("Chocolate chip cookies with 9 ingredients.").catch(fail);
console.log("json schema:", b.parsed);

// 3. The explicit form `{ name, schema, strict }`, with streaming.
const sentiment = new Agent({
  model: MODEL,
  instructions: "Return the sentiment as JSON.",
  output: {
    name: "feedback",
    strict: true,
    schema: z.object({ sentiment: z.enum(["positive", "neutral", "negative"]), summary: z.string() }),
  },
});
process.stdout.write("stream: ");
const c = await sentiment
  .run("The new UI is incredibly intuitive.", { stream: true, onDelta: (d) => process.stdout.write(d) })
  .catch(fail);
console.log("\nparsed:", c.parsed);

// 4. An answer that does not match the schema throws a ValidationError, with the partial answer attached.
const strict = new Agent({
  model: MODEL,
  instructions: "You always answer in prose.",
  output: z.object({ city: z.string() }),
});
try {
  console.log("parsed:", (await strict.run("Write a haiku about the sea (no JSON).")).parsed);
} catch (err) {
  console.log(`${(err as Error).name}: ${(err as Error).message.slice(0, 120)}`);
}
