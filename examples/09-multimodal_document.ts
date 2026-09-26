import { Agent } from "agent-accelerator";
import { fail } from "./_shared";

const agent = new Agent({
  name: "Reader",
  instructions: "Summarize documents concisely.",
  model: process.env.MODEL,
});

const res = await agent.run([
  { type: "text", text: "Summarize this document in one line. also tell me did you actually read the file or not?" },
  // NOTE: the parser fetches the URL itself — it must be directly reachable.
  // NOTE: native parsing needs a capable model — otherwise use
  // examples/10-document_markdown.ts (Markdown preprocessing) instead.
  { type: "file", file: "https://arxiv.org/pdf/2609.25611v1", mimeType: "application/pdf", filename: "2024ltr.pdf" },
]).catch(fail);

console.log(res.text);
console.log(`[${res.usage.totalTokens} tok]`);
