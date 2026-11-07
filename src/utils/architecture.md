# src/utils/

Small shared helpers. Each file has one job.

| File | What it does |
| :-- | :-- |
| `durable.ts` | The ONE disk writer (`writeFileDurable`: temp, fsync, `.bak`, rename, folder fsync), `readWithBackup`, and `lockFolder` (one process per folder, stale-lock takeover, temp sweep). |
| `home.ts` | `resolveHome` / `setHome`: the single folder everything is stored in. |
| `env.ts` | Process-env lookups and API key resolution. No `globalThis` fallback. |
| `headers.ts` | Session-affinity headers, opt-in attribution, browser stripping, package version fallback. |
| `media.ts` | Normalizes a path, URL, data URL, base64 or bytes to base64 and a MIME type; magic-byte sniffing. |
| `safe-io.ts` | `fileAccess.roots` containment and the guarded remote fetch (private hosts refused, redirects re-checked, size cap). |
| `raw-capture.ts` | The `captureRaw` policy for `AgentResponse.raw`. |
| `cache.ts` | Cache-key clamp (64 chars) and the central secret redaction. |
| `errors.ts` | `toConciseProviderError` and pre-network modality guards. |
| `retry.ts` | `withRetries`, `isTransientError`, `isRetryableRun`, `sleep`. Structured data only (status, code, flags), never message text. |
| `session.ts` | Id helpers (`createSessionId`, `hashSessionPart`, `createTrackingId`, run/turn ids), `parseModelRef`, `previewPrompt`. |
| `serialization.ts` | `toJsonSafe`, `safeStringify`, `escapeXml`. |
| `base64.ts`, `thought-signature.ts` | Runtime-agnostic base64; Gemini thought-signature helpers. |

## Invariants
- Never write state with a bare `writeFileSync`; use `writeFileDurable`.
- `media.ts` and `safe-io.ts` import `node:*` lazily so browser bundles keep working.
- Redaction is central (`cache.ts`); adapters must not keep their own deny-lists.
- `AGENT_ACCEL_HOME` is read at import time; `setHome()` after import relies on the catalog reload hook.
