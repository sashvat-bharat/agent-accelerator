/**
 * `imageTool`: the image function as a normal tool, so a text agent can make pictures. The developer fixes the image model,
 * the defaults, which options the LLM may set (`allow`) and a cap on pictures; the tool checks the setup at creation, saves
 * every picture under `dir` (default `<home>/images`) and tells the model the file paths. Each call's spending goes to the
 * Agent that runs it (`spend.ts`): it counts toward that agent's `usageLimit` and `budget`, is saved with its session and is
 * listed by `agent.usageReport()` as an `image` line. With `show: true` the model also SEES the pictures (Google agents only).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { getImageModel, unsupportedImageModelReason } from "../models/image-models.ts";
import { resolveHome } from "../utils/home.ts";
import { ConfigError, ValidationError } from "../types/errors.ts";
import { toolContent } from "../tools/tool-content.ts";
import { tool } from "../tools/tool.ts";
import type { ToolDefinition } from "../types/tool.ts";
import type { ImageOptions } from "../types/image.ts";
import { generateImage, imagePriceSource } from "./generate.ts";
import { reportImageCall } from "./spend.ts";
import { resolveImageRequest } from "./request.ts";

/** The options the LLM may be given (`allow`); `prompt` is always given. */
export type ImageToolOption = "aspectRatio" | "resolution" | "quality" | "format" | "background" | "thinking";

/** What `imageTool` takes. */
export interface ImageToolOptions {
  /** The image model, a `provider/model` string from `listImageModels()`: the developer's choice, never the LLM's. */
  model: string;
  /** Tool name the LLM sees. Default `"make_image"` (the record key wins when used in a `tools` record). */
  name?: string;
  /** What the tool description says it does. A default is used when omitted. */
  description?: string;
  /** Where pictures are saved. Default `<home>/images`. */
  dir?: string;
  /** Options fixed for every call (the LLM cannot change them), plus connection settings (`apiKey`, `baseUrl`, `fetch`, `retry` ...). */
  defaults?: Omit<ImageOptions, "model" | "prompt" | "images" | "continueFrom" | "signal" | "n">;
  /** Which options the LLM may set besides the prompt. Default: none. */
  allow?: ImageToolOption[];
  /** At most this many pictures over the life of this tool object (in this process); later calls fail with a message to the model. Default 8. For a cap that survives a restart, use the agent's `usageLimit` or `budget`. */
  maxImages?: number;
  /** Also show the pictures to the model (Google agents see them; other providers get the text only with one warning). Default false. */
  show?: boolean;
}

const DEFAULT_MAX_IMAGES = 8;

// A short file-name stem from the prompt: lower-case words joined with "-", at most 40 characters; in: the LLM's prompt, out: part of the file name.
function slug(prompt: string): string {
  const s = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "image";
}

// The first free `<stem>-<k>` path (k from 1) in `dir` for this extension; in: the saving loop, out: a path nothing exists at.
function freePath(dir: string, stem: string, ext: string): string {
  for (let k = 1; ; k++) {
    const file = path.join(dir, `${stem}-${k}${ext}`);
    if (!fs.existsSync(file)) return file;
  }
}

/**
 * Creates a tool that makes pictures with `model` and saves them to `dir`. Throws `ConfigError` for an unsupported model or an
 * `allow` entry the model lacks, and `ValidationError` for `defaults` the model cannot take, so a wrong setup fails at
 * construction, not in the middle of a paid run.
 *
 * @example `tools: { make_image: imageTool({ model: "openai/gpt-image-2.6-flare", allow: ["aspectRatio"], maxImages: 4 }) }`
 */
export function imageTool(options: ImageToolOptions): ToolDefinition {
  const def = getImageModel(String(options?.model ?? ""));
  if (!def)
    throw new ConfigError(
      `[Agent Accelerator] imageTool: ${unsupportedImageModelReason(String(options?.model ?? "")) ?? "no model given."}`
    );
  const allow = options.allow ?? [];
  const max = options.maxImages ?? DEFAULT_MAX_IMAGES;
  if (!(Number.isInteger(max) && max > 0))
    throw new ConfigError("[Agent Accelerator] imageTool: maxImages must be a whole number above 0.");
  // The defaults must be valid for this model now (this throws a ValidationError listing every problem).
  resolveImageRequest({ ...options.defaults, model: def.model, prompt: "check" }, def);

  // The input the LLM fills in: the prompt, and an enum of what THIS model accepts for each allowed option.
  const shape: Record<string, z.ZodTypeAny> = {
    prompt: z.string().min(1).describe("What the picture shows, in detail."),
  };
  const lacks: string[] = [];
  const pick = (key: ImageToolOption, values: readonly string[] | undefined, text: string): void => {
    if (!allow.includes(key)) return;
    if (!values || values.length === 0) return void lacks.push(key);
    shape[key] = z
      .enum(values as [string, ...string[]])
      .optional()
      .describe(text);
  };
  pick(
    "aspectRatio",
    def.aspectRatios === "any"
      ? ["1:3", "1:2", "9:16", "2:3", "3:4", "1:1", "4:3", "3:2", "16:9", "2:1", "3:1"]
      : def.aspectRatios,
    "Shape of the picture."
  );
  pick("resolution", def.resolutions, "Size tier.");
  pick("quality", def.quality, "Quality; higher costs more.");
  pick("format", def.formats, "File type.");
  pick("background", def.backgrounds, "Background.");
  pick("thinking", def.thinking?.levels, "How much the model thinks first.");
  if (lacks.length > 0)
    throw new ConfigError(`[Agent Accelerator] imageTool: ${def.model} has no ${lacks.join(", ")} to allow.`);

  let made = 0;
  const defn = tool({
    name: options.name ?? "make_image",
    description:
      options.description ??
      `Makes a picture from a text description and saves it as a file. Returns the file path(s). Costs money: describe the whole picture in one call and do not repeat a call that worked.`,
    input: z.object(shape),
    maxConcurrency: 2,
    execute: async (input: Record<string, unknown>, ctx) => {
      if (made >= max)
        throw new ValidationError(`The picture limit of this tool (${max}) is used up; do not call it again.`);
      made += 1; // counted before the request: a failing call may still have been charged
      const { prompt, ...asked } = input as { prompt: string } & Partial<Record<ImageToolOption, string>>;
      const result = await generateImage({
        ...options.defaults,
        ...Object.fromEntries(Object.entries(asked).filter(([, v]) => v !== undefined)),
        model: def.model,
        prompt,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      reportImageCall(ctx, result.usage, imagePriceSource(result)); // to the Agent running this call, if any
      const dir = path.resolve(options.dir ?? path.join(resolveHome(), "images"));
      const stem = slug(prompt);
      const files: string[] = [];
      for (const image of result.images) files.push(await image.save(freePath(dir, stem, image.extension)));
      const text = `Saved: ${files.join(", ")}`;
      return options.show ? toolContent([text, ...result.images.map((i) => i.toPart())]) : text;
    },
  });
  return Object.assign(defn, { imageSpend: { model: def.model } });
}
