export const fail = (err: any): never => {
  console.error(`\n\u2716 ${err?.message ?? err}\n`);
  process.exit(1);
};

// v0.4.0: provider warnings go to telemetry bus + optional sink (console.warn kept for compat).
// Attach in demos to show warnings without scraping stdout.
export function attachWarnSink(prefix = "[warn]"): void {
  (globalThis as any).__agentAccelWarnSink = (msg: string) => {
    console.log(`${prefix} ${msg}`);
  };
}

// The models the examples use: `examples/models.json` in the exact `setModels` shape. Edit that file to try other models
// (the ids must be real catalog ids). The environment holds API keys only; models are set in code since 0.7.0.
import { setModels, listModels } from "agent-accelerator";
import models from "./models.json";

setModels(models);
/** The default main model of the examples (`default.model` of `models.json`). */
export const MODEL: string = listModels()!.default.model;
/** The default worker model of the examples (`default.sub_agent_model` of `models.json`). */
export const SUB_AGENT_MODEL: string = listModels()!.default.sub_agent_model;
