import { z } from "zod";
import { tool } from "../tools/tool.ts";
import { normalizeToolName } from "../tools/executor.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { SubAgentExecutionMetadata } from "../types/response.ts";
import type { Agent } from "./agent.ts";
import { resolveModel } from "../providers/registry.ts";

/** Task descriptor accepted by the automatic `spawn_subagents` tool.
 *
 * The Main Agent controls prompts (`name`/`role`/`instructions`/`task`), which
 * worker tools to grant (`tools`), and — only when the developer sets
 * `dynamicSubagents.timeout: -1` — each worker's `timeoutMs`. Model, reasoning
 * level, and history are never LLM-choosable: workers are stateless and run on
 * the developer-configured model.
 */
export interface DynamicSubagentTask {
  name: string;
  role?: string;
  instructions: string;
  task: string;
  /** Names of worker tools to grant this sub-agent. Must be a subset of the developer-configured `dynamicSubagents.tools` pool; unknown names are ignored. Omit for no tools. */
  tools?: string[];
  /** Per-worker timeout in ms. Honored ONLY when the developer sets `dynamicSubagents.timeout: -1`. Must be > 0, otherwise the worker runs with no limit. */
  timeoutMs?: number;
}

function sanitizeXmlTag(raw: string): string {
  let s = raw.toUpperCase().replace(/[^A-Z0-9_.-]/g, "_");
  if (!/^[A-Z_]/.test(s)) s = `AGENT_${s}`;
  s = s.replace(/[.-]/g, "_");
  return s.slice(0, 64) || "SUBAGENT";
}
function sanitizeToolName(raw: string): string {
  const tag = sanitizeXmlTag(raw);
  return tag.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64) || "sub_agent";
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createChildSessionId(parentId: string, tag: string): string {
  let rand: string;
  try {
    if (typeof globalThis !== "undefined" && (globalThis as any).crypto?.randomUUID) {
      rand = (globalThis as any).crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    } else {
      // Node fallback - dynamic require avoids bundling issues
      const nodeCrypto: any = (globalThis as any).process?.getBuiltinModule?.("node:crypto") ?? null;
      if (nodeCrypto?.randomUUID) rand = nodeCrypto.randomUUID().replace(/-/g, "").slice(0, 8);
      else rand = Math.random().toString(36).slice(2, 10);
    }
  } catch {
    rand = Math.random().toString(36).slice(2, 10);
  }
  // Provider-safe: OpenAI `prompt_cache_key` enforces max 64 chars (400
  // otherwise). Parent ids are already ~42 chars (`accel-<uuid>`), so naive
  // `${parent}-sub-${tag}-${rand}` overflows (observed 65-72 chars → every
  // sub-agent 400s with 0 usage). Truncate the parent portion to fit, keeping
  // the tag + rand suffix intact for uniqueness/debuggability.
  const cleanTag = tag.toLowerCase().slice(0, 16);
  const suffix = `-sub-${cleanTag}-${rand}`;
  const maxParent = Math.max(0, 64 - suffix.length);
  const truncatedParent = parentId.slice(0, maxParent);
  return `${truncatedParent}${suffix}`;
}

/** Builds a deterministic fixed-subagent session id that fits 64 chars. */
function createFixedChildSessionId(parentId: string, name: string): string {
  const suffix = `-sub-${name}`;
  if ((parentId + suffix).length <= 64) return parentId + suffix;
  // Truncate parent first (preserves full tool name for debugging); if still
  // over (very long tool name), truncate the name tail as last resort.
  const maxParent = Math.max(0, 64 - suffix.length);
  if (maxParent > 0) return parentId.slice(0, maxParent) + suffix;
  return (`${parentId}-sub-${name}`).slice(0, 64);
}

function providerOf(modelStr: string | any | undefined): string | undefined {
  if (!modelStr) return undefined;
  try {
    const m = typeof modelStr === "string" ? modelStr : (modelStr as any)?.model ?? (modelStr as any)?.id ?? String(modelStr);
    return resolveModel(m as any).provider.id;
  } catch {
    return undefined;
  }
}

