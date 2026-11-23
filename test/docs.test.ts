// Keeps the docs true. A page that links to a page that is gone, an example that does not compile, a new telemetry code that
// nobody documented, or a page missing from the site and llms.txt fails here, so the docs cannot drift from the code.
import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const rel = (file: string): string => path.relative(root, file);

// Every Markdown file under `dir`, recursively.
function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

const DOC_PAGES = markdownFiles(path.join(root, "docs"));
const README = path.join(root, "README.md");
const ALL_PAGES = [...DOC_PAGES, README];
const text = (file: string): string => fs.readFileSync(file, "utf8");

// The lines of a Markdown file that are not inside a code fence, with their 1-based line numbers.
function proseLines(file: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let inFence = false;
  text(file)
    .split("\n")
    .forEach((l, i) => {
      if (/^\s*```/.test(l)) inFence = !inFence;
      else if (!inFence) out.push({ line: i + 1, text: l });
    });
  return out;
}

// The anchor a heading gets on the site and on GitHub: lower case, no punctuation, spaces to hyphens, `-1`, `-2` for repeats.
function anchorsOf(file: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const { text: l } of proseLines(file)) {
    const m = l.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const plain = m[1]!.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`/g, "");
    const base = plain
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

describe("links", () => {
  const files = [...ALL_PAGES, path.join(root, "docs", "llms.txt")];

  it("every relative link points at a file or folder that exists", () => {
    const broken: string[] = [];
    for (const file of files) {
      const lines = file.endsWith(".txt") ? text(file).split("\n").map((t, i) => ({ line: i + 1, text: t })) : proseLines(file);
      for (const { line, text: l } of lines) {
        for (const m of l.matchAll(/\]\(([^)\s]+)\)/g)) {
          const target = m[1]!;
          if (/^(https?:|mailto:|#)/.test(target)) continue;
          const [file2] = target.split("#");
          if (!file2) continue;
          if (!fs.existsSync(path.resolve(path.dirname(file), file2))) broken.push(`${rel(file)}:${line} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("every #anchor points at a heading that exists, in the same page or another", () => {
    const broken: string[] = [];
    for (const file of ALL_PAGES) {
      for (const { line, text: l } of proseLines(file)) {
        for (const m of l.matchAll(/\]\(([^)\s#]*)#([^)\s]+)\)/g)) {
          const [, targetFile, anchor] = m;
          if (/^(https?:|mailto:)/.test(targetFile!)) continue;
          const page = targetFile ? path.resolve(path.dirname(file), targetFile) : file;
          if (!page.endsWith(".md") || !fs.existsSync(page)) continue; // a missing file is reported by the test above
          if (!anchorsOf(page).has(anchor!)) broken.push(`${rel(file)}:${line} -> ${targetFile}#${anchor}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("code examples", () => {
  // Every ```ts block of the docs pages and the README, with where it came from.
  function snippets(): Array<{ file: string; line: number; code: string }> {
    const out: Array<{ file: string; line: number; code: string }> = [];
    for (const file of ALL_PAGES) {
      const lines = text(file).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/^```(ts|typescript)\s*$/.test(lines[i]!)) continue;
        let j = i + 1;
        while (j < lines.length && !lines[j]!.startsWith("```")) j++;
        out.push({ file, line: i + 2, code: lines.slice(i + 1, j).join("\n") });
        i = j;
      }
    }
    return out;
  }

  it("every TypeScript example in the docs and the README compiles on its own, against the real SDK", () => {
    const found = snippets();
    expect(found.length).toBeGreaterThan(40); // the extraction itself works
    const dir = path.join(root, ".snippets-check");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    try {
      const names = new Map<string, { file: string; line: number }>();
      found.forEach((s, i) => {
        const name = `snippet-${String(i).padStart(3, "0")}.ts`;
        names.set(name, { file: s.file, line: s.line });
        // Each block is its own module (so top-level await works) and imports the SDK from the source in this repo.
        fs.writeFileSync(path.join(dir, name), `${s.code.replace(/from "agent-accelerator"/g, 'from "../src/index.ts"')}\nexport {};\n`);
      });
      fs.writeFileSync(
        path.join(dir, "tsconfig.json"),
        JSON.stringify({
          extends: "../tsconfig.json",
          include: ["./*.ts"],
          compilerOptions: { noUnusedLocals: false, noUnusedParameters: false },
        })
      );
      const tsc = path.join(root, "node_modules", ".bin", "tsc");
      const run = Bun.spawnSync([tsc, "--noEmit", "-p", path.join(dir, "tsconfig.json")], { cwd: root });
      const output = `${run.stdout.toString()}${run.stderr.toString()}`.trim();
      const problems = output
        .split("\n")
        .filter((l) => l.includes("error TS"))
        .map((l) => {
          const m = l.match(/(snippet-\d+\.ts)\((\d+),/);
          const origin = m ? names.get(m[1]!) : undefined;
          return origin ? `${rel(origin.file)} (block at line ${origin.line}, its line ${m![2]}): ${l.replace(/^[^:]+: /, "")}` : l;
        });
      expect(problems).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("every page is findable", () => {
  const pages = DOC_PAGES.filter((f) => path.basename(f) !== "README.md");
  const route = (f: string): string => `/${rel(f).replace(/^docs\//, "").replace(/\.md$/, "")}`;

  it("is in the sidebar of the docs site", () => {
    const config = text(path.join(root, "website", ".vitepress", "config.ts"));
    expect(pages.filter((f) => !config.includes(`link: "${route(f)}"`)).map(rel)).toEqual([]);
  });

  it("is listed in llms.txt", () => {
    const llms = text(path.join(root, "docs", "llms.txt"));
    expect(pages.filter((f) => !llms.includes(`](${rel(f).replace(/^docs\//, "")})`)).map(rel)).toEqual([]);
  });
});

describe("the architecture notes", () => {
  it("every src folder's architecture.md names every file in it", () => {
    const missing: string[] = [];
    const folders = [path.join(root, "src"), ...fs.readdirSync(path.join(root, "src"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, "src", e.name))];
    for (const dir of folders) {
      const note = path.join(dir, "architecture.md");
      if (!fs.existsSync(note)) {
        if (dir !== path.join(root, "src")) missing.push(`${rel(dir)}: no architecture.md`);
        continue;
      }
      const body = text(note);
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
        if (!body.includes(f)) missing.push(`${rel(note)} does not mention ${f}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("the reference", () => {
  it("lists every telemetry code that the source can emit", () => {
    const codes = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".ts")) {
          const src = text(full);
          for (const m of src.matchAll(/emitWarning\(\s*"([a-z_]+(?:\.[a-z_]+)*)"/g)) codes.add(m[1]!);
          for (const m of src.matchAll(/code:\s*"([a-z_]+\.[a-z_.]+)"/g)) codes.add(m[1]!);
        }
      }
    };
    walk(path.join(root, "src"));
    const reference = text(path.join(root, "docs", "reference.md"));
    expect([...codes].filter((c) => !reference.includes(`\`${c}\``)).sort()).toEqual([]);
  });
});
