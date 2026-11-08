/**
 * task-shelf: a home for small scheduled jobs that have no app of their own, and an overview of
 * the scheduled tasks of this machine's apps (ai-space's own tasks and backups are left out). The jobs are stored here and run by ai-space's
 * scheduler as tasks of this app (src/jobs.ts); the tasks page has an assistant that manages them by
 * chat (src/assistant.ts). The service binds 127.0.0.1 only; ai-space hands over PORT, DATABASE_URL,
 * SPACE_API_URL, SPACE_NAME and the app token.
 */
import type { Database } from "bun:sqlite";
import index from "../web/index.html";
import { Assistant } from "./assistant.ts";
import { buildRows, countRows, nextUp, type Row } from "./catalog.ts";
import { config, databasePath, operatorToken, serverZone } from "./config.ts";
import { changesOf, getJob, keptRuns, openDatabase } from "./db.ts";
import { type Lang, scheduleText } from "./describe.ts";
import { JobError, Shelf } from "./jobs.ts";
import { ScheduleError, isZone, nextRuns, parseSchedule } from "./schedule.ts";
import { httpSpace, modelClient, type ModelFn, type SpaceApi, type SpaceRun } from "./space.ts";

export interface ServerOptions {
  db: Database;
  space: SpaceApi;
  model: ModelFn | null;
  port?: number;
  app?: string;
  machine?: string;
  machineZone?: string;
  dataDir?: string;
  /** false: no page, for tests. */
  web?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (code: string, error: string, status = 400) => json({ ok: false, code, error }, status);

function failure(e: unknown): Response {
  if (e instanceof JobError) return fail(e.code, e.message, e.status);
  if (e instanceof ScheduleError) return fail(e.code, e.message, 400);
  return fail("error", (e as Error)?.message ?? String(e), 500);
}

/** Writes come from this app's own page: JSON, and when a browser names an origin, this host's. */
function sameOrigin(req: Request): boolean {
  if ((req.headers.get("content-type") ?? "").split(";")[0]!.trim() !== "application/json") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === (req.headers.get("x-forwarded-host") ?? req.headers.get("host")); } catch { return false; }
}

const langOf = (v: unknown): Lang => (v === "en" ? "en" : "zh");

