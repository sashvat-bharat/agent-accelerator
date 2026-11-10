# src/tools/

Defining tools and running them.

| File                 | What it is                                                                                                                                                     |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool.ts`            | `tool()` factory, name validation, `toStandardToolDeclarations`, option normalizers.                                                                           |
| `schema.ts`          | Zod to JSON Schema, `$ref` resolution, `stripSchemaForGoogle`.                                                                                                 |
| `executor.ts`        | `executeToolCalls`: validation, concurrency (8 global + per-tool), attempts, timeout, result cap, error scrubbing, `ctx.stop`, `tool.*` events, per-call logs. |
| `subagent-result.ts` | The private-Symbol brand that marks a result as made by the SDK's delegation tools.                                                                            |

## Invariants

- Tool names match `^[a-zA-Z0-9_-]{1,64}$` and must not collide after normalization (checked in the `Agent` constructor).
- One attempt by default; only idempotent tools retry transient failures (what counts as transient is the one `isTransientError` in `utils/errors.ts`, shared with the provider retries); the timeout is best effort (`ctx.signal` is cooperative), and an uncooperative tool no longer holds an aborted run.
- Results are capped by serialized size (default 20000 chars); nested error stacks and absolute paths are scrubbed. The telemetry bus gets full detail, the model gets the scrubbed text.
- A truncated call (`{ __truncated_raw }`) never executes.
- `ctx.stop(reason)` throws a private signal; the batch finishes, then the loop ends the run as `stopped`.
- Only branded envelopes get their `_subagentMetadata` trusted; the executor passes them through untouched.
- Failures return `Error executing <name>: <msg>` plus a JSON block (attempts, timedOut, last progress, hint).
