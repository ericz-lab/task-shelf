import type { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type Actor, type Job, type JobFields, type JobKind, findJob, getJob, insertJob, keepRuns, listJobs, logChange, setArchived, setSync, updateJob,
} from "./db.ts";
import { type JobSchedule, ScheduleError, parseDuration, parseSchedule, sameSchedule, toSpaceSchedule } from "./schedule.ts";
import { type SpaceApi, SpaceError, type SpaceTarget, type SpaceTask, type TaskCreateBody } from "./space.ts";

/**
 * The shelf: this app's own jobs. The definition lives here; each active job is one ai-space task
 * under this app (source `api`), which ai-space schedules, runs, times out, backs off and records.
 * Every change is applied to ai-space first and stored here only when ai-space took it, so the two
 * never disagree for long; `reconcile` repairs what a lost write or a restart left behind. Jobs are
 * never deleted: archiving takes the task out of ai-space, keeps its runs here and can be undone.
 */

export type JobErrorCode =
  | "bad-name" | "reserved-name" | "name-taken" | "bad-kind" | "bad-command" | "bad-cwd" | "bad-url" | "bad-method" | "bad-body"
  | "bad-prompt" | "bad-model" | "bad-timeout" | "bad-description" | "not-found" | "archived" | "not-archived" | "read-only" | "not-registered" | "space";

export class JobError extends Error {
  constructor(readonly code: JobErrorCode | ScheduleError["code"], message: string, readonly status = 400) { super(message); }
}

