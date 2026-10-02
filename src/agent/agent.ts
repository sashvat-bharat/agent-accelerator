import type { AgentConfig, AgentRunOptions, MidSessionConfig } from "../types/agent.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { ThinkingLevel, ThinkingConfig, CacheConfig, ServiceTier } from "../types/core.ts";
import type { ContentPart } from "../types/message.ts";
import { AgentResponse, type StreamEvent } from "../types/response.ts";
import { AssistantMessageEventStream } from "../streaming/event-stream.ts";
import { AgentContext } from "./context.ts";
import { resolveModel } from "../providers/registry.ts";
import { buildAgentTools, createSubagentSpawnTool } from "./delegation.ts";
import { convert_document_to_markdown } from "../utils/documents.ts";
import { runAgentLoop, streamAgentLoop, type SteerEntry } from "./loop.ts";
import { createSessionId } from "../utils/session.ts";
import { getSubAgentTrace, subscribeToSubAgent, listSubAgentTraceIds, type SubAgentTrace } from "./delegation.ts";
import { saveSessionDir, saveSessionFile } from "../session/store.ts";
import { getModel, getSubModel } from "../utils/env.ts";
import { validateModelThinking, ensureModelCatalogFresh } from "../models/catalog.ts";
import { buildSessionData, type PersistedAgentSession, type SessionTotals,} from "../session/store.ts";
import { SessionTelemetry } from "../session/store.ts";

/**
 * Resolves a per-run thinking override without mutating agent config.
 */
