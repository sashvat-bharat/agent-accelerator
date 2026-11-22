# Security

> What the SDK protects, what you must do yourself, and its known limits.

## What the SDK does

| Area | Behavior | Control |
|---|---|---|
| API keys | A key is never sent to another vendor. A custom prefix needs its own key and address. Keys are not enumerable on errors. | `apiKey`, `env` |
| Request audit | Header names with key, token, secret, cookie or authorization, and values that look like credentials, are redacted. | `captureRaw`: `"redacted"` (default, no bodies), `true` (full bodies, for debugging), `false` |
| Local files | A local media path must resolve inside `roots`. `[]` denies all. Unset means unrestricted. | `fileAccess: { roots }` |
| URLs | A URL the model controls may not point to a private, loopback or link-local host, including what DNS returns. Redirects are re-checked and the size is capped. | Automatic |
| Tool errors | Stack frames are dropped. Absolute paths and URL credentials are removed. | `redactError` |
| Worker traces | Visible only to the agent that started the worker. Results are branded, so a tool cannot forge them. | Automatic |
| Sessions | The shape is checked on load. Files are created `0600` and folders `0700`. | `fileAccess` |

## Hardening checklist

- Set a finite `maxTurns`, a `limits.deadlineMs` and a `budget`.
- Set `fileAccess.roots`.
- Leave `captureRaw` at `"redacted"`.
- Make tools validate their own input and honor `ctx.signal`.
- Keep secrets out of `instructions`.
- Treat web content that a tool fetches as untrusted. It can try to give the model instructions.
- Log with `telemetryBus`.
- To require approval for a tool, use the `beforeTool` hook, or ask inside `execute` and refuse with `ctx.stop(reason)`. See [Tools](tools.md#ask-for-permission).

## Known limitations

The SDK is before version 1.0. Be aware of these:

- **One process per session folder.** A saved session is locked. A second process that opens the same session fails fast with a `ConfigError`. A lock left by a killed process is taken over. Local disks only. See [Sessions](sessions.md#one-process-per-session).
- **Durable writes.** Files are written with `fsync`, a `.bak` copy and an atomic rename, so a crash or power cut never leaves a half-written file. Telemetry files are appended without `fsync`.
- **Scheduled actions** run only while your process is alive, and only if the creating agent is still referenced. See [Scheduled actions](scheduled-actions.md#limits-to-know-about).
- **`thinking.budgetTokens`** is accepted but not forwarded to any provider.
- **History is sent again each turn.** Providers other than Google need the whole history on every call. With `persist.file` the whole snapshot is rewritten at each step. With `persist.dir` a journal is appended instead.
- **Memory.** An idle process that imported the SDK uses about 40 MB: Bun about 17 MB, `zod` about 10 MB and the SDK about 15 MB. The model catalog is read lazily and is small. 100 parallel streaming runs add about 17 MB at their peak. `bun run bench` measures both. The SDK is not yet tuned for very small hosts.
- **The address check** resolves DNS before it calls `fetch`, so a small DNS-rebinding window remains.
- **Local disk only.** Network drives are not supported.
