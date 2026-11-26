// The scripted providers of examples/17-image-generation.ts: a Google interaction reply, an images-API reply and a chat
// reply that calls make_image once, then answers. No network, no key, no cost.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="; // a 1x1 PNG

let interactions = 0;

/** Every request the scripted providers received. */
// biome-ignore lint/suspicious/noExplicitAny: request bodies are read loosely in the demos
export const requests: Array<{ url: string; body: any }> = [];

/** A `fetch` that answers like the providers do. */
export const offline: typeof fetch = (async (url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  requests.push({ url, body });
  if (url.endsWith("/interactions")) {
    interactions += 1;
    return new Response(
      JSON.stringify({
        id: `v1_${interactions}`,
        status: "completed",
        steps: [{ type: "model_output", content: [{ type: "image", data: PNG_B64, mime_type: "image/png" }] }],
        usage: {
          total_input_tokens: 12,
          total_output_tokens: 1120,
          total_tokens: 1132,
          output_tokens_by_modality: [{ modality: "image", tokens: 1120 }],
        },
      }),
      { status: 200 }
    );
  }
  if (url.endsWith("/chat/completions")) {
    const asked = (body.messages as Array<{ role: string }>).some((m) => m.role === "tool");
    const call = {
      id: "call_1",
      type: "function",
      function: { name: "make_image", arguments: JSON.stringify({ prompt: "A logo for Bean There coffee" }) },
    };
    const message = asked
      ? { role: "assistant", content: "Your logo is ready." }
      : { role: "assistant", content: null, tool_calls: [call] };
    return new Response(
      JSON.stringify({
        id: "r",
        choices: [{ finish_reason: asked ? "stop" : "tool_calls", message }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return new Response(
    JSON.stringify({
      data: [{ b64_json: PNG_B64, media_type: "image/png" }],
      usage: { prompt_tokens: 12, completion_tokens: 1756, total_tokens: 1768, cost: 0.0527 },
    }),
    { status: 200 }
  );
}) as unknown as typeof fetch;
