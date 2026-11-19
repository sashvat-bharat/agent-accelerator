/**
 * Checks an embedding request against what the chosen model supports (`models/embedding-models.ts`) and turns it into the one
 * request the rest of the call works from. Pure: no network, no files. A value the model cannot take (an input kind it does not
 * read, a vector length outside its range, a part count over its limit) is a problem that fails the whole call with ONE
 * `ValidationError` listing every problem; a control the model does not have at all (`task` on a model with none) becomes a warning
 * and is dropped, so the same code keeps working across models. Token counts are not checked here (the SDK has no tokenizer):
 * the provider's own error says when an input is too long.
 */
import { ValidationError } from "../types/errors.ts";
import type { EmbeddingInputKind, EmbeddingModelInfo } from "../models/embedding-models.ts";
import { EMBEDDING_TASKS, type EmbeddingOptions, type EmbeddingPart, type EmbeddingTask } from "../types/embedding.ts";

/** A control the model does not have: reported once on the bus by the caller, then dropped. */
export interface EmbeddingWarning {
  capability: string;
  requested: string;
  reason: string;
  fallback: string;
}

/** The request after the checks: every item is a list of parts (one vector each), the values are final. */
export interface ResolvedEmbeddingRequest {
  def: EmbeddingModelInfo;
  items: EmbeddingPart[][];
  dimensions?: number;
  task?: EmbeddingTask;
  title?: string;
  /** The kinds of input the items carry (what the price depends on). */
  kinds: ReadonlySet<EmbeddingInputKind>;
}

// The input kind of a part (a `file` is a PDF), or undefined for a part type this call does not know; in: item normalization, out: the kind.
function kindOf(part: { type?: unknown }): EmbeddingInputKind | undefined {
  switch (part.type) {
    case "text":
    case "image":
    case "audio":
    case "video":
      return part.type;
    case "file":
      return "pdf";
    default:
      return undefined;
  }
}

// The media value of a part (`image`, `audio`, `video` or `file`), or undefined when it has none; in: item normalization, out: the value.
function mediaOf(part: EmbeddingPart): unknown {
  return part.type === "text" ? undefined : (part as unknown as Record<string, unknown>)[part.type];
}

/**
 * Checks `opts` against `def` and returns the final request and the warnings. Throws one `ValidationError` that lists
 * every problem (so one fix round is enough).
 */
