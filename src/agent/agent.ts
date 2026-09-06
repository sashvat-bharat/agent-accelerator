import type { AgentConfig, AgentRunOptions } from "../types/agent.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { ThinkingLevel, ThinkingConfig, CacheConfig, ServiceTier } from "../types/core.ts";
import type { ContentPart } from "../types/message.ts";
import { AgentResponse, type StreamEvent } from "../types/response.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentContext } from "./context.ts";
import { resolveModel } from "../providers/registry.ts";
import { buildAgentTools, createSubagentSpawnTool } from "./delegation.ts";
import { runAgentLoop, streamAgentLoop } from "./loop.ts";
import { createSessionId } from "../utils/session.ts";
import { getModel, getSubModel } from "../utils/env.ts";
import { tool } from "../tools/tool.ts";
import { validateModelThinking } from "../models/catalog.ts";

export class SubAgentModelError extends Error {
  readonly parentModel?: string;

  constructor(parentModel?: string) {
    const parentName = parentModel || "your main model";
    const formatted =
      `\x1b[31m[Agent Accelerator] Missing Configuration: SubAgentModel is required when EnableSubagents is true\x1b[0m\n` +
      `  \x1b[1mMain Agent Model:\x1b[0m ${parentName}\n` +
      `  \x1b[1mIssue:\x1b[0m            Sub-agent delegation was enabled (EnableSubagents: true), but no model was assigned for sub-agents.\n` +
      `                    Sub-agents must never run on unverified models or default implicitly.\n\n` +
      `  \x1b[36m💡 How to fix:\x1b[0m\n` +
      `    1. Pass SubAgentModel in your Agent configuration:\n` +
      `       const agent = new Agent({\n` +
      `         model: "${parentName}",\n` +
      `         EnableSubagents: true,\n` +
      `         SubAgentModel: "provider/model-id", // Explicit sub-agent model\n` +
      `       });\n\n` +
      `    2. Or set the SUB_AGENT_MODEL environment variable in your .env or shell:\n` +
      `       SUB_AGENT_MODEL="provider/model-id"`;

    super(formatted);
    this.name = "SubAgentModelError";
    this.parentModel = parentModel;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SubAgentModelError);
    }
  }
}

export class Agent {
  readonly name: string;
  readonly description: string;
  instructions: string;
  readonly modelStringOrSpec: string | any;
  readonly subagentModel?: string | any;
  readonly tools: Record<string, ToolDefinition> = {};
  readonly thinkingConfig?: ThinkingConfig;
  readonly cacheConfig?: CacheConfig;
  readonly serviceTier?: ServiceTier;
  readonly maxTurns: number;
  readonly sessionId: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly customHeaders?: Record<string, string>;
  readonly context: AgentContext;
  readonly stateless: boolean;

