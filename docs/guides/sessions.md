# Sessions

> Save a conversation, continue it later, and survive a crash.

## Save and continue

Turn on `persist` and the SDK saves the conversation after every step.

```ts
import { Agent, findLatestSessionDir, loadSessionDir } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  persist: { dir: "sessions" }, // saves sessions/<sessionId>/
});

// Continue where you left off:
const latest = findLatestSessionDir("sessions");
const saved = latest ? loadSessionDir(latest) : null;
if (saved) agent.importSession(saved.session);

const res = await agent.run("Continue our conversation.");
console.log(res.text);
```

Use one `sessionId` per conversation. A session folder holds `session.json` (the snapshot), `journal.ndjson` (one line per step), and a `media/` folder for images and audio.

## Where it is saved

| `persist` | What it writes |
|---|---|
| `{ dir }` | `<dir>/<sessionId>/session.json` and `journal.ndjson`, plus `media/` files. The snapshot includes the agent's own spending as `usage`. The journal gets one appended line per step and is folded into the snapshot after 500 lines or 4 MB, or when the history changes another way. |
| `{ file }` | One JSON file, rewritten at each step. Media is inlined as data URLs. No journal. |
| `{}` | The same as `{ dir }`, with `dir` set to `<home>/sessions`. |

Other `persist` keys: `onPersistError(error)` is called when a save fails, and `allowStateless: true` also saves a `stateless` agent. Saves are batched and never fail a turn.

## The home folder

Everything the SDK stores is in one folder, `.agent-accel/` by default. Nothing is scattered across your project.

| Subfolder | Holds |
|---|---|
| `sessions/` | Saved conversations. With `telemetry: { persist: true }`, each session folder also gets its own `telemetry.ndjson`. |
| `scheduled/` | Scheduled actions and their results. |
| `telemetry/` | A daily event log for events that belong to no saved session. Only with `telemetry: { persist: true }`. |
| `catalog/` | The model catalog cache. |

Move it with `setHome(dir)` (call it once, before you create agents) or with a per-agent `home`. There is no environment variable for it. Paths you pass yourself, like `persist: { dir }` and `saveSessionFile`, are used as given.

## Survive a crash

With `persist: { dir }` and the same `sessionId` after a restart, an agent notices a run that was cut off, or prompts that were still waiting, and carries on by itself.

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  persist: { dir: "sessions" },
  sessionId: "support-chat", // the same id after the restart
  // resume: "automatic" is the default
});
// The cut-off run is already continuing. A run() you call now waits behind it.
```

- The conversation is loaded and the model continues from where it stopped.
- A tool call that already finished is never run again. Its result was saved when it finished. Only calls with no saved result run now, such as the email that was still being sent. See [Tools](tools.md#after-a-crash).
- Sub-agent usage of a call that finished before the crash is not counted twice.
- Prompts that were waiting run afterwards. Steers go first, in order.
- A resume that fails is reported on the bus (`agent.resume_failed`). It does not throw from the constructor.
- It needs `persist: { dir }`, not `{ file }`. If a saved session is over the load limits, the constructor throws `SessionLoadError` instead of overwriting it. Media in the session must still be allowed by `fileAccess.roots`, if you set it.

To decide yourself, set `resume: "explicit"`. The state loads and nothing runs. `agent.interrupted()` lists the cut-off runs (`runId`, `startedAt`, `prompt`, `pendingToolCalls`), and `await agent.resume()` continues them. It resolves to the run's response, or `undefined` when nothing was cut off. A new `run()` closes the old one as `abandoned`.

## One process per session

An agent that saves a session takes a lock, `<session folder>/.lock`, with the process id, host and start time.

- A second process that opens the same session fails at once with a `ConfigError` that names the owner.
- Different sessions in the same home do not interfere.
- The lock is shared by all agents in one process. It is held until the process exits. A lock left by a process that was killed is taken over, and leftover temp files in the folder are removed.
- Everything else in a home is safe to share: scheduled actions use one folder and a short lock per action, telemetry is appended one line at a time, and the model catalog is written atomically.
- Local disks only. Other processes may read the files, but must not write session files.

## What is saved

- Each run's start is recorded in `runs` (run id, index of its user message, time), so turns can be counted later.
- Prompts still waiting in the steer inbox or the queue are saved in `pending`, in the journal only. Media in them becomes a file under `media/`. `loadSessionDir(dir).session.pending` shows what was waiting when the process stopped.
- Each tool call writes `tool-logs/<n>-<tool>.ndjson` next to the session. The session itself keeps only a `logFile` reference on the result. See [Tools](tools.md).
- Sub-agent traces are saved too.
- Google turns keep their raw output steps, so a resumed session replays them exactly, with thought signatures and the cache prefix intact.

Saves are durable: a temp file, `fsync` of the file and the folder, the last good version kept as `session.json.bak`, and an atomic rename. A crash or power cut never leaves a half-written file. A damaged `session.json` loads from its `.bak`.

Loading checks the shape of the messages. A corrupt file is renamed `*.corrupt-<time>`. A valid file over the limits (50,000 messages or 100 MB) throws `SessionLoadError` and is never touched. Older pretty-printed and JSONL files still load. Importing a session that points at local files warns with `session.local_media_paths` unless you set `fileAccess.roots`.

## Functions

| Function | Does |
|---|---|
| `findLatestSessionDir(root)` | Finds the most recently changed session folder. |
| `loadSessionDir(dir)` | Reads a session folder. Returns `{ session, ... }` or `null`. |
| `saveSessionDir(root, agent, telemetry?)` | Saves a session into the folder layout. Throws when it cannot write. |
| `loadSessionFile(file)`, `saveSessionFile(file, agent, telemetry?)` | The same, for one JSON file. `saveSessionFile` throws when it cannot write. |
| `sessionDirFor(root, sessionId)` | The folder path for a session id. Refuses `../`. |
| `agent.exportSession()`, `agent.importSession(saved)` | The snapshot of an agent, and restoring it. |

The two save functions throw when the file cannot be written, so a failed save is never silent. An agent that saves by itself (`persist`) catches that for you and calls `persist.onPersistError`. `saveSessionDir` writes in a crash-safe order: media files first (a file that has not changed is left alone), then the new `session.json`, then it removes media that the new snapshot no longer uses. A media file that cannot be written stays inside `session.json`, and a `session.media_write_failed` warning goes to the telemetry bus.

A `sessionId` you pass must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`. Otherwise saving to a folder throws `ValidationError`. Generated ids are shortened to 64 characters.

## Tips

- Resume a finished chat with `findLatestSessionDir`, then `loadSessionDir`, then `agent.importSession(saved.session)`.
- Set `fileAccess.roots` before you import sessions you did not create.
- With `persist: { dir }` each step costs one appended line, so long sessions stay fast.
