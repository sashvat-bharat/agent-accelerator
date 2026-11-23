export const fail = (err: unknown): never => {
  console.error(`\n\u2716 ${(err as { message?: string } | undefined)?.message ?? err}\n`);
  process.exit(1);
};

// The models the examples use: `examples/models.json` in the exact `setModels` shape. Edit that file to try other models
// (the ids must be real catalog ids). The environment holds API keys only; models are set in code since 0.7.0.
import { setModels, listModels, resolveModel, getModelFromCatalog } from "agent-accelerator";
import type { PersistedAgentSession, SessionTelemetry } from "agent-accelerator";
import models from "./models.json";

setModels(models);
/** The default main model of the examples (`default.model` of `models.json`). */
export const MODEL: string = listModels()!.default.model;
/** The default worker model of the examples (`default.sub_agent_model` of `models.json`). */
export const SUB_AGENT_MODEL: string = listModels()!.default.sub_agent_model;

// ---------------------------------------------------------------------------
// Status-line helpers for the chat demos: display only, built on public APIs.
// ---------------------------------------------------------------------------

/** A compact token count (`1.2k`, `3.4M`). */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) && n >= 0 ? n : 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return `${Math.floor(v)}`;
}

/** A cost with the precision that fits its size (`$0.0042`). */
export function formatCost(c?: number): string {
  if (!c || c <= 0) return "$0.00";
  if (c < 0.0001) return `$${c.toFixed(6)}`;
  if (c < 0.01) return `$${c.toFixed(4)}`;
  if (c < 1.0) return `$${c.toFixed(3)}`;
  return `$${c.toFixed(2)}`;
}

/** The context window of a `provider/model` string from the catalog, or 1M when the catalog does not know it. */
export function contextWindow(model: string): number {
  try {
    const { provider, modelId } = resolveModel(model);
    return getModelFromCatalog(provider.id, modelId)?.limit?.context ?? 1_048_576;
  } catch {
    // why: an unknown or disallowed model only means the status line shows the default window.
    return 1_048_576;
  }
}

/** The startup line of the chat demo: a resumed session or a new one. */
export function sessionBanner(
  saved: PersistedAgentSession | null,
  telemetry: SessionTelemetry,
  filePath: string
): string {
  const shortFile = filePath.split("/").pop() ?? filePath;
  if (!saved) return `\x1b[90mNew session \u2022 ${shortFile} (no prior history found)\x1b[0m`;
  const count = saved.messages.length;
  const level = saved.thinkingLevel ? ` \u2022 ${saved.thinkingLevel}` : "";
  const rate = telemetry.totalHitRate().toFixed(1);
  const id = (saved.sessionId ?? "").slice(0, 8);
  return (
    `\x1b[32m\u21ba Previous session loaded\x1b[0m \x1b[90m\u2022 ${id}\u2026 (${shortFile}) \u2022 ` +
    `${count} message${count === 1 ? "" : "s"} \u2022 ${saved.model || "unknown model"}${level} \u2022 ` +
    `total-CH${rate}% \u2022 ${formatCost(telemetry.totals.cost)} total\x1b[0m`
  );
}
