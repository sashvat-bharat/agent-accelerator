// Audio in a prompt.
// Run: bun run examples/07-multimodal_audio.ts
import { Agent } from "agent-accelerator";
import { fail, MODEL } from "./_shared";

const agent = new Agent({ model: MODEL, instructions: "Describe what you hear concisely." });

const res = await agent
  .run([
    { type: "text", text: "What kind of audio is this? One paragraph." },
    { type: "audio", audio: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3" },
  ])
  .catch(fail);

console.log(res.text);
console.log(`[${res.usage.totalTokens} tokens]`);