export function createServer(opts: ServerOptions) {
  const { db, space, model } = opts;
  const now = opts.now ?? Date.now;
  const app = opts.app ?? config.app;
  const machine = opts.machine ?? config.machine;
  const machineZone = opts.machineZone ?? serverZone();
  const log = opts.log ?? ((line: string) => console.log(`[task-shelf] ${new Date().toISOString()} ${line}`));
  const shelf = new Shelf({ db, space, app, dataDir: opts.dataDir ?? config.dataDir, agentRuntime: config.agentRuntime, now });
  const zoneOf = (v: unknown) => (isZone(v) ? v : config.defaultZone);

  /** Every row, or this app's jobs alone with the error when ai-space cannot be read. */
  const overview = async (): Promise<{ rows: Row[]; spaceError: string | null }> => {
    const jobs = shelf.list();
    try {
      const [tasks, apps] = await Promise.all([space.listTasks(), space.listApps()]);
      return { rows: buildRows({ tasks, apps, jobs, app, machine, machineZone }), spaceError: null };
    } catch (e) {
      return { rows: buildRows({ tasks: [], apps: [], jobs, app, machine, machineZone }).map((r) => ({ ...r, syncError: null })), spaceError: (e as Error).message };
    }
  };

  /** A task's runs, newest first; a job's runs from tasks it had before (an edit, an archive) are kept here. */
  const runsOf = async (row: Row, limit: number): Promise<SpaceRun[]> => {
    const live = row.taskId ? await space.runs(row.taskId, limit) : [];
    const kept = row.jobId ? keptRuns(db, row.jobId, limit) : [];
    const seen = new Set(live.map((r) => `${r.taskId}:${r.id}`));
    return [...live, ...kept.filter((r) => !seen.has(`${r.taskId}:${r.id}`))].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  };

  const assistant = new Assistant({ db, shelf, model, rows: async () => (await overview()).rows, runs: runsOf, machine, now, timeoutMs: config.assistantTimeoutMs });

  const body = async (req: Request): Promise<Record<string, unknown>> => {
    try { const v = await req.json(); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}; } catch { return {}; }
  };
  const write = (h: (req: Request & { params: Record<string, string> }) => Promise<Response>) => async (req: Request & { params: Record<string, string> }) => {
    if (!sameOrigin(req)) return fail("cross-origin", "writes must come from this app's page as JSON", 403);
    try { return await h(req); } catch (e) { return failure(e); }
  };
  const jobAction = (fn: (id: string, b: Record<string, unknown>) => Promise<unknown>) => write(async (req) => json({ ok: true, ...(await fn(req.params.id!, await body(req)) as object) }));

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? config.port,
    idleTimeout: 255,
    routes: {
      "/": opts.web === false ? () => new Response("no page", { status: 404 }) : index,
      "/healthz": () => json({ ok: true }),
      "/icon.svg": () => new Response(Bun.file(new URL("../icon.svg", import.meta.url).pathname), { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=3600" } }),

      "/api/meta": () => json({ ok: true, app, machine, machineZone, defaultZone: config.defaultZone, writable: space.canWrite(), assistant: Boolean(model) }),

      "/api/overview": async () => {
        const { rows, spaceError } = await overview();
        return json({ ok: true, machine, machineZone, writable: space.canWrite(), at: new Date(now()).toISOString(), spaceError, counts: countRows(rows), nextUp: nextUp(rows), rows });
      },

      "/api/rows/:key/runs": async (req) => {
        try {
          const limit = Math.min(50, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 20));
          const { rows } = await overview();
          const row = rows.find((r) => r.key === req.params.key);
          if (!row) return fail("not-found", "no such task", 404);
          return json({ ok: true, runs: await runsOf(row, limit) });
        } catch (e) { return failure(e); }
      },

      "/api/jobs": {
        GET: () => json({ ok: true, jobs: shelf.list() }),
        POST: write(async (req) => {
          const b = await body(req);
          return json({ ok: true, job: await shelf.create(b, "page", zoneOf(b.zone)) }, 201);
        }),
      },
      "/api/jobs/:id": {
        GET: (req) => {
          const job = /^\d+$/.test(req.params.id) ? getJob(db, Number(req.params.id)) : null;
          if (!job) return fail("not-found", "no such job", 404);
          return json({ ok: true, job, changes: changesOf(db, job.id) });
        },
        PATCH: write(async (req) => {
          const b = await body(req);
          return json({ ok: true, job: await shelf.update(Number(req.params.id), b, "page", zoneOf(b.zone)) });
        }),
      },
      "/api/jobs/:id/pause": { POST: jobAction(async (id) => ({ job: await shelf.setEnabled(Number(id), false, "page") })) },
      "/api/jobs/:id/resume": { POST: jobAction(async (id) => ({ job: await shelf.setEnabled(Number(id), true, "page") })) },
      "/api/jobs/:id/run": { POST: jobAction(async (id) => await shelf.runNow(Number(id), "page")) },
      "/api/jobs/:id/archive": { POST: jobAction(async (id) => ({ job: await shelf.archive(Number(id), "page") })) },
      "/api/jobs/:id/restore": { POST: jobAction(async (id) => ({ job: await shelf.restore(Number(id), "page") })) },
      "/api/reconcile": { POST: write(async () => json({ ok: true, report: await shelf.reconcile() })) },

      // What a schedule means before it is saved: normalised, in words, and its next runs.
      "/api/schedule/preview": {
        POST: write(async (req) => {
          const b = await body(req);
          const s = parseSchedule(b.schedule, { zone: zoneOf(b.zone), now: now() });
          return json({ ok: true, schedule: s, text: { zh: scheduleText(s, "zh"), en: scheduleText(s, "en") }, next: nextRuns(s, now(), 3).map((ms) => new Date(ms).toISOString()) });
        }),
      },

      "/api/assistant": {
        GET: () => {
          const list = assistant.conversation();
          return json({ ok: true, available: Boolean(model), session: list[0]?.session ?? 1, messages: list });
        },
        POST: write(async (req) => {
          const b = await body(req);
          const msgs = await assistant.turn({ message: String(b.message ?? ""), zone: zoneOf(b.zone), lang: langOf(b.lang), ...(typeof b.session === "number" ? { session: b.session } : {}) });
          return json({ ok: true, messages: msgs });
        }),
      },
      "/api/assistant/new": { POST: write(async () => json({ ok: true, session: assistant.fresh() })) },
      "/api/assistant/confirm": {
        POST: write(async (req) => {
          const b = await body(req);
          return json({ ok: true, messages: await assistant.confirm(String(b.token ?? ""), b.accept === true, langOf(b.lang)) });
        }),
      },
    },
    fetch: () => fail("not-found", "not found", 404),
  });

  return { server, port: server.port, shelf, assistant, stop: () => server.stop(true), reconcile: () => shelf.reconcile().then((r) => { if (r.created.length || r.fixed.length || r.failed.length || r.strays.length) log(`reconcile: created ${r.created.join(",") || "-"} fixed ${r.fixed.join(",") || "-"} failed ${r.failed.map((f) => f.name).join(",") || "-"} unknown ${r.strays.join(",") || "-"}`); return r; }) };
}

if (import.meta.main) {
  const db = openDatabase(databasePath());
  const op = await operatorToken();
  const space = httpSpace({ apiUrl: config.spaceApiUrl, appToken: config.spaceAppToken, operatorToken: op });
  const model = modelClient({ apiUrl: config.spaceApiUrl, token: config.spaceAppToken });
  const app = createServer({ db, space, model });
  console.log(`[task-shelf] listening on http://127.0.0.1:${app.port} · machine ${config.machine || "?"} (${serverZone()}) · writes ${op ? "on" : "off (no operator credential)"} · assistant ${model ? "on" : "off"}`);
  // A job whose ai-space task went missing (a lost write, a restored database) is put back.
  setTimeout(() => { app.reconcile().catch((e) => console.error(`[task-shelf] reconcile failed: ${(e as Error).message}`)); }, 3000);
  const shutdown = () => { app.stop(); db.close(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
