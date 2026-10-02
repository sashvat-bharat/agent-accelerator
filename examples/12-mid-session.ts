import { Agent, tool, z } from "agent-accelerator";
import { fail } from "./_shared";

const C = "\x1b[36m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const B = "\x1b[34m";
const DIM = "\x1b[90m";
const R = "\x1b[0m";
const head = (t: string) => console.log(`\n${C}━━━ ${t} ━━━${R}`);
const info = (t: string) => console.log(`${B}${t}${R}`);
const ok = (t: string) => console.log(`${G}${t}${R}`);

// Set true to debug reasoning (gray). Default off: no <think> tags, no replay.
const SHOW_THINKING = false;

// Slow tool keeps the turn busy so the second message lands mid-run.
const slow_tool = tool({
  name: "slow_tool",
  description: "Call exactly once per task, then answer from its result.",
  input: z.object({}),
  execute: async () => {
    await new Promise((r) => setTimeout(r, 1200));
    return "slow action done";
  },
});

const agent = new Agent({
  name: "MidSession Demo",
  instructions: "Be concise. Call slow_tool exactly once per task, then answer.",
  model: process.env.MODEL ?? "google/gemini-3.5-flash-lite",
  tools: { slow_tool },
  // "auto" = each message picks steer vs queue. Use "steer"/"queue" to enforce one.
  midSession: { mode: "auto", maxQueued: 10 },
});

const live = () => ({
  stream: true as const,
  ...(SHOW_THINKING
    ? { onThinkingDelta: (d: string) => process.stdout.write(`${DIM}${d}${R}`) }
    : {}),
  onDelta: (d: string) => process.stdout.write(d),
  onEvent: (e: any) => {
    if (e.type === "steer_injected") console.log(`\n${Y}↳ steered into this turn${R}`);
    if (e.type === "queued") console.log(`\n${Y}↳ queued for next turn${R}`);
  },
});

console.log(`${C}policy: ${agent.midSessionMode} (steer = same turn, queue = next turn)${R}`);

// 1. STEER — change direction mid-turn, one combined live answer.
head("1. Steer — same turn, one answer");
info("Starting a slow turn, then steering it while the tool runs...");
{
  agent.reset();
  const first = agent.run("Call slow_tool once, then reply 'base done'.", live());
  await new Promise((r) => setTimeout(r, 150));
  info(`Agent busy: ${agent.isBusy}. Steering...`);
  const steered = agent.steer("Use bullets.");
  const [res, steerRes] = await Promise.all([first, steered]).catch(fail);
  console.log("");
  ok(`Done: ${res.turns} turns, one response (same: ${res.text === steerRes.text}).`);
}

// 2. QUEUE — finish first, then run the follow-up as its own turn.
head("2. Queue — next turn, two answers");
info("Starting a slow turn, then queuing a follow-up...");
{
  agent.reset();
  const first = agent.run("Call slow_tool once, then reply 'first done'.", live());
  await new Promise((r) => setTimeout(r, 150));
  const second = agent.queue("Reply with exactly: follow-up done.");
  info(`Agent busy: ${agent.isBusy}. Queued: ${agent.pendingCount}.`);
  const [r1, r2] = await Promise.all([first, second]).catch(fail);
  console.log("");
  ok(`Done: first ${r1.turns} turns, follow-up ${r2.turns} turn.`);
}

// 3. STREAM — watch it happen live (interrupt = cancel now).
head("3. Stream — realtime");
info("Streaming live. Steer lands mid-turn; interrupt() would stop it.");
{
  agent.reset();
  const s = agent.stream("Call slow_tool once, then reply 'stream done'.", live());
  await new Promise((r) => setTimeout(r, 150));
  void agent.steer("Keep it to one line.");
  // To stop instead: agent.interrupt();
  const res = await s.result().catch(fail);
  console.log("");
  ok(`Done: ${res.turns} turns (${res.finishReason}).`);
}