  constructor(config: AgentConfig) {
    this.name = config.name || "Agent";
    this.description = config.description || "AI Agent powered by Agent Accelerator";
    // DX1: only instructions (no systemPrompt alias)
    this.instructions = config.instructions || "";
    const rawModel: any = (config.model as any)?.model ? (config.model as any) : config.model;
    // Support ModelProviderInstance {model, apiKey, baseUrl, thinkingLevel} and ModelSpec {id, provider}
    if (rawModel && typeof rawModel === "object" && "model" in rawModel) {
      this.modelStringOrSpec = rawModel.model;
    } else if (rawModel && typeof rawModel === "object" && "id" in rawModel && "provider" in rawModel) {
      this.modelStringOrSpec = rawModel;
    } else {
      this.modelStringOrSpec = rawModel || getModel();
    }
    // DX2: only SubAgentModel (bloatfree) — also accept subagentModel lowercase for backwards compat during transition
    const subAgentRaw = (config as any).SubAgentModel ?? (config as any).subagentModel;
    if (subAgentRaw && typeof subAgentRaw === "object" && "model" in subAgentRaw) {
      this.subagentModel = (subAgentRaw as any).model;
    } else if (subAgentRaw && typeof subAgentRaw === "object" && "id" in subAgentRaw && "provider" in subAgentRaw) {
      this.subagentModel = subAgentRaw;
    } else {
      this.subagentModel = subAgentRaw || getSubModel();
    }
    this.apiKey = (rawModel as any)?.apiKey || config.apiKey;
    this.baseUrl = (rawModel as any)?.baseUrl || config.baseUrl;
    this.customHeaders = config.headers;
    this.maxTurns = config.maxTurns ?? 10;
    this.sessionId = config.sessionId || config.cache?.sessionId || createSessionId();

    // DX4: single ThinkingLevel flag — also inherit from ModelProviderInstance if config.ThinkingLevel not set
    const mpThinking = (rawModel as any)?.thinkingLevel ?? (rawModel as any)?.thinking_level;
    this.thinkingConfig = normalizeThinking(config, mpThinking);

    // DX5: cache retention short|medium|long, undefined = no explicit
    this.cacheConfig = {
      sessionId: this.sessionId,
      ...(config.cache ?? {}),
    };
    // C11: wire explicit cachedContentId into context for Google explicit cache
    const initialCachedId = (this.cacheConfig as any)?.cachedContentId;

    // DX6: ServiceTier only flex|priority
    this.serviceTier = config.ServiceTier;
    this.stateless = config.stateless ?? false;

    // Tools registration
    if (config.tools) {
      if (Array.isArray(config.tools)) {
        for (const t of config.tools) {
          const tName = t.name || `tool_${Object.keys(this.tools).length}`;
          this.tools[tName] = { ...t, name: tName };
        }
      } else {
        for (const [key, def] of Object.entries(config.tools)) {
          this.tools[key] = {
            ...def,
            name: def.name || key,
          };
        }
      }
    }

    if (config.functions && Array.isArray(config.functions)) {
      for (const fn of config.functions) {
        const fnName = fn.name || `func_${Object.keys(this.tools).length}`;
        this.tools[fnName] = tool({
          name: fnName,
          description: `Executes function ${fnName}`,
          execute: async (args: any) => {
            if (typeof args === "object" && args !== null) {
              const argValues = Object.values(args);
              return fn(...argValues);
            }
            return fn(args);
          },
        });
      }
    }

    // Dedicated SubAgents registration (subagents: [critique, researcher])
    const rawSubagents = (config as any).subagents;
    if (Array.isArray(rawSubagents)) {
      const subagentTools = buildAgentTools(rawSubagents);
      for (const [toolName, toolDef] of Object.entries(subagentTools)) {
        this.tools[toolName] = toolDef;
      }
    }

    // DX3: only CustomAgents (renamed from agents)
    const rawCustom = (config as any).CustomAgents ?? (config as any).customAgents;
    if (rawCustom && Array.isArray(rawCustom)) {
      const agentTools = buildAgentTools(rawCustom);
      for (const [toolName, toolDef] of Object.entries(agentTools)) {
        this.tools[toolName] = toolDef;
      }
    }

    // DX8: Dynamic Subagents Spawning (EnableSubagents: true or subagents: true)
    const enableSubs =
      (config as any).EnableSubagents === true ||
      (config as any).enableSubagents === true ||
      (config as any).EnableSubAgents === true ||
      rawSubagents === true ||
      (config as any).subAgents === true;
    if (enableSubs === true) {
      if (!this.subagentModel) {
        throw new SubAgentModelError(
          typeof this.modelStringOrSpec === "string" ? this.modelStringOrSpec : (this.modelStringOrSpec as any)?.id
        );
      }
      const spawnTool = createSubagentSpawnTool(this);
      this.tools[spawnTool.name || "spawn_subagents"] = spawnTool;
    }

    this.context = new AgentContext(this.getFullInstructions());
    if (initialCachedId) {
      this.context.cachedContentId = initialCachedId;
    }
  }

  private getFullInstructions(): string | undefined {
    const base = this.instructions || "";
    const isThinkingEnabled =
      this.thinkingConfig?.enabled !== false &&
      this.thinkingConfig?.level &&
      this.thinkingConfig?.level !== "none";
    if (isThinkingEnabled && !base.includes("[Reasoning Directive]")) {
      const guidance =
        "[Reasoning Directive]\n" +
        "1. Use internal reasoning strictly for private planning and step-by-step thinking.\n" +
        "2. Never attempt to execute tools or output final user deliverables inside reasoning.\n" +
        "3. Once your reasoning is complete, output your final response or function calls directly in the standard response output.";
      return base ? `${base}\n\n${guidance}` : guidance;
    }
    return base || undefined;
  }

