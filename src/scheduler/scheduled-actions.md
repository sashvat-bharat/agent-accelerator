Schedules a sub-agent (a "scheduled action") to run LATER, once or on repeat, on its own. Every run starts blank, does its task with the worker tools, and saves its answer to a file. It does NOT reply in this chat. Use it for deliveries such as "a research brief every day at 7:00 AM" or "a codebase health report every Monday at 9:00 AM".

Call get_datetime first whenever you create or reschedule, then pick DD from today's date.

COMMANDS (one tool, the `command` field)
- create: schedule a new action. Needs instructions, task and scheduled_action.{name, id, timeToDeliver, meridiem, startCookingInAdvance}. Optional: role, tools, timeoutMs, scheduled_action.repeatEvery, scheduled_action.retries.
- list: every action with its metadata and state (waiting, cooking, missed, done).
- get: one action by `id`, with its latest run result.
- update: change instructions, task, tools, timeoutMs, role or any scheduled_action field of the action `id`.
- kill: delete the action `id` for good. If the answer says it is running, ask the user before retrying with force: true. purge: true also deletes its past run files.
- run_now: run the action `id` immediately, outside its schedule. Also fixes a missed run.
- skip: ignore a missed run of `id` and wait for the next scheduled time.

SCHEDULED_ACTION FIELDS
- name: human label.
- id: lowercase kebab-case, at most 48 characters, e.g. "daily-ai-brief". The SDK appends 6 characters ("daily-ai-brief-d64aj2"); use that full id in every later command.
- timeToDeliver: "DD:HH:MM". DD = days from today (00 today, 01 tomorrow, 55 = 55 days ahead). HH:MM = clock time on a 12-hour clock, HH 01-12.
- meridiem: "AM" or "PM" for timeToDeliver.
- startCookingInAdvance: "DD:HH:MM" as a duration (HH 00-23): how long before delivery the run starts. "00:00:10" = 10 minutes, "00:01:00" = 1 hour.
- repeatEvery (optional): "DD:HH:MM" gap between deliveries. "01:00:00" = every day, "07:00:00" = every week. Omit to run once.
- retries (optional): extra attempts if a run fails, used only while there is still time before delivery. Default 0.

EXAMPLES
Daily brief, first delivery tomorrow at 7:00 AM, starting 30 minutes ahead:
{"command":"create","instructions":"You write a short, sourced AI research brief.","task":"Summarize the most important AI news of the last day in 5 bullets.","scheduled_action":{"name":"Daily AI Research Brief","id":"daily-ai-brief","timeToDeliver":"01:07:00","meridiem":"AM","startCookingInAdvance":"00:00:30","repeatEvery":"01:00:00"}}

Weekly report, every Monday at 9:00 AM (use get_datetime to count the days to the next Monday), starting 2 hours ahead:
{"command":"create","instructions":"You review a codebase and report its health.","task":"Report test health, open risks and notable changes this week.","scheduled_action":{"name":"Weekly Codebase Health Report","id":"weekly-code-health","timeToDeliver":"03:09:00","meridiem":"AM","startCookingInAdvance":"00:02:00","repeatEvery":"07:00:00"}}

TIMING ADVICE (do not guess; talk to the user)
- A run must finish before the next one is due, so startCookingInAdvance must be shorter than repeatEvery.
- Pick the lead time from the job: a quick lookup fits the 10-minute lead ("00:00:10"); research with many tools needs much more.
- If the job looks too heavy for the gap the user asked for, do not schedule it blindly. Say so and suggest a wider gap, an earlier start, or a lighter task.
- A run still cooking when the next one is due is skipped, never stacked, so a gap that is too small means lost runs.

RULES
- Each run starts blank and remembers nothing from earlier runs: put everything the worker needs in instructions and task.
- Results go to files, not into this chat. Tell the user the action is scheduled and when it will be delivered.
- Never put secrets in instructions or task: they are stored as plain text.
- Actions run only while the host program is running.
- Worker tools you may grant through `tools`: {{TOOLS}}.
