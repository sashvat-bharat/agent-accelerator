// What the live examples share: the models and `fail`. The models are `examples/models.json` in the exact
// `setModels` shape: edit that file to try other models (the ids must be real catalog ids).
// The environment holds API keys only; models are set in code.
import { listModels, setModels } from "agent-accelerator";
import models from "./models.json";

export { fail } from "./_helpers";

setModels(models);
/** The default main model of the examples (`default.model` of `models.json`). */
export const MODEL: string = listModels()!.default.model;
/** The default worker model of the examples (`default.sub_agent_model` of `models.json`). */
export const SUB_AGENT_MODEL: string = listModels()!.default.sub_agent_model;
