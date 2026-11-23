// The default address of each provider is written once (src/providers/base-urls.ts) and resolved in one place:
// an agent's `baseUrl`, then the `base_urls` setting, then that default.
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_BASE_URLS } from "../src/providers/base-urls.ts";
import { resolveProviderBaseUrl } from "../src/providers/shared.ts";
import { setConfigs, SETTING_KEYS } from "../src/config/settings.ts";

// Every .ts file under `dir`; in: a folder, out: its files (recursive).
function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? tsFiles(full) : e.name.endsWith(".ts") ? [full] : [];
  });
}

describe("provider base URLs", () => {
  it("has the default address of each first-class provider", () => {
    expect({ ...DEFAULT_BASE_URLS }).toEqual({
      google: "https://generativelanguage.googleapis.com/v1beta",
      openai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com/v1",
      openrouter: "https://openrouter.ai/api/v1",
    });
  });

  it("uses the default, strips trailing slashes, and lets the setting and then the agent's baseUrl win", () => {
    try {
      for (const provider of ["google", "openai", "anthropic", "openrouter"] as const) {
        expect(resolveProviderBaseUrl(provider)).toBe(DEFAULT_BASE_URLS[provider]);
      }
      expect(resolveProviderBaseUrl("openai", { baseUrl: "https://agent.test/v1///" })).toBe("https://agent.test/v1");

      setConfigs({ values: { catalog_refresh: "off", base_urls: { google: "https://proxy.test/v1beta/" } }, editable: [...SETTING_KEYS] });
      expect(resolveProviderBaseUrl("google")).toBe("https://proxy.test/v1beta"); // the setting beats the default
      expect(resolveProviderBaseUrl("google", { baseUrl: "https://agent.test" })).toBe("https://agent.test"); // the agent beats the setting
      expect(resolveProviderBaseUrl("openai")).toBe(DEFAULT_BASE_URLS.openai); // another provider is not affected
    } finally {
      setConfigs({ values: { catalog_refresh: "off" }, editable: [...SETTING_KEYS] });
    }
  });

  it("is the only place the provider hosts are written in the source", () => {
    // An address is `https://` and the host: a message that only names a provider (as one error does) is fine.
    const host = /https?:\/\/(generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com|openrouter\.ai\/api)/;
    const root = path.resolve(import.meta.dir, "..", "src");
    const found: string[] = [];
    for (const file of tsFiles(root)) {
      if (file.endsWith(path.join("providers", "base-urls.ts"))) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return; // comments may name an address
          if (host.test(line)) found.push(`${path.relative(root, file)}:${i + 1}`);
        });
    }
    expect(found).toEqual([]);
  });
});
