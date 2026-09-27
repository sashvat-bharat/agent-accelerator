import { fail } from "./_shared";
import * as path from "node:path";
import { Agent, convertDocumentToMarkdown, convert_document_to_markdown, isAnydocAvailable, modelSupportsFileInput, resolveModel} from "agent-accelerator";

const MODEL = process.env.MODEL || "google/gemini-3.5-flash-lite";
const csvPath = path.join(import.meta.dir, "files/prices.csv");

if (!(await isAnydocAvailable())) {
  console.error("\nThis example needs the optional peer '@firecrawl/anydoc'. Install it with:\n  bun add @firecrawl/anydoc\n");
  process.exit(1);
}

console.log("\x1b[1;36m━━━ Document → Markdown (any model) ━━━\x1b[0m");
console.log(`Model: ${MODEL}`);
console.log(`Fixture: ${csvPath}\n`);

// ── 1. Explicit util: dev converts, model just reads text ────────────
console.log("\x1b[1;33m[1] convertDocumentToMarkdown() — local conversion, zero model involvement\x1b[0m");
const t0 = Date.now();
const md = await convertDocumentToMarkdown(csvPath).catch(fail);

console.log(`\x1b[90mconverted ${(md.length / 1024).toFixed(1)} KB of Markdown in ${Date.now() - t0}ms (local Rust, no tokens spent)\x1b[0m`);

const analyst = new Agent({
  name: "Analyst",
  instructions: "Answer using only the provided document excerpt.",
  model: MODEL,
});

const direct = await analyst.run(`Which fruit is cheapest?\n\n${md}`).catch(fail);
console.log("answer:", direct.text.trim());
console.log(`\x1b[90musage: ↑${direct.usage.inputTokens} ↓${direct.usage.outputTokens}\x1b[0m\n`);

// ── 2. Built-in tool: the model drives conversion itself ─────────────
console.log("\x1b[1;33m[2] convert_document_to_markdown tool — model calls it mid-run\x1b[0m");
const agent = new Agent({
  name: "Doc Agent",
  instructions: "Use convert_document_to_markdown for document questions.",
  model: MODEL,
  tools: { convert_document_to_markdown },
});

// Tracks the terminal cursor: tool logs get a leading newline only when
// streamed text left the cursor mid-line (otherwise a stray blank line).

let atLineStart = true;
const viaTool = await agent
  .run(`Which fruit is dearest in ${csvPath}?`, {
    stream: true,
    onDelta: (d) => {
      process.stdout.write(d);
      if (d) atLineStart = d.endsWith("\n");
    },
    onEvent: (e) => {
      const prefix = atLineStart ? "" : "\n";
      if (e.type === "tool_call_complete") {
        console.log(`${prefix}\x1b[90m↳ model called ${e.toolCall?.name}(${JSON.stringify(e.toolCall?.arguments)})\x1b[0m`);
        atLineStart = true;
      }
      if (e.type === "tool_result") {
        const size = JSON.stringify(e.toolResult?.result ?? "").length;
        console.log(`${prefix}\x1b[90m↳ tool returned ${size} chars of <Document> XML in ${e.toolResult?.durationMs ?? 0}ms\x1b[0m`);
        atLineStart = true;
      }
    },
  })
  .catch(fail);
  console.log(`\n\x1b[90mturns: ${viaTool.turns} • usage: ↑${viaTool.usage.inputTokens} ↓${viaTool.usage.outputTokens}\x1b[0m\n`);

// ── 3. Flag: file parts survive even incapable models ────────────────
console.log("\x1b[1;33m[3] bypassInputFileModality — what happens to the file part\x1b[0m");
const { provider, modelId } = resolveModel(MODEL);
const native = modelSupportsFileInput(provider.id, modelId);

console.log(
  `\x1b[90m${provider.id}/${modelId} ${
    native
      ? "reads files natively → flag is a no-op, file part sent as-is"
      : "has NO file support → file part is preprocessed to <Document> Markdown before sending"
  }\x1b[0m`
);

const resilient = new Agent({
  name: "Resilient",
  instructions: "Answer using only the attached document.",
  model: MODEL,
  bypassInputFileModality: true,
});

const viaFlag = await resilient
  .run([
    { type: "text", text: "Total price of all fruits?" },
    { type: "file", file: csvPath, filename: "files/prices.csv" },
  ])
  .catch(fail);

  console.log("answer:", viaFlag.text.trim());
console.log(`\x1b[90musage: ↑${viaFlag.usage.inputTokens} ↓${viaFlag.usage.outputTokens}\x1b[0m`);