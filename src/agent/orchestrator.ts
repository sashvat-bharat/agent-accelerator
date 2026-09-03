import { z } from "zod";
import { tool } from "../tools/tool.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { SubAgentExecutionMetadata } from "../types/response.ts";
import type { Agent } from "./agent.ts";
import { resolveModel } from "../providers/registry.ts";

export interface DynamicSubagentTask {
  name: string;
  role?: string;
  instructions: string;
  task: string;
  /** Optional per-subagent model override; if omitted inherits parent SubAgentModel (agent-accel parity). */
  model?: string;
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
  return `${parentId}-sub-${tag.toLowerCase().slice(0, 16)}-${rand}`;
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
 * Creates a dynamic sub-agent spawning tool.
 * Allows ANY provider/model for any sub-agent (no restriction). If LLM requests a model whose API key is missing, gracefully falls back to parent model instead of failing.
 */
export function createSubagentSpawnTool(parentAgent: Agent): ToolDefinition {
  return tool({
    name: "spawn_subagents",
    description:
      "Dynamically creates and runs one or more specialized sub-agents concurrently to handle sub-tasks. " +
      "Use this whenever a query or task benefits from modular delegation, parallel research, multi-perspective analysis, or division of labor. " +
      "All sub-agent outputs are aggregated and returned inside structured XML tags.",
    input: z.object({
      tasks: z
        .array(
          z.object({
            name: z
              .string()
              .describe("Unique UPPER_SNAKE role tag dynamically derived from task (e.g. RESEARCH_ANALYST, MARKET_ANALYST, CODE_REVIEWER)"),
            role: z
              .string()
              .optional()
              .describe("Short persona / domain expertise for this sub-agent"),
            instructions: z
              .string()
              .describe("Personalized system prompt crafted by Main Agent to increase instruction following"),
            task: z
              .string()
              .describe("Specific research/task prompt for this sub-agent"),
            model: z
              .string()
              .optional()
              .describe("Optional model override for this sub-agent (e.g. google/model-id). If omitted inherits parent SubAgentModel"),
          })
        )
        .describe("Array of sub-agents to spawn — each gets a personalized prompt, inherits parent SubAgentModel if model not specified"),
    }),
    execute: async ({ tasks }, context) => {
      if (!tasks || tasks.length === 0) {
        return "No sub-agent tasks provided.";
      }
      if (context?.signal?.aborted) {
        throw new Error("Sub-agent spawning aborted");
      }

      const { Agent: AgentClass } = await import("./agent.ts");

      const subagentMetadataList: SubAgentExecutionMetadata[] = [];
      const seenNames = new Set<string>();

      const limitedTasks = tasks.slice(0, 8);
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

          // Resolve model — per-task model optional, else inherit SubAgentModel (agent-accel parity)
          const parentModelStrRaw: any = (parentAgent.subagentModel as any) || (parentAgent.modelStringOrSpec as any);
          const parentModelStr = typeof parentModelStrRaw === "string" ? parentModelStrRaw : (parentModelStrRaw?.model ?? parentModelStrRaw?.id ?? String(parentModelStrRaw));
          let chosenModel: any = (t as any).model || parentModelStr;
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
            const subAgent = new AgentClass({
              name: t.name,
              description: t.role || `Sub-agent ${t.name}`,
              instructions: t.instructions,
              model: modelToUse,
              apiKey,
              baseUrl,
              ThinkingLevel: parentAgent.thinkingConfig?.level,
              sessionId: childSessionId,
              // Inherit cache & service tier from parent for max hit
              cache: parentAgent.cacheConfig,
              ServiceTier: parentAgent.serviceTier,
              headers: parentAgent.customHeaders,
              maxTurns: parentAgent.maxTurns,
            });
            let abortListener: (() => void) | null = null;
            const abortPromise = context?.signal
              ? new Promise<never>((_, reject) => {
                  const onAbort = () => reject(new Error("Sub-agent aborted via parent signal"));
                  abortListener = onAbort;
                  if (context.signal!.aborted) reject(new Error("Sub-agent aborted via parent signal"));
                  else context.signal!.addEventListener("abort", onAbort, { once: true });
                })
              : null;
            const taskPromise = subAgent.run(t.task, { signal: context?.signal } as any);
            try {
              const res = abortPromise ? await Promise.race([taskPromise, abortPromise]) : await taskPromise;
              return res;
            } finally {
              if (abortListener && context?.signal) {
                try { context.signal.removeEventListener("abort", abortListener as any); } catch {}
              }
            }
          };

          try {
            let res: any;
            try {
              res = await runWithModel(chosenModel, apiKeyToUse, baseUrlToUse);
            } catch (err: any) {
              const msg = err?.message || String(err);
              const isMissingKey = msg.includes("API key is missing") || msg.includes("apiKey") || msg.includes("No API key");
              const mainModelRaw: any = parentAgent.modelStringOrSpec as any;
              const mainModelStr: string = typeof mainModelRaw === "string" ? mainModelRaw : (mainModelRaw?.model ?? mainModelRaw?.id ?? String(mainModelRaw));
              const chosenForCompare = typeof chosenModel === "string" ? chosenModel : (chosenModel as any)?.model ?? (chosenModel as any)?.id ?? String(chosenModel);
              if (isMissingKey && chosenForCompare !== mainModelStr) {
                // SubAgentModel missing key → fallback to main model (cross-provider inheritance)
                res = await runWithModel(mainModelRaw, parentAgent.apiKey, parentAgent.baseUrl);
                chosenModel = mainModelRaw;
                chosenModelStrForProvider = mainModelStr;
                attemptedProvider = providerOf(mainModelStr);
              } else {
                throw err;
              }
            }

            const durationMs = Date.now() - startTime;
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
              text: (res as any).text,
              thinking: (res as any).thinking,
              toolCalls: (res as any).toolCalls,
              raw: (res as any).raw,
              isError: false,
            };
            return { name: subagentName, text: (res as any).text, metadata };
          } catch (err: any) {
            const durationMs = Date.now() - startTime;
            const errorMessage = err?.message || String(err);
            const prov = attemptedProvider || providerOf(chosenModelStrForProvider) || providerOf(chosenModel as any) || "unknown";
            const metadata: SubAgentExecutionMetadata = {
              name: subagentName,
              role: t.role,
              task: t.task,
              model: typeof chosenModel === "string" ? chosenModel : ((chosenModel as any)?.model ?? (chosenModel as any)?.id ?? (parentModelStr as string) ?? "unknown"),
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

export interface AgentAsToolTarget {
  name?: string;
  description?: string;
  agent: Agent;
}

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
        const response: any = await agentInstance.run(task, { signal: ctx?.signal } as any);
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
