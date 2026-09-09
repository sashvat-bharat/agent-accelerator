import { Agent } from "agent-accelerator";
import { fail } from "./_shared";

const agent = new Agent({
  name: "Reader",
  instructions: "Summarize documents concisely.",
  model: process.env.MODEL,
});

const res = await agent.run([
  { type: "text", text: "Summarize this document in one line." },
  { type: "file", file: "https://sample-files.com/downloads/documents/pdf/sample-pdf-legal-size.pdf", mimeType: "application/pdf", filename: "dummy.pdf" },
]).catch(fail);

console.log(res.text);
console.log(`[${res.usage.totalTokens} tok]`);
