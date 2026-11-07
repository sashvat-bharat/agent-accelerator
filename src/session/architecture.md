# src/session/

Saving a conversation, its spending and its tool logs.

| File | What it is |
| :-- | :-- |
| `store.ts` | Snapshot format (`session.json`, one line per field and per turn), load validation, `SessionTelemetry`, media extraction, journal replay (`replayJournal`), and `priceUsage` (the one cost model, integer micro-USD). |
| `journal.ts` | `SessionJournal`: after each step appends one fsynced line to `journal.ndjson`; writes a fresh snapshot (new `epoch`) when history changed any other way or the journal passed 500 lines / 4 MB. |
| `usage.ts` | Pure spending accounting: `UsageTotals`, `usageLine`, `buildUsageReport`. No Agent import. |
| `tool-log.ts` | `ToolLogs`: one fsynced NDJSON file per tool call under `<session>/tool-logs/`. |

## Invariants
- Layout: `<home>/sessions/<id>/{session.json, journal.ndjson, media/, tool-logs/, workers/}`.
- A journal whose header epoch differs from the snapshot's is ignored on load.
- Journal record types: `base`, `msg`, `meta`, `run`, `end`, `tool`, `pending`, `usage`. Replay ignores unknown types, drops a torn last line, and stops at earlier damage with `session.journal_corrupt`.
- Media is content-addressed (`media/<kind>-h<hash>.<ext>`), written once, never deleted.
- Valid sessions over the load limits throw `SessionLoadError` and are never quarantined; only corrupt files are renamed `*.corrupt-<ts>`.
- Pricing: a provider-reported cost wins and is never rescaled; unknown pricing stays unknown, never $0; cache reads and writes are subsets of input.
- Never call `saveSessionDir` on a folder an Agent persists to.
