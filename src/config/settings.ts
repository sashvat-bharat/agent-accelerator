/**
 * The program's settings, set in code (`setConfigs`) and, where the developer allows it, changed by the end user
 * (`setConfig`). They replace the settings env vars of earlier releases: caps, concurrency, catalog and network options.
 * A harness developer embeds the `configs.json` text in the program and hands it to `setConfigs`; the SDK never reads the
 * developer's file from disk.
 *
 * Shape (exact; unknown keys are refused):
 * `{ "values": { "usage_limit": { "max_cost_usd": 5 }, "concurrency": { "max_requests": 8 } }, "editable": ["concurrency"] }`
 * Every setting is `hidden` unless its key is listed in `editable`. A hidden setting only ever has the developer's value.
 * An editable one has the user's value when they set one, else the developer's value, else the built-in default.
 * With no `setConfigs` call at all there is no developer policy: every setting is editable.
 *
 * The user's values live in `<home>/configs.json` (see `user-file.ts`): `setConfig` saves there, and a hand edit is read
 * the next time the process starts (or the home changes). A value in the file that is unknown, invalid or for a hidden
 * setting is ignored with a warning on the telemetry bus.
 */
import { ConfigError, SettingNotEditableError } from "../types/errors.ts";
import { isRecord } from "../utils/guards.ts";
import { currentUserFile, invalidateUserFile, saveUserFile, warnOnce, configsPath } from "./user-file.ts";
import { onHomeChange, resolveHome } from "../utils/home.ts";

/** One value-checking rule: returns the cleaned value, or a one-line problem. */
type Check = (v: unknown) => { value: unknown } | { problem: string };

// Plain-object guard; in: the checks, out: a type guard.
const isPositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const isWhole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
const ok = (value: unknown) => ({ value });
const bad = (problem: string) => ({ problem });

// Builds a check for an object with a fixed set of optional keys, each with its own rule; in: the settings table, out: a Check.
function shape(what: string, fields: Record<string, (v: unknown) => string | undefined>, needOne = false): Check {
  return (v) => {
    if (!isRecord(v)) return bad(`expected an object with ${Object.keys(fields).join(", ")}`);
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    for (const k of keys)
      if (!(k in fields)) return bad(`unknown key "${k}" (allowed: ${Object.keys(fields).join(", ")})`);
    if (needOne && keys.length === 0) return bad(`set at least one of ${Object.keys(fields).join(", ")}`);
    for (const k of keys) {
      const problem = fields[k]!(v[k]);
      if (problem) return bad(`${what}.${k} ${problem}`);
    }
    return ok(Object.fromEntries(keys.map((k) => [k, v[k]])));
  };
}

const positive = (v: unknown) => (isPositive(v) ? undefined : "must be a number greater than 0");
const bool = (v: unknown) => (typeof v === "boolean" ? undefined : "must be true or false");
const text = (v: unknown) => (typeof v === "string" && v.trim() ? undefined : "must be a non-empty string");
const names = (v: unknown) =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim())
    ? undefined
    : "must be a non-empty list of provider names";
const oneOf =
  (...allowed: string[]) =>
  (v: unknown) =>
    typeof v === "string" && allowed.includes(v) ? undefined : `must be one of: ${allowed.join(", ")}`;

// A check for a spending cap ({ max_cost_usd, max_total_tokens }); in: usage_limit and scheduled_action_budget, out: a Check.
const cap = (what: string): Check => shape(what, { max_cost_usd: positive, max_total_tokens: positive }, true);

/** The name of every setting the SDK knows. */
const SETTING_NAMES = [
  "usage_limit",
  "scheduled_action_budget",
  "concurrency",
  "catalog_refresh",
  "catalog_cache_dir",
  "models_dev_sha256",
  "base_urls",
  "openrouter",
  "compat",
] as const;

/** The name of one setting. */
export type SettingKey = (typeof SETTING_NAMES)[number];

