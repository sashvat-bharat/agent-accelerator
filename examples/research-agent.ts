import { Agent, tool, z } from "agent-accelerator";
import { fail } from "./_shared";

interface TinyFishResult {
  position?: number;
  title?: string;
  url?: string;
  snippet?: string;
  site_name?: string;
}

interface TinyFishSearchResponse {
  query?: string;
  results?: TinyFishResult[];
  total_results?: number;
}

// Hardcoded for now — replace with your real key.
const TINYFISH_API_KEY = process.env.TINYFISH_API_KEY;

const web_search = tool({
  name: "web_search",
  description: "Search the live web for current information. Returns ranked web sources with titles, snippets, and URLs. Use this when you need fresh information, documentation, research, news, or facts that may have changed.",
  input: z.object({ query: z.string().min(1).describe("The web search query") }),
  timeoutMs: 15_000,
  maxTries: 2,

  execute: async ({ query }) => {
    const apiKey = TINYFISH_API_KEY;

    if (!apiKey || apiKey === "PASTE_YOUR_TINYFISH_API_KEY_HERE") {
      throw new Error("TINYFISH_API_KEY is not configured");
    }

    const startedAt = Date.now();
    console.log(`\n\x1b[36m→ [web_search] request:\x1b[0m ${JSON.stringify({ query })}`);

    const url = new URL("https://api.search.tinyfish.ai");
    url.searchParams.set("query", query);

    const response = await fetch(url, {
      method: "GET",
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
    });

    if (!response.ok) {
      const error = await response.text();
      console.log(`\x1b[31m← [web_search] error (${Date.now() - startedAt}ms): ${response.status} ${error.slice(0, 200)}\x1b[0m`);
      throw new Error(`TinyFish Search failed (${response.status}): ${error}`);
    }

    const data = (await response.json()) as TinyFishSearchResponse;

    const mapped = {
      query, results:
        data.results?.map((result) => ({
          position: result.position,
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          site: result.site_name,
        })) ?? [],
      totalResults: data.total_results ?? 0,
    };
    console.log(`\x1b[32m← [web_search] arrived: ${mapped.results.length} results (total: ${mapped.totalResults}) in ${Date.now() - startedAt}ms\x1b[0m`);
    return mapped;
  },
});

const agent = new Agent({
  name: "Main Agent",
  tools: {web_search},
  thinkingLevel: "medium",
  model: process.env.MODEL,

  instructions: `
You are a main research agent. You can search the live web using the web_search tool.

When answering research questions:
1. Break complex questions into smaller research queries.
2. Use web_search when current or external information is required.
3. Prefer primary sources, official documentation, papers, and first-party sources.
4. Do not assume search snippets are sufficient evidence.
5. When multiple sources are relevant, compare them.
6. Include source URLs in your final research output.`,

  dynamicSubagents: {
    enabled: true,
    model: process.env.SUB_AGENT_MODEL,
    maxSpawn: 2,
    thinkingLevel: "medium",
    // Workers get zero tools unless granted here — research workers need search.
    tools: { web_search },
    timeout: 0,
  },
});

const res = await agent.run("Research on the latest model and its capability introduced by OpenAI called GPT-6-ASTRA", {
    stream: true,
    wrapThinking: true,
    onThinkingDelta: (d) => process.stdout.write(`\x1b[90m${d}\x1b[0m`),
    onDelta: (d) => process.stdout.write(d),
    onEvent: (e) => {
      if (e.type === "tool_call_complete" && e.toolCall?.name === "web_search") {
        const q = (e.toolCall.arguments as any)?.query ?? e.toolCall.rawArguments;
        console.log(`\n\x1b[36m↳ [web_search →] model requested search: ${JSON.stringify(q)}\x1b[0m`);
      } else if (e.type === "tool_result" && e.toolResult?.name === "web_search") {
        const r = e.toolResult.result as any;
        const count = Array.isArray(r?.results) ? r.results.length : "?";
        console.log(`\x1b[32m↳ [web_search ←] result arrived: ${count} results in ${e.toolResult.durationMs ?? 0}ms${e.toolResult.isError ? " (error)" : ""}\x1b[0m`);
      } else if (e.type === "subagent_complete" && e.subagent) {
        console.log(`\n\x1b[33m↳ [SubAgent Completed] ${e.subagent.name} (${e.subagent.durationMs}ms)\x1b[0m`);
      }
    },
  })
  .catch(fail);

console.log("\n" + "─".repeat(70));
console.log(res.text);
console.log("─".repeat(70));
console.log(res.subagents.map((s) => `${s.name} (${s.durationMs}ms)`));
console.log(res.usage);