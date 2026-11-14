/**
 * Memory benchmark: `bun run bench`. Prints the RSS of an idle process at each step of loading the SDK, then the peak
 * with N mocked streaming runs in flight (no network, no cost). Numbers are noisy by about 1 MB; compare runs on one machine.
 * Needs the model catalog cache (`bun run update-models` once).
 */
const mb = (n: number): string => (n / 1048576).toFixed(1).padStart(6);
const rss = (): number => {
  Bun.gc(true);
  return process.memoryUsage().rss;
};
const row = (label: string, bytes: number, note = ""): void => console.log(`${label.padEnd(34)} ${mb(bytes)} MB  ${note}`);

process.env.AGENT_CATALOG_REFRESH = "off";
const streams = Number(process.argv[2] ?? 100);
const floor = rss();
row("bun with nothing loaded", floor);

await import("zod");
row("+ zod", rss());

const sdk = await import("../src/index.ts");
const afterImport = rss();
row("+ agent-accelerator (import)", afterImport, `catalog models: ${sdk.getCatalogStatus().modelCount} (not read yet)`);

const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const body = (): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  const chunks = [
    ...Array.from({ length: 30 }, () => frame({ id: "c", choices: [{ delta: { content: "hello world " } }] })),
    frame({ id: "c", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 60, total_tokens: 70 } }),
    "data: [DONE]\n\n",
  ];
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 2));
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
};
const fetchMock = (async () =>
  new Response(body(), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

const agent = new sdk.Agent({ model: "groq/bench", apiKey: "k", baseUrl: "http://localhost:1/v1", fetch: fetchMock });
sdk.getModelFromCatalog("google", "gemini-3.5-flash-lite");
row("+ one Agent and a catalog lookup", rss(), "(reads one shard)");

let peak = 0;
const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
const t0 = performance.now();
await Promise.all(
  Array.from({ length: streams }, (_, i) => agent.fork(`bench-${i}`).stream("hi", { sessionId: `bench-${i}` }).result())
);
clearInterval(sampler);
row(`peak with ${streams} streams in flight`, peak, `${(performance.now() - t0).toFixed(0)} ms, +${((peak - afterImport) / 1048576).toFixed(1)} MB over import`);
row("after they finished (gc)", rss());