/** Every setting the SDK knows, with the rule its value must follow. */
const SETTINGS: Record<SettingKey, Check> = {
  usage_limit: cap("usage_limit"),
  scheduled_action_budget: cap("scheduled_action_budget"),
  concurrency: (v) => {
    const r = shape(
      "concurrency",
      {
        max_requests: (x) => (isWhole(x) ? undefined : "must be a whole number >= 1"),
        per_provider: (x) =>
          isRecord(x) && Object.keys(x).length > 0 && Object.values(x).every(isWhole)
            ? undefined
            : "must be an object like { google: 4 } of whole numbers >= 1",
      },
      true
    )(v);
    return r;
  },
  catalog_refresh: (v) => (v === "on" || v === "off" ? ok(v) : bad('must be "on" or "off"')),
  catalog_cache_dir: (v) => (typeof v === "string" && v.trim() ? ok(v.trim()) : bad("must be a non-empty folder path")),
  models_dev_sha256: (v) =>
    typeof v === "string" && /^[a-f0-9]{64}$/i.test(v) ? ok(v.toLowerCase()) : bad("must be 64 hex characters"),
  base_urls: (v) => {
    if (!isRecord(v) || Object.keys(v).length === 0)
      return bad('expected an object like { "openai": "https://host/v1" }');
    const out: Record<string, string> = {};
    for (const [name, url] of Object.entries(v)) {
      let parsed: URL | undefined;
      try {
        parsed = typeof url === "string" ? new URL(url) : undefined;
      } catch {
        parsed = undefined;
      }
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:"))
        return bad(`base_urls.${name} must be an http(s) URL`);
      const key = name.trim().toLowerCase();
      out[key === "gemini" ? "google" : key] = (url as string).trim(); // the SDK routes `gemini/...` to `google`
    }
    return ok(out);
  },
  openrouter: shape(
    "openrouter",
    {
      order: names,
      only: names,
      ignore: names,
      allow_fallbacks: bool,
      require_parameters: bool,
      zdr: bool,
      data_collection: oneOf("allow", "deny"),
      sort: oneOf("price", "throughput", "latency"),
      parallel_tool_calls: bool,
      reasoning_exclude: bool,
      user: text,
    },
    true
  ),
  compat: shape("compat", { no_stream_options: bool, no_session_headers: bool }, true),
};

const KEYS: readonly SettingKey[] = SETTING_NAMES;

/** Every setting name (tests build "everything editable" policies from it). Internal. */
export const SETTING_KEYS: readonly SettingKey[] = KEYS;

/** The developer's `configs.json`: values plus the keys the end user may change. */
export interface SettingsJson {
  values?: Partial<Record<SettingKey, unknown>>;
  editable?: SettingKey[];
}

interface Policy {
  readonly values: Readonly<Partial<Record<SettingKey, unknown>>>;
  readonly editable: ReadonlySet<SettingKey>;
}

// Recursively freezes a value; in: the stored values, out: the same value, read-only.
function freeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

// Checks one setting value, throwing nothing: the cleaned value or the problem; in: setConfigs and setConfig, out: the result.
function checkValue(key: SettingKey, v: unknown): { value: unknown } | { problem: string } {
  const r = SETTINGS[key](v);
  return "problem" in r ? { problem: `${key}: ${r.problem}.` } : r;
}

/**
 * Checks a `configs.json` value (pure, no state). Throws ONE `ConfigError` that lists every problem: wrong shape,
 * unknown keys, unknown settings, a bad value, a key listed twice in `editable`.
 */
export function parseConfigs(json: unknown): Policy {
  const problems: string[] = [];
  const values: Partial<Record<SettingKey, unknown>> = {};
  const editable = new Set<SettingKey>();
  if (!isRecord(json)) {
    problems.push('expected an object like { "values": { ... }, "editable": ["concurrency"] }.');
  } else {
    for (const k of Object.keys(json))
      if (k !== "values" && k !== "editable") problems.push(`configs: unknown key "${k}" (allowed: values, editable).`);
    const v = json["values"];
    if (v !== undefined) {
      if (!isRecord(v)) problems.push("values: expected an object of settings.");
      else
        for (const [key, raw] of Object.entries(v)) {
          if (!KEYS.includes(key as SettingKey)) {
            problems.push(`values.${key}: unknown setting (known: ${KEYS.join(", ")}).`);
            continue;
          }
          const r = checkValue(key as SettingKey, raw);
          if ("problem" in r) problems.push(`values.${r.problem}`);
          else values[key as SettingKey] = r.value;
        }
    }
    const e = json["editable"];
    if (e !== undefined) {
      if (!Array.isArray(e)) problems.push("editable: expected a list of setting names.");
      else
        e.forEach((key, i) => {
          if (typeof key !== "string" || !KEYS.includes(key as SettingKey))
            problems.push(`editable[${i}]: ${JSON.stringify(key)} is not a known setting (known: ${KEYS.join(", ")}).`);
          else if (editable.has(key as SettingKey)) problems.push(`editable[${i}]: "${key}" is listed twice.`);
          else editable.add(key as SettingKey);
        });
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `[Agent Accelerator] Invalid configs (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.map((p, i) => `(${i + 1}) ${p}`).join(" ")}`
    );
  }
  return freeze({ values, editable });
}

const changeListeners = new Set<() => void>();

/** Runs `fn` whenever a setting may have changed (`setConfigs`, `setConfig`, a new home): readers that cache a value (the catalog's folder, the concurrency limit) re-read it. Internal. */
export function onSettingsChange(fn: () => void): void {
  changeListeners.add(fn);
}

// Tells the cached readers that settings may have changed; in: setConfigs, setConfig, resetConfigs and a home change, out: the listeners.
function changed(): void {
  for (const fn of changeListeners) fn();
}
onHomeChange(changed);

let policy: Policy | undefined;
// Bumped whenever the developer's policy changes, so the checked user values are rebuilt.
let generation = 0;
let memo: { file: object; generation: number; values: Map<SettingKey, unknown> } | undefined;

/**
 * Sets the program's settings from the exact `configs.json` shape (see the file header): `values` are the developer's
 * settings, `editable` lists the keys the end user may change (all others stay hidden). Validates everything first: on any
 * problem it throws one `ConfigError` and keeps what was set before. Calling it again replaces the developer's settings.
 */
export function setConfigs(json: unknown): void {
  policy = parseConfigs(json);
  generation++;
  changed();
}

// The user's saved setting values that pass the checks (known key, valid value, not hidden), warning once about each that does not; memoized per file version and policy; in: getSetting and getConfigs, out: key -> frozen value.
function userValues(): Map<SettingKey, unknown> {
  const file = currentUserFile();
  if (memo?.file === file && memo.generation === generation) return memo.values;
  const values = new Map<SettingKey, unknown>();
  const at = configsPath(resolveHome());
  for (const [key, raw] of Object.entries(file.settings)) {
    if (!KEYS.includes(key as SettingKey)) {
      warnOnce("config.file_ignored_key", `${at}: "${key}" is not a known setting and is ignored.`, {
        key,
        reason: "unknown",
      });
      continue;
    }
    const k = key as SettingKey;
    if (!isEditable(k)) {
      warnOnce(
        "config.file_ignored_key",
        `${at}: "${key}" is not editable in this program, so the value in the file is ignored.`,
        { key, reason: "hidden" }
      );
      continue;
    }
    const r = checkValue(k, raw);
    if ("problem" in r) {
      warnOnce("config.file_ignored_key", `${at}: ${r.problem} The value in the file is ignored.`, {
        key,
        reason: "invalid",
      });
      continue;
    }
    values.set(k, freeze(r.value));
  }
  memo = { file, generation, values };
  return values;
}

