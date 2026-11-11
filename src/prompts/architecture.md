# src/prompts/

The prompts the SDK itself puts in front of the model, as plain `.md` files, so they can be read, copied and replaced.

| File                                                                                                                        | What it is                                                                                                                                                                         |
| :-------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompts.ts`                                                                                                                | `DEFAULT_PROMPTS` (the shipped text, read once at load, final newline removed), `resolvePrompts` (defaults + `AgentConfig.prompts`, validated), `fillPrompt` (`{{name}}` markers). |
| `reasoning-directive.md`, `structured-output.md`, `additional-context.md`, `tool-bridge.md`                                 | Text added to the system prompt, a user turn or a history gap.                                                                                                                     |
| `tool-truncated-arguments.md`, `tool-not-found.md`, `tool-schema-error.md`, `tool-repeat-blocked.md`, `tool-interrupted.md` | The refusals the executor and the loop send back as tool results.                                                                                                                  |
| `worker-replied.md`, `worker-failed.md`                                                                                     | The header of a `subagents` answer.                                                                                                                                                |
| `subagents-tool.md`, `scheduled-actions-tool.md`                                                                            | The manuals that are the descriptions of the `subagents` and `scheduled_actions` tools.                                                                                            |

## Invariants

- One file per prompt; the name in `FILES` (`prompts.ts`) is the public name. Add a prompt by adding a file, a `FILES` entry, its use, a row in `docs/guides/prompts.md` and a pinned-text assertion in `test/prompts.test.ts`.
- The default text is pinned exactly by a test: reflowing a file (an editor or formatter) changes what the model sees and the prompt cache, so the test must fail.
- Every user of a prompt reads it from the Agent's resolved prompts (`agent.prompts`, `loop` config `prompts`, `ProviderRequestOptions.prompts`, executor `prompts`), never from `DEFAULT_PROMPTS` directly, except as the default of an optional parameter.
- Machine-readable parts stay in code: the `repeat_blocked` `errorCode`, the `[Structured Output]` marker line.
- The system prompt carries no delegation text (cache-stable): tool manuals are tool descriptions.
