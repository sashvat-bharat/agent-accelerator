/**
 * The developer's list of allowed models, set in code. A harness developer embeds the `models.json` text in the program
 * (`import models from "./models.json"`) and hands it to `setModels`; the SDK never reads it from disk, so an end user
 * cannot change it by editing a file in their home folder. (A guardrail inside the program, not a security wall: code
 * that runs in the same process can still call `setModels`.)
 *
 * Shape (exact; unknown keys are refused):
 * `{ "default": { "model": "google/gemini-4-argon", "sub_agent_model": "google/gemini-4-argon" },
 *    "providers": { "google": { "models": ["gemini-4-argon"] }, "openrouter": { "models": ["meta/muse-ember"] } } }`
 * Models sit under their provider WITHOUT the `provider/` prefix (OpenRouter ids keep their own slash); the SDK joins them
 * into `provider/model`. The two defaults are full `provider/model` strings and must be in the list.
 */
import { ConfigError } from "../types/errors.ts";

/** One allowed model: its provider, its id inside that provider, and the full `provider/id` string agents use. */
export interface ModelOption {
  readonly provider: string;
  readonly id: string;
  readonly model: string;
}

/** What `listModels()` returns: the defaults and every allowed model, frozen. */
export interface ModelList {
  readonly default: { readonly model: string; readonly sub_agent_model: string };
  readonly models: readonly ModelOption[];
}

const TOP_KEYS = ["default", "providers"];
const DEFAULT_KEYS = ["model", "sub_agent_model"];

// True for a plain object (not null, not an array); in: the validators, out: a type guard.
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Names the keys of `obj` that are not in `allowed`; in: the validators, out: problem lines.
function unknownKeys(where: string, obj: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${where}: unknown key "${k}" (allowed: ${allowed.join(", ")}).`);
}

// Recursively freezes a value; in: parseModels, out: the same value, read-only.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Checks a `models.json` value and turns it into a frozen {@link ModelList}. Pure: no state, no disk. Throws ONE
 * `ConfigError` that lists every problem: wrong shape, unknown keys, a provider with no models, an empty, duplicate,
 * wildcard or `provider/`-prefixed model, and a default that is not in the list.
 */
export function parseModels(json: unknown): ModelList {
  const problems: string[] = [];
  const options: ModelOption[] = [];
  const full = new Set<string>();
  if (!isObject(json)) {
    problems.push(
      "expected an object like { default: { model, sub_agent_model }, providers: { google: { models: [...] } } }."
    );
  } else {
    problems.push(...unknownKeys("models", json, TOP_KEYS));
    const providers = json["providers"];
    if (!isObject(providers) || Object.keys(providers).length === 0) {
      problems.push(
        'providers: required, an object with at least one provider, e.g. { "google": { "models": ["gemini-4-argon"] } }.'
      );
    } else {
      for (const [rawName, entry] of Object.entries(providers)) {
        const provider = rawName.trim().toLowerCase();
        const where = `providers.${rawName}`;
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(provider)) {
          problems.push(`${where}: not a provider name (letters, digits, "_" or "-").`);
          continue;
        }
        if (!isObject(entry)) {
          problems.push(`${where}: expected an object like { "models": [...] }.`);
          continue;
        }
        problems.push(...unknownKeys(where, entry, ["models"]));
        const list = entry["models"];
        if (!Array.isArray(list) || list.length === 0) {
          problems.push(`${where}.models: required, a non-empty list of model ids.`);
          continue;
        }
        list.forEach((raw, i) => {
          const at = `${where}.models[${i}]`;
          const id = typeof raw === "string" ? raw.trim() : "";
          if (!id) return void problems.push(`${at}: expected a non-empty string.`);
          if (id.includes("*")) return void problems.push(`${at}: "${id}" has a wildcard; list every model by name.`);
          if (id.toLowerCase().startsWith(`${provider}/`))
            return void problems.push(
              `${at}: "${id}" starts with "${provider}/"; list the id without the provider prefix, the SDK adds it.`
            );
          const model = `${provider}/${id}`;
          if (full.has(model)) return void problems.push(`${at}: "${id}" is listed twice.`);
          full.add(model);
          options.push({ provider, id, model });
        });
      }
    }
    const def = json["default"];
    if (!isObject(def)) {
      problems.push(
        'default: required, an object like { "model": "google/gemini-4-argon", "sub_agent_model": "google/gemini-4-argon" }.'
      );
    } else {
      problems.push(...unknownKeys("default", def, DEFAULT_KEYS));
      for (const key of DEFAULT_KEYS) {
        const v = def[key];
        if (typeof v !== "string" || !v.trim()) problems.push(`default.${key}: required, a "provider/model" string.`);
        else if (!full.has(v.trim()))
          problems.push(
            `default.${key}: "${v}" is not in the list (write it as "provider/model" and list the model under its provider).`
          );
      }
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `[Agent Accelerator] Invalid models config (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.map((p, i) => `(${i + 1}) ${p}`).join(" ")}`
    );
  }
  const def = (json as { default: { model: string; sub_agent_model: string } }).default;
  return deepFreeze({
    default: { model: def.model.trim(), sub_agent_model: def.sub_agent_model.trim() },
    models: options,
  });
}

let current: ModelList | undefined;

/**
 * Sets the models this program allows, from the exact `models.json` shape (see the file header). Validates everything
 * first: on any problem it throws one `ConfigError` and keeps what was set before. Embed the JSON in your code; the SDK
 * never reads it from disk. Calling it again replaces the list.
 */
export function setModels(json: unknown): void {
  current = parseModels(json);
}

/** The allowed models (`default` plus every `provider/model`, frozen) for a picker, or `undefined` when `setModels` was never called. */
export function listModels(): ModelList | undefined {
  return current;
}

/** Forgets the list (tests only; not exported from the barrel). */
export function resetModels(): void {
  current = undefined;
}
