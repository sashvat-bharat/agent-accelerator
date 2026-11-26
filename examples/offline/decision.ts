// The scripted providers of examples/19-decisions.ts: a toy "model" that answers from a few words in the input. Each wire has
// its own shape (Google and OpenRouter share one, OpenAI has its own). No network, no key, no cost.
type Q = { type: string; instructions: string; criteria?: unknown; name?: string; choices?: Array<{ value: string }> };
const has = (text: string, w: string): boolean => text.toLowerCase().includes(w);

// One answer in the shared (Google/OpenRouter) shape.
function answer(text: string, q: Q): Record<string, unknown> {
  if (has(q.instructions, "decline")) return { type: "refusal" };
  if (q.type === "noul") return { type: "noul", noul: has(text, "charged twice") ? 0.97 : 0.04 };
  if (q.type === "choice") {
    const names = Object.keys(q.criteria as Record<string, string>);
    const top = has(text, "charged") ? "billing" : names[0]!;
    const rest = (1 - 0.9) / (names.length - 1);
    return {
      type: "choice",
      choice: top,
      probabilities: Object.fromEntries(names.map((n) => [n, n === top ? 0.9 : rest])),
      confidence: 0.9,
    };
  }
  return {
    type: "score",
    score: 1.7,
    probabilities: { "0": 0.05, "1": 0.25, "2": 0.7 },
    legend: { "0": "Low", "1": "Medium", "2": "High" },
    confidence: 0.7,
  };
}

/** Every request the scripted providers received. */
// biome-ignore lint/suspicious/noExplicitAny: request bodies are read loosely in the demos
export const requests: Array<{ url: string; body: any }> = [];

/** A `fetch` that answers like Google, OpenAI and OpenRouter do (OpenRouter's model list included). */
export const offline: typeof fetch = (async (url: string, init?: { body?: string }) => {
  if (url.includes("/models?")) {
    const model = {
      id: "perplexity/pplx-decider-flash-v1.3:free",
      context_length: 262144,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["decisions"] },
      pricing: { prompt: "0" },
      endpoints: ["/api/alpha/decisions"],
    };
    return new Response(JSON.stringify({ data: [model] }), { status: 200 });
  }
  const body = JSON.parse(init?.body ?? "{}");
  requests.push({ url, body });
  if (url.includes("openai.com")) {
    // OpenAI: an ARRAY of questions in, an ARRAY of answers out (predicate, probabilities as lists).
    const text: string = typeof body.input === "string" ? body.input : "";
    const answers = (body.questions as Q[]).map((q) => {
      const a = answer(text, {
        type: q.type === "predicate" ? "noul" : q.type,
        instructions: q.instructions,
        criteria: Object.fromEntries((q.choices ?? []).map((c) => [c.value, ""])),
      });
      if (a["type"] === "refusal") return { type: "refusal", name: q.name };
      if (q.type === "predicate") return { type: "predicate", name: q.name, probability: a["noul"] };
      const probs = a["probabilities"] as Record<string, number>;
      const list = Object.entries(probs).map(([value, probability]) => ({ value, label: value, probability }));
      return { ...a, name: q.name, probabilities: list };
    });
    const usage = { input_tokens: 40, output_tokens: 3, total_tokens: 43 };
    return new Response(JSON.stringify({ answers, usage }), { status: 200 });
  }
  // Google and OpenRouter: a map of questions in, a map of answers out.
  const text: string = typeof (body.input ?? body.state) === "string" ? (body.input ?? body.state) : "";
  const answers = Object.fromEntries(
    Object.entries(body.questions as Record<string, Q>).map(([k, q]) => [k, answer(text, q)])
  );
  const usage = url.includes("openrouter")
    ? { input_tokens: 40, output_tokens: 3, cost: 0 }
    : { total_input_tokens: 40, total_output_tokens: 0, total_tokens: 40 };
  return new Response(JSON.stringify({ answers, usage }), { status: 200 });
}) as unknown as typeof fetch;