export function resolveEmbeddingRequest(
  opts: EmbeddingOptions,
  def: EmbeddingModelInfo
): { request: ResolvedEmbeddingRequest; warnings: EmbeddingWarning[] } {
  const problems: string[] = [];
  const warnings: EmbeddingWarning[] = [];
  const drop = (capability: string, requested: string, reason: string): void =>
    void warnings.push({ capability, requested, reason, fallback: "the model's default (the option is not sent)" });

  // Items: one item or a list; a string, one part or `{ parts }`; each ends as a list of parts.
  const list = Array.isArray(opts.input) ? opts.input : opts.input === undefined ? undefined : [opts.input];
  const items: EmbeddingPart[][] = [];
  const kinds = new Set<EmbeddingInputKind>();
  if (!list || list.length === 0) problems.push("input: required, a string, a part or a non-empty list of them.");
  (list ?? []).forEach((raw, i) => {
    const at = `input[${i}]`;
    const parts: unknown[] | undefined =
      typeof raw === "string"
        ? [{ type: "text", text: raw }]
        : raw && typeof raw === "object" && Array.isArray((raw as { parts?: unknown }).parts)
          ? (raw as { parts: unknown[] }).parts
          : raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string"
            ? [raw]
            : undefined;
    if (!parts)
      return void problems.push(`${at}: expected a string, a part like { type: "image", image } or { parts: [...] }.`);
    if (parts.length === 0) return void problems.push(`${at}: has no parts.`);
    if (parts.length > 1 && def.inputs.length === 1)
      return void problems.push(
        `${at}: ${def.model} cannot combine several parts into one vector; send them as separate items.`
      );
    const counts: Partial<Record<EmbeddingInputKind, number>> = {};
    for (const [j, part] of parts.entries()) {
      const where = parts.length > 1 ? `${at}.parts[${j}]` : at;
      const kind = part && typeof part === "object" ? kindOf(part as { type?: unknown }) : undefined;
      if (!kind) {
        problems.push(`${where}: unknown part type ${JSON.stringify((part as { type?: unknown } | null)?.type)}.`);
        continue;
      }
      if (!def.inputs.includes(kind)) {
        problems.push(`${where}: ${def.model} cannot read ${kind}. It reads: ${def.inputs.join(", ")}.`);
        continue;
      }
      if (kind === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text !== "string" || !text.trim()) problems.push(`${where}: text is empty.`);
      } else {
        const media = mediaOf(part as EmbeddingPart);
        if (!(typeof media === "string" && media) && !(media instanceof Uint8Array) && !(media instanceof ArrayBuffer))
          problems.push(`${where}: the ${kind} is missing (a path, a URL, a data URL, base64 or bytes).`);
      }
      counts[kind] = (counts[kind] ?? 0) + 1;
      kinds.add(kind);
    }
    const { images, pdfFiles } = def.limits;
    if (images !== undefined && (counts.image ?? 0) > images)
      problems.push(`${at}: ${counts.image} images; this model takes at most ${images} per vector.`);
    if (pdfFiles !== undefined && (counts.pdf ?? 0) > pdfFiles)
      problems.push(`${at}: ${counts.pdf} PDFs; this model takes at most ${pdfFiles} per vector.`);
    items.push(parts as EmbeddingPart[]);
  });

  // Vector length.
  let dimensions = opts.dimensions;
  if (dimensions !== undefined) {
    const d = def.dimensions;
    if (!Number.isInteger(dimensions) || dimensions < 1) {
      problems.push(`dimensions: must be a whole number above 0; got ${JSON.stringify(dimensions)}.`);
      dimensions = undefined;
    } else if (d && !d.shortenable) {
      if (dimensions !== d.default)
        problems.push(`dimensions: ${def.model} always makes ${d.default} numbers; it cannot be shortened.`);
      dimensions = undefined; // its own length: nothing to send
    } else if (d && ((d.min !== undefined && dimensions < d.min) || (d.max !== undefined && dimensions > d.max))) {
      problems.push(
        `dimensions: ${dimensions} is outside what ${def.model} makes (${d.min ?? 1} to ${d.max ?? d.default}${d.recommended ? `; recommended ${d.recommended.join(", ")}` : ""}).`
      );
    }
  }

  // Task and title.
  let task = opts.task;
  if (task !== undefined && !EMBEDDING_TASKS.includes(task)) {
    problems.push(`task: "${String(task)}" is not one of: ${EMBEDDING_TASKS.join(", ")}.`);
    task = undefined;
  } else if (task !== undefined && def.task === "none") {
    drop("task", task, "this model has no task control.");
    task = undefined;
  }
  let title = opts.title;
  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) {
      problems.push("title: must be a non-empty string.");
      title = undefined;
    } else if (def.provider !== "google" || task !== "search_document") {
      drop(
        "title",
        title,
        def.provider !== "google"
          ? "only Google models take a document title."
          : 'a title is used only with task "search_document".'
      );
      title = undefined;
    }
  }

  if (problems.length > 0)
    throw new ValidationError(
      `[Agent Accelerator] Invalid embedding request for ${def.model} (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.map((p, i) => `(${i + 1}) ${p}`).join(" ")}`,
      { provider: def.provider, model: def.id }
    );

  const request: ResolvedEmbeddingRequest = { def, items, kinds };
  if (dimensions !== undefined) request.dimensions = dimensions;
  if (task !== undefined) request.task = task;
  if (title !== undefined) request.title = title.trim();
  return { request, warnings };
}
