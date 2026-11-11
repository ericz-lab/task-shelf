# Task Shelf · 定时任务收纳

A home for small scheduled jobs that have no app of their own: a nightly export script, an hourly
HTTP ping, a daily AI prompt. You keep them here; ai-space's scheduler runs them.

The tasks page shows only the jobs kept here. Tasks of other apps and ai-space's own tasks
(`space/*`, every app's `backup`) are left out: their own app or ai-space looks after them.

- **任务 / Jobs**: add, edit, pause, resume, run now, delete (archive, restorable).
- **已归档 / Archived**: deleted jobs; restore one to put it back on the schedule.

Each row shows the schedule in words with the raw cron and its zone, the next run, the last run and
its result, and whether it is on. Selecting a row shows its runs; click a run to read its whole output
(ai-space keeps the first 4,000 characters).

**A run's conversation.** When a command job starts Claude Code, have it print the session it started
on a line of its own near the top of its output, and the run gets a 对话记录 / Conversation button that
shows what was asked, each tool call with its result, and the answers:

```bash
SID=$(cat /proc/sys/kernel/random/uuid)     # or: uuidgen | tr A-Z a-z
echo "claude-session: $SID"
claude -p "$PROMPT" --session-id "$SID"
```

The session is read on the machine the job ran on, from Claude Code's own folder; once Claude Code
has removed an old session the button says so.

The **AI assistant** on the right does the same things by chat: "every weekday at 08:30 Los Angeles
time run `bun scripts/report.ts`", "pause the export", "run ping now", "why did ping fail?". Deleting a job always waits for you to press 确认删除 / Confirm.

## Several machines

Install it on every machine whose scheduler should run jobs. The page on the hub shows the jobs of every
peer that runs Task Shelf too, each row tagged with its machine, and changes them there: the form asks which
machine a new job runs on, and the assistant has a machine menu. Each job still lives and runs on its own
machine. Point every machine's `SPACE_APP_URL_TASK_SHELF` at the hub's page so the panel shows one tile.

## How it differs from ai-space's built-in Tasks window

The panel's Settings → 定时任务 lists the tasks apps declare in their `space.yaml`; a new task there
means writing or changing an app. Task Shelf is where jobs without an app live: you create and change
them here, by form or by chat, and they run as ai-space tasks of this app (`task-shelf/<name>`), so
the built-in window, notifications and run history see them too.

## Kinds of job

| Kind | What ai-space runs |
| --- | --- |
| Command | `sh -c <command>` in this app's directory (or the working directory you give) |
| HTTP | one request to a URL; a 2xx answer is ok |
| AI prompt | a read-only agent run of the prompt you wrote |

Schedules: a 5-field cron with its time zone, a fixed interval (at least 1 minute), or one time at a
date and time in a zone.
