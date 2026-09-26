/**
 * Agent Accelerator - Complete Metadata Exposure & API Inspection Example
 *
 * Demonstrates 100% of the metadata APIs exposed by Agent Accelerator:
 * 1. Top-Level Execution Metadata (duration, turns, model, provider, IDs)
 * 2. Token Usage & Prompt Cache Metrics (input, output, cache read/write, thinking)
 * 3. Real-Time Dollar Cost Breakdown (inputCost, cacheReadCost, outputCost, totalCost)
 * 4. Tool Calls & Tool Results Metadata (arguments, execution durations, signatures)
 * 5. Sub-Agent Execution Metadata (isolated usage, models, turns, and durations)
 * 6. Zero-Leak Raw Wire Payloads (exact HTTP request and response wire data)
 * 7. Catalog Metadata Inspection APIs (context limits, pricing, reasoning options)
 * 8. Complete Serialized JSON Export (`response.toJSON()`)
 */

import {
  Agent,
  tool,
  z,
  getModelFromCatalog,
  getModelThinkingInfo,
  resolveModel,
} from "agent-accelerator";

// ---------------------------------------------------------------------------
// 1. Tool Setup to demonstrate Tool Calls & Results Metadata
// ---------------------------------------------------------------------------
const get_system_metrics = tool({
  name: "get_system_metrics",
  description: "Get real-time CPU, Memory, and Network telemetry for a specific cluster.",
  input: z.object({
    clusterId: z.string().describe("Target cluster ID, e.g. 'us-east-prod-1'"),
  }),
  execute: async ({ clusterId }) => {
    // Simulated tool execution
    return {
      clusterId,
      status: "HEALTHY",
      cpuUtilization: "41.8%",
      memoryUsedGb: 88.5,
      memoryTotalGb: 128.0,
      activeNodes: 12,
      latencyP99Ms: 18.4,
      timestamp: new Date().toISOString(),
    };
  },
});

// ---------------------------------------------------------------------------
// 2. Agent Initialization
// ---------------------------------------------------------------------------
const modelToUse = process.env.MODEL || "google/gemini-3.5-flash-lite";

let agent: Agent;
try {
  agent = new Agent({
    name: "Telemetry Analyst",
    instructions: "You are a systems infrastructure analyst. Always use get_system_metrics to inspect clusters and give concise, technical summaries.",
    model: modelToUse,
    dynamicSubagents: {
      enabled: true,
      model: process.env.SUB_AGENT_MODEL || "google/gemini-3.5-flash-lite",
      maxSpawn: 4,
      timeout: 0,
    },
    thinkingLevel: (process.env.THINKING_LEVEL as any) ?? "medium",
    cache: { retention: "short" },
    tools: { get_system_metrics },
  });
} catch (err: any) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

console.log("\x1b[1;36m======================================================================\x1b[0m");
console.log("\x1b[1;36m       AGENT ACCELERATOR - COMPLETE METADATA EXPOSURE DEMO            \x1b[0m");
console.log("\x1b[1;36m======================================================================\x1b[0m\n");