/** What the page and the assistant send to create or change a job (every field optional on change). */
export interface JobInput {
  name?: unknown;
  description?: unknown;
  kind?: unknown;
  command?: unknown;
  cwd?: unknown;
  method?: unknown;
  url?: unknown;
  body?: unknown;
  prompt?: unknown;
  model?: unknown;
  schedule?: unknown;
  timeout?: unknown;
  enabled?: unknown;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Task names ai-space itself gives every app with storage. */
const RESERVED = new Set(["backup"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MODEL_RE = /^[a-z][a-z0-9-]{0,31}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 6 * 3_600_000;

export interface ShelfOptions {
  db: Database;
  space: SpaceApi;
  /** This app's name in ai-space (`SPACE_APP`). */
  app: string;
  /** Where agent jobs' prompt files are written (`SPACE_APP_DATA_DIR`). */
  dataDir: string;
  agentRuntime: string;
  now?: () => number;
}

export interface ReconcileReport { created: string[]; fixed: string[]; failed: { name: string; error: string }[]; strays: string[] }

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? undefined : String(v));

export class Shelf {
  readonly db: Database;
  readonly space: SpaceApi;
  readonly app: string;
  private readonly dataDir: string;
  private readonly agentRuntime: string;
  private readonly now: () => number;

  constructor(o: ShelfOptions) {
    this.db = o.db; this.space = o.space; this.app = o.app; this.dataDir = o.dataDir; this.agentRuntime = o.agentRuntime;
    this.now = o.now ?? Date.now;
  }

  list(opts: { archived?: boolean } = {}): Job[] {
    return listJobs(this.db, opts);
  }

  find(ref: unknown): Job {
    const job = ref === undefined || ref === null || ref === "" ? null : findJob(this.db, typeof ref === "number" ? ref : String(ref));
    if (!job) throw new JobError("not-found", `no job ${String(ref)}`, 404);
    return job;
  }

  /** Check and normalise an input; `base` is the job being changed. Throws JobError / ScheduleError. */
  validate(input: JobInput, base: Job | null, zone: string): JobFields {
    const pick = <T>(v: T | undefined, b: T): T => (v === undefined ? b : v);
    const name = (str(input.name) ?? base?.name ?? "").trim();
    if (!NAME_RE.test(name)) throw new JobError("bad-name", "name: lowercase letters, digits, . _ - (up to 64), starting with a letter or digit");
    if (RESERVED.has(name)) throw new JobError("reserved-name", `"${name}" is a name ai-space uses itself`);
    const clash = findJob(this.db, name);
    if (clash && clash.id !== base?.id) throw new JobError("name-taken", `a job named ${name} already exists${clash.archivedAt ? " (archived)" : ""}`, 409);
    const description = (str(input.description) ?? base?.description ?? "").trim();
    if (description.length > 500) throw new JobError("bad-description", "description: at most 500 characters");
    const kind = (str(input.kind) ?? base?.kind) as JobKind | undefined;
    if (kind !== "command" && kind !== "http" && kind !== "agent") throw new JobError("bad-kind", "kind must be command, http or agent");

    let command: string | null = null, cwd: string | null = null, httpMethod: string | null = null, httpUrl: string | null = null;
    let httpBody: string | null = null, prompt: string | null = null, agentModel: string | null = null;
    const same = base?.kind === kind;
    if (kind === "command") {
      command = (str(input.command) ?? (same ? base?.command : undefined) ?? "").trim();
      if (!command || command.length > 4000) throw new JobError("bad-command", "command: required, at most 4000 characters");
      const c = str(input.cwd) ?? (same ? base?.cwd ?? undefined : undefined);
      cwd = c?.trim() ? c.trim() : null;
      if (cwd && !cwd.startsWith("/")) throw new JobError("bad-cwd", "working directory must be an absolute path");
    } else if (kind === "http") {
      httpMethod = (str(input.method) ?? (same ? base?.httpMethod : undefined) ?? "POST").trim().toUpperCase();
      if (!METHODS.has(httpMethod)) throw new JobError("bad-method", "method must be GET, POST, PUT, PATCH or DELETE");
      httpUrl = (str(input.url) ?? (same ? base?.httpUrl : undefined) ?? "").trim();
      let u: URL | null = null;
      try { u = new URL(httpUrl); } catch { /* reported below */ }
      if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || httpUrl.length > 2000) {
        throw new JobError("bad-url", "url must be an http(s) address without a user name or password");
      }
      const b = input.body === undefined ? (same ? base?.httpBody : null) : input.body === null ? null : typeof input.body === "string" ? input.body : JSON.stringify(input.body);
      httpBody = b && b.trim() ? b : null;
      if (httpBody && httpBody.length > 20_000) throw new JobError("bad-body", "body: at most 20000 characters");
      if (httpBody && httpMethod === "GET") throw new JobError("bad-body", "a GET request has no body");
    } else {
      prompt = (str(input.prompt) ?? (same ? base?.prompt : undefined) ?? "").trim();
      if (!prompt || prompt.length > 20_000) throw new JobError("bad-prompt", "prompt: required, at most 20000 characters");
      const m = input.model === undefined ? (same ? base?.agentModel : null) : input.model === null || input.model === "" ? null : str(input.model)!.trim();
      if (m && !MODEL_RE.test(m)) throw new JobError("bad-model", "model must be runtime/tier, for example claude/junior");
      agentModel = m || null;
    }

    const schedule: JobSchedule = input.schedule === undefined && base ? base.schedule : parseSchedule(input.schedule, { zone, now: this.now() });
    let timeoutMs = base?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (input.timeout !== undefined && input.timeout !== null && input.timeout !== "") {
      try { timeoutMs = parseDuration(input.timeout); } catch { throw new JobError("bad-timeout", "timeout must be like 30s, 10m or 1h"); }
    }
    if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) throw new JobError("bad-timeout", "timeout must be between 10 seconds and 6 hours");
    const enabled = pick(typeof input.enabled === "boolean" ? input.enabled : undefined, base?.enabled ?? true);
    return { name, description, kind, command, cwd, httpMethod, httpUrl, httpBody, prompt, agentModel, schedule, timeoutMs, enabled };
  }

  private promptPath(name: string): string {
    return join(this.dataDir, "prompts", `${name}.md`);
  }

  /** The ai-space target for a job. Agent jobs read their prompt from a file this app writes. */
  target(f: JobFields): SpaceTarget {
    switch (f.kind) {
      case "command":
        return { kind: "command", command: f.command!, ...(f.cwd ? { cwd: f.cwd } : {}) };
      case "http": {
        let body: unknown = undefined;
        if (f.httpBody) { try { body = JSON.parse(f.httpBody); } catch { body = f.httpBody; } }
        return { kind: "http", method: f.httpMethod!, url: f.httpUrl!, ...(body !== undefined ? { body } : {}) };
      }
      case "agent": {
        const [runtime, model] = f.agentModel ? [f.agentModel.slice(0, f.agentModel.indexOf("/")), f.agentModel.slice(f.agentModel.indexOf("/") + 1)] : [this.agentRuntime, undefined];
        return { kind: "agent", runtime, prompt: this.promptPath(f.name), cwd: this.dataDir, ...(model ? { model } : {}) };
      }
    }
  }

