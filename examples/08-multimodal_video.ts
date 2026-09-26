import { Agent } from "agent-accelerator";
import { fail } from "./_shared";

// Video input needs a video-capable model: a Gemini model, or an OpenRouter
// model with video support (Chat Completions `video_url`; the free
// space-bunny route gates video behind a funded key). Anything else fails
// fast with a one-line provider error instead of a dump.
const agent = new Agent({
  name: "Watcher",
  instructions: "Describe what you see concisely.",
  model: process.env.MODEL,
});

const res = await agent.run([
  { type: "text", text: "What happens in this clip? One paragraph." },
  { type: "video", video: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" },
]).catch(fail);

console.log(res.text);
console.log(`[${res.usage.totalTokens} tok]`);