  reset(): void {
    this.context.messages = [];
    this.context.thoughtSignatures = [];
    this.context.cachedContentId = (this.cacheConfig as any)?.cachedContentId;
    this.context.systemPrompt = this.getFullInstructions();
  }

  private prepareTurn(prompt: string | ContentPart[], options?: AgentRunOptions): void {
    if (this.stateless) {
      this.context.messages = [];
      this.context.thoughtSignatures = [];
    }
    const fullInstructions = this.getFullInstructions();
    // C13: keep systemPrompt stable for Google implicit cache; additionalContext goes as user prefix, not system mutation
    if (options?.additionalContext) {
      // Preserve stable instructions as systemPrompt
      this.context.systemPrompt = fullInstructions;
      const prefix = `[Additional Context]\n${options.additionalContext}\n\n`;
      if (typeof prompt === "string") {
        prompt = prefix + prompt;
      } else if (Array.isArray(prompt)) {
        prompt = [{ type: "text", text: prefix } as ContentPart, ...prompt];
      }
    } else if (this.context.systemPrompt !== fullInstructions) {
      this.context.systemPrompt = fullInstructions;
    }
    // C11: keep context cachedContentId in sync with cacheConfig if updated via options
    if (options?.headers && (this.cacheConfig as any)?.cachedContentId && !this.context.cachedContentId) {
      this.context.cachedContentId = (this.cacheConfig as any).cachedContentId;
    }
    this.context.addUserMessage(prompt);
  }

  run(
    prompt: string | ContentPart[],
    options?: AgentRunOptions
  ): Promise<AgentResponse> & AssistantMessageEventStream {
    const isStream = options?.stream === true;
    if (isStream) {
      const hasCallbacks = !!(options?.onDelta || options?.onThinkingDelta || options?.onEvent);
      const s = this.stream(prompt, options) as any;
      if (hasCallbacks) {
        // Make `await agent.run(..., {stream:true, onDelta})` resolve to final response
        // while still streaming via callbacks. The returned value stays iterable/on-able.
        const resultPromise = s.result();
        const hybrid: any = resultPromise;
        hybrid[Symbol.asyncIterator] = s[Symbol.asyncIterator].bind(s);
        hybrid.on = s.on.bind(s);
        hybrid.off = s.off.bind(s);
        hybrid.result = s.result.bind(s);
        // also expose push/end/fail for compat, though not needed by caller
        return hybrid;
      }
      return s;
    }

    const resolved = resolveModel(this.modelStringOrSpec);
    const effectiveLevel = (options as any)?.ThinkingLevel || (options as any)?.thinkingLevel || this.thinkingConfig?.level;
    if (effectiveLevel) {
      validateModelThinking(resolved.provider.id, resolved.modelId, effectiveLevel);
    }
    this.prepareTurn(prompt, options);

    const providerOptions = {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      headers: { ...(this.customHeaders ?? {}), ...(options?.headers ?? {}) },
      thinking: this.thinkingConfig,
      cache: this.stateless
        ? { sessionId: options?.sessionId || this.sessionId }
        : { ...this.cacheConfig, sessionId: options?.sessionId || this.sessionId },
      serviceTier: this.serviceTier,
      sessionId: options?.sessionId || this.sessionId,
    };

    const loopConfig = {
      agentName: this.name,
      provider: resolved.provider,
      modelId: resolved.modelId,
      context: this.context,
      tools: this.tools,
      options: providerOptions,
      runOptions: options,
      maxTurns: this.maxTurns,
    };

    const promise = runAgentLoop(loopConfig).then((res) => {
      if (this.stateless) {
        this.context.messages = [];
        this.context.thoughtSignatures = [];
      }
      return res;
    });
    return promise as any;
  }

