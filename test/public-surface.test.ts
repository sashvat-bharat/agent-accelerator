// Keeps the public surface lean. `src/index.ts` is the whole public API: a name goes in only when a user needs it to
// call, configure or type a documented API. Names that were made internal must not come back, and the number of names
// can only go up on purpose (raise MAX_NAMES with a reason in the commit), never by accident.
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Every name the barrel exports with its kind; in: the text of src/index.ts, out: one entry per exported name.
function exportedNames(text: string): Array<{ name: string; type: boolean }> {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const out: Array<{ name: string; type: boolean }> = [];
  for (const block of clean.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*from\s*"[^"]+"/g)) {
    for (const part of (block[2] ?? "").split(",")) {
      const item = part.trim();
      if (!item) continue;
      const inline = /^type\s+(.*)$/.exec(item);
      const name = (inline?.[1] ?? item).split(" as ").pop()?.trim();
      if (name) out.push({ name, type: block[1] !== undefined || inline !== null });
    }
  }
  return out;
}

const barrel = fs.readFileSync(path.resolve(import.meta.dir, "..", "src", "index.ts"), "utf8");
const names = exportedNames(barrel);

// Names that were made internal. They still live in their own files, but the barrel must not export them again.
const INTERNAL: Record<string, string[]> = {
  "session plumbing (the folder and file savers do this for you)": [
    "writeFileAtomic",
    "extractMediaToDir",
    "resolveMediaPaths",
    "buildSessionData",
    "serializeSession",
    "deserializeSession",
    "inspectSessionPayload",
    "computeSessionTurnCost",
    "SessionAgentLike",
    "SessionPayloadStatus",
  ],
  "provider adapters, their tables and aliases (use Agent, getProvider and ensureCustomProvider)": [
    "GoogleInteractionsProvider",
    "OpenAIResponsesProvider",
    "AnthropicMessagesProvider",
    "OpenRouterChatCompletionsProvider",
    "OpenAICompatibleChatProvider",
    "GOOGLE_MODELS",
    "OPENAI_MODELS",
    "ANTHROPIC_MODELS",
    "OPENROUTER_MODELS",
    "createOpenAICompatibleProvider",
    "createCustomProvider",
    "CustomProvider",
    "CustomProviderOptions",
  ],
  "schema and tool-name helpers (tool() does this for you)": [
    "zodToJsonSchema",
    "cleanJsonSchema",
    "toStandardToolDeclarations",
    "StandardToolDeclaration",
    "stripSchemaForGoogle",
    "assertValidToolName",
    "TOOL_NAME_PATTERN",
  ],
  "Google signature, cache and thinking helpers (the SDK keeps this state itself)": [
    "isValidThoughtSignature",
    "retainThoughtSignature",
    "extractGoogleThoughtSignature",
    "clearInteractionChains",
    "clampCacheKey",
    "resolveEffectiveThinking",
    "CACHE_OPTIONS",
  ],
  "error, header and lineage helpers": [
    "toConciseProviderError",
    "assertModalitiesSupported",
    "getAttribution",
    "buildSessionHeaders",
    "createTrackingId",
    "createChildSessionId",
    "createFixedChildSessionId",
    "isSessionDescendant",
  ],
  "catalog internals (getCatalogStatus and the catalog settings cover them)": [
    "getCacheDir",
    "getCacheFilePath",
    "getCatalogTTL",
    "isValidCatalogPayload",
    "DEFAULT_CATALOG_TTL_MS",
    "CATALOG_PROVIDERS",
  ],
  "chat display helpers (copies live in examples/_shared.ts)": [
    "formatSessionBanner",
    "formatSessionTokens",
    "formatSessionCost",
    "getSessionContextWindow",
  ],
};
// The most names the barrel may export (values and types). Lower it whenever names are removed.
const MAX_NAMES = 270;

describe("the public surface", () => {
  it("reads the barrel (the check itself works)", () => {
    const all = new Set(names.map((n) => n.name));
    expect(names.length).toBeGreaterThan(200);
    for (const expected of ["Agent", "tool", "generateImage", "loadSessionDir", "UsageReport"]) expect(all.has(expected)).toBe(true);
  });

  it("exports no name twice", () => {
    const seen = new Set<string>();
    const twice = names.map((n) => n.name).filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(twice).toEqual([]);
  });

  it("does not export a name that was made internal", async () => {
    const api = (await import("../src/index.ts")) as Record<string, unknown>;
    const back: string[] = [];
    for (const [group, list] of Object.entries(INTERNAL)) {
      for (const name of list) {
        if (names.some((n) => n.name === name) || name in api) back.push(`${name} (${group})`);
      }
    }
    expect(back).toEqual([]);
  });

  it(`stays within ${MAX_NAMES} names`, () => {
    expect(names.length).toBeLessThanOrEqual(MAX_NAMES);
  });
});
