// An image in a prompt: a public URL by default, or a local file inside ./examples/files.
// Run: bun run examples/06-multimodal_image.ts [./examples/files/photo.png]
import { Agent } from "agent-accelerator";
import { fail, MODEL } from "./_shared";

const image = process.argv[2] ?? "https://picsum.photos/seed/accel/512";

const agent = new Agent({
  model: MODEL,
  instructions: "Describe what you see concisely.",
  fileAccess: { roots: ["./examples/files"] }, // a local path outside these folders is refused
});

const res = await agent
  .run([
    { type: "text", text: "What is in this image? One paragraph." },
    { type: "image", image },
  ])
  .catch(fail);

console.log(res.text);
console.log(`[${res.usage.totalTokens} tokens]`);
