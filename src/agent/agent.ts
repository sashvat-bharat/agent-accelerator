import type { AgentConfig, AgentRunOptions } from "../types/agent.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { ThinkingLevel, ThinkingConfig, CacheConfig, ServiceTier } from "../types/core.ts";
import type { ContentPart } from "../types/message.ts";
import { AgentResponse, type StreamEvent } from "../types/response.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentContext } from "./context.ts";
import { resolveModel } from "../ai-sdk/registry.ts";
import { buildAgentTools, createSubagentSpawnTool } from "./delegation.ts";
import { runAgentLoop, streamAgentLoop } from "./loop.ts";
import { createSessionId } from "../utils/session.ts";
import { getModel, getSubModel } from "../utils/env.ts";
import { validateModelThinking } from "../models/catalog.ts";
import { resolveEffectiveThinking } from "../ai-sdk/options.ts";

/** Thrown when dynamic sub-agent spawning is enabled without an explicit model. */
export class SubAgentModelError extends Error {
  readonly parentModel?: string;

  /**
   * Creates a configuration error with the missing sub-agent model and a
   * concrete fix for the parent model setup.
   *
   * @param parentModel The parent model that attempted to enable delegation.
   */
  constructor(parentModel?: string) {
    const parentName = parentModel || "your main model";
    const formatted =
      `\x1b[31m[Agent Accelerator] Missing Configuration: a sub-agent model is required when dynamic sub-agents are enabled\x1b[0m\n` +
      `  \x1b[1mMain Agent Model:\x1b[0m ${parentName}\n` +
      `  \x1b[1mIssue:\x1b[0m            Dynamic sub-agent delegation was enabled (dynamicSubagents.enabled), but no model was assigned for sub-agents.\n` +
      `                    Sub-agents must never run on unverified models or default implicitly.\n\n` +
      `  \x1b[36m💡 How to fix:\x1b[0m\n` +
      `    1. Pass a model in your Agent configuration:\n` +
      `       const agent = new Agent({\n` +
      `         model: "${parentName}",\n` +
      `         dynamicSubagents: { enabled: true, model: "provider/model-id" },\n` +
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

/**
 * Stateful, tool-capable LLM agent with unified provider routing.
 *
 * @example
 * ```ts
 * const agent = new Agent({
 *   model: "google/gemini-3.5-flash-lite",
 *   instructions: "Be concise and factual.",
 *   tools: { get_status },
 * });
 * const response = await agent.run("Check the status");
 * console.log(response.text);
 * ```
 */
export class Agent {
  /** Display name. */
  readonly name: string;
  /** Delegation/tool description. */
  readonly description: string;
  /** Stable system instructions. */
  instructions: string;
  /** Original model string or catalog spec used for resolution. */
  readonly modelStringOrSpec: string | any;
  /** Configured dynamic sub-agent model, if enabled. */
  readonly subagentModel?: string | any;
  /** Normalized dynamic sub-agent spawning policy. */
  readonly dynamicSubagents?: {
    enabled: boolean;
    model?: string | any;
    maxSpawn: number;
    thinkingLevel?: ThinkingLevel;
    tools: Record<string, ToolDefinition>;
    timeout: number;
  };
  /** Registered model-callable tools. */
  readonly tools: Record<string, ToolDefinition> = {};
  /** Normalized reasoning configuration. */
  readonly thinkingConfig?: ThinkingConfig;
  /** Cache retention/session settings. */
  readonly cacheConfig?: CacheConfig;
  /** Provider service tier. */
  readonly serviceTier?: ServiceTier;
  /** Maximum model/tool turns per run. */
  readonly maxTurns: number;
  /** Session ID used for history and cache affinity. */
  readonly sessionId: string;
  /** Explicit API key override. */
  readonly apiKey?: string;
  /** Explicit provider endpoint override. */
  readonly baseUrl?: string;
  /** Headers applied to requests. */
  readonly customHeaders?: Record<string, string>;
  /** Mutable conversation context. */
  readonly context: AgentContext;
  /** Whether history is cleared around each run. */
  readonly stateless: boolean;

  /**
   * Creates an agent and registers its model, tools, cache, and delegation settings.
   *
   * @param config Agent configuration. `model` may be a provider/model string,
   * a catalog spec, or a model-provider instance.
   *
   * @example
   * ```ts
   * const agent = new Agent({
   *   model: "google/gemini-3.5-flash-lite",
   *   instructions: "Be concise and factual.",
   *   thinkingLevel: "medium",
   *   tools: { get_status },
   * });
   *
   * const response = await agent.run("Check the status");
   * console.log(response.text);
   * ```
   */
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
    const dynRaw = config.dynamicSubagents;
    const dynModelRaw = (dynRaw as any)?.model ?? config.subagentModel;
    let dynModel: string | any | undefined;
    if (dynModelRaw && typeof dynModelRaw === "object" && "model" in dynModelRaw) {
      dynModel = (dynModelRaw as any).model;
    } else if (dynModelRaw && typeof dynModelRaw === "object" && "id" in dynModelRaw && "provider" in dynModelRaw) {
      dynModel = dynModelRaw;
    } else {
      dynModel = (dynModelRaw as any) || getSubModel();
    }
    this.subagentModel = dynModel;
    const dynEnabled = dynRaw ? (dynRaw.enabled ?? true) : false;
    if (dynRaw) {
      const rawTools = (dynRaw as any)?.tools;
      const dynTools: Record<string, ToolDefinition> = {};
      if (rawTools) {
        if (Array.isArray(rawTools)) {
          for (const t of rawTools) {
            const tName = (t as any)?.name || `tool_${Object.keys(dynTools).length}`;
            dynTools[tName] = { ...(t as any), name: tName };
          }
        } else {
          for (const [key, def] of Object.entries(rawTools as Record<string, ToolDefinition>)) {
            dynTools[key] = { ...(def as any), name: (def as any)?.name || key };
          }
        }
      }
      const rawMax = (dynRaw as any)?.maxSpawn;
      const maxSpawn = Number.isFinite(rawMax) ? Math.max(1, Math.floor(rawMax as number)) : 4;
      const rawTimeout = (dynRaw as any)?.timeout;
      const timeout = Number.isFinite(rawTimeout) ? Math.floor(rawTimeout as number) : 0;
      this.dynamicSubagents = {
        enabled: dynEnabled,
        model: dynModel,
        maxSpawn,
        thinkingLevel: (dynRaw as any)?.thinkingLevel,
        tools: dynTools,
        timeout,
      };
    }
    this.apiKey = (rawModel as any)?.apiKey || config.apiKey;
    this.baseUrl = (rawModel as any)?.baseUrl || config.baseUrl;
    this.customHeaders = config.headers;
    this.maxTurns = config.maxTurns ?? 10;
    this.sessionId = config.sessionId || config.cache?.sessionId || createSessionId();

    // DX4: single thinkingLevel flag — also inherit from ModelProviderInstance when omitted
    const mpThinking = (rawModel as any)?.thinkingLevel;
    this.thinkingConfig = normalizeThinking(config, mpThinking);

    // DX5: cache retention short|medium|long, undefined = no explicit
    this.cacheConfig = {
      sessionId: this.sessionId,
      ...(config.cache ?? {}),
    };
    // C11: wire explicit cachedContentId into context for Google explicit cache
    const initialCachedId = (this.cacheConfig as any)?.cachedContentId;

    this.serviceTier = config.serviceTier;
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


    if (Array.isArray(config.subagents)) {
      const subagentTools = buildAgentTools(config.subagents);
      for (const [toolName, toolDef] of Object.entries(subagentTools)) {
        this.tools[toolName] = toolDef;
      }
    }

    if (this.dynamicSubagents?.enabled === true) {
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
    let out = base;
    const isThinkingEnabled =
      this.thinkingConfig?.enabled !== false &&
      this.thinkingConfig?.level &&
      this.thinkingConfig?.level !== "none";
    if (isThinkingEnabled && !out.includes("[Reasoning Directive]")) {
      const guidance =
        "[Reasoning Directive]\n" +
        "1. Use internal reasoning strictly for private planning and step-by-step thinking.\n" +
        "2. Never attempt to execute tools or output final user deliverables inside reasoning.\n" +
        "3. Once your reasoning is complete, output your final response or function calls directly in the standard response output.";
      out = out ? `${out}\n\n${guidance}` : guidance;
    }
    if (this.dynamicSubagents?.enabled === true && !out.includes("[Dynamic Sub-Agents]")) {
      const dyn = this.dynamicSubagents;
      const toolNames = Object.keys(dyn.tools);
      const timeoutNote =
        dyn.timeout === -1
          ? "Timeout policy: set a per-sub-agent timeoutMs (ms) for each task; omit it for no limit."
          : dyn.timeout === 0
            ? "Timeout policy: workers run with no time limit."
            : `Timeout policy: every worker is limited to ${dyn.timeout}ms; per-task timeouts are ignored.`;
      const policy =
        "[Dynamic Sub-Agents]\n" +
        `1. You may spawn at most ${dyn.maxSpawn} sub-agent(s) per spawn_subagents call. Extra tasks beyond ${dyn.maxSpawn} are ignored.\n` +
        "2. Workers are stateless: each receives one task, returns its result, then shuts down. No conversation history is kept.\n" +
        "3. You cannot choose worker models or reasoning levels — they are fixed by the developer.\n" +
        (toolNames.length > 0
          ? `4. Worker-available tools: ${toolNames.join(", ")}. Grant each worker ONLY the tools its task needs via the per-task tools list; omit it for no tools.\n`
          : "4. No worker tools are available; omit the per-task tools list.\n") +
        `5. ${timeoutNote}`;
      out = out ? `${out}\n\n${policy}` : policy;
    }
    return out || undefined;
  }

  /** Clears conversation messages and provider thought signatures while keeping configuration. */
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

  /**
   * Runs one or more model/tool turns and resolves to a normalized AgentResponse.
   * @example `const response = await agent.run("Summarize this document");`
   */
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
        hybrid.cancel = s.cancel.bind(s);
        hybrid.onCancel = s.onCancel.bind(s);
        hybrid.isCancelled = s.isCancelled.bind(s);
        // also expose push/end/fail for compat, though not needed by caller
        return hybrid;
      }
      return s;
    }