  ask(
    prompt: string | ContentPart[],
    optionsOrStream?: boolean | AgentRunOptions
  ): Promise<AgentResponse> & AsyncIterable<string | StreamEvent> {
    const isStream =
      typeof optionsOrStream === "boolean"
        ? optionsOrStream
        : optionsOrStream?.stream === true;

    const runOpts: AgentRunOptions =
      typeof optionsOrStream === "object" ? optionsOrStream : { stream: isStream };

    if (isStream) {
      const stream = this.stream(prompt, runOpts);
      // If callbacks are used, proxy them through string stream as well
      if (runOpts.onDelta || runOpts.onThinkingDelta || runOpts.onEvent) {
        if (runOpts.onEvent) stream.on("*", runOpts.onEvent as any);
        if (runOpts.onDelta) stream.on("text_delta", (e: any) => runOpts.onDelta!(e.delta!, e));
        if (runOpts.onThinkingDelta) stream.on("thinking_delta", (e: any) => runOpts.onThinkingDelta!(e.thinkingDelta!, e));
      }
      const stringStream: any = {
        [Symbol.asyncIterator]: async function* () {
          for await (const chunk of stream) {
            if (chunk.type === "text_delta" && chunk.delta) {
              yield chunk.delta;
            }
          }
        },
        result: () => stream.result(),
        on: (evt: string, fn: any) => stream.on(evt, fn),
      };
      // Make await work (resolves to AgentResponse)
      const resultPromise = stream.result();
      (stringStream as any).then = (res: any, rej: any) => resultPromise.then(res, rej);
      (stringStream as any).catch = (rej: any) => resultPromise.catch(rej);
      return stringStream;
    }

    return this.run(prompt, runOpts);
  }