// ---------------------------------------------------------------------------
// 3. Preflight Catalog Metadata Inspection APIs
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[1] PREFLIGHT CATALOG METADATA APIs\x1b[0m");
console.log("─".repeat(70));

const resolved = resolveModel(modelToUse);
const catalogSpec = getModelFromCatalog(resolved.provider.id, resolved.modelId);
const thinkingInfo = getModelThinkingInfo(resolved.provider.id, resolved.modelId);

console.log(`Resolved Provider:         ${resolved.provider.id} (${resolved.provider.name})`);
console.log(`Resolved Model ID:         ${resolved.modelId}`);
console.log(`Catalog Context Window:    ${catalogSpec?.contextWindow?.toLocaleString() ?? "Unknown"} tokens`);
console.log(`Catalog Max Output:        ${catalogSpec?.maxOutputTokens?.toLocaleString() ?? "Unknown"} tokens`);
console.log(`Supported Input Modalities: [${catalogSpec?.modalities?.input?.join(", ") ?? "text"}]`);
console.log(`Supported Output Modalities:[${catalogSpec?.modalities?.output?.join(", ") ?? "text"}]`);
console.log(`Pricing (Per 1M tokens):`);
console.log(`  • Uncached Input:        $${catalogSpec?.pricing?.inputPerMillion ?? catalogSpec?.cost?.input ?? 0}`);
console.log(`  • Cached Input Read:     $${catalogSpec?.pricing?.cacheReadPerMillion ?? catalogSpec?.cost?.cache_read ?? 0}`);
console.log(`  • Output Tokens:         $${catalogSpec?.pricing?.outputPerMillion ?? catalogSpec?.cost?.output ?? 0}`);
console.log(`Thinking Capabilities:`);
console.log(`  • Supports Thinking:     ${thinkingInfo.supportsThinking}`);
console.log(`  • Allowed Levels:        [${thinkingInfo.allowedLevels.join(", ")}]`);
console.log(`  • Supports Disabling:    ${thinkingInfo.supportsDisable}`);
console.log(`  • Description:           ${thinkingInfo.description}\n`);

// ---------------------------------------------------------------------------
// 4. Execute Agent with Streaming Event Metadata
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[2] LIVE STREAMING EVENT METADATA\x1b[0m");
console.log("─".repeat(70));

const streamEventsLog: string[] = [];

const prompt = "Inspect the system telemetry for cluster 'us-east-prod-1' and provide a 2-sentence executive summary.";
console.log(`\x1b[90mUser Prompt: "${prompt}"\x1b[0m\n`);

let response: any;
try {
  response = await agent.run(prompt, {
    stream: true,
    wrapThinking: true,
    onThinkingDelta: (d) => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
    onDelta: (d) => process.stdout.write(d),
    onEvent: (event) => {
      streamEventsLog.push(event.type);
      if (event.type === "tool_call_complete") {
        console.log(`\n\x1b[34m↳ Stream Event [tool_call_complete]:\x1b[0m ${event.toolCall?.name}(${JSON.stringify(event.toolCall?.arguments)})`);
      } else if (event.type === "tool_result") {
        console.log(`\x1b[34m↳ Stream Event [tool_result]:\x1b[0m ${event.toolResult?.name} completed in ${event.toolResult?.durationMs ?? 0}ms`);
      } else if (event.type === "subagent_complete") {
        console.log(`\x1b[35m↳ Stream Event [subagent_complete]:\x1b[0m Subagent "${event.subagent?.name}" finished`);
      }
    },
  });
} catch (err: any) {
  console.error(`\n\x1b[31mExecution Failed: ${err.message}\x1b[0m\n`);
  process.exit(1);
}

console.log("\n\nStream Event Lifecycle Recorded:");
console.log(`  [${streamEventsLog.join(" → ")}]\n`);

// ---------------------------------------------------------------------------
// 5. Response Top-Level & Execution Metadata
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[3] TOP-LEVEL RESPONSE METADATA (res.*)\x1b[0m");
console.log("─".repeat(70));
console.log(`res.provider:              "${response.provider}"`);
console.log(`res.model:                 "${response.model}"`);
console.log(`res.responseId:            "${response.responseId ?? "N/A"}"`);
console.log(`res.finishReason:          "${response.finishReason ?? "N/A"}"`);
console.log(`res.durationMs:            ${response.durationMs}ms`);
console.log(`res.turns:                 ${response.turns} turns`);
console.log(`res.thoughtSignature:      ${response.thoughtSignature ? `"${response.thoughtSignature.slice(0, 32)}..."` : "None"}`);
console.log(`res.thinking (length):     ${response.thinking ? `${response.thinking.length} chars` : "None"}\n`);

// ---------------------------------------------------------------------------
// 6. Token Usage & Cache Metrics Metadata (res.usage)
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[4] TOKEN USAGE & PROMPT CACHE METADATA (res.usage)\x1b[0m");
console.log("─".repeat(70));
console.log(`res.usage.inputTokens:      ${response.usage.inputTokens.toLocaleString()}`);
console.log(`res.usage.outputTokens:     ${response.usage.outputTokens.toLocaleString()}`);
console.log(`res.usage.totalTokens:      ${response.usage.totalTokens.toLocaleString()}`);
console.log(`res.usage.cachedTokens:     ${response.usage.cachedTokens?.toLocaleString() ?? 0}`);
console.log(`res.usage.cacheReadTokens:  ${response.usage.cacheReadTokens?.toLocaleString() ?? 0}`);
console.log(`res.usage.cacheWriteTokens: ${response.usage.cacheWriteTokens?.toLocaleString() ?? 0}`);
console.log(`res.usage.thinkingTokens:   ${response.usage.thinkingTokens?.toLocaleString() ?? 0}`);

const cacheHitRate = response.usage.inputTokens > 0
  ? (((response.usage.cachedTokens ?? 0) / response.usage.inputTokens) * 100).toFixed(1)
  : "0.0";
console.log(`Cache Efficiency Ratio:     ${cacheHitRate}%\n`);

// ---------------------------------------------------------------------------
// 7. Real-Time Dollar Cost Metadata (res.usage.cost)
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[5] REAL-TIME DOLLAR COST BREAKDOWN (res.usage.cost)\x1b[0m");
console.log("─".repeat(70));
const formatDollar = (val?: number) => val !== undefined ? `$${val.toFixed(6)}` : "$0.000000";
console.log(`res.usage.cost.inputCost:      ${formatDollar(response.usage.cost?.inputCost)}`);
console.log(`res.usage.cost.cacheReadCost:  ${formatDollar(response.usage.cost?.cacheReadCost)} (Prompt Cache Savings)`);
console.log(`res.usage.cost.cacheWriteCost: ${formatDollar(response.usage.cost?.cacheWriteCost)}`);
console.log(`res.usage.cost.outputCost:     ${formatDollar(response.usage.cost?.outputCost)}`);
console.log(`res.usage.cost.totalCost:      ${formatDollar(response.usage.cost?.totalCost)} (Grand Total)\n`);

// ---------------------------------------------------------------------------
// 8. Tool Calls & Execution Results Metadata (res.toolCalls & res.toolResults)
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[6] TOOL CALLS & TOOL RESULTS METADATA\x1b[0m");
console.log("─".repeat(70));
console.log(`Total Tool Calls Executed: ${response.toolCalls.length}`);
response.toolCalls.forEach((call: any, idx: number) => {
  console.log(`  [Call #${idx + 1}] ID: ${call.id}`);
  console.log(`    • Function Name:     ${call.name}`);
  console.log(`    • Parsed Arguments:  ${JSON.stringify(call.arguments)}`);
  if (call.thoughtSignature) {
    console.log(`    • Thought Signature: ${call.thoughtSignature.slice(0, 32)}...`);
  }
});

console.log(`\nTotal Tool Results Received: ${response.toolResults.length}`);
response.toolResults.forEach((res: any, idx: number) => {
  console.log(`  [Result #${idx + 1}] ID: ${res.id}`);
  console.log(`    • Function Name:     ${res.name}`);
  console.log(`    • Result Data:       ${JSON.stringify(res.result)}`);
  console.log(`    • Is Error:          ${res.isError ?? false}`);
  console.log(`    • Tool Duration:     ${res.durationMs ?? 0}ms`);
});
console.log("");

// ---------------------------------------------------------------------------
// 9. Sub-Agent Metadata (res.subagents)
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[7] SUB-AGENT EXECUTION METADATA (res.subagents)\x1b[0m");
console.log("─".repeat(70));
if (response.subagents && response.subagents.length > 0) {
  response.subagents.forEach((sub: any, idx: number) => {
    console.log(`  [Subagent #${idx + 1}] "${sub.name}" (Role: ${sub.role ?? "General"})`);
    console.log(`    • Model / Provider:  ${sub.provider}/${sub.model}`);
    console.log(`    • Task Given:        "${sub.task}"`);
    console.log(`    • Execution Time:    ${sub.durationMs}ms (${sub.turns} turns)`);
    console.log(`    • Tokens Consumed:   ↑${sub.usage.inputTokens} ↓${sub.usage.outputTokens} (Total: ${sub.usage.totalTokens})`);
    console.log(`    • Subagent Cost:     ${formatDollar(sub.usage.cost?.totalCost)}`);
    console.log(`    • Is Error:          ${sub.isError ?? false}`);
  });
} else {
  console.log("  No subagents were delegated for this single-agent turn.");
  console.log("  (When dynamicSubagents spawns delegates, full traces appear here)");
}
console.log("");

// ---------------------------------------------------------------------------
// 10. Zero-Leak Raw Wire Payloads (res.raw)
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[8] ZERO-LEAK RAW WIRE METADATA (res.raw)\x1b[0m");
console.log("─".repeat(70));
console.log("Outgoing HTTP Request:");
console.log(`  • URL:                 ${response.raw.request.url}`);
console.log(`  • HTTP Method:         ${response.raw.request.method}`);
console.log(`  • Headers Sent:        ${Object.keys(response.raw.request.headers).join(", ")}`);
console.log(`  • Raw Payload Keys:    ${Object.keys(response.raw.request.body as object).join(", ")}`);

console.log("\nIncoming HTTP Response:");
console.log(`  • Status Code:         ${response.raw.response?.status} (${response.raw.response?.statusText})`);
console.log(`  • Headers Received:    ${Object.keys(response.raw.response?.headers ?? {}).slice(0, 8).join(", ")}...`);
console.log(`  • Raw Response Keys:   ${Object.keys((response.raw.response?.body as object) ?? {}).join(", ")}`);
console.log("");

// ---------------------------------------------------------------------------
// 11. Complete Serialized JSON Export (res.toJSON())
// ---------------------------------------------------------------------------
console.log("\x1b[1;33m[9] COMPLETE SERIALIZED JSON (res.toJSON() Schema)\x1b[0m");
console.log("─".repeat(70));
const jsonTree = response.toJSON();
console.log(JSON.stringify({
  text: jsonTree.text.slice(0, 60) + "...",
  thinking: jsonTree.thinking ? jsonTree.thinking.slice(0, 40) + "..." : undefined,
  model: jsonTree.model,
  provider: jsonTree.provider,
  durationMs: jsonTree.durationMs,
  turns: jsonTree.turns,
  usage: jsonTree.usage,
  toolCallsCount: jsonTree.toolCalls?.length ?? 0,
  toolResultsCount: jsonTree.toolResults?.length ?? 0,
  subagentsCount: jsonTree.subagents?.length ?? 0,
  rawRequestUrl: jsonTree.raw.request.url,
  rawResponseStatus: jsonTree.raw.response?.status,
}, null, 2));

console.log("\n\x1b[1;32m✔ Complete metadata inspection finished successfully.\x1b[0m\n");
