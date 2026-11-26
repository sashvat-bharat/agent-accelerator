// The scripted providers of examples/18-embeddings.ts: a toy "embedding" that counts a few words, so similar sentences get
// similar vectors. No network, no key, no cost.
/** The words the toy embedding counts: one number per word. */
export const WORDS: string[] = ["cat", "purr", "dog", "bark", "rust", "borrow", "compiler", "pet"];
const toy = (text: string): number[] => WORDS.map((w) => (text.toLowerCase().includes(w) ? 1 : 0) + 0.01);
// The text of an item as the Google adapter sends it (the task words in front are not part of the meaning).
const bare = (t: string): string => t.replace(/^(task: [^|]*\| query: |title: [^|]*\| text: )/, "");

/** Every request the scripted providers received. */
// biome-ignore lint/suspicious/noExplicitAny: request bodies are read loosely in the demos
export const requests: Array<{ url: string; body: any }> = [];

/** A `fetch` that answers like Google, OpenAI and OpenRouter do (OpenRouter's model list included). */
export const offline: typeof fetch = (async (url: string, init?: { body?: string }) => {
  if (url.endsWith("/embeddings/models")) {
    const model = {
      id: "nvidia/nemotron-3.5-embed-1b:free",
      context_length: 32768,
      architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
      pricing: { prompt: "0" },
    };
    return new Response(JSON.stringify({ data: [model] }), { status: 200 });
  }
  const body = JSON.parse(init?.body ?? "{}");
  requests.push({ url, body });
  if (url.includes(":batchEmbedContents")) {
    const texts = body.requests.map((r: { content: { parts: Array<{ text: string }> } }) =>
      bare(r.content.parts[0]!.text)
    );
    return new Response(
      JSON.stringify({
        embeddings: texts.map((t: string) => ({ values: toy(t) })),
        usageMetadata: {
          promptTokenCount: texts.length * 6,
          promptTokenDetails: [{ modality: "TEXT", tokenCount: texts.length * 6 }],
        },
      }),
      { status: 200 }
    );
  }
  const texts: string[] = body.input;
  return new Response(
    JSON.stringify({
      data: texts.map((t, index) => ({ object: "embedding", index, embedding: toy(t) })),
      usage: {
        prompt_tokens: texts.length * 6,
        total_tokens: texts.length * 6,
        ...(url.includes("openrouter") ? { cost: 0 } : {}),
      },
    }),
    { status: 200 }
  );
}) as unknown as typeof fetch;