  stream(
    prompt: string | ContentPart[],
    options?: AgentRunOptions
  ): AssistantMessageEventStream {
    const resolved = resolveModel(this.modelStringOrSpec);
    const effectiveLevel = (options as any)?.ThinkingLevel || (options as any)?.thinkingLevel || this.thinkingConfig?.level;
    if (effectiveLevel) {
      validateModelThinking(resolved.provider.id, resolved.modelId, effectiveLevel);
    }
    this.prepareTurn(prompt, options);

    const providerOptions = {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      headers: { ...(this.customHeaders ?? {}), ...(options?.headers ?? {}) },
      thinking: this.thinkingConfig,
      cache: this.stateless
        ? { sessionId: options?.sessionId || this.sessionId }
        : { ...this.cacheConfig, sessionId: options?.sessionId || this.sessionId },
      serviceTier: this.serviceTier,
      sessionId: options?.sessionId || this.sessionId,
    };

    const loopConfig = {
      agentName: this.name,
      provider: resolved.provider,
      modelId: resolved.modelId,
      context: this.context,
      tools: this.tools,
      options: providerOptions,
      runOptions: options,
      maxTurns: this.maxTurns,
    };

    const s = streamAgentLoop(loopConfig);
    if (this.stateless) {
      s.result().then(() => {
        this.context.messages = [];
        this.context.thoughtSignatures = [];
      }).catch(() => {});
    }
    // Wire one-liner callbacks so `stream:true` + onDelta is enough — no manual for-await needed
    if (options?.wrapThinking) {
      // Auto-wrap reasoning as <think>\n...\n</think>\n\n per-turn — clean boundaries across multi-turn agent runs
      let isThinking = false;
      const userOnThinking = options.onThinkingDelta;
      const userOnDelta = options.onDelta;
      const userOnEvent = options.onEvent;
      if (userOnEvent) s.on("*", userOnEvent as any);

      const openThink = (e?: any) => {
        if (!isThinking) {
          isThinking = true;
          const tag = "<think>\n";
          if (userOnThinking) userOnThinking(tag, e);
          else if (userOnDelta) userOnDelta(tag, e as any);
        }
      };

      const closeThink = (e?: any) => {
        if (isThinking) {
          isThinking = false;
          const close = "\n</think>\n\n";
          if (userOnThinking) userOnThinking(close, e);
          else if (userOnDelta) userOnDelta(close, e as any);
        }
      };

      if (userOnThinking || userOnDelta) {
        s.on("thinking_delta", (e: any) => {
          openThink(e);
          if (userOnThinking) userOnThinking(e.thinkingDelta!, e);
          else if (userOnDelta) userOnDelta(e.thinkingDelta!, e as any);
        });
        s.on("text_delta", (e: any) => {
          closeThink(e);
          if (userOnDelta) userOnDelta(e.delta!, e);
          else if (userOnThinking) userOnThinking(e.delta!, e as any);
        });
        // Close thinking tag and reset turn state before tool/subagent execution or results
        s.on("tool_call_start" as any, (e: any) => closeThink(e));
        s.on("tool_call_complete" as any, (e: any) => closeThink(e));
        s.on("tool_result" as any, (e: any) => closeThink(e));
        s.on("subagent_complete" as any, (e: any) => closeThink(e));
        s.on("done", (e: any) => {
          closeThink(e || ({ type: "done" } as any));
        });
      } else {
        // No callbacks but wrapThinking true — still emit tags as events for manual iteration
        s.on("thinking_delta", (e: any) => {
          if (!isThinking) {
            isThinking = true;
            s.push({ type: "thinking_delta", thinkingDelta: "<think>\n" } as any);
          }
        });
        s.on("text_delta", (e: any) => {
          if (isThinking) {
            isThinking = false;
            s.push({ type: "thinking_delta", thinkingDelta: "\n</think>\n\n" } as any);
          }
        });
        s.on("tool_call_start" as any, () => {
          if (isThinking) {
            isThinking = false;
            s.push({ type: "thinking_delta", thinkingDelta: "\n</think>\n\n" } as any);
          }
        });
        s.on("tool_call_complete" as any, () => {
          if (isThinking) {
            isThinking = false;
            s.push({ type: "thinking_delta", thinkingDelta: "\n</think>\n\n" } as any);
          }
        });
        s.on("tool_result" as any, () => {
          if (isThinking) {
            isThinking = false;
            s.push({ type: "thinking_delta", thinkingDelta: "\n</think>\n\n" } as any);
          }
        });
        s.on("subagent_complete" as any, () => {
          if (isThinking) {
            isThinking = false;
            s.push({ type: "thinking_delta", thinkingDelta: "\n</think>\n\n" } as any);
          }
        });
        s.on("done", () => {
          if (isThinking) {
            isThinking = false;
            s.push({ type: "thinking_delta", thinkingDelta: "\n</think>\n\n" } as any);
          }
        });
        if (userOnEvent) s.on("*", userOnEvent as any);
      }
    } else {
      if (options?.onEvent) s.on("*", options.onEvent as any);
      if (options?.onDelta) s.on("text_delta", (e: any) => options.onDelta!(e.delta!, e));
      if (options?.onThinkingDelta) s.on("thinking_delta", (e: any) => options.onThinkingDelta!(e.thinkingDelta!, e));
    }
    return s;
  }
}

export function normalizeThinking(config: AgentConfig, fallbackLevel?: string): ThinkingConfig | undefined {
  // DX4: only ThinkingLevel flag, values: none, dynamic, minimal, low, medium, high, xhigh
  const rawLevel = (config as any).ThinkingLevel ?? (config as any).thinkingLevel ?? (config as any).thinking_level ?? fallbackLevel;
  const level = rawLevel as ThinkingLevel | undefined;

  if (!level) return undefined;

  // Validate model thinking from catalog if model is configured
  if (config.model) {
    try {
      const rawModel: any = (config.model as any)?.model ? (config.model as any).model : config.model;
      const modelStr = typeof rawModel === "string" ? rawModel : rawModel?.id || "";
      const provStr = typeof rawModel === "object" && rawModel?.provider ? rawModel.provider : modelStr.includes("/") ? modelStr.split("/")[0] : "";
      const actualModelId = modelStr.includes("/") ? modelStr.split("/").slice(1).join("/") : modelStr;
      if (actualModelId) {
        validateModelThinking(provStr || "opencode", actualModelId, level);
      }
    } catch (e) {
      throw e;
    }
  }

  if (level === "none") {
    return { enabled: false, level: "none", budgetTokens: 0 };
  }
  if (level === "dynamic") {
    return { enabled: true, level: "dynamic", budgetTokens: -1 };
  }
  return { enabled: true, level };
}
