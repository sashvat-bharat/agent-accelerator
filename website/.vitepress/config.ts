import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { defineConfig } from "vitepress";

// The docs site reads the plain Markdown in ../docs, so the same pages also read well on GitHub.
// Links that leave docs/ (the examples) are rewritten to GitHub, and the build stops on any broken link.
const REPO = "https://github.com/sashvat-bharat/agent-accelerator";
const require = createRequire(import.meta.url);

export default defineConfig({
  title: "Agent Accelerator",
  description: "Build, run and look after AI agents in TypeScript with one small SDK.",
  srcDir: "../docs",
  cleanUrls: true,
  base: process.env.DOCS_BASE ?? "/",
  rewrites: { "README.md": "index.md" },
  lang: "en",

  // The pages live outside this folder, so the Vue imports Vite adds to them are pointed at this folder's copy.
  vite: {
    resolve: {
      alias: [
        { find: /^vue\/server-renderer$/, replacement: require.resolve("vue/server-renderer") },
        { find: /^vue$/, replacement: require.resolve("vue/dist/vue.runtime.esm-bundler.js") },
      ],
    },
    server: { fs: { allow: [".."] } },
  },

  markdown: {
    theme: { light: "github-light", dark: "github-dark" },
    // A link such as ../examples/05-chat.ts leaves the docs folder: send it to the file on GitHub.
    config(md) {
      md.core.ruler.push("outside-docs-links", (state) => {
        for (const block of state.tokens) {
          for (const token of block.children ?? []) {
            if (token.type !== "link_open") continue;
            const href = token.attrGet("href") ?? "";
            const m = href.match(/^(?:\.\.\/)+(examples\/.*|README\.md.*|LICENSE.*)$/);
            if (!m) continue;
            const path = m[1]!;
            const isFolder = path.endsWith("/");
            token.attrSet("href", `${REPO}/${isFolder ? "tree" : "blob"}/main/${path.replace(/\/$/, "")}`);
          }
        }
        return true;
      });
    },
  },

  themeConfig: {
    siteTitle: "Agent Accelerator",
    nav: [
      { text: "Docs", link: "/getting-started", activeMatch: "^/(getting-started|how-it-works|guides)" },
      { text: "Reference", link: "/reference", activeMatch: "^/(reference|scheduled-action-files|migration)" },
      { text: "npm", link: "https://www.npmjs.com/package/agent-accelerator" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Getting started", link: "/getting-started" },
          { text: "How it works", link: "/how-it-works" },
        ],
      },
      {
        text: "Build agents",
        items: [
          { text: "Agents", link: "/guides/agents" },
          { text: "Models and providers", link: "/guides/models-and-providers" },
          { text: "Provider notes", link: "/guides/provider-notes" },
          { text: "Allowed models", link: "/guides/allowed-models" },
          { text: "Reasoning and caching", link: "/guides/reasoning-and-caching" },
          { text: "Tools", link: "/guides/tools" },
          { text: "Streaming and steering", link: "/guides/streaming-and-steering" },
          { text: "Workers", link: "/guides/workers" },
          { text: "Scheduled actions", link: "/guides/scheduled-actions" },
        ],
      },
      {
        text: "Data",
        items: [
          { text: "Sessions", link: "/guides/sessions" },
          { text: "Media input", link: "/guides/media-input" },
          { text: "Usage and cost", link: "/guides/usage-and-cost" },
        ],
      },
      {
        text: "Run in production",
        items: [
          { text: "Limits and retries", link: "/guides/limits-and-retries" },
          { text: "Settings", link: "/guides/settings" },
          { text: "Errors and telemetry", link: "/guides/errors-and-telemetry" },
          { text: "Security", link: "/guides/security" },
          { text: "Prompts", link: "/guides/prompts" },
          { text: "Testing", link: "/guides/testing" },
        ],
      },
      {
        text: "Make things",
        items: [
          { text: "Images", link: "/guides/images" },
          { text: "Videos", link: "/guides/videos" },
          { text: "Embeddings", link: "/guides/embeddings" },
          { text: "Decisions", link: "/guides/decisions" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Reference", link: "/reference" },
          { text: "Scheduled action files", link: "/scheduled-action-files" },
          { text: "Migration", link: "/migration" },
        ],
      },
      { text: "For AI agents", items: [{ text: "For AI agents", link: "/for-ai-agents" }] },
    ],
    socialLinks: [{ icon: "github", link: REPO }],
    search: { provider: "local", options: { detailedView: false } },
    outline: { level: [2, 3], label: "On this page" },
    editLink: { pattern: `${REPO}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
    docFooter: { prev: "Previous", next: "Next" },
    footer: { message: "Released under the MIT License.", copyright: "Agent Accelerator" },
  },

  // llms.txt lives next to the docs; copy it so it is served at /llms.txt.
  buildEnd(config) {
    copyFileSync(join(config.srcDir, "llms.txt"), join(config.outDir, "llms.txt"));
  },
});
