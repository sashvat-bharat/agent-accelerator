import type { AgentConfig, EditableAgentConfig } from "../types/agent.ts";
import type { ToolDefinition } from "../types/tool.ts";
import { ConfigError } from "../types/errors.ts";
import { telemetryBus } from "../session/store.ts";
import { namedProviderOf, normalizeToolMap, resolveMainModel } from "./worker.ts";

// The building blocks for self-improving agents (RSI): an agent may edit ONLY `model`, `instructions` and `tools`;
// everything else (limits, budgets, cache, thinking, keys, ...) stays with the developer who wrote `base`.

const EDITABLE_FIELDS = ["model", "instructions", "tools"] as const;

// The model as a plain `provider/id` string (a string stays as written, a ModelSpec becomes `provider/id`); in: Agent.modelStringOrSpec or a base `model`, out: toConfig, applyEditable.
function modelKey(model: unknown): string | undefined {
  if (typeof model === "string") return model.trim() || undefined;
  const m = model as { model?: unknown; id?: unknown; provider?: unknown } | null | undefined;
  if (m && typeof m.model === "string") return m.model.trim() || undefined;
  if (m && typeof m.id === "string" && typeof m.provider === "string") return `${m.provider}/${m.id}`;
  return undefined;
}

// The editable part of an agent as plain JSON; in: the Agent's model, instructions and the developer's tool list (not the built-in delegation/scheduler tools), out: Agent.toConfig.
export function toEditableConfig(
  model: unknown,
  instructions: string,
  tools: AgentConfig["tools"]
): Required<EditableAgentConfig> {
  return { model: modelKey(model) ?? "", instructions, tools: Object.keys(normalizeToolMap(tools)) };
}

// Merges what an agent edited into the developer's config: only model/instructions/tools can change; tools are names picked from base.tools; a new model keeps the developer's key, base URL and headers only when both models name the same provider; the model list is checked when the Agent is built; in: Agent.fromConfig args, out: the AgentConfig for `new Agent`.
export function applyEditable(editable: EditableAgentConfig, base: AgentConfig): AgentConfig {
  if (!editable || typeof editable !== "object" || Array.isArray(editable)) {
    throw new ConfigError(
      `[Agent Accelerator] Invalid editable config ${JSON.stringify(editable)}: expected an object like { model, instructions, tools } (see Agent.toConfig()).`
    );
  }
  const e = editable as Record<string, unknown>;
  const ignored = Object.keys(e).filter(
    (k) => !(EDITABLE_FIELDS as readonly string[]).includes(k) && e[k] !== undefined
  );
  if (ignored.length > 0) {
    telemetryBus.emitWarning(
      "config.not_editable",
      `[Agent Accelerator] Ignored ${ignored.map((k) => `"${k}"`).join(", ")} in the editable config: an agent can change only ${EDITABLE_FIELDS.join(", ")}. The rest comes from the developer's config.`,
      { fields: ignored }
    );
  }
  const out: AgentConfig = { ...base };
  if (e.model !== undefined) {
    const next = typeof e.model === "string" ? e.model.trim() : "";
    if (!next)
      throw new ConfigError(
        `[Agent Accelerator] Invalid editable model ${JSON.stringify(e.model)}: expected a "provider/model" string.`
      );
    // A key, base URL and headers belong to the provider they were written for (the model helper's own, and the
    // top-level ones the Agent falls back to): they are never sent to another provider, nor to an unknown one.
    const prev = base.model as { model?: unknown; apiKey?: string; baseUrl?: string } | string | undefined;
    const prevProvider = namedProviderOf(resolveMainModel(base.model).modelStringOrSpec);
    const sameProvider = prevProvider !== undefined && prevProvider === namedProviderOf(next);
    out.model =
      prev && typeof prev === "object" && typeof prev.model === "string"
        ? { ...prev, model: next, ...(sameProvider ? {} : { apiKey: undefined, baseUrl: undefined }) }
        : next;
    if (!sameProvider) {
      out.apiKey = undefined;
      out.baseUrl = undefined;
      out.headers = undefined;
    }
  }
  if (e.instructions !== undefined) {
    if (typeof e.instructions !== "string")
      throw new ConfigError(
        `[Agent Accelerator] Invalid editable instructions: expected a string, got ${typeof e.instructions}.`
      );
    out.instructions = e.instructions;
  }
  if (e.tools !== undefined) {
    if (!Array.isArray(e.tools) || e.tools.some((n) => typeof n !== "string")) {
      throw new ConfigError(
        `[Agent Accelerator] Invalid editable tools ${JSON.stringify(e.tools)}: expected a list of tool names from the developer's tool pool.`
      );
    }
    // A tool is found by its key in base.tools (what toConfig lists) or by the name the model sees (`def.name`).
    const pool = normalizeToolMap(base.tools);
    const keyOf = new Map<string, string>();
    for (const [key, def] of Object.entries(pool)) if (def.name) keyOf.set(def.name, key);
    for (const key of Object.keys(pool)) keyOf.set(key, key); // a key wins over another tool's name
    const unknown = (e.tools as string[]).filter((n) => !keyOf.has(n));
    if (unknown.length > 0) {
      throw new ConfigError(
        `[Agent Accelerator] Unknown tool ${unknown.map((n) => JSON.stringify(n)).join(", ")} in the editable config. Available: ${
          Object.keys(pool)
            .map((n) => JSON.stringify(n))
            .join(", ") || "none"
        }.`
      );
    }
    const picked: Record<string, ToolDefinition> = {};
    for (const n of e.tools as string[]) {
      const key = keyOf.get(n); // every name was checked above
      const def = key === undefined ? undefined : pool[key];
      if (key !== undefined && def) picked[key] = def;
    }
    out.tools = picked;
  }
  return out; // the model list (`setModels`) is enforced by the Agent constructor
}
