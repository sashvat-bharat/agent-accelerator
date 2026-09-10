import { Agent } from "agent-accelerator";
import { fail } from "./_shared";

const agent = new Agent({
  name: "Listener",
  instructions: "Describe what you hear concisely.",
  model: process.env.MODEL,
});

const res = await agent.run([
  { type: "text", text: "What kind of audio is this? One paragraph." },
  { type: "audio", audio: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3" },
]).catch(fail);

console.log(res.text);
console.log(`[${res.usage.totalTokens} tok]`);
