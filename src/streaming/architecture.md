# src/streaming/

| File              | What it is                                                                                                                                                                                                |
| :---------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event-stream.ts` | `AssistantMessageEventStream`: an async-iterable event stream with listeners (`on`/`off`), a `result()` promise, `cancel()` and bounded buffering. Providers produce it; the loop and `Agent` consume it. |
| `sse-parser.ts`   | `SSEParser`: incremental Server-Sent Events framing that survives events split across network chunks. Internal (not exported from the barrel).                                                            |

## Invariants

- The buffer holds at most 1000 events (oldest dropped, reported on the bus); an event over 1 MB is dropped. `{ buffer: false }` keeps none (for a caller that only wants `result()`).
- `end()` without a response fails the stream instead of leaving `result()` hanging.
- A cancel is recognised by the `AbortError` name only, never by message text.
- Breaking out of `for await` cancels the stream, which tears down the HTTP request.
- A throwing listener never breaks the stream; the first error is kept in `getListenerError()`.