/**
 * Creates the built-in tool that spawns stateless dynamic sub-agents concurrently.
 *
 * Workers run on the developer-configured model with the developer-configured
 * reasoning level. The Main Agent controls prompts, per-worker tool grants, and
 * (when `dynamicSubagents.timeout: -1`) per-worker timeouts — nothing else.
 *
 * @example `new Agent({ model, dynamicSubagents: { enabled: true, maxSpawn: 4 } })`
 */
export function createSubagentSpawnTool(parentAgent: Agent): ToolDefinition {
  const dyn = (parentAgent as any).dynamicSubagents as
    | { maxSpawn: number; tools: Record<string, unknown>; timeout: number }
    | undefined;
  const maxSpawn = dyn && Number.isFinite(dyn.maxSpawn) ? Math.max(1, Math.floor(dyn.maxSpawn)) : 4;
  const poolNames = dyn ? Object.keys(dyn.tools ?? {}) : [];
  const parentTimeout = dyn && Number.isFinite(dyn.timeout) ? Math.floor(dyn.timeout) : 0;
  const timeoutNote =
    parentTimeout === -1
      ? "Set a per-task timeoutMs (ms, > 0) to time-limit a worker; omit it for no limit."
      : parentTimeout === 0
        ? "Workers run with no time limit; any per-task timeoutMs is ignored."
        : `Every worker is limited to ${parentTimeout}ms; any per-task timeoutMs is ignored.`;
  return tool({
    name: "spawn_subagents",
    description:
      "Dynamically creates and runs specialized stateless sub-agents concurrently to handle sub-tasks. " +
      "Use this whenever a query or task benefits from modular delegation, parallel research, multi-perspective analysis, or division of labor. " +
      "All sub-agent outputs are aggregated and returned inside structured XML tags. " +
      `You may spawn at most ${maxSpawn} sub-agent(s) per call — extra tasks beyond ${maxSpawn} are ignored. ` +
      "Workers are stateless: each receives one task, returns its result, then shuts down; no conversation history is kept. " +
      "You cannot choose worker models or reasoning levels. " +
      (poolNames.length > 0
        ? `Worker-available tools: ${poolNames.join(", ")}. Grant each worker ONLY the tools its task needs via the per-task tools list; omit it for no tools. `
        : "No worker tools are available; omit the per-task tools list. ") +
      timeoutNote + " " +
      "Every entry in tasks MUST include all of: name (UPPER_SNAKE tag), instructions (system prompt for the worker), task (concrete assignment for the worker). " +
      "Example: {\"tasks\": [{\"name\": \"HBM_PRICING_ANALYST\", \"role\": \"memory market analyst\", \"instructions\": \"You are a memory market analyst. Return sourced findings only.\", \"task\": \"Research HBM3E pricing, LTA structures, and supply constraints.\", \"tools\": [\"recent_news\"]}]}",
    input: z.object({
      tasks: z
        .array(
          z.object({
            name: z
              .string()
              .optional()
              .describe("Unique UPPER_SNAKE role tag dynamically derived from task (e.g. RESEARCH_ANALYST, MARKET_ANALYST, CODE_REVIEWER). Auto-generated when omitted."),
            role: z
              .string()
              .optional()
              .describe("Short persona / domain expertise for this sub-agent"),
            instructions: z
              .string()
              .optional()
              .describe("Personalized system prompt crafted by Main Agent to increase instruction following. Falls back to task when omitted."),
            task: z
              .string()
              .optional()
              .describe("Specific research/task prompt for this sub-agent. REQUIRED — falls back to instructions when omitted."),
            tools: z
              .array(z.string())
              .optional()
              .describe(
                poolNames.length > 0
                  ? `Tool names to grant this worker (subset of: ${poolNames.join(", ")}). Unknown names are ignored. Omit for no tools.`
                  : "No worker tools are available; omit this field."
              ),
            timeoutMs: z
              .number()
              .optional()
              .describe(
                parentTimeout === -1
                  ? "Per-worker timeout in ms (> 0). Honored because the developer set timeout: -1. Omit for no limit."
                  : "Per-worker timeout is developer-controlled; this field is ignored."
              ),
          })
        )
        .min(1)
        .max(maxSpawn)
        .describe(`Array of sub-agents to spawn (max ${maxSpawn} per call) — each gets a personalized prompt and runs statelessly on the developer-configured model`),
    }),
    execute: async ({ tasks }, context) => {
      if (!tasks || tasks.length === 0) {
        return "Error: tasks array is empty. Provide at least one entry shaped like {\"name\": \"HBM_PRICING_ANALYST\", \"role\": \"memory market analyst\", \"instructions\": \"<system prompt>\", \"task\": \"<concrete assignment>\"}. Fix the arguments and call spawn_subagents again.";
      }
      const repaired = tasks.map((entry: Record<string, unknown>, index: number) => {
        const rec = (entry ?? {}) as Record<string, unknown>;
        const taskText =
          (typeof rec["task"] === "string" && rec["task"].trim()) ||
          (typeof rec["instructions"] === "string" && (rec["instructions"] as string).trim()) ||
          "";
        const instructionsText =
          (typeof rec["instructions"] === "string" && (rec["instructions"] as string).trim()) ||
          (typeof rec["task"] === "string" && (rec["task"] as string).trim()) ||
          (typeof rec["role"] === "string" && (rec["role"] as string).trim()) ||
          "";
        const nameText =
          (typeof rec["name"] === "string" && (rec["name"] as string).trim()) ||
          `SUBAGENT_${index + 1}`;
        const roleText =
          typeof rec["role"] === "string" ? ((rec["role"] as string).trim() || undefined) : undefined;
        const toolsList = Array.isArray(rec["tools"])
          ? (rec["tools"] as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
          : undefined;
        const timeoutRaw = rec["timeoutMs"];
        const timeoutMs = typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) ? Math.floor(timeoutRaw) : undefined;
        return { ...rec, name: nameText, role: roleText, instructions: instructionsText, task: taskText, tools: toolsList, timeoutMs };
      });
      const invalid = repaired.findIndex((r) => !r.task);
      if (invalid >= 0) {
        const keys = Object.keys((tasks[invalid] ?? {}) as object).join(", ") || "(none)";
        return (
          `Error: tasks[${invalid}].task is missing and could not be inferred. ` +
          `Received keys: [${keys}]. ` +
          `Each tasks[] entry MUST include task (concrete assignment) plus instructions (system prompt) and name (UPPER_SNAKE tag). ` +
          `Example: {\"name\": \"HBM_PRICING_ANALYST\", \"role\": \"memory market analyst\", \"instructions\": \"You are a memory market analyst.\", \"task\": \"Research HBM3E pricing.\"}. ` +
          `Fix the entry and call spawn_subagents again.`
        );
      }
      if (context?.signal?.aborted) {
        throw new Error("Sub-agent spawning aborted");
      }

      const dynCfg = (parentAgent as any).dynamicSubagents as
        | { model?: unknown; maxSpawn: number; thinkingLevel?: string; tools: Record<string, ToolDefinition>; timeout: number }
        | undefined;
      const effectiveMax = dynCfg && Number.isFinite(dynCfg.maxSpawn) ? Math.max(1, Math.floor(dynCfg.maxSpawn)) : 4;
      const toolPool: Record<string, ToolDefinition> = (dynCfg?.tools as any) ?? {};
      const cfgTimeout = dynCfg && Number.isFinite(dynCfg.timeout) ? Math.floor(dynCfg.timeout) : 0;

      if (!parentAgent.subagentModel) {
        throw new Error(
          "[Agent Accelerator] Cannot spawn sub-agents: no sub-agent model is configured. " +
          "Set dynamicSubagents.model in Agent config or set the SUB_AGENT_MODEL environment variable."
        );
      }

      const { Agent: AgentClass } = await import("./agent.ts");

      const subagentMetadataList: SubAgentExecutionMetadata[] = [];
      const seenNames = new Set<string>();

      // maxSpawn: trim extras safely — only the first N tasks run.
      const limitedTasks = repaired.slice(0, effectiveMax);
      const executedResults = await Promise.all(
        limitedTasks.map(async (t) => {
          const startTime = Date.now();
          let sanitized = sanitizeXmlTag(t.name);
          let deduped = sanitized;
          let suffix = 1;
          while (seenNames.has(deduped)) {
            deduped = `${sanitized}_${suffix++}`;
          }
          seenNames.add(deduped);
          const subagentName = deduped;

          // Fixed developer-configured worker model — never LLM-choosable.
          const chosenModel: any = parentAgent.subagentModel;
          // Normalize chosenModel to string|ModelSpec handling
          let chosenModelStrForProvider = typeof chosenModel === "string" ? chosenModel : (chosenModel as any)?.model ?? (chosenModel as any)?.id ?? String(chosenModel);
          let attemptedProvider = providerOf(chosenModelStrForProvider);
          // Determine creds: only reuse parent creds if provider matches parent provider, else let env resolve for cross-provider
          const parentProvider = providerOf(parentAgent.modelStringOrSpec as any);
          const targetProviderFinal = providerOf(chosenModelStrForProvider);
          let apiKeyToUse: string | undefined;
          let baseUrlToUse: string | undefined;
          if (targetProviderFinal === parentProvider) {
            apiKeyToUse = parentAgent.apiKey;
            baseUrlToUse = parentAgent.baseUrl;
          } else {
            apiKeyToUse = undefined;
            baseUrlToUse = undefined;
          }

          const runWithModel = async (modelToUse: any, apiKey: string | undefined, baseUrl: string | undefined) => {
            if (context?.signal?.aborted) throw new Error("Aborted before spawn");
            const childSessionId = createChildSessionId(parentAgent.sessionId, subagentName);
            // Grant ONLY the Main Agent-selected subset from the developer pool. Unknown names are dropped.
            // Matching is case/format-insensitive (same rules as tool execution): the model may emit
            // "RECENT_NEWS" or "recent news" for a registered "recent_news" tool.
            const poolByNormalized = new Map<string, ToolDefinition>();
            for (const [key, def] of Object.entries(toolPool)) {
              poolByNormalized.set(normalizeToolName(key), def);
              const declared = (def as ToolDefinition)?.name;
              if (declared) poolByNormalized.set(normalizeToolName(declared), def);
            }
            const grantedTools: Record<string, ToolDefinition> = {};
            for (const toolName of (t as any).tools ?? []) {
              const pooled = toolPool[toolName] ?? poolByNormalized.get(normalizeToolName(String(toolName)));
              if (pooled) grantedTools[(pooled as ToolDefinition).name || toolName] = pooled;
            }
            // Timeout: >0 fixed for every worker; 0 = no limit; -1 = per-task timeoutMs from the Main Agent.
            const workerTimeout = cfgTimeout > 0 ? cfgTimeout : cfgTimeout === -1 && (t as any).timeoutMs > 0 ? (t as any).timeoutMs : 0;
            const subAgent = new AgentClass({
              name: t.name,
              description: t.role || `Sub-agent ${t.name}`,
              instructions: t.instructions,
              model: modelToUse,
              apiKey,
              baseUrl,
              thinkingLevel: (dynCfg?.thinkingLevel as any) ?? parentAgent.thinkingConfig?.level,
              sessionId: childSessionId,
              tools: grantedTools,
              // Stateless by design: one task in, one result out, then shut down. No history, no recursion.
              stateless: true,
              serviceTier: parentAgent.serviceTier,
              headers: parentAgent.customHeaders,
              maxTurns: parentAgent.maxTurns,
            });
            let abortListener: (() => void) | null = null;
            // Per-worker controller: the parent signal alone cannot stop a
            // worker that hits its own timeout, so the timeout path aborts
            // the worker explicitly instead of leaving it running unseen.
            const workerController = new AbortController();
            const parentSignal = context?.signal;
            const forwardParentAbort = () => {
              try {
                workerController.abort((parentSignal as any)?.reason);
              } catch {
                try { workerController.abort(); } catch {}
              }
            };
            if (parentSignal?.aborted) forwardParentAbort();
            else parentSignal?.addEventListener("abort", forwardParentAbort, { once: true });
            const abortPromise = parentSignal
              ? new Promise<never>((_, reject) => {
                  const onAbort = () => reject(new Error("Sub-agent aborted via parent signal"));
                  abortListener = onAbort;
                  if (parentSignal.aborted) reject(new Error("Sub-agent aborted via parent signal"));
                  else parentSignal.addEventListener("abort", onAbort, { once: true });
                })
              : null;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;
            const timeoutPromise = workerTimeout > 0
              ? new Promise<never>((_, reject) => {
                  timeoutId = setTimeout(() => {
                    try {
                      workerController.abort(new Error(`Sub-agent ${subagentName} timed out after ${workerTimeout}ms`));
                    } catch {}
                    reject(new Error(`Sub-agent ${subagentName} timed out after ${workerTimeout}ms`));
                  }, workerTimeout);
                })
              : null;
            const taskPromise = subAgent.run(t.task, { signal: workerController.signal } as any);
            try {
              const racers: Promise<unknown>[] = [taskPromise as unknown as Promise<unknown>];
              if (abortPromise) racers.push(abortPromise);
              if (timeoutPromise) racers.push(timeoutPromise);
              const res = await Promise.race(racers);
              return res;
            } finally {
              if (timeoutId) clearTimeout(timeoutId);
              if (abortListener && parentSignal) {
                try { parentSignal.removeEventListener("abort", abortListener as any); } catch {}
              }
              try { parentSignal?.removeEventListener("abort", forwardParentAbort); } catch {}
            }
          };

          try {
            const res: any = await runWithModel(chosenModel, apiKeyToUse, baseUrlToUse);

            const durationMs = Date.now() - startTime;
            const rawText = (res as any).text;
            const subagentText = typeof rawText === "string" && rawText.trim().length > 0
              ? rawText
              : `[Sub-agent ${subagentName} produced no output (empty response).]`;

            const metadata: SubAgentExecutionMetadata = {
              name: subagentName,
              role: t.role,
              task: t.task,
              model: (res as any).model,
              provider: (res as any).provider,
              durationMs,
              usage: (res as any).usage,
              turns: (res as any).turns,
              finishReason: (res as any).finishReason,
              responseId: (res as any).responseId,
              text: subagentText,
              thinking: (res as any).thinking,
              toolCalls: (res as any).toolCalls,
              raw: (res as any).raw,
              isError: false,
            };
            return { name: subagentName, text: subagentText, metadata };
          } catch (err: any) {
            const durationMs = Date.now() - startTime;
            const errorMessage = err?.message || String(err);
            const prov = attemptedProvider || providerOf(chosenModelStrForProvider) || providerOf(chosenModel as any) || "unknown";
            const metadata: SubAgentExecutionMetadata = {
              name: subagentName,
              role: t.role,
              task: t.task,
              model: typeof chosenModel === "string" ? chosenModel : ((chosenModel as any)?.model ?? (chosenModel as any)?.id ?? "unknown"),
              provider: prov,
              durationMs,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              turns: 0,
              text: `Error executing sub-agent ${t.name}: ${errorMessage}`,
              isError: true,
              error: errorMessage,
            };
            return { name: subagentName, text: `Error executing sub-agent ${t.name}: ${errorMessage}`, metadata };
          }
        })
      );

      const xmlBlocks = executedResults.map((r) => {
        subagentMetadataList.push(r.metadata);
        const escaped = escapeXml(r.text);
        const indentedText = escaped.split("\n").map((line) => `        ${line}`).join("\n");
        return `    <${r.name}>\n${indentedText}\n    </${r.name}>`;
      });

      const xmlOutput = `<SUB-AGENTS-RESPONSE>\n${xmlBlocks.join("\n")}\n</SUB-AGENTS-RESPONSE>`;

      const resultPayload = {
        xml: xmlOutput,
        _subagentMetadata: subagentMetadataList,
        toString() { return xmlOutput; },
      };
      return resultPayload;
    },
  });
}

