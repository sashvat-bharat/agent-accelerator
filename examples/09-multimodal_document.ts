// A PDF in a prompt. The link must be reachable by the provider, and the model must accept PDF input.
// Run: bun run examples/09-multimodal_document.ts
import { Agent } from "agent-accelerator";
import { fail, MODEL } from "./_shared";

const agent = new Agent({ model: MODEL, instructions: "Summarize documents concisely." });

const res = await agent
  .run([
    { type: "text", text: "Summarize this document in one line." },
    { type: "file", file: "https://arxiv.org/pdf/2609.25611v1", mimeType: "application/pdf", filename: "paper.pdf" },
  ])
  .catch(fail);

console.log(res.text);
console.log(`[${res.usage.totalTokens} tokens]`);