  private body(f: JobFields): TaskCreateBody {
    return { app: this.app, name: f.name, ...(f.description ? { description: f.description } : {}), schedule: toSpaceSchedule(f.schedule), target: this.target(f), timeoutMs: f.timeoutMs, enabled: f.enabled };
  }

  private async writePrompt(f: JobFields): Promise<void> {
    if (f.kind !== "agent") return;
    await mkdir(join(this.dataDir, "prompts"), { recursive: true });
    await Bun.write(this.promptPath(f.name), `${f.prompt}\n`);
  }

  private needWrite(): void {
    if (!this.space.canWrite()) throw new JobError("read-only", "this app found no operator credential, so it cannot change ai-space tasks", 503);
  }

  private async spaceCall<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) {
      if (e instanceof SpaceError) throw new JobError("space", e.message, 502);
      throw e;
    }
  }

  private log(job: Job | null, actor: Actor, action: string, detail = ""): void {
    logChange(this.db, { jobId: job?.id ?? null, at: this.now(), actor, action, detail });
  }

  async create(input: JobInput, actor: Actor, zone: string): Promise<Job> {
    this.needWrite();
    const f = this.validate(input, null, zone);
    await this.writePrompt(f);
    const task = await this.spaceCall(() => this.space.createTask(this.body(f)));
    const job = insertJob(this.db, f, this.now());
    setSync(this.db, job.id, task.id, null);
    this.log(job, actor, "create", describeFields(f));
    return getJob(this.db, job.id)!;
  }

  /** Keep a task's runs here before ai-space forgets them with the task. */
  private async keep(job: Job): Promise<void> {
    if (!job.spaceTaskId) return;
    try { keepRuns(this.db, job.id, await this.space.runs(job.spaceTaskId, 200), this.now()); } catch { /* the task may already be gone */ }
  }

  private async dropTask(id: string | null): Promise<void> {
    if (!id) return;
    try { await this.space.deleteTask(id); } catch (e) {
      if (e instanceof SpaceError && e.status === 404) return;
      throw e;
    }
  }

  async update(ref: unknown, input: JobInput, actor: Actor, zone: string): Promise<Job> {
    const job = this.find(ref);
    if (job.archivedAt) throw new JobError("archived", `${job.name} is archived; restore it first`, 409);
    this.needWrite();
    const f = this.validate(input, job, zone);
    const fields = (Object.keys(f) as (keyof JobFields)[]).filter((k) => JSON.stringify(f[k]) !== JSON.stringify(job[k]));
    if (!fields.length) return job;
    const recreate = fields.some((k) => k !== "schedule" && k !== "enabled") || !job.spaceTaskId;
    await this.writePrompt(f);
    if (recreate) {
      // ai-space can change only a task's schedule and on/off in place: anything else replaces the task.
      await this.keep(job);
      await this.spaceCall(() => this.dropTask(job.spaceTaskId));
      let task: SpaceTask;
      try {
        task = await this.spaceCall(() => this.space.createTask(this.body(f)));
      } catch (e) {
        // Put the previous definition back so the job keeps running as it was.
        try {
          const back = await this.space.createTask(this.body(job));
          setSync(this.db, job.id, back.id, null);
        } catch (e2) {
          setSync(this.db, job.id, null, `not registered: ${(e2 as Error).message}`);
        }
        throw e;
      }
      setSync(this.db, job.id, task.id, null);
    } else {
      const patch: { enabled?: boolean; schedule?: ReturnType<typeof toSpaceSchedule> } = {};
      if (fields.includes("schedule")) patch.schedule = toSpaceSchedule(f.schedule);
      if (fields.includes("enabled")) patch.enabled = f.enabled;
      await this.spaceCall(() => this.space.patchTask(job.spaceTaskId!, patch));
      setSync(this.db, job.id, job.spaceTaskId, null);
    }
    const next = updateJob(this.db, job.id, f, this.now());
    this.log(next, actor, "update", fields.join(", "));
    return next;
  }

  async setEnabled(ref: unknown, enabled: boolean, actor: Actor): Promise<Job> {
    const job = this.find(ref);
    if (job.archivedAt) throw new JobError("archived", `${job.name} is archived; restore it first`, 409);
    this.needWrite();
    if (!job.spaceTaskId) throw new JobError("not-registered", `${job.name} is not registered in ai-space yet`, 409);
    if (job.enabled !== enabled) {
      await this.spaceCall(() => this.space.patchTask(job.spaceTaskId!, { enabled }));
      updateJob(this.db, job.id, { enabled }, this.now());
    }
    const next = getJob(this.db, job.id)!;
    this.log(next, actor, enabled ? "resume" : "pause");
    return next;
  }

  /** Ask ai-space to run the job now; false when a run is already in progress. */
  async runNow(ref: unknown, actor: Actor): Promise<{ job: Job; started: boolean }> {
    const job = this.find(ref);
    if (job.archivedAt) throw new JobError("archived", `${job.name} is archived; restore it first`, 409);
    this.needWrite();
    if (!job.spaceTaskId) throw new JobError("not-registered", `${job.name} is not registered in ai-space yet`, 409);
    const { started } = await this.spaceCall(() => this.space.runTask(job.spaceTaskId!));
    this.log(job, actor, "run", started ? "started" : "already running");
    return { job, started };
  }

  /** Take the job out of ai-space's schedule; its definition and runs stay here and `restore` brings it back. */
  async archive(ref: unknown, actor: Actor): Promise<Job> {
    const job = this.find(ref);
    if (job.archivedAt) return job;
    this.needWrite();
    await this.keep(job);
    await this.spaceCall(() => this.dropTask(job.spaceTaskId));
    setSync(this.db, job.id, null, null);
    const next = setArchived(this.db, job.id, this.now(), this.now());
    this.log(next, actor, "archive");
    return next;
  }

  async restore(ref: unknown, actor: Actor): Promise<Job> {
    const job = this.find(ref);
    if (!job.archivedAt) throw new JobError("not-archived", `${job.name} is not archived`, 409);
    this.needWrite();
    if (job.schedule.kind === "at" && Date.parse(job.schedule.at) <= this.now()) {
      throw new ScheduleError("at-past", "its one-time run is in the past; create a new job instead");
    }
    await this.writePrompt(job);
    const task = await this.spaceCall(() => this.space.createTask(this.body(job)));
    setSync(this.db, job.id, task.id, null);
    const next = setArchived(this.db, job.id, null, this.now());
    this.log(next, actor, "restore");
    return next;
  }

  /**
   * Make ai-space match the shelf: register active jobs it lacks, put back on/off and schedule where
   * they drifted. Tasks of this app the shelf does not know are reported, never removed.
   */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { created: [], fixed: [], failed: [], strays: [] };
    const tasks = (await this.space.listTasks()).filter((t) => t.app === this.app && t.source === "api");
    const active = this.list({ archived: false });
    for (const job of active) {
      const task = tasks.find((t) => t.id === job.spaceTaskId) ?? tasks.find((t) => t.name === job.name);
      try {
        if (!task) {
          if (!this.space.canWrite()) { setSync(this.db, job.id, null, "not registered in ai-space (no operator credential)"); continue; }
          await this.writePrompt(job);
          const created = await this.space.createTask(this.body(job));
          setSync(this.db, job.id, created.id, null);
          report.created.push(job.name);
          continue;
        }
        if (task.id !== job.spaceTaskId) setSync(this.db, job.id, task.id, null);
        const patch: { enabled?: boolean; schedule?: ReturnType<typeof toSpaceSchedule> } = {};
        if (task.enabled !== job.enabled) patch.enabled = job.enabled;
        if (!sameSchedule(job.schedule, task.schedule)) patch.schedule = toSpaceSchedule(job.schedule);
        if (Object.keys(patch).length && this.space.canWrite()) {
          await this.space.patchTask(task.id, patch);
          report.fixed.push(job.name);
        }
        setSync(this.db, job.id, task.id, null);
      } catch (e) {
        setSync(this.db, job.id, task?.id ?? null, (e as Error).message);
        report.failed.push({ name: job.name, error: (e as Error).message });
      }
    }
    const known = new Set(active.map((j) => j.name));
    report.strays = tasks.filter((t) => !known.has(t.name)).map((t) => t.name);
    for (const r of [...report.created, ...report.fixed]) this.log(findJob(this.db, r), "system", "reconcile");
    return report;
  }
}

/** One line for the change log. */
export function describeFields(f: JobFields): string {
  const what = f.kind === "command" ? f.command : f.kind === "http" ? `${f.httpMethod} ${f.httpUrl}` : `agent: ${(f.prompt ?? "").split("\n")[0]!.slice(0, 80)}`;
  const when = f.schedule.kind === "cron" ? `${f.schedule.expr} ${f.schedule.tz}` : f.schedule.kind === "every" ? `every ${f.schedule.everyMs}ms` : `at ${f.schedule.at}`;
  return `${what} · ${when}`;
}