    const resolved = resolveModel(this.modelStringOrSpec);
    const effectiveLevel = options?.thinkingLevel || this.thinkingConfig?.level;
    if (effectiveLevel) {
      validateModelThinking(resolved.provider.id, resolved.modelId, effectiveLevel);
    }
    this.prepareTurn(prompt, options);

    const providerOptions = {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      headers: { ...(this.customHeaders ?? {}), ...(options?.headers ?? {}) },
      thinking: resolveEffectiveThinking(this.thinkingConfig, options?.thinkingLevel),
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

  /**
   * Convenience API: non-streaming alias for run, or a text-delta async iterable when streaming.
   * @example `const response = await agent.ask("What is the answer?");`
   */
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
        cancel: () => stream.cancel(),
        onCancel: (fn: any) => stream.onCancel(fn),
        isCancelled: () => stream.isCancelled(),
      };
      // Make await work (resolves to AgentResponse)
      const resultPromise = stream.result();
      (stringStream as any).then = (res: any, rej: any) => resultPromise.then(res, rej);
      (stringStream as any).catch = (rej: any) => resultPromise.catch(rej);
      return stringStream;
    }

    return this.run(prompt, runOpts);
  }

  /**
   * Starts a stream of text, thinking, tool, sub-agent, usage, and completion events.
   * @example
   * ```ts
   * for await (const event of agent.stream("Explain this")) {
   *   if (event.type === "text_delta") process.stdout.write(event.delta ?? "");
   * }
   * ```
   */
  stream(
    prompt: string | ContentPart[],
    options?: AgentRunOptions
  ): AssistantMessageEventStream {
    const resolved = resolveModel(this.modelStringOrSpec);
    const effectiveLevel = options?.thinkingLevel || this.thinkingConfig?.level;
    if (effectiveLevel) {
      validateModelThinking(resolved.provider.id, resolved.modelId, effectiveLevel);
    }
    this.prepareTurn(prompt, options);

    const providerOptions = {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      headers: { ...(this.customHeaders ?? {}), ...(options?.headers ?? {}) },
      thinking: resolveEffectiveThinking(this.thinkingConfig, options?.thinkingLevel),
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

/** Normalizes the public `thinkingLevel` flag into provider-neutral thinking settings. */
export function normalizeThinking(config: AgentConfig, fallbackLevel?: string): ThinkingConfig | undefined {
  // DX4: only thinkingLevel, values: none, dynamic, minimal, low, medium, high, xhigh
  const rawLevel = config.thinkingLevel ?? fallbackLevel;
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
