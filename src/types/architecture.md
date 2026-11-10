# src/types/

Shared contracts. Types only, plus a few tiny helpers that belong to a type.

| File           | What it defines                                                                                                        |
| :------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `agent.ts`     | `AgentConfig`, `AgentRunOptions`, `DynamicSubagentsConfig`, `Budget`, `EditableAgentConfig`, run/turn event shapes.    |
| `core.ts`      | `ThinkingLevel`, `CacheOption` (+ `CACHE_OPTIONS`), `ServiceTier`, `TokenUsage`.                                       |
| `message.ts`   | `Message` and the content parts (text, image, audio, video, file, tool call/result, thinking), `ProviderSteps`.        |
| `model.ts`     | `ModelSpec`, `Provider`, `ProviderRequestOptions`, `ProviderGenerateResult`, structured-output spec.                   |
| `response.ts`  | `AgentResponse`, `FinishReason` + `normalizeFinishReason`, `StreamEvent`, worker metadata.                             |
| `tool.ts`      | `ToolDefinition`, `ToolExecutionContext` (`log`, `stop`, `emit`), call/result records, the truncated-arguments marker. |
| `scheduler.ts` | Scheduled-action input, record and delivery types.                                                                     |
| `errors.ts`    | The typed error family (`AgentAccelError` and subclasses), `isAbortError`.                                             |

## Invariants

- Adding a field to a public type is a public API change: update `README.md` and `docs/`.
- Abort means `signal.aborted` or `name === "AbortError"`, never a message match.
- Error messages are one line and ANSI-free.
- No logic here beyond `normalizeFinishReason`, `isTruncatedArguments` and the error classes.
