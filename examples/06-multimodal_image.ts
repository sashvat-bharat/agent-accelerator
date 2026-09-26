import { Agent } from "agent-accelerator";
import { fail } from "./_shared";

// Pass a local file or use the default remote URL:
//   bun run examples/06-multimodal_image.ts ./photo.png
const image = process.argv[2] ?? "https://picsum.photos/seed/accel/512";

const agent = new Agent({
  name: "Vision",
  instructions: "Describe what you see concisely.",
  model: process.env.MODEL,
});

const res = await agent.run([{ type: "text", text: "What is in this image? One paragraph." }, { type: "image", image }]).catch(fail);

console.log(res.text);
console.log("TOTAL_TOKENS: " + `[${res.usage.totalTokens} tok]`);
console.log("INPUT_TOKENS: " + `[${res.usage.inputTokens} tok]`);
console.log("OUTPUT_TOKENS: " + `[${res.usage.outputTokens} tok]`);
