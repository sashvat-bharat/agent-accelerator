import { describe, it, expect } from "bun:test";
import { generateImage, ConfigError, ValidationError, GeneratedImage } from "../src/index.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const NB = "google/gemini-nano-banana-2.1";
const LITE = "google/gemini-3.1-flash-lite-image";
const OR = "openrouter/openai/gpt-image-2.6-flare";

function stub(handler: (n: number, body: any) => Response) {
  const calls: Array<{ url: string; body: any }> = [];
  const fn = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return handler(calls.length, body);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const google = (id: string) =>
  new Response(
    JSON.stringify({
      id,
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "image", data: b64(PNG), mime_type: "image/png" }] }],
      usage: { total_input_tokens: 5, total_output_tokens: 1120, total_tokens: 1125, output_tokens_by_modality: [{ modality: "image", tokens: 1120 }] },
    }),
    { status: 200 }
  );
const openrouter = () =>
  new Response(JSON.stringify({ data: [{ b64_json: b64(PNG), media_type: "image/png" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.01 } }), { status: 200 });

describe("image.edit()", () => {
  it("Google, same model: continues the stored interaction and does not resend the picture", async () => {
    const s = stub((n) => google(`v1_${n}`));
    const first = await generateImage({ model: NB, prompt: "A fox", apiKey: "key-1", fetch: s.fn });
    const second = await first.image.edit("Make it night");
    expect(s.calls[1]!.body.previous_interaction_id).toBe("v1_1");
    expect(s.calls[1]!.body.input).toEqual([{ type: "text", text: "Make it night" }]); // no image block
    expect(s.calls[0]!.body.previous_interaction_id).toBeUndefined();
    // the edit reuses the connection settings and chains on: a third edit continues from the second
    await second.image.edit("Add snow");
    expect(s.calls[2]!.body.previous_interaction_id).toBe("v1_2");
  });

  it("Google, different model: the picture goes in as a reference instead", async () => {
    const s = stub((n) => google(`v1_${n}`));
    const first = await generateImage({ model: NB, prompt: "A fox", apiKey: "k", fetch: s.fn });
    await first.image.edit("Make it night", { model: LITE });
    expect(s.calls[1]!.body.previous_interaction_id).toBeUndefined();
    expect(JSON.stringify(s.calls[1]!.body.input)).toContain(b64(PNG));
  });

  it("OpenRouter: the picture is the first reference, ahead of the developer's own", async () => {
    const s = stub(() => openrouter());
    const first = await generateImage({ model: OR, prompt: "A fox", apiKey: "k", fetch: s.fn });
    const other = `data:image/png;base64,${b64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7]))}`;
    await first.image.edit("Merge", { images: [other] });
    const refs = s.calls[1]!.body.input_references;
    expect(refs).toHaveLength(2);
    expect(refs[0].image_url.url).toBe(first.image.dataUrl);
    expect(refs[1].image_url.url).toBe(other);
  });

  it("counts the picture against the model's reference limit", async () => {
    const s = stub(() => openrouter());
    const first = await generateImage({ model: OR, prompt: "x", apiKey: "k", fetch: s.fn });
    const sixteen = Array.from({ length: 16 }, () => first.image);
    await expect(first.image.edit("x", { images: sixteen })).rejects.toBeInstanceOf(ValidationError);
    expect(s.calls).toHaveLength(1);
  });

  it("a picture not made by generateImage needs a model; with one it works as a reference", async () => {
    const loose = new GeneratedImage(PNG, "image/png");
    await expect(loose.edit("x")).rejects.toBeInstanceOf(ConfigError);
    const s = stub(() => openrouter());
    await loose.edit("x", { model: OR, apiKey: "k", fetch: s.fn });
    expect(s.calls[0]!.body.input_references).toHaveLength(1);
  });

  it("does not leak the key or the chain id through JSON", async () => {
    const s = stub(() => google("v1_secretchain"));
    const r = await generateImage({ model: NB, prompt: "x", apiKey: "key-secret-0123456789", fetch: s.fn });
    expect(JSON.stringify(r.image)).not.toMatch(/key-secret|v1_secretchain/);
  });
});
