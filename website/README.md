# Docs site

A [VitePress](https://vitepress.dev) site that shows the Markdown pages in `../docs`. The pages stay plain Markdown, so they also read well on GitHub.

```bash
cd website && bun install   # once
bun run docs:dev            # from the repo root: live preview at http://localhost:5173
bun run docs:build          # builds to website/.vitepress/dist; fails on any broken link
```

- `.vitepress/config.ts`: title, sidebar, search and the link rules.
- `.vitepress/theme/style.css`: the whole look (colors, fonts, code blocks, tables).
- A new page needs one line in the sidebar of `config.ts`.
