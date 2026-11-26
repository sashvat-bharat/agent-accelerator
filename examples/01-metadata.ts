// What a response and the model catalog tell you: usage, cost, tool calls, the raw request, toJSON().
// Run: bun run examples/01-metadata.ts
import { Agent, tool, getModelFromCatalog, getModelThinkingInfo, resolveModel } from "agent-accelerator";
import { z } from "zod";
import { fail, MODEL } from "./_shared";

const getMetrics = tool({
  name: "get_system_metrics",
  description: "Get CPU and memory telemetry for a cluster.",
  input: z.object({ clusterId: z.string() }),
  execute: async ({ clusterId }) => ({ clusterId, status: "HEALTHY", cpu: "41.8%", memoryUsedGb: 88.5 }),
});

// What the catalog knows about the model, before any request.
const { provider, modelId } = resolveModel(MODEL);
const spec = getModelFromCatalog(provider.id, modelId);
console.log("catalog:", {
  contextWindow: spec?.contextWindow,
  maxOutputTokens: spec?.maxOutputTokens,
  inputModalities: spec?.modalities?.input,
  pricing: spec?.pricing,
  thinking: getModelThinkingInfo(provider.id, modelId),
});

const agent = new Agent({
  model: MODEL,
  instructions: "You are a systems analyst. Use get_system_metrics, then summarize in two sentences.",
  tools: { get_system_metrics: getMetrics },
});

const events: string[] = [];
const res = await agent
  .run("Check cluster 'us-east-prod-1'.", { stream: true, onEvent: (e) => events.push(e.type) })
  .catch(fail);

console.log("\nanswer:", res.text);
console.log("events:", [...new Set(events)].join(", "));
console.log("run:", {
  provider: res.provider,
  model: res.model,
  finishReason: res.finishReason,
  turns: res.turns,
  durationMs: res.durationMs,
});
console.log("usage:", res.usage); // tokens, cache reads and writes, thinking tokens, and `cost` in USD
console.log(
  "tool calls:",
  res.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments }))
);
console.log(
  "tool results:",
  res.toolResults.map((r) => ({ name: r.name, result: r.result, ms: r.durationMs }))
);
console.log("sub-agents:", res.subagents.length);
console.log("raw:", res.raw.request.method, res.raw.request.url, "->", res.raw.response?.status); // bodies are redacted by default
console.log("toJSON keys:", Object.keys(res.toJSON()));
