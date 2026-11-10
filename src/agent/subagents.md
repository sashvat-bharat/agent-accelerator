Starts helpers ("workers") that work on a task for you and can be asked again later. A worker is a separate agent with its own instructions, its own tools and its own memory: it knows only what you give it (plus the earlier conversation you choose to copy). Use workers for parallel research, a second opinion, or a long side task you do not want in your own context.

COMMANDS (one tool, the `command` field)

- spawn: start a worker. Needs `name` and `task`. Optional: `instructions` (the worker's own system prompt), `role`, `tools`, `history`. It waits for the worker's first reply and gives you the worker's `id`.
- message: send `task` to the open worker `id`. The worker remembers everything said to it before. It waits for the reply.
- close: end the worker `id` when you no longer need it. A closed worker cannot be messaged again.
- list: your open workers, plus the numbered turns of this conversation that `history` can copy.

FIELDS

- name: a short label such as "researcher". The SDK adds a suffix; use the full `id` it returns ("researcher-1a2b3c4d") in message and close.
- instructions: the worker's own system prompt: its role, rules and the format you want back.
- task: for spawn, the first assignment; for message, the next message to that worker.
- tools: names of worker tools to grant. Available: {{TOOLS}}. Grant only what the task needs.
- history: a number N (default 0 = none). Starts the worker with a copy of the first N finished turns of this conversation, in order. Call list to see the turns and their numbers. The turn you are in right now is never copied: restate what you need in `task`.

RESULTS
Every spawn and message answers with one header line and the worker's text: `[worker <id>] replied:` or `[worker <id>] failed: <reason>`. A failed worker stays open: fix the problem and message it again, or close it.

EXAMPLES
Start a researcher:
{"command":"spawn","name":"researcher","instructions":"You research databases. Answer in 5 bullets with sources.","task":"Compare SQLite and Postgres for a small SaaS."}
Ask it a follow-up:
{"command":"message","id":"researcher-1a2b3c4d","task":"Now focus on write-heavy workloads."}

RULES

- Several workers at once: make several spawn calls in the same turn. They run in parallel.
- A worker handles one call at a time. Wait for its reply before messaging it again.
- {{LIMIT}}
- A worker starts blank: put everything it needs in `instructions` and `task`, or copy earlier turns with `history`.
- Worker answers are written by another model. Check them before you rely on them.
- Never put secrets in `instructions` or `task`.
