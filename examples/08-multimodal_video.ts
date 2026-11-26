// Video in a prompt. Needs a video-capable model (a Gemini model, or an OpenRouter model with video support).
// Any other model fails before the request with a one-line error.
// Run: bun run examples/08-multimodal_video.ts
import { Agent } from "agent-accelerator";
import { fail, MODEL } from "./_shared";

const agent = new Agent({ model: MODEL, instructions: "Describe what you see concisely." });

const res = await agent
  .run([
    { type: "text", text: "What happens in this clip? One paragraph." },
    { type: "video", video: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" },
  ])
  .catch(fail);

console.log(res.text);
console.log(`[${res.usage.totalTokens} tokens]`);
