# Prompts

The SDK puts a few prompts of its own in front of the model: the reasoning directive, the refusals the executor sends back when a tool call is wrong, the headers of worker replies, the manuals of the `subagents` and `scheduled_actions` tools, and a few more. They live as plain `.md` files in `src/prompts/`, and `DEFAULT_PROMPTS` holds their text, so you can read exactly what the model sees. `AgentConfig.prompts` replaces single ones for one agent.

**Keeping the original prompt is recommended.** The shipped text is what the SDK is tested with. Treat it as the reference: copy a prompt, change what you must, and keep the parts that tell the model how to use a tool or recover from an error.

```ts
import { Agent, DEFAULT_PROMPTS } from "agent-accelerator";

console.log(DEFAULT_PROMPTS.toolSchemaError); // read the original

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  prompts: {
    toolNotFound: "Unknown tool '{{tool}}'.{{suggestion}} Use only the tools you were given.",
  },
});
```

Every prompt you leave out keeps its default. An unknown name or an empty text throws a `ConfigError` when the agent is built. Workers (the `subagents` tool, `agent.workers`, scheduled actions) inherit the overrides.

## The prompts

`{{name}}` marks a value the SDK fills in. A marker you leave out of your text is simply not filled; a marker the SDK does not know stays as written.

| Name | Where the model sees it | Placeholders |
|---|---|---|
| `reasoningDirective` | End of the system prompt, when thinking is on | none |
| `structuredOutput` | System prompt, only for a model without native JSON output (after a `[Structured Output]` line) | `{{schema}}` |
| `additionalContext` | Start of a user turn that has `additionalContext` (then a blank line) | `{{context}}` |
| `toolBridge` | A short assistant turn between a tool result and the next user message, on OpenRouter and compatible endpoints | none |
| `toolTruncatedArguments` | Result of a call whose streamed arguments never parsed | `{{tool}}` |
| `toolNotFound` | Result of a call to an unknown tool | `{{tool}}`, `{{suggestion}}` (" Did you mean 'x'?" or empty) |
| `toolSchemaError` | Result of a call whose arguments fail the tool's schema | `{{tool}}`, `{{detail}}`, `{{keys}}`, `{{expected}}` |
| `toolRepeatBlocked` | Result of the 3rd identical call in a row (the result also carries `errorCode: "repeat_blocked"`) | `{{tool}}` |
| `toolInterrupted` | Result placed behind a call a crash or interrupt left without one | `{{tool}}`, `{{id}}` |
| `workerReplied`, `workerFailed` | The header of a `subagents` spawn/message answer | `{{id}}`, `{{text}}` / `{{reason}}` |
| `subagentsTool` | The `subagents` tool description | `{{TOOLS}}`, `{{LIMIT}}` |
| `scheduledActionsTool` | The `scheduled_actions` tool description | `{{TOOLS}}` |

## Caching

`reasoningDirective`, `structuredOutput` and the two tool manuals are part of the cached prompt prefix. Set them once in the config, not per run, so the prefix stays stable.

## For AI agents

- `prompts` is `Partial<Record<PromptName, string>>`; `DEFAULT_PROMPTS` is a frozen `Record<PromptName, string>`; `PromptName` and `PromptOverrides` are exported types.
- Not editable by an agent through `toConfig`/`fromConfig` (only `model`, `instructions`, `tools` are).
- The tool-result texts keep their machine-readable parts out of the prompt: `repeat_blocked` is also an `errorCode`, and the `[worker <id>]` header is only text for the model.
- Do not rely on a prompt change for safety: it is advice to the model, not enforcement.
