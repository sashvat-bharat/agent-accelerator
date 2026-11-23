// Keeps the layers in order. `src/utils/` is the bottom layer: it imports only from itself and from `src/types/`, never
// from the models, the providers, the agent or anything above. A helper that needs the catalog or a provider belongs
// next to the code that calls it (this is why the modality checks live in `src/providers/modalities.ts`).
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const src = path.resolve(import.meta.dir, "..", "src");

// The first folder under src/ that a relative import of `file` points into, for every import of that file (`utils`, `types`, ...).
function importedFolders(file: string): Array<{ spec: string; folder: string }> {
  const text = fs.readFileSync(file, "utf8");
  const out: Array<{ spec: string; folder: string }> = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)) {
    const spec = m[1] ?? "";
    const target = path.relative(src, path.resolve(path.dirname(file), spec));
    out.push({ spec, folder: target.split(path.sep)[0] ?? "" });
  }
  return out;
}

describe("the layers", () => {
  it("reads the imports of src/utils (the check itself works)", () => {
    const files = fs.readdirSync(path.join(src, "utils")).filter((f) => f.endsWith(".ts"));
    const all = files.flatMap((f) => importedFolders(path.join(src, "utils", f)));
    expect(files.length).toBeGreaterThan(10);
    expect(all.some((i) => i.folder === "types")).toBe(true);
    expect(all.some((i) => i.folder === "utils")).toBe(true);
  });

  it("src/utils imports only from src/utils and src/types", () => {
    const wrong: string[] = [];
    for (const f of fs.readdirSync(path.join(src, "utils")).filter((n) => n.endsWith(".ts"))) {
      for (const { spec, folder } of importedFolders(path.join(src, "utils", f))) {
        if (folder !== "utils" && folder !== "types") wrong.push(`utils/${f} imports ${spec}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
