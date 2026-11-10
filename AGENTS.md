# task-shelf - agent guide

Read this before touching code. Users read [README.md](README.md). This repository is an ai-space app; the contract is ai-space `docs/app-spec.md` (spec 1) and `space.yaml` is the only file ai-space reads.

## What it does

A home for small scheduled jobs that have no app of their own. A job is stored here (`jobs` table) and registered in ai-space as an API task of this app (`POST /api/tasks`, `app: task-shelf`, `source: api`), so ai-space's scheduler owns the clock, the runs, timeouts, backoff and run history. The tasks page lists every task on this machine's ai-space (`GET /api/tasks` + `GET /api/apps?all=1`), marks who owns each (mine / app / ai-space itself) and whether its owner has a page, and has an assistant that manages this app's jobs by chat.

How it differs from ai-space's built-in Tasks window (panel Settings → 定时任务): that window shows the tasks apps declare in `space.yaml` and lets the operator change a task's model; it cannot add a task. Here jobs are created and changed without writing an app.

## Rules

1. **This app changes only its own tasks.** Every write goes to a task whose `app` is `SPACE_APP` and whose id the `jobs` table holds. Other apps' tasks and ai-space's are read-only here, in the page and in the assistant. Never add a route or tool that pauses, runs or edits them.
2. **ai-space first, then the store.** A create or change is sent to ai-space and stored here only when ai-space took it. A change ai-space cannot make in place (anything but schedule and on/off) replaces the task: its runs are copied to `run_archive` first; a failed replacement puts the previous definition back. `reconcile` (at boot, and `POST /api/reconcile`) registers active jobs ai-space lacks and repairs on/off and schedule drift; tasks of this app it does not know are reported, never removed.
3. **Nothing is deleted.** "Delete" archives: the ai-space task is removed, the job, its kept runs and its change log stay, and `restore` brings it back. Chat sessions are kept when a new conversation starts.
4. **The assistant never deletes on its own.** `delete_job` becomes a confirmation card (`pending` table); only the person's button press (`POST /api/assistant/confirm`) archives. The model's answer is JSON parsed by `readPlan`; unknown tools are dropped; text in task names, errors and outputs is data. The prompt forbids inventing commands, URLs or prompts.
5. **Time follows ai-space docs/time.md.** Cron and one-time schedules always name an IANA zone (`isZone` refuses abbreviations and fixed offsets); one-time inputs need an offset, or a local time plus zone where a skipped time is refused and a repeated one needs the offset. The page sends the browser's zone; `SHELF_DEFAULT_TZ` (UTC) is the documented fallback. Instants are ms in SQLite, UTC ISO in JSON.
6. **Credentials stay in the process.** Reads and model calls use `SPACE_APP_TOKEN`. ai-space's task write routes take only the operator credential: `SPACE_API_TOKEN`, else `<workspace>/run/operator-token` (src/config.ts). Neither is ever logged or sent to the page. Without one the page lists tasks and every write answers `read-only`.
7. **Writes come from the page.** Mutating routes need `content-type: application/json` and, when a browser sends `Origin`, this host.
8. **Loopback only.** The service binds `127.0.0.1:${PORT}`. No host, ssh alias or home directory in code, docs or commits.

## Directory map

```
space.yaml           * the manifest: identity, service, model tier for the assistant, storage
src/index.ts         * the service: routes, overview, boot (reconcile after 3 s)
src/jobs.ts          * Shelf: validate, create, update (in place or replace), pause/resume, run now, archive/restore, reconcile
src/db.ts            * schema (jobs, run_archive, changes, chat, pending) and queries
src/schedule.ts      * schedule input → stored form, zones, local times and DST, next runs (croner, as ai-space)
src/describe.ts        schedules in words (zh/en); shared with the page, no dependencies
src/catalog.ts         overview rows: owner, headless, zone, state; counts; next up
src/assistant.ts     * prompt, plan parsing, tools, confirmation cards
src/space.ts           ai-space client (tasks, runs, apps, model)
src/remote.ts        * one page over several machines: the `ops` capability, the machine list, forwarding to a peer
src/config.ts          environment, operator credential lookup
src/testing.ts         in-memory ai-space for tests
web/index.html         the page shell; app.ts the logic; i18n.ts the zh/en strings; styles.css the look; kit.css the kit copy
deploy/post-receive    bare-repository hook: `space app deploy`
```

