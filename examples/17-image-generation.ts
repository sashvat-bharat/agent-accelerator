/**
 * Agent Accelerator - Image generation
 *
 * One function makes pictures with a supported image model (`listImageModels()`), and every picture can be changed again:
 *
 *   1. Make a picture, save it, read its usage and cost.
 *   2. Ask for something the model cannot do: a wrong value is ONE error that lists every problem and what the model offers.
 *   3. A control the model does not have at all (quality on a Google model) is dropped with one warning, not an error.
 *   4. Edit the picture: the same Google model continues its stored conversation, another model gets it as a reference.
 *   5. Let a text agent make pictures with `imageTool` (its spending is in `usageReport()`).
 *
 * It also works as a smoke check: it asserts these contracts and exits with code 1 (one line on stderr) if one stops holding.
 *
 * Run:  bun run examples/17-image-generation.ts                   (offline: a scripted stand-in for the providers, no key, no cost)
 *       bun run examples/17-image-generation.ts --live <model>    (a REAL image model, e.g. google/gemini-nano-banana-2.1; costs money)
 * Pictures go to ./.agent-accel/demo-images/ (gitignored; wiped at the start).
 *
 * Note: this example does not import `_shared.ts`, because that file sets the model list for the live examples.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  Agent,
  ValidationError,
  generateImage,
  imageTool,
  listImageModels,
  resolveHome,
  telemetryBus,
} from "agent-accelerator";

const C = "\x1b[36m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const R = "\x1b[0m";
const head = (t: string) => console.log(`\n${C}━━━ ${t} ━━━${R}`);
const OUT = path.join(resolveHome(), "demo-images");

// One-line failure report, like `fail` in _shared.ts (which this example does not import).
const fail = (err: unknown): never => {
  console.error(`\n✖ ${(err as { message?: string } | undefined)?.message ?? err}\n`);
  process.exit(1);
};
const check = (ok: boolean, what: string): void => {
  if (!ok) fail(new Error(`contract broken: ${what}`));
  console.log(`${G}✓${R} ${what}`);
};

// A 1x1 PNG, so the offline run still saves a real picture.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const live = process.argv.includes("--live") ? process.argv[process.argv.indexOf("--live") + 1] : undefined;
if (process.argv.includes("--live") && !live)
  fail(new Error("--live needs a model, e.g. --live google/gemini-nano-banana-2.1"));

// The scripted providers: a Google interaction reply, and a chat reply that calls make_image once, then answers.
let interactions = 0;
// biome-ignore lint/suspicious/noExplicitAny: request bodies are read loosely in this demo
const requests: Array<{ url: string; body: any }> = [];
const offline = (async (url: string, init: { body: string }) => {
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
    const message = asked
      ? { role: "assistant", content: "Your logo is ready." }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "make_image", arguments: JSON.stringify({ prompt: "A logo for Bean There coffee" }) },
            },
          ],
        };
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
const conn = live ? {} : { apiKey: "demo-key", fetch: offline };

async function main(): Promise<void> {
  fs.rmSync(OUT, { recursive: true, force: true });
  const MODEL = live ?? "google/gemini-nano-banana-2.1";

  head("1. Make a picture");
  const first = await generateImage({
    ...conn,
    model: MODEL,
    prompt: "A nano banana dish in a fancy restaurant",
    aspectRatio: "16:9",
  });
  const file = await first.image.save(path.join(OUT, "banana"));
  console.log(`${file}  (${first.image.mimeType}, ${first.image.bytes.length} bytes)`);
  console.log(
    "usage:",
    first.usage.inputTokens,
    "in,",
    first.usage.outputTokens,
    "out, cost $",
    first.usage.cost?.totalCost ?? "unknown"
  );
  check(
    fs.existsSync(file) && path.extname(file) === ".png",
    "the picture is saved with the extension of its real type"
  );

  if (live) {
    head("Edit (live)");
    const edit = await first.image.edit("Make it night");
    console.log(await edit.image.save(path.join(OUT, "banana-night")));
    return;
  }

  head("2. A value the model cannot do is one clear error");
  try {
    await generateImage({ ...conn, model: MODEL, prompt: "x", aspectRatio: "7:1", resolution: "8K" as never });
    fail(new Error("contract broken: a bad ratio and tier were accepted"));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    console.log(`${Y}${err.message}${R}`);
    check(/7:1/.test(err.message) && /8K/.test(err.message), "one error lists every problem");
  }

  head("3. A control the model does not have is dropped with a warning");
  const warnings: string[] = [];
  const off = telemetryBus.onEvent((e) => {
    if (e.code === "provider_warning") warnings.push(e.message);
  });
  await generateImage({ ...conn, model: MODEL, prompt: "x", quality: "high" });
  off();
  check(!requests.at(-1)!.body.quality, "quality never reaches the wire");
  check(warnings.length === 1, "exactly one provider_warning");

  head("4. Edit the picture");
  const before = requests.length;
  const night = await first.image.edit("Make it night");
  check(
    requests[before]!.body.previous_interaction_id === "v1_1",
    "same Google model: the stored conversation continues, the picture is not sent again"
  );
  const viaOpenRouter = await night.image.edit("Add snow", { model: "openrouter/openai/gpt-image-2.6-flare" });
  const last = requests.at(-1)!.body;
  check(
    Array.isArray(last.input_references) && last.input_references.length === 1,
    "another model: the picture goes in as a reference image"
  );
  await viaOpenRouter.image.save(path.join(OUT, "banana-snow"));

  head("5. A text agent that makes pictures");
  const designer = new Agent({
    model: "groq/demo-chat",
    apiKey: "demo-key",
    baseUrl: "https://chat.demo/v1",
    fetch: offline,
    stateless: true,
    instructions: "You are a designer. Use make_image once, then say what you made.",
    tools: {
      make_image: imageTool({
        model: "openrouter/openai/gpt-image-2.6-flare",
        dir: OUT,
        maxImages: 2,
        defaults: { apiKey: "demo-key", fetch: offline },
      }),
    },
  });
  const res = await designer.run("A logo for a coffee shop called Bean There.");
  console.log(res.text);
  const report = designer.usageReport();
  check(
    report.workers.some((w) => w.role === "image"),
    "the tool's spending is a line of usageReport()"
  );
  console.log(
    "images made by the tool:",
    fs
      .readdirSync(OUT)
      .filter((f) => f.startsWith("a-logo"))
      .join(", ")
  );
  console.log("total cost $", report.total.cost.totalUsd, "| models you can use:", listImageModels().length);
  console.log(`\n${G}All contracts hold.${R}`);
}

main().catch(fail);