/** Optional name/description wrapper for converting an Agent into a tool. */
export interface AgentAsToolTarget {
  name?: string;
  description?: string;
  agent: Agent;
}

/**
 * Converts one agent into a `{ task: string }` ToolDefinition.
 *
 * @example `const researchTool = researcher.asTool("research");`
 */
export function agentToTool(
  input: Agent | AgentAsToolTarget
): ToolDefinition {
  const agentInstance = "agent" in input ? input.agent : input;
  const rawName =
    ("name" in input && (input as any).name) ||
    agentInstance.name ||
    `sub_agent_${Math.random().toString(36).slice(2, 7)}`;
  const name = sanitizeToolName(rawName);
  const description =
    ("description" in input && (input as any).description) ||
    agentInstance.description ||
    `Calls the sub-agent '${name}' to perform tasks.`;

  return tool({
    name,
    description,
    input: z.object({
      task: z.string().describe("The detailed instruction or prompt to pass to this sub-agent."),
    }),
    execute: async ({ task }, ctx) => {
      const startTime = Date.now();
      try {
        const parentSessionId = ctx?.sessionId || agentInstance.sessionId || "session";
        const subSessionId = createFixedChildSessionId(parentSessionId, sanitizeToolName(name));
        const response: any = await agentInstance.run(task, { signal: ctx?.signal, sessionId: subSessionId } as any);
        const durationMs = Date.now() - startTime;
        const metadata: SubAgentExecutionMetadata = {
          name,
          task,
          model: response.model,
          provider: response.provider,
          durationMs,
          usage: response.usage,
          turns: response.turns,
          finishReason: response.finishReason,
          responseId: response.responseId,
          text: response.text,
          thinking: response.thinking,
          toolCalls: response.toolCalls,
          raw: response.raw,
          isError: false,
        };
        const wrapper: any = {
          xml: response.text,
          _subagentMetadata: [metadata],
          toString() { return response.text; },
        };
        return wrapper;
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        const msg = err?.message || String(err);
        const metadata: SubAgentExecutionMetadata = {
          name,
          task,
          model: "unknown",
          provider: "unknown",
          durationMs,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          turns: 0,
          text: `Error in ${name}: ${msg}`,
          isError: true,
          error: msg,
        };
        const wrapper: any = {
          xml: `Error in ${name}: ${msg}`,
          _subagentMetadata: [metadata],
          toString() { return `Error in ${name}: ${msg}`; },
        };
        return wrapper;
      }
    },
  });
}

/**
 * Converts a list of agents into uniquely named delegation tools.
 *
 * @example `const tools = buildAgentTools([researcher, reviewer]);`
 */
export function buildAgentTools(
  agents?: (Agent | AgentAsToolTarget)[]
): Record<string, ToolDefinition> {
  if (!agents || agents.length === 0) return {};

  const tools: Record<string, ToolDefinition> = {};
  for (const item of agents) {
    const t = agentToTool(item);
    if (t.name) {
      let finalName = t.name;
      let n = 1;
      while (tools[finalName]) {
        finalName = `${t.name}_${n++}`;
      }
      tools[finalName] = { ...t, name: finalName };
    }
  }
  return tools;
}
