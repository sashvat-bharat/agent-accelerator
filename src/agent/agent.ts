import type { AgentConfig, AgentRunOptions } from "../types/agent.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { ThinkingLevel, ThinkingConfig, CacheConfig, ServiceTier } from "../types/core.ts";
import type { ContentPart } from "../types/message.ts";
import { AgentResponse, type StreamEvent } from "../types/response.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentContext } from "./context.ts";
import { resolveModel } from "../providers/registry.ts";
import { buildAgentTools, createSubagentSpawnTool } from "./orchestrator.ts";
import { runAgentLoop, streamAgentLoop } from "./loop.ts";
import { createSessionId } from "../utils/session.ts";
import { getModel, getSubModel } from "../utils/env.ts";
import { tool } from "../tools/tool.ts";

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
    if (!((config as any).ThinkingLevel ?? (config as any).thinkingLevel) && mpThinking) {
      (config as any).ThinkingLevel = mpThinking;
    }
    this.thinkingConfig = normalizeThinking(config);

    // DX5: cache retention short|medium|long, undefined = no explicit
    this.cacheConfig = {
      sessionId: this.sessionId,
      ...(config.cache ?? {}),
    };
    // C11: wire explicit cachedContentId into context for Google explicit cache
    const initialCachedId = (this.cacheConfig as any)?.cachedContentId;

    // DX6: ServiceTier only flex|priority
    this.serviceTier = config.ServiceTier;

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

    if (config.skills && Array.isArray(config.skills)) {
      for (const skill of config.skills) {
        if (skill.instructions) {
          this.instructions = `${this.instructions}\n\n# Skill: ${skill.name}\n${skill.instructions}`.trim();
        }
        for (const [toolName, toolDef] of Object.entries(skill.tools)) {
          this.tools[toolName] = toolDef;
        }
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

    // DX8: only EnableSubagents (plus legacy subagents alias for test compat)
    const enableSubs = (config as any).EnableSubagents ?? (config as any).enableSubagents ?? (config as any).EnableSubAgents ?? (config as any).subagents ?? (config as any).subAgents;
    if (enableSubs === true) {
      const spawnTool = createSubagentSpawnTool(this);
      this.tools[spawnTool.name || "spawn_subagents"] = spawnTool;
    }

    this.context = new AgentContext(this.instructions || undefined);
    if (initialCachedId) {
      this.context.cachedContentId = initialCachedId;
    }
  }

  reset(): void {
    this.context.messages = [];
    this.context.thoughtSignatures = [];
    this.context.cachedContentId = (this.cacheConfig as any)?.cachedContentId;
    this.context.systemPrompt = this.instructions || undefined;
  }

  private prepareTurn(prompt: string | ContentPart[], options?: AgentRunOptions): void {
    // C13: keep systemPrompt stable for Google implicit cache; additionalContext goes as user prefix, not system mutation
    if (options?.additionalContext) {
      // Preserve stable instructions as systemPrompt
      this.context.systemPrompt = this.instructions || undefined;
      const prefix = `[Additional Context]\n${options.additionalContext}\n\n`;
      if (typeof prompt === "string") {
        prompt = prefix + prompt;
      } else if (Array.isArray(prompt)) {
        prompt = [{ type: "text", text: prefix } as ContentPart, ...prompt];
      }
    } else if (this.context.systemPrompt !== this.instructions) {
      this.context.systemPrompt = this.instructions || undefined;
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
    this.prepareTurn(prompt, options);

    const providerOptions = {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      headers: { ...(this.customHeaders ?? {}), ...(options?.headers ?? {}) },
      thinking: this.thinkingConfig,
      cache: { ...this.cacheConfig, sessionId: options?.sessionId || this.sessionId },
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

    const promise = runAgentLoop(loopConfig);
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
    this.prepareTurn(prompt, options);

    const providerOptions = {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      headers: { ...(this.customHeaders ?? {}), ...(options?.headers ?? {}) },
      thinking: this.thinkingConfig,
      cache: { ...this.cacheConfig, sessionId: options?.sessionId || this.sessionId },
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
    // Wire one-liner callbacks so `stream:true` + onDelta is enough — no manual for-await needed
    if (options?.wrapThinking) {
      // Auto-wrap reasoning as <think>\n...\n</think>\n\n — no manual isThinking needed
      let started = false;
      let ended = false;
      const userOnThinking = options.onThinkingDelta;
      const userOnDelta = options.onDelta;
      const userOnEvent = options.onEvent;
      if (userOnEvent) s.on("*", userOnEvent as any);
      if (userOnThinking || userOnDelta) {
        s.on("thinking_delta", (e: any) => {
          if (!started) {
            started = true;
            const tag = "<think>\n";
            if (userOnThinking) userOnThinking(tag, e);
            else if (userOnDelta) userOnDelta(tag, e as any);
          }
          if (userOnThinking) userOnThinking(e.thinkingDelta!, e);
          else if (userOnDelta) userOnDelta(e.thinkingDelta!, e as any);
        });
        s.on("text_delta", (e: any) => {
          if (started && !ended) {
            ended = true;
            const close = "\n</think>\n\n";
            if (userOnThinking) userOnThinking(close, e);
            else if (userOnDelta) userOnDelta(close, e as any);
          }
          if (userOnDelta) userOnDelta(e.delta!, e);
          else if (userOnThinking) userOnThinking(e.delta!, e as any);
        });
        s.on("done", () => {
          if (started && !ended) {
            ended = true;
            const close = "\n</think>\n\n";
            if (userOnThinking) userOnThinking(close, { type: "done" } as any);
            else if (userOnDelta) userOnDelta(close, { type: "done" } as any);
          }
        });
      } else {
        // No callbacks but wrapThinking true — still emit tags as events for manual iteration
        s.on("thinking_delta", (e: any) => {
          if (!started) { started = true; s.push({ type: "thinking_delta", thinkingDelta: "<think>\n" } as any); }
        });
        s.on("text_delta", (e: any) => {
          if (started && !ended) { ended = true; s.push({ type: "thinking_delta", thinkingDelta: "\n</think>\n\n" } as any); }
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

export function normalizeThinking(config: AgentConfig): ThinkingConfig | undefined {
  // DX4: only ThinkingLevel flag, values: none, dynamic, minimal, low, medium, high, xhigh
  const rawLevel = (config as any).ThinkingLevel ?? (config as any).thinkingLevel ?? (config as any).thinking_level;
  // Also support legacy raw?.level for internal migration but type only exposes ThinkingLevel
  const level = rawLevel as ThinkingLevel | undefined;

  if (!level) return undefined;
  if (level === "none") {
    return { enabled: false, level: "none", budgetTokens: 0 };
  }
  if (level === "dynamic") {
    return { enabled: true, level: "dynamic", budgetTokens: -1 };
  }
  return { enabled: true, level };
}