export function resolveEffectiveThinking(
  base?: ThinkingConfig,
  overrideLevel?: string
): ThinkingConfig | undefined {
  if (!overrideLevel) return base;
  if (overrideLevel === "none") return { enabled: false, level: "none", budgetTokens: 0 };
  if (overrideLevel === "dynamic") return { enabled: true, level: "dynamic", budgetTokens: -1 };
  return { enabled: true, level: overrideLevel as ThinkingConfig["level"] };
}

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
  /** Convert `file` parts client-side for pdf-incapable models. */
  readonly bypassInputFileModality: boolean;
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
  /** Durable persistence target: session file rewritten after every step. */
  readonly persistConfig?: { dir?: string; file?: string };
  /** Mid-session queue policy for new queries arriving while a run is active. */
  readonly midSessionConfig: Required<Pick<MidSessionConfig, "mode">> & MidSessionConfig;
  private currentRun: {
    steerInbox: SteerEntry[];
    outerStream?: AssistantMessageEventStream;
    runPromise?: Promise<AgentResponse>;
    abortController: AbortController;
  } | null = null;
  private pendingQueue: Array<{
    prompt: string | ContentPart[];
    options?: AgentRunOptions;
    isStream: boolean;
    deferredStream?: AssistantMessageEventStream;
    resolve: (res: AgentResponse) => void;
    reject: (err: unknown) => void;
  }> = [];

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
    this.maxTurns =
      config.maxTurns === undefined || config.maxTurns === 0 || config.maxTurns === Infinity
        ? Infinity
        : Number.isFinite(config.maxTurns as number)
          ? Math.max(1, Math.floor(config.maxTurns as number))
          : Infinity;
    this.sessionId = config.sessionId || config.cache?.sessionId || createSessionId();
    (this as any).subagentTraces = {};
    this.persistConfig = config.persist;
    const rawMode = config.midSession?.mode ?? "auto";
    const normalizedMode = rawMode === "steer" || rawMode === "queue" ? rawMode : "auto";
    const rawMaxQueued = (config.midSession as any)?.maxQueued;
    this.midSessionConfig = {
      mode: normalizedMode,
      ...(Number.isFinite(rawMaxQueued) && (rawMaxQueued as number) >= 0
        ? { maxQueued: Math.floor(rawMaxQueued as number) }
        : { maxQueued: 20 }),
    };

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
    this.bypassInputFileModality = config.bypassInputFileModality ?? false;
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

    if (this.bypassInputFileModality && !this.tools["convert_document_to_markdown"]) {
      this.tools["convert_document_to_markdown"] = convert_document_to_markdown;
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

  /**
   * True while a `run()`/`stream()` turn is active on this agent.
   * Use with `steer()` (current-turn redirect) vs `queue()` (next-turn follow-up).
   */
  get isBusy(): boolean {
    return this.currentRun !== null;
  }

  /** Number of queued follow-up requests waiting for the active run to finish. */
  get pendingCount(): number {
    return this.pendingQueue.length;
  }

  /** Number of steer messages buffered for injection into the active turn. */
  get steerPendingCount(): number {
    return this.currentRun?.steerInbox.length ?? 0;
  }

  /** Effective mid-session policy (`steer` | `queue` | `auto`). */
  get midSessionMode(): "steer" | "queue" | "auto" {
    return this.midSessionConfig.mode;
  }

  private resolveEnqueueMode(requested?: "steer" | "queue"): "steer" | "queue" {
    const enforced = this.midSessionConfig.mode;
    if (enforced === "steer" || enforced === "queue") return enforced;
    return requested === "steer" ? "steer" : "queue";
  }

  private assertPromptValid(prompt: string | ContentPart[]): void {
    if (Array.isArray(prompt) && prompt.length === 0) {
      throw new Error(
        "[Agent Accelerator] Prompt cannot be empty: pass a non-empty string or at least one content part."
      );
    }
  }

  private previewPrompt(prompt: string | ContentPart[]): string {
    if (typeof prompt === "string") return prompt.slice(0, 500);
    try {
      const texts = prompt
        .filter((p) => (p as { type?: unknown }).type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("\n");
      return (texts || "[multipart]").slice(0, 500);
    } catch {
      return "[multipart]";
    }
  }

  /**
   * Interrupts the active run immediately (STOP. Do this instead).
   * Cancels the active stream and aborts provider/tool/sub-agent work via
   * the run's internal `AbortController`. No-op when idle. The interrupted
   * run rejects with `AbortError`; queued follow-ups still run afterwards.
   */
  interrupt(reason?: unknown): void {
    const active = this.currentRun;
    if (!active) return;
    try {
      active.abortController.abort(reason instanceof Error ? reason : new Error("Agent interrupted"));
    } catch {}
    try {
      active.outerStream?.cancel(reason);
    } catch {}
  }

  /**
   * Steers the active turn (While you're doing that, change direction).
   * The current provider/tool work finishes first, then `prompt` is injected
   * as a user message into the SAME run — same `AgentResponse`, same
   * `maxTurns` budget. Resolves to the active run's final response.
   * When idle, behaves like `run(prompt, options)`.
   * Throws when the developer enforces `midSession: { mode: "queue" }`.
   * Note: `options` only honors `additionalContext` mid-turn (thinking level,
   * session, and streaming callbacks stay with the active run). For a
   * streaming follow-up use `stream(prompt, { enqueue: "steer" })`.
   */
  steer(prompt: string | ContentPart[], options?: AgentRunOptions): Promise<AgentResponse> {
    this.assertPromptValid(prompt);
    if (options?.stream === true) {
      throw new Error(
        '[Agent Accelerator] steer() is non-streaming. Use stream(prompt, { enqueue: "steer" }) for a streaming steer.'
      );
    }
    if (this.midSessionConfig.mode === "queue") {
      throw new Error(
        '[Agent Accelerator] steer() is disabled by midSession.mode "queue". Use queue() or set mode to "auto"/"steer".'
      );
    }
    const active = this.currentRun;
    if (!active) return this.run(prompt, options) as Promise<AgentResponse>;
    active.steerInbox.push({ prompt, options });
    this.persistNow();
    if (active.runPromise) return active.runPromise;
    if (active.outerStream) return active.outerStream.result();
    return this.run(prompt, options) as Promise<AgentResponse>;
  }

  /**
   * Queues a follow-up for the next turn (When you're done, do this next).
   * The active run finishes completely first; this prompt then starts a new
   * run with its own turn budget and `AgentResponse`. Resolves to that next
   * turn's response. When idle, behaves like `run(prompt, options)`.
   * Throws when the developer enforces `midSession: { mode: "steer" }` or
   * when `maxQueued` is exceeded. For a streaming follow-up use
   * `stream(prompt, { enqueue: "queue" })`.
   */
  queue(prompt: string | ContentPart[], options?: AgentRunOptions): Promise<AgentResponse> {
    this.assertPromptValid(prompt);
    if (options?.stream === true) {
      throw new Error(
        '[Agent Accelerator] queue() is non-streaming. Use stream(prompt, { enqueue: "queue" }) for a streaming follow-up.'
      );
    }
    if (this.midSessionConfig.mode === "steer") {
      throw new Error(
        '[Agent Accelerator] queue() is disabled by midSession.mode "steer". Use steer() or set mode to "auto"/"queue".'
      );
    }
    if (!this.currentRun) return this.run(prompt, options) as Promise<AgentResponse>;
    const max = this.midSessionConfig.maxQueued ?? 20;
    if (this.pendingQueue.length >= max) {
      throw new Error(
        `[Agent Accelerator] Queue is full (${this.pendingQueue.length}/${max}). Wait for the active run to finish or increase midSession.maxQueued.`
      );
    }
    return new Promise<AgentResponse>((resolve, reject) => {
      this.pendingQueue.push({ prompt, options, isStream: false, resolve, reject });
      try {
        this.currentRun?.outerStream?.push({
          type: "queued",
          queuedPrompt: this.previewPrompt(prompt),
          queueLength: this.pendingQueue.length,
        } as any);
      } catch {}
    });
  }

  private pumpQueue(): void {
    if (this.currentRun !== null) return;
    const next = this.pendingQueue.shift();
    if (!next) return;
    if (next.isStream && next.deferredStream) {
      const deferred = next.deferredStream;
      try {
        const real = this.startStreamingRun(next.prompt, next.options);
        try { (deferred as any).__piped = true; } catch {}
        const forward = (e: StreamEvent) => {
          try { deferred.push(e); } catch {}
        };
        real.on("*", forward as any);
        try {
          deferred.onCancel(() => {
            try { real.cancel(); } catch {}
          });
        } catch {}
        real.result().then(
          (res) => {
            try { next.resolve(res); } catch {}
            try { deferred.end(res); } catch {}
          },
          (err) => {
            try { next.reject(err); } catch {}
            // Pipe failures into the deferred stream so for-await sees them.
            try { deferred.fail(err instanceof Error ? err : new Error(String(err))); } catch {}
          }
        );
      } catch (err) {
        try { next.reject(err); } catch {}
        try { deferred.fail(err instanceof Error ? err : new Error(String(err))); } catch {}
        // Keep draining even if starting failed.
        queueMicrotask(() => this.pumpQueue());
      }
      return;
    }
    this.startNonStreamingRun(next.prompt, next.options).then(next.resolve, next.reject);
  }

  private finishCurrentRun(): void {
    this.currentRun = null;
    // Defer pump so the completing run's .then handlers settle first.
    queueMicrotask(() => this.pumpQueue());
  }

  private mergeUserSignal(userSignal?: AbortSignal, runController?: AbortController): AbortSignal | undefined {
    if (!runController) return userSignal;
    if (!userSignal) return runController.signal;
    if (userSignal.aborted) {
      try {
        runController.abort((userSignal as any).reason);
      } catch {
        try { runController.abort(); } catch {}
      }
      return runController.signal;
    }
    const forward = () => {
      try {
        runController.abort((userSignal as any).reason);
      } catch {
        try { runController.abort(); } catch {}
      }
    };
    userSignal.addEventListener("abort", forward, { once: true });
    // Detached on run completion via runController abort listener cleanup below.
    // Store for removal: piggyback on abort event (once) + explicit removal in finally.
    (runController as any).__forwardUserAbort = forward;
    (runController as any).__userSignal = userSignal;
    return runController.signal;
  }

  private startNonStreamingRun(
    prompt: string | ContentPart[],
    options?: AgentRunOptions
  ): Promise<AgentResponse> {
    const runController = new AbortController();
    const steerInbox: SteerEntry[] = [];
    const mergedSignal = this.mergeUserSignal(options?.signal, runController);
    const runOptions = { ...options, signal: mergedSignal };
    const task = (async (): Promise<AgentResponse> => {
      await ensureModelCatalogFresh();
      const resolved = resolveModel(this.modelStringOrSpec);
      const effectiveLevel = runOptions?.thinkingLevel || this.thinkingConfig?.level;
      if (effectiveLevel) {
        validateModelThinking(resolved.provider.id, resolved.modelId, effectiveLevel);
      }
      this.prepareTurn(prompt, runOptions);
      this.persistNow();

      const providerOptions = {
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        headers: { ...(this.customHeaders ?? {}), ...(runOptions?.headers ?? {}) },
        thinking: resolveEffectiveThinking(this.thinkingConfig, runOptions?.thinkingLevel),
        cache: this.stateless
          ? { sessionId: runOptions?.sessionId || this.sessionId }
          : { ...this.cacheConfig, sessionId: runOptions?.sessionId || this.sessionId },
        serviceTier: this.serviceTier,
        sessionId: runOptions?.sessionId || this.sessionId,
      };

      const loopConfig = {
        agentName: this.name,
        provider: resolved.provider,
        modelId: resolved.modelId,
        context: this.context,
        tools: this.tools,
        options: providerOptions,
        runOptions,
        maxTurns: this.maxTurns,
        bypassInputFileModality: this.bypassInputFileModality,
        onProgress: () => this.persistNow(),
        steerInbox,
        onSteerInjected: () => this.persistNow(),
      };

      const res = await runAgentLoop(loopConfig);
      this.mergeSubagentTraces(res.subagents as any);
      this.persistNow();
      if (this.stateless) {
        this.context.messages = [];
        this.context.thoughtSignatures = [];
      }
      return res;
    })();

    this.currentRun = { steerInbox, abortController: runController, runPromise: task };
    const cleanup = () => {
      try {
        const userSignal = (runController as any).__userSignal as AbortSignal | undefined;
        const forward = (runController as any).__forwardUserAbort as (() => void) | undefined;
        if (userSignal && forward) userSignal.removeEventListener("abort", forward);
      } catch {}
      if (this.currentRun?.runPromise === task) this.finishCurrentRun();
    };
    task.then(cleanup, cleanup);
    return task;
  }

  private startStreamingRun(
    prompt: string | ContentPart[],
    options?: AgentRunOptions
  ): AssistantMessageEventStream {
    const resolved = resolveModel(this.modelStringOrSpec);
    const effectiveLevel = options?.thinkingLevel || this.thinkingConfig?.level;
    if (effectiveLevel) {
      validateModelThinking(resolved.provider.id, resolved.modelId, effectiveLevel);
    }
    this.prepareTurn(prompt, options);
    this.persistNow();

    const runController = new AbortController();
    const mergedSignal = this.mergeUserSignal(options?.signal, runController);
    const runOptions = { ...options, signal: mergedSignal };
    const steerInbox: SteerEntry[] = [];

    const providerOptions = {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      headers: { ...(this.customHeaders ?? {}), ...(runOptions?.headers ?? {}) },
      thinking: resolveEffectiveThinking(this.thinkingConfig, runOptions?.thinkingLevel),
      cache: this.stateless
        ? { sessionId: runOptions?.sessionId || this.sessionId }
        : { ...this.cacheConfig, sessionId: runOptions?.sessionId || this.sessionId },
      serviceTier: this.serviceTier,
      sessionId: runOptions?.sessionId || this.sessionId,
    };

    const loopConfig = {
      agentName: this.name,
      provider: resolved.provider,
      modelId: resolved.modelId,
      context: this.context,
      tools: this.tools,
      options: providerOptions,
      runOptions,
      maxTurns: this.maxTurns,
      bypassInputFileModality: this.bypassInputFileModality,
      onProgress: () => this.persistNow(),
      steerInbox,
      onSteerInjected: () => this.persistNow(),
    };

    const s = streamAgentLoop(loopConfig);
    this.currentRun = { steerInbox, outerStream: s, abortController: runController };
    s.result().then(
      (res) => {
        try {
          this.mergeSubagentTraces(res.subagents as any);
          this.persistNow();
        } catch {}
        try {
          const userSignal = (runController as any).__userSignal as AbortSignal | undefined;
          const forward = (runController as any).__forwardUserAbort as (() => void) | undefined;
          if (userSignal && forward) userSignal.removeEventListener("abort", forward);
        } catch {}
        if (this.stateless) {
          this.context.messages = [];
          this.context.thoughtSignatures = [];
        }
        if (this.currentRun?.outerStream === s) this.finishCurrentRun();
      },
      () => {
        try {
          const userSignal = (runController as any).__userSignal as AbortSignal | undefined;
          const forward = (runController as any).__forwardUserAbort as (() => void) | undefined;
          if (userSignal && forward) userSignal.removeEventListener("abort", forward);
        } catch {}
        if (this.currentRun?.outerStream === s) this.finishCurrentRun();
      }
    );
    return s;
  }

  /**
   * Returns a snapshot of one sub-agent worker's trace by tracking id
   * (`SUBAGENT-NAME-{32hex}` or the raw 32-hex suffix). Sees live running
   * state: steps appear as the worker acts, not just after it finishes.
   *
   * @example `const trace = agent.track("RAM-RESEARCH-AGENT-9f2c…");`
   */
  track(trackingId: string): SubAgentTrace | undefined {
    if (!trackingId) return undefined;
    try {
      const own = (this as any).subagentTraces as Record<string, SubAgentTrace> | undefined;
      const hit = own?.[trackingId];
      if (hit) return { ...hit, steps: hit.steps.map((s) => ({ ...s })) };
    } catch {}
    return getSubAgentTrace(trackingId);
  }

  /** Lists TrackingIDs of worker traces visible to this agent (deduped). */
  listTrackedSubAgents(): string[] {
    const rawOf = (id: string): string => {
      const tail = id.split("-").pop() ?? "";
      return /^[0-9a-f]{32}$/.test(tail) ? tail : id;
    };
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [...Object.keys((this as any).subagentTraces ?? {}), ...listSubAgentTraceIds()]) {
      const raw = rawOf(id);
      if (!seen.has(raw)) {
        seen.add(raw);
        out.push(raw);
      }
    }
    return out;
  }

  /**
   * Subscribes to live updates of one worker trace. The callback fires on
   * every logged step; returns an unsubscribe fn.
   *
   * @example `const off = agent.subscribeToSubAgent(id, (t) => render(t));`
   */
  subscribeToSubAgent(trackingId: string, fn: (trace: SubAgentTrace) => void): () => void {
    return subscribeToSubAgent(trackingId, fn);
  }

  /**
   * Rewrites the configured session file now (when `persist` is set).
   * Called automatically after every step during runs; safe to call
   * manually. Never throws.
   */
  persistNow(): void {
    const cfg = this.persistConfig;
    if (!cfg || (!cfg.dir && !cfg.file)) return;
    try {
      if (cfg.dir) saveSessionDir(cfg.dir, this as any, null);
      else if (cfg.file) saveSessionFile(cfg.file, this as any, null);
    } catch {}
  }

  /** Merges completed worker metadata (incl. steps) into this agent's trace registry. */
  private mergeSubagentTraces(subagents: Array<{ trackingId?: string; name: string; sessionId?: string; parentSessionId?: string; task: string; steps?: SubAgentTrace["steps"]; [k: string]: unknown }>): void {
    if (!subagents || subagents.length === 0) return;
    const rawOf = (id?: string): string | undefined => {
      if (!id) return undefined;
      const tail = id.split("-").pop() ?? "";
      return /^[0-9a-f]{32}$/.test(tail) ? tail : id;
    };
    try {
      const registry = ((this as any).subagentTraces ??= {}) as Record<string, SubAgentTrace>;
      for (const s of subagents) {
        const raw = rawOf(s.trackingId);
        const key = raw || s.name;
        const existing = registry[key] ?? (raw ? registry[s.trackingId ?? ""] : undefined);
        if (existing) {
          existing.status = "done";
          if (s.steps && s.steps.length > 0 && existing.steps.length === 0) {
            existing.steps = s.steps.map((x) => ({ ...x }));
          }
          if (raw && !registry[raw]) registry[raw] = existing;
        } else if (raw) {
          registry[raw] = {
            trackingId: raw,
            name: s.name,
            sessionId: s.sessionId || "",
            parentSessionId: s.parentSessionId || this.sessionId,
            status: "done",
            task: s.task,
            turns: 0,
            steps: (s.steps ?? []).map((x) => ({ ...x })),
          };
        }
      }
    } catch {}
  }

  /**
   * Exports this agent's conversation + config as a storable session snapshot.
   * Pair with `importSession` / `loadSessionFile` / `saveSessionFile`.
   *
   * @example `saveSessionFile(".session.json", agent, telemetry)`
   */
  exportSession(telemetry?: SessionTelemetry | SessionTotals | null): PersistedAgentSession {
    return buildSessionData(this as any, telemetry);
  }

  /**
   * Restores conversation + config from `exportSession` / `loadSessionFile`.
   * Restores messages, system prompt, cached content id, sub-agent traces,
   * and (when present) session id, model, thinking level, instructions,
   * cache, and worker model. No-ops on nullish input.
   *
   * @example `const saved = loadSessionFile(".session.json"); if (saved) agent.importSession(saved);`
   */
  importSession(data?: PersistedAgentSession | null): void {
    if (!data) return;
    if (data.sessionId) (this as any).sessionId = data.sessionId;
    if ((data as any).parentSessionId) (this as any).parentSessionId = (data as any).parentSessionId;
    if ((data as any).subagents && typeof (data as any).subagents === "object") {
      try {
        (this as any).subagentTraces = JSON.parse(JSON.stringify((data as any).subagents));
      } catch {
        (this as any).subagentTraces = { ...((data as any).subagents as object) };
      }
    }
    if (data.model) (this as any).modelStringOrSpec = data.model;
    if (data.thinkingLevel) {
      const lvl = String(data.thinkingLevel);
      (this as any).thinkingConfig =
        lvl === "none"
          ? { enabled: false, level: "none", budgetTokens: 0 }
          : lvl === "dynamic"
            ? { enabled: true, level: "dynamic", budgetTokens: -1 }
            : { enabled: true, level: lvl };
    }
    if (typeof data.instructions === "string") this.instructions = data.instructions;
    if (data.cache) {
      (this as any).cacheConfig = {
        ...this.cacheConfig,
        ...data.cache,
        sessionId: data.sessionId ?? this.sessionId,
      };
    }
    if (data.subagentModel) {
      (this as any).subagentModel = data.subagentModel;
      const dyn = (this as any).dynamicSubagents;
      if (dyn) dyn.model = data.subagentModel;
    }
    try {
      const g: any = globalThis as any;
      this.context.messages = Array.isArray(data.messages)
        ? (typeof g.structuredClone === "function"
            ? g.structuredClone(data.messages)
            : JSON.parse(JSON.stringify(data.messages)))
        : [];
    } catch {
      this.context.messages = Array.isArray(data.messages) ? [...data.messages] : [];
    }
    this.context.thoughtSignatures = [];
    if (data.systemPrompt) {
      this.context.systemPrompt = data.systemPrompt;
    } else {
      this.context.systemPrompt = this.getFullInstructions();
    }
    this.context.cachedContentId =
      data.cachedContentId ?? (this.cacheConfig as any)?.cachedContentId;
  }

  private prepareTurn(prompt: string | ContentPart[], options?: AgentRunOptions): void {
    if (Array.isArray(prompt) && prompt.length === 0) {
      throw new Error(
        "[Agent Accelerator] Prompt cannot be empty: pass a non-empty string or at least one content part."
      );
    }
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
    options: AgentRunOptions & { stream: true } & (
      | { onDelta: NonNullable<AgentRunOptions["onDelta"]> }
      | { onThinkingDelta: NonNullable<AgentRunOptions["onThinkingDelta"]> }
      | { onEvent: NonNullable<AgentRunOptions["onEvent"]> }
    )
  ): Promise<AgentResponse> & AsyncIterable<StreamEvent>;
  run(
    prompt: string | ContentPart[],
    options: AgentRunOptions & { stream: true }
  ): AssistantMessageEventStream;
  run(
    prompt: string | ContentPart[],
    options?: AgentRunOptions
  ): Promise<AgentResponse>;
  run(
    prompt: string | ContentPart[],
    options?: AgentRunOptions
  ): Promise<AgentResponse> | AssistantMessageEventStream {
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

    // Mid-session: busy agent serializes via steer (same turn) or queue (next turn).
    if (this.currentRun) {
      const enforced = this.midSessionConfig.mode;
      const requested = options?.enqueue;
      if (requested && (enforced === "steer" || enforced === "queue") && requested !== enforced) {
        throw new Error(
          `[Agent Accelerator] enqueue "${requested}" is disabled by midSession.mode "${enforced}". Use ${enforced}() or set mode to "auto"/"${requested}".`
        );
      }
      const mode = this.resolveEnqueueMode(requested);
      if (mode === "steer") {
        this.assertPromptValid(prompt);
        this.currentRun.steerInbox.push({ prompt, options });
        this.persistNow();
        const active = this.currentRun;
        if (active.runPromise) return active.runPromise;
        if (active.outerStream) return active.outerStream.result();
      } else {
        if (this.midSessionConfig.mode === "steer") {
          throw new Error(
            '[Agent Accelerator] enqueue "queue" is disabled by midSession.mode "steer". Use steer() or set mode to "auto"/"queue".'
          );
        }
        this.assertPromptValid(prompt);
        const max = this.midSessionConfig.maxQueued ?? 20;
        if (this.pendingQueue.length >= max) {
          throw new Error(
            `[Agent Accelerator] Queue is full (${this.pendingQueue.length}/${max}). Wait for the active run to finish or increase midSession.maxQueued.`
          );
        }
        return new Promise<AgentResponse>((resolve, reject) => {
          this.pendingQueue.push({ prompt, options, isStream: false, resolve, reject });
          try {
            this.currentRun?.outerStream?.push({
              type: "queued",
              queuedPrompt: this.previewPrompt(prompt),
              queueLength: this.pendingQueue.length,
            } as any);
          } catch {}
        });
      }
    }

    return this.startNonStreamingRun(prompt, options);
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
          try {
            for await (const chunk of stream) {
              if (chunk.type === "text_delta" && chunk.delta) {
                yield chunk.delta;
              }
            }
          } finally {
            // Breaking out early must stop the underlying provider stream
            // instead of leaving the HTTP connection running in the background.
            stream.cancel();
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

    return this.run(prompt, runOpts) as any;
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
    // Mid-session: busy agent serializes via steer (same turn) or queue (next turn).
    if (this.currentRun) {
      const enforcedStream = this.midSessionConfig.mode;
      const requestedStream = options?.enqueue;
      if (requestedStream && (enforcedStream === "steer" || enforcedStream === "queue") && requestedStream !== enforcedStream) {
        throw new Error(
          `[Agent Accelerator] enqueue "${requestedStream}" is disabled by midSession.mode "${enforcedStream}". Use ${enforcedStream}() or set mode to "auto"/"${requestedStream}".`
        );
      }
      const mode = this.resolveEnqueueMode(requestedStream);
      if (mode === "steer") {
        this.assertPromptValid(prompt);
        this.currentRun.steerInbox.push({ prompt, options });
        this.persistNow();
        const activeStream = this.currentRun.outerStream;
        if (activeStream) {
          this.wireStreamCallbacks(activeStream, options);
          return activeStream;
        }
        // Active run is non-streaming: attach a lightweight stream that ends
        // with the same final response so streaming callers still get events.
        const stub = new AssistantMessageEventStream();
        this.wireStreamCallbacks(stub, options);
        const activePromise = this.currentRun.runPromise;
        if (activePromise) {
          activePromise.then(
            (res) => {
              try {
                stub.push({ type: "done", delta: "", usage: res.usage, finishReason: res.finishReason, responseId: res.responseId } as any);
              } catch {}
              try { stub.end(res); } catch {}
            },
            (err) => {
              try { stub.fail(err instanceof Error ? err : new Error(String(err))); } catch {}
            }
          );
        } else {
          try { stub.fail(new Error("[Agent Accelerator] No active run to steer.")); } catch {}
        }
        return stub;
      }
      if (this.midSessionConfig.mode === "steer") {
        throw new Error(
          '[Agent Accelerator] enqueue "queue" is disabled by midSession.mode "steer". Use steer() or set mode to "auto"/"queue".'
        );
      }
      this.assertPromptValid(prompt);
      const max = this.midSessionConfig.maxQueued ?? 20;
      if (this.pendingQueue.length >= max) {
        throw new Error(
          `[Agent Accelerator] Queue is full (${this.pendingQueue.length}/${max}). Wait for the active run to finish or increase midSession.maxQueued.`
        );
      }
      const deferred = new AssistantMessageEventStream();
      this.wireStreamCallbacks(deferred, options);
      // Notify the active stream (if any) that a follow-up was queued.
      try {
        this.currentRun.outerStream?.push({
          type: "queued",
          queuedPrompt: this.previewPrompt(prompt),
          queueLength: this.pendingQueue.length + 1,
        } as any);
      } catch {}
      const queuedEntry: {
        prompt: string | ContentPart[];
        options?: AgentRunOptions;
        isStream: boolean;
        deferredStream?: AssistantMessageEventStream;
        resolve: (res: AgentResponse) => void;
        reject: (err: unknown) => void;
      } = {
        prompt,
        options,
        isStream: true,
        deferredStream: deferred,
        resolve: () => {},
        reject: () => {},
      };
      const done = new Promise<AgentResponse>((resolve, reject) => {
        queuedEntry.resolve = resolve;
        queuedEntry.reject = reject;
      });
      // Keep result() in sync: deferred ends when the queued turn completes.
      done.then(
        () => {},
        () => {}
      );
      // Forward cancellation before start: drop from queue and fail.
      deferred.onCancel(() => {
        try {
          const idx = this.pendingQueue.indexOf(queuedEntry as any);
          if (idx >= 0) {
            this.pendingQueue.splice(idx, 1);
            queuedEntry.reject(Object.assign(new Error("Stream aborted"), { name: "AbortError" }));
            try { deferred.fail(Object.assign(new Error("Stream aborted"), { name: "AbortError" })); } catch {}
          }
        } catch {}
      });
      this.pendingQueue.push(queuedEntry as any);
      // Attach deferred completion to queued promise without exposing it.
      // Real events are piped in pumpQueue() when the turn starts.
      void done.then(
        (res) => {
          // If pump already piped via real stream, deferred is already ended.
          // Otherwise (edge), end it here.
          try {
            if ((deferred as any).__piped !== true) {
              deferred.push({ type: "done", delta: "", usage: res.usage, finishReason: res.finishReason, responseId: res.responseId } as any);
              deferred.end(res);
            }
          } catch {}
        },
        (err) => {
          try {
            if ((deferred as any).__piped !== true) {
              deferred.fail(err instanceof Error ? err : new Error(String(err)));
            }
          } catch {}
        }
      );
      return deferred;
    }

    const s = this.startStreamingRun(prompt, options);
    this.wireStreamCallbacks(s, options);
    return s;
  }

  private wireStreamCallbacks(
    s: AssistantMessageEventStream,
    options?: AgentRunOptions
  ): void {
    // Wire one-liner callbacks so `stream:true` + onDelta is enough — no manual for-await needed
    if (options?.wrapThinking) {
      // Auto-wrap reasoning as <think>…</think> per-turn — clean boundaries across multi-turn agent runs.
      //
      // Display-only whitespace hygiene (cache-safe): provider thought
      // summaries routinely carry edge blank lines (observed `"...\n\n\n"`),
      // and the wrapper itself adds newlines around the span. Without care
      // this renders as blank lines after `<think>`, double blanks between
      // sections, and a stray blank line before `</think>`. The buffering
      // below touches ONLY the presented strings/callback args and synthetic
      // tag events — never provider accumulation, AgentContext history, or
      // request bodies — so prefix-cache affinity is untouched.
      //
      // Trailing-newline buffering: each chunk's trailing `\n` run is
      // withheld and prepended to the next chunk (or dropped at close), so
      // emitted display text never ends with `\n` and `</think>` never gets
      // a preceding blank line. Interior breaks are preserved (collapsed to
      // a single blank line at most).
      let isThinking = false;
      let emittedAny = false;
      let pendingNewlines = "";
      // True once text has been emitted without a trailing newline: the next
      // <think> open tag then needs its own leading newline, otherwise it
      // glues onto the streamed text mid-line. False at stream start and
      // after every tag (both end with newlines), preserving the exact
      // "<think>\n...\n</think>\n\n" contract for thinking-first streams.
      let needThinkNewline = false;
      const collapseBlankLines = (s: string): string => s.replace(/\n{3,}/g, "\n\n");
      const userOnThinking = options.onThinkingDelta;
      const userOnDelta = options.onDelta;
      const userOnEvent = options.onEvent;
      if (userOnEvent) s.on("*", userOnEvent as any);

      const openThink = (e?: any) => {
        if (!isThinking) {
          isThinking = true;
          emittedAny = false;
          pendingNewlines = "";
          const tag = (needThinkNewline ? "\n" : "") + "<think>\n";
          needThinkNewline = false;
          if (userOnThinking) userOnThinking(tag, e);
          else if (userOnDelta) userOnDelta(tag, e as any);
        }
      };

      const closeThink = (e?: any) => {
        if (isThinking) {
          isThinking = false;
          // Drop any withheld trailing newlines: the span ends cleanly and
          // the tag supplies its own line breaks. Empty spans still close.
          pendingNewlines = "";
          const close = emittedAny ? "\n</think>\n\n" : "</think>\n\n";
          emittedAny = false;
          if (userOnThinking) userOnThinking(close, e);
          else if (userOnDelta) userOnDelta(close, e as any);
        }
      };

      /** Buffers one raw thinking chunk, returning the display string to
       * emit now (`""` when nothing displayable yet). Mutates the event in
       * place so manual `for-await` consumers see the same clean text; safe
       * because loop context derives from the provider result, not these
       * outer events. */
      const bufferThinkingEvent = (e: any): string => {
        const raw: string = e.thinkingDelta ?? "";
        let chunk = collapseBlankLines(pendingNewlines + raw);
        pendingNewlines = "";
        if (!emittedAny) {
          chunk = chunk.replace(/^\n+/, "");
        }
        if (!chunk) return "";
        const m = chunk.match(/\n+$/);
        if (m) {
          pendingNewlines = m[0];
          chunk = chunk.slice(0, -m[0].length);
          if (!chunk) return "";
        }
        emittedAny = true;
        e.thinkingDelta = chunk;
        if (typeof e.partialThinking === "string") {
          e.partialThinking = collapseBlankLines(e.partialThinking);
        }
        return chunk;
      };

      if (userOnThinking || userOnDelta) {
        s.on("thinking_delta", (e: any) => {
          openThink(e);
          const chunk = bufferThinkingEvent(e);
          if (!chunk) return;
          if (userOnThinking) userOnThinking(chunk, e);
          else if (userOnDelta) userOnDelta(chunk, e as any);
        });
        s.on("text_delta", (e: any) => {
          closeThink(e);
          needThinkNewline = !((e.delta ?? "").endsWith("\n"));
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
        // No callbacks but wrapThinking true — still emit tags as events for manual iteration.
        // Same display hygiene as above (in-place event normalization is safe:
        // loop context derives from the provider result, not outer events).
        const closeSynthetic = () => {
          if (isThinking) {
            isThinking = false;
            pendingNewlines = "";
            const tag = emittedAny ? "\n</think>\n\n" : "</think>\n\n";
            emittedAny = false;
            s.push({ type: "thinking_delta", thinkingDelta: tag, __synthetic: true } as any);
          }
        };
        s.on("thinking_delta", (e: any) => {
          // Ignore our own synthetic tags: push() redelivers events to
          // listeners synchronously, so without this guard the handler
          // re-enters on every tag it emits (duplicate <think> spans and
          // mutated queued events).
          if ((e as any).__synthetic) return;
          if (!isThinking) {
            isThinking = true;
            emittedAny = false;
            pendingNewlines = "";
            const openTag = (needThinkNewline ? "\n" : "") + "<think>\n";
            needThinkNewline = false;
            s.push({ type: "thinking_delta", thinkingDelta: openTag, __synthetic: true } as any);
          }
          const chunk = bufferThinkingEvent(e);
          if (!chunk) {
            e.thinkingDelta = "";
          }
        });
        s.on("text_delta", (e: any) => {
          closeSynthetic();
          needThinkNewline = !((e.delta ?? "").endsWith("\n"));
        });
        s.on("tool_call_start" as any, () => {
          closeSynthetic();
        });
        s.on("tool_call_complete" as any, () => {
          closeSynthetic();
        });
        s.on("tool_result" as any, () => {
          closeSynthetic();
        });
        s.on("subagent_complete" as any, () => {
          closeSynthetic();
        });
        s.on("done", () => {
          closeSynthetic();
        });
        if (userOnEvent) s.on("*", userOnEvent as any);
      }
    } else {
      if (options?.onEvent) s.on("*", options.onEvent as any);
      if (options?.onDelta) s.on("text_delta", (e: any) => options.onDelta!(e.delta!, e));
      if (options?.onThinkingDelta) s.on("thinking_delta", (e: any) => options.onThinkingDelta!(e.thinkingDelta!, e));
    }
  }
}

/** Normalizes the public `thinkingLevel` flag into provider-neutral thinking settings. */
export function normalizeThinking(config: AgentConfig, fallbackLevel?: string): ThinkingConfig | undefined {
  // DX4: only thinkingLevel, values: none, dynamic, minimal, low, medium, high, xhigh, max
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
        validateModelThinking(provStr || "openrouter", actualModelId, level);
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