// True when the end user may change this setting: always without a developer policy, else only when listed in `editable`; in: getConfigs, setConfig and the readers, out: a boolean.
function isEditable(key: SettingKey): boolean {
  return !policy || policy.editable.has(key);
}

/** The value of one setting as the SDK reads it, or `undefined` for "built-in default": a hidden setting has only the developer's value; an editable one the user's, else the developer's. Internal. */
export function getSetting<K extends SettingKey>(key: K): unknown {
  const dev = policy?.values[key];
  const mine = userValues(); // also reports file entries the program does not allow
  if (!isEditable(key)) return dev;
  return mine.has(key) ? mine.get(key) : dev;
}

/** The settings the end user may change, with their current value (`null` = not set: the built-in default applies). Hidden settings never appear. */
export function getConfigs(): Readonly<Partial<Record<SettingKey, unknown>>> {
  const out: Partial<Record<SettingKey, unknown>> = {};
  for (const key of KEYS) if (isEditable(key)) out[key] = getSetting(key) ?? null;
  return freeze(out);
}

/**
 * Changes one editable setting and saves it in `<home>/configs.json` (the folder is created on the first write). `null` (or `undefined`) removes the user's value, so the developer's value or the built-in
 * default applies again. Throws a `ConfigError` for an unknown key, a bad value or a file that cannot be written, and a
 * `SettingNotEditableError` when the program keeps the setting hidden; nothing changes in any of these cases.
 */
export function setConfig(key: string, value: unknown): void {
  if (!KEYS.includes(key as SettingKey))
    throw new ConfigError(`[Agent Accelerator] Unknown setting "${key}". Known: ${KEYS.join(", ")}.`);
  const k = key as SettingKey;
  if (!isEditable(k))
    throw new SettingNotEditableError(
      key,
      `[Agent Accelerator] Setting "${key}" is not editable: the program keeps it hidden.`
    );
  if (value === null || value === undefined) {
    saveUserFile((f) => void delete f.settings[k]);
    changed();
    return;
  }
  const r = checkValue(k, value);
  if ("problem" in r) throw new ConfigError(`[Agent Accelerator] Invalid value for ${r.problem}`);
  saveUserFile((f) => void (f.settings[k] = r.value));
  changed();
}

/** Forgets the developer's settings and what was read from the user's file (tests only; not exported from the barrel). The file itself is not touched. */
export function resetConfigs(): void {
  policy = undefined;
  generation++;
  invalidateUserFile();
  changed();
}

/** The base URL set for a provider or custom prefix (`base_urls`), or `undefined`. */
export function baseUrlSetting(provider: string): string | undefined {
  const urls = getSetting("base_urls") as Record<string, string> | undefined;
  const name = provider.trim().toLowerCase();
  return urls?.[name === "gemini" ? "google" : name];
}

/** The `openrouter` settings (`{}` when unset): provider routing and request options. */
export function openRouterSetting(): Readonly<Record<string, unknown>> {
  return (getSetting("openrouter") as Record<string, unknown> | undefined) ?? {};
}

/** The `compat` settings (`{}` when unset): opt-outs for strict OpenAI-compatible endpoints. */
export function compatSetting(): { no_stream_options?: boolean; no_session_headers?: boolean } {
  return (getSetting("compat") as { no_stream_options?: boolean; no_session_headers?: boolean } | undefined) ?? {};
}

/** A spending cap setting as the Agent options spell it, or `undefined` when unset. */
export function capSetting(
  key: "usage_limit" | "scheduled_action_budget"
): { maxCostUsd?: number; maxTotalTokens?: number } | undefined {
  const v = getSetting(key) as { max_cost_usd?: number; max_total_tokens?: number } | undefined;
  if (!v) return undefined;
  return {
    ...(v.max_cost_usd !== undefined ? { maxCostUsd: v.max_cost_usd } : {}),
    ...(v.max_total_tokens !== undefined ? { maxTotalTokens: v.max_total_tokens } : {}),
  };
}
