# Task Shelf · 定时任务收纳

A home for small scheduled jobs that have no app of their own: a nightly export script, an hourly
HTTP ping, a daily AI prompt. You keep them here; ai-space's scheduler runs them.

The tasks page shows every scheduled task this machine's ai-space runs, in three views:

- **我的任务 / My jobs**: the jobs you keep here. Add, edit, pause, resume, run now, delete (archive,
  restorable).
- **无界面 / No page**: tasks whose owner has no page of its own (ai-space's own backups, apps
  without a page). Read-only.
- **全部 / All**: everything, including tasks other apps declare in their `space.yaml`. Read-only:
  their own app manages them.

Each row shows the schedule in words with the raw cron and its zone, the next run, the last run and
its result, and whether it is on. Selecting a row shows its runs and output.

The **AI assistant** on the right does the same things by chat: "every weekday at 08:30 Los Angeles
time run `bun scripts/report.ts`", "pause the export", "run ping now", "why did theme-watch refresh
fail?". Deleting a job always waits for you to press 确认删除 / Confirm.

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