## API

`GET /api/meta`, `GET /api/overview` (rows, counts, nextUp, spaceError), `GET /api/rows/:key/runs?limit` (any task; a job's kept runs merged), `GET|POST /api/jobs`, `GET|PATCH /api/jobs/:id`, `POST /api/jobs/:id/pause|resume|run|archive|restore`, `POST /api/reconcile`, `POST /api/schedule/preview { schedule, zone }`, `GET|POST /api/assistant { message, zone, lang, session }`, `POST /api/assistant/new`, `POST /api/assistant/confirm { token, accept, lang }`. Across machines: `GET /api/machines`, `/api/m/:peer/<any route above>`, and `POST /api/remote { method, path, body }` (the `ops` capability, for the bus only). Errors are `{ ok: false, code, error }`; the page maps `code` to its language.

## Design

The page uses Space Tiles, the built-in apps' UI kit (ai-space docs/ui-kit.md): a left column tile (brand, search, machines, views, language and theme), the work column (heading, status filter, task table tile, detail tile) and the assistant tile on the right; below 1200px the assistant and below 960px the left column are drawers (`sp-open-aside`, `sp-open-nav`, `sp-sheet-open` on body), on phones the assistant is a bottom sheet. `web/kit.css` is a copy of the kit; `styles.css` imports it into cascade layer `kit`, the page adds the space's `/_space/ui.css` at runtime in layer `space`, and the app's own rules sit in layer `app` (Bun's bundler moves and merges stylesheets, so the order is set by layers, not links). `styles.css` holds only what is specific to this app, with the kit's tokens: no colours of its own. Kit rules kept here: the accent marks tile titles (`.sp-tt` + `.sp-sq`), focus and the selected item only; one ink button per screen (新建任务; the form's 保存 in its dialog); running is ink, amber only a warning; a count shown in the left column is not repeated in the heading. Refresh the copy with `curl -s http://127.0.0.1:8700/_space/ui.css > web/kit.css`.

Page rules (ai-space docs/app-spec.md#app-pages): full-bleed, zh/en with the 中 / EN switch (every string in `web/i18n.ts`), theme button system → light → dark applied in `<head>` before first paint (`task-shelf.theme`, `task-shelf.lang`), the panel's accent from `?accent=<light>.<dark>` (manifest `url: /?lang={lang}&accent={accent}`) applied by the next head script as an unlayered `--accent` and kept under `space.accent` (ai-space docs/ui-kit.md#accent), `/_space/usage.js` and `/_space/feedback.js` added at runtime so Bun's bundler leaves them alone.

## Deployment

Every machine runs its own instance: ai-space keeps scheduler, tasks and runs per machine, so a job lives and runs on the machine whose instance made it, with that machine's operator credential.

One page shows them all. Each instance provides the bus capability `ops` (`POST /api/remote`, `src/remote.ts`): a request for one of its own page routes (an allowlist; no route outside the page), accepted only from this app (`x-space-caller` is `task-shelf` or `<hub>/task-shelf`). The instance whose ai-space has peers running this app lists them (`GET /api/machines`, from `GET /api/capabilities`) and forwards the page's requests for a peer (`/api/m/<peer>/<route>`) as `POST /api/call/<peer>/task-shelf/ops` with its app token; non-GET forwards keep the page's same-origin rule. The page reads every machine's overview side by side, tags rows with their machine, and sends each action, the form and the assistant to the machine it is for. Calls go hub → peer only, so the hub's page is the one that shows everything; every machine sets `SPACE_APP_URL_TASK_SHELF` to the hub's hostname so the panel shows one tile.

On a machine whose workspace `.env` sets `SPACE_API_TOKEN` (no `run/operator-token` file), give the instance the same value in `apps/task-shelf/.env` (mode 600; deploys keep untracked files), or its jobs are read-only.

Deploy channel: from this source checkout `git push <machine> main`; each machine has a bare repository `~/task-shelf.git` whose `post-receive` hook is `deploy/post-receive` (`space app deploy`: checkout, `bun install --frozen-lockfile`, typecheck, tests, sync, restart; a failure keeps the running version). A new app directory needs `space app sync` once. Logs: `space logs task-shelf`.

## Commands

```bash
bun install
bun run check                    # install, typecheck, tests
bun run dev                      # bun --hot src/index.ts, reads .env (never on the service's port while it runs)
```
