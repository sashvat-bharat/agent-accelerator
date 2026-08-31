import * as fs from "node:fs";
import { Agent } from "agent-accelerator";

/**
 * Dynamic Multi-Agent Orchestration with Real-Time Streaming & Prompt Caching
 *
 * - Model: Resolved from process.env.MODEL (or fallback)
 * - Sub-agents: Resolved from process.env.SUB_AGENT_MODEL (or fallback)
 * - Real-time streaming for text and reasoning (thinking in dim/dark font)
 * - Preserves session history across turns
 * - Explicit prompt caching
 * - Emits clean, raw JSON metadata summary at the very end
 */

const mainAgent = new Agent({
  model: process.env.MODEL,
  name: "Editorial Orchestrator Agent",
  instructions: fs.readFileSync(new URL("../SYSTEM_PROMPT_ORCHESTRATOR.md", import.meta.url), "utf8"),
  EnableSubagents: true,
  ThinkingLevel: "minimal",
  cache: {
    retention: "short",
  },
});

// Helper to stream responses and print thinking in darker/dim font
async function runStreamTurn(turnNumber: number, prompt: string) {
  console.log(`\n=== Turn ${turnNumber} ===`);
  console.log(`User: ${prompt}\n`);
  process.stdout.write(`=== Response (Turn ${turnNumber}) ===\n`);

  const stream = mainAgent.stream(prompt);
  let isThinking = false;

  for await (const event of stream) {
    if (event.type === "thinking_start") {
      isThinking = true;
      process.stdout.write("\x1b[90m"); // Darker/dim gray font for reasoning
    } else if (event.type === "thinking_delta" && event.delta) {
      process.stdout.write(event.delta);
    } else if (event.type === "thinking_end") {
      if (isThinking) {
        process.stdout.write("\x1b[0m\n\n"); // Reset font
        isThinking = false;
      }
    } else if (event.type === "text_delta" && event.delta) {
      if (isThinking) {
        process.stdout.write("\x1b[0m\n\n");
        isThinking = false;
      }
      process.stdout.write(event.delta);
    }
  }

  if (isThinking) {
    process.stdout.write("\x1b[0m\n");
  }

  process.stdout.write("\n\n-------------------------------------------------------------------------------\n");
  return await stream.result();
}

// === Turn 1: Dynamic Multi-Agent Research & Synthesis ===
const prompt1 = "Research on the rising HBM RAM pricings and rapid development in the AI space, then merge both to make a final editorial-level professional detailed report.";
const result1 = await runStreamTurn(1, prompt1);

// === Turn 2: Context-Aware Follow-Up Query (Prompt Caching) ===
const prompt2 = "Based on the editorial report above, summarize all critical strategic takeaways in bullet points and name the #1 supplier positioned to benefit the most.";
const result2 = await runStreamTurn(2, prompt2);

// === Calculate Cache Hit Percentage ===
const inputTokens2 = result2.usage.inputTokens;
const cachedTokens2 = result2.usage.cachedTokens ?? result2.usage.cacheReadTokens ?? 0;
const cacheHitPercentage =
  inputTokens2 > 0 ? Number(((cachedTokens2 / inputTokens2) * 100).toFixed(2)) : 0;

// === Sanitize Sub-Agents Metadata (Clean Stats without Full Text Dumps) ===
const sanitizedSubagents = (result1.subagents ?? []).map((sub) => ({
  name: sub.name,
  role: sub.role || "N/A",
  task: sub.task,
  model: sub.model,
  provider: sub.provider,
  durationMs: sub.durationMs,
  turns: sub.turns,
  usage: {
    inputTokens: sub.usage.inputTokens,
    outputTokens: sub.usage.outputTokens,
    cachedTokens: sub.usage.cachedTokens ?? 0,
    thinkingTokens: sub.usage.thinkingTokens ?? 0,
    totalTokens: sub.usage.totalTokens,
  },
  status: sub.isError ? "Error" : "Success",
}));

// === Final Raw JSON Metadata Output ===
const finalMetadataReport = {
  sessionId: mainAgent.sessionId,
  model: mainAgent.modelStringOrSpec,
  promptCaching: {
    cacheHitRate: `${cacheHitPercentage}%`,
    turn2CachedInputTokens: cachedTokens2,
    turn2TotalInputTokens: inputTokens2,
    coldTurn1DurationMs: result1.durationMs,
    warmTurn2DurationMs: result2.durationMs,
    speedup: `${(result1.durationMs / Math.max(result2.durationMs, 1)).toFixed(1)}x faster`,
  },
  turn1Metrics: {
    durationMs: result1.durationMs,
    turns: result1.turns,
    toolCallsCount: result1.toolCalls.length,
    usage: result1.usage,
    subagentsCount: sanitizedSubagents.length,
    subagents: sanitizedSubagents,
  },
  turn2Metrics: {
    durationMs: result2.durationMs,
    turns: result2.turns,
    usage: result2.usage,
  },
};

console.log("\n===============================================================================");
console.log("  FINAL EXECUTION METADATA (RAW JSON)");
console.log("===============================================================================");
console.log(JSON.stringify(finalMetadataReport, null, 2));
console.log("===============================================================================\n");