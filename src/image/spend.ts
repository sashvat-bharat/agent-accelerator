/**
 * How an `imageTool` call tells the Agent that runs it what the call spent. The Agent registers a report for the call's
 * context object before it runs the tool; the tool calls it once the pictures are made. A tool run outside an Agent finds
 * no report and only makes the pictures. Internal: not exported from the package.
 */
import type { TokenUsage } from "../types/core.ts";

/** Where a picture call's price came from: the provider's reported cost or the SDK's price table. */
export type ImagePriceSource = "provider" | "catalog";

/** Receives what one image call spent (`source` undefined: the price is unknown). */
export type ImageCallReport = (usage: TokenUsage, source: ImagePriceSource | undefined) => void;

const reports = new WeakMap<object, ImageCallReport>();

/** Registers the Agent's report for one tool call, keyed by that call's context object. */
export function reportImageCallsTo(ctx: object, report: ImageCallReport): void {
  reports.set(ctx, report);
}

/** Hands one image call's spending to the Agent that registered for `ctx`; does nothing outside an Agent. */
export function reportImageCall(ctx: object, usage: TokenUsage, source: ImagePriceSource | undefined): void {
  reports.get(ctx)?.(usage, source);
}
