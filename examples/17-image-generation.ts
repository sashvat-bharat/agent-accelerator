// Image generation: one function makes pictures with a supported image model (`listImageModels()`), and every picture can be edited.
//
//   1. Make a picture, save it, read its usage and cost.
//   2. Ask for something the model cannot do: a wrong value is ONE error that lists every problem and what the model offers.
//   3. A control the model does not have at all (quality on a Google model) is dropped with one warning, not an error.
//   4. Edit the picture: the same Google model continues its stored conversation, another model gets it as a reference.
//   5. Let a text agent make pictures with `imageTool` (its spending is in `usageReport()`).
//
// It also works as a smoke check: it asserts these contracts and exits with code 1 if one stops holding.
//
// Run: bun run examples/17-image-generation.ts                  (offline: scripted providers, no key, no cost)
//      bun run examples/17-image-generation.ts --live <model>   (a REAL image model, e.g. google/gemini-nano-banana-2.1; costs money)
// Pictures go to .agent-accel/demo-images/ (gitignored, wiped at the start).
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
import { check, fail, liveModel } from "./_helpers";
import { offline, requests } from "./offline/image";

const OUT = path.join(resolveHome(), "demo-images");
const live = liveModel("google/gemini-nano-banana-2.1");
const conn = live ? {} : { apiKey: "demo-key", fetch: offline };
const MODEL = live ?? "google/gemini-nano-banana-2.1";

async function main(): Promise<void> {
  fs.rmSync(OUT, { recursive: true, force: true }); // the demo owns this folder

  console.log("1. Make a picture");
  const first = await generateImage({
    ...conn,
    model: MODEL,
    prompt: "A nano banana dish in a fancy restaurant",
    aspectRatio: "16:9",
  });
  const file = await first.image.save(path.join(OUT, "banana"));
  console.log(`${file} (${first.image.mimeType}, ${first.image.bytes.length} bytes)`);
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
    const edit = await first.image.edit("Make it night");
    console.log("edited:", await edit.image.save(path.join(OUT, "banana-night")));
    return;
  }

  console.log("\n2. A value the model cannot do is one clear error");
  try {
    await generateImage({ ...conn, model: MODEL, prompt: "x", aspectRatio: "7:1", resolution: "8K" as never });
    fail(new Error("contract broken: a bad ratio and tier were accepted"));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    console.log(err.message);
    check(/7:1/.test(err.message) && /8K/.test(err.message), "one error lists every problem");
  }

  console.log("\n3. A control the model does not have is dropped with a warning");
  const warnings: string[] = [];
  const off = telemetryBus.onEvent((e) => e.code === "provider_warning" && warnings.push(e.message));
  await generateImage({ ...conn, model: MODEL, prompt: "x", quality: "high" });
  off();
  check(!requests.at(-1)!.body.quality, "quality never reaches the wire");
  check(warnings.length === 1, "exactly one provider_warning");

  console.log("\n4. Edit the picture");
  const before = requests.length;
  const night = await first.image.edit("Make it night");
  check(
    requests[before]!.body.previous_interaction_id === "v1_1",
    "same Google model: the stored conversation continues, the picture is not sent again"
  );
  const snow = await night.image.edit("Add snow", { model: "openrouter/openai/gpt-image-2.6-flare" });
  const last = requests.at(-1)!.body;
  check(
    Array.isArray(last.input_references) && last.input_references.length === 1,
    "another model: the picture goes in as a reference image"
  );
  await snow.image.save(path.join(OUT, "banana-snow"));

  console.log("\n5. A text agent that makes pictures");
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
  console.log("total cost $", report.total.cost.totalUsd, "| image models you can use:", listImageModels().length);
  console.log("\nAll contracts hold.");
}

main().catch(fail);
