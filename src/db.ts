import { Database } from "bun:sqlite";
import type { JobSchedule } from "./schedule.ts";
import type { SpaceRun } from "./space.ts";

/**
 * The job store: this app's own jobs (the definitions; ai-space keeps the clock, the runs and the
 * state), the runs kept when a job's ai-space task is replaced or archived, an append-only log of
 * every change, and the assistant's conversation. Instants are integer milliseconds (docs/time.md).
 */

export type JobKind = "command" | "http" | "agent";
export type Actor = "page" | "assistant" | "system";

export interface Job {
  id: number;
  name: string;
  description: string;
  kind: JobKind;
  command: string | null;
  cwd: string | null;
  httpMethod: string | null;
  httpUrl: string | null;
  httpBody: string | null;
  prompt: string | null;
  agentModel: string | null;
  schedule: JobSchedule;
  timeoutMs: number;
  enabled: boolean;
  spaceTaskId: string | null;
  syncError: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export type JobFields = Omit<Job, "id" | "spaceTaskId" | "syncError" | "createdAt" | "updatedAt" | "archivedAt">;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('command', 'http', 'agent')),
  command TEXT,
  cwd TEXT,
  http_method TEXT,
  http_url TEXT,
  http_body TEXT,
  prompt TEXT,
  agent_model TEXT,
  schedule TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  space_task_id TEXT,
  sync_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS run_archive (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL,
  space_run_id INTEGER NOT NULL,
  run TEXT NOT NULL,
  kept_at INTEGER NOT NULL,
  UNIQUE (job_id, space_run_id)
);
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY,
  job_id INTEGER,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS changes_job ON changes (job_id, at);
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY,
  session INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  actions TEXT,
  confirm TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending (
  token TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  chat_id INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  outcome TEXT
);
`;

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

type JobRow = {
  id: number; name: string; description: string; kind: JobKind; command: string | null; cwd: string | null;
  http_method: string | null; http_url: string | null; http_body: string | null; prompt: string | null; agent_model: string | null;
  schedule: string; timeout_ms: number; enabled: number; space_task_id: string | null; sync_error: string | null;
  created_at: number; updated_at: number; archived_at: number | null;
};

function fromRow(r: JobRow): Job {
  return {
    id: r.id, name: r.name, description: r.description, kind: r.kind, command: r.command, cwd: r.cwd,
    httpMethod: r.http_method, httpUrl: r.http_url, httpBody: r.http_body, prompt: r.prompt, agentModel: r.agent_model,
    schedule: JSON.parse(r.schedule) as JobSchedule, timeoutMs: r.timeout_ms, enabled: r.enabled === 1,
    spaceTaskId: r.space_task_id, syncError: r.sync_error, createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at,
  };
}

export function listJobs(db: Database, opts: { archived?: boolean } = {}): Job[] {
  const where = opts.archived === undefined ? "" : opts.archived ? "WHERE archived_at IS NOT NULL" : "WHERE archived_at IS NULL";
  return db.query<JobRow, []>(`SELECT * FROM jobs ${where} ORDER BY name`).all().map(fromRow);
}

export function getJob(db: Database, id: number): Job | null {
  const r = db.query<JobRow, [number]>("SELECT * FROM jobs WHERE id = ?").get(id);
  return r ? fromRow(r) : null;
}

export function findJob(db: Database, ref: string | number): Job | null {
  if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
    const byId = getJob(db, Number(ref));
    if (byId) return byId;
  }
  const r = db.query<JobRow, [string]>("SELECT * FROM jobs WHERE name = ?").get(String(ref).trim());
  return r ? fromRow(r) : null;
}

export function insertJob(db: Database, f: JobFields, now: number): Job {
  const r = db.query<{ id: number }, [string, string, string, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string, number, number, number, number]>(
    `INSERT INTO jobs (name, description, kind, command, cwd, http_method, http_url, http_body, prompt, agent_model, schedule, timeout_ms, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(f.name, f.description, f.kind, f.command, f.cwd, f.httpMethod, f.httpUrl, f.httpBody, f.prompt, f.agentModel, JSON.stringify(f.schedule), f.timeoutMs, f.enabled ? 1 : 0, now, now)!;
  return getJob(db, r.id)!;
}

export function updateJob(db: Database, id: number, f: Partial<JobFields>, now: number): Job {
  const cols: Record<keyof JobFields, string> = {
    name: "name", description: "description", kind: "kind", command: "command", cwd: "cwd", httpMethod: "http_method", httpUrl: "http_url",
    httpBody: "http_body", prompt: "prompt", agentModel: "agent_model", schedule: "schedule", timeoutMs: "timeout_ms", enabled: "enabled",
  };
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(f) as [keyof JobFields, unknown][]) {
    if (v === undefined) continue;
    sets.push(`${cols[k]} = ?`);
    vals.push(k === "schedule" ? JSON.stringify(v) : k === "enabled" ? (v ? 1 : 0) : (v as string | number | null));
  }
  sets.push("updated_at = ?");
  vals.push(now, id);
  db.query(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getJob(db, id)!;
}

/** Where the job lives in ai-space now, and what went wrong the last time it was applied there. */
export function setSync(db: Database, id: number, spaceTaskId: string | null, syncError: string | null): void {
  db.query("UPDATE jobs SET space_task_id = ?, sync_error = ? WHERE id = ?").run(spaceTaskId, syncError, id);
}

export function setArchived(db: Database, id: number, at: number | null, now: number): Job {
  db.query("UPDATE jobs SET archived_at = ?, updated_at = ? WHERE id = ?").run(at, now, id);
  return getJob(db, id)!;
}

/** Keep runs a job had in ai-space before its task there is replaced or archived. */
export function keepRuns(db: Database, jobId: number, runs: SpaceRun[], now: number): number {
  const ins = db.query("INSERT OR IGNORE INTO run_archive (job_id, space_run_id, run, kept_at) VALUES (?, ?, ?, ?)");
  let n = 0;
  db.transaction(() => { for (const r of runs) n += ins.run(jobId, r.id, JSON.stringify(r), now).changes; })();
  return n;
}

export function keptRuns(db: Database, jobId: number, limit = 50): SpaceRun[] {
  return db.query<{ run: string }, [number, number]>("SELECT run FROM run_archive WHERE job_id = ? ORDER BY json_extract(run, '$.startedAt') DESC LIMIT ?")
    .all(jobId, limit).map((r) => JSON.parse(r.run) as SpaceRun);
}

export interface Change { id: number; jobId: number | null; at: number; actor: Actor; action: string; detail: string }

export function logChange(db: Database, c: Omit<Change, "id">): void {
  db.query("INSERT INTO changes (job_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)").run(c.jobId, c.at, c.actor, c.action, c.detail);
}

export function changesOf(db: Database, jobId: number, limit = 20): Change[] {
  return db.query<{ id: number; job_id: number | null; at: number; actor: Actor; action: string; detail: string }, [number, number]>(
    "SELECT * FROM changes WHERE job_id = ? ORDER BY at DESC, id DESC LIMIT ?",
  ).all(jobId, limit).map((r) => ({ id: r.id, jobId: r.job_id, at: r.at, actor: r.actor, action: r.action, detail: r.detail }));
}

// ---------------------------------------------------------------- assistant conversation

export interface ActionResult { tool: string; ok: boolean; summary: string; jobId?: number; error?: string }
export interface ConfirmCard { token: string; jobId: number; name: string; action: "archive"; state: "open" | "done" | "declined" | "failed"; error?: string }
export interface ChatMessage { id: number; session: number; role: "user" | "assistant"; text: string; actions: ActionResult[]; confirm: ConfirmCard | null; createdAt: number }

type ChatRow = { id: number; session: number; role: "user" | "assistant"; text: string; actions: string | null; confirm: string | null; created_at: number };
const chatFrom = (r: ChatRow): ChatMessage => ({
  id: r.id, session: r.session, role: r.role, text: r.text, actions: r.actions ? JSON.parse(r.actions) : [], confirm: r.confirm ? JSON.parse(r.confirm) : null, createdAt: r.created_at,
});

export function currentSession(db: Database): number {
  return db.query<{ s: number | null }, []>("SELECT MAX(session) AS s FROM chat").get()?.s ?? 1;
}

/** A new conversation starts a new session; earlier ones stay in the table. */
export function nextSession(db: Database): number {
  return currentSession(db) + 1;
}

export function addMessage(db: Database, m: Omit<ChatMessage, "id">): ChatMessage {
  const r = db.query<{ id: number }, [number, string, string, string | null, string | null, number]>(
    "INSERT INTO chat (session, role, text, actions, confirm, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
  ).get(m.session, m.role, m.text, m.actions.length ? JSON.stringify(m.actions) : null, m.confirm ? JSON.stringify(m.confirm) : null, m.createdAt)!;
  return { ...m, id: r.id };
}

export function messages(db: Database, session: number, limit = 60): ChatMessage[] {
  return db.query<ChatRow, [number, number]>("SELECT * FROM (SELECT * FROM chat WHERE session = ? ORDER BY id DESC LIMIT ?) ORDER BY id").all(session, limit).map(chatFrom);
}

export function sessionOf(db: Database, chatId: number): number | null {
  return db.query<{ session: number }, [number]>("SELECT session FROM chat WHERE id = ?").get(chatId)?.session ?? null;
}

export function setConfirm(db: Database, chatId: number, confirm: ConfirmCard): void {
  db.query("UPDATE chat SET confirm = ? WHERE id = ?").run(JSON.stringify(confirm), chatId);
}

export interface Pending { token: string; jobId: number; action: "archive"; chatId: number | null; createdAt: number; resolvedAt: number | null; outcome: string | null }

export function addPending(db: Database, p: Omit<Pending, "resolvedAt" | "outcome">): void {
  db.query("INSERT INTO pending (token, job_id, action, chat_id, created_at) VALUES (?, ?, ?, ?, ?)").run(p.token, p.jobId, p.action, p.chatId, p.createdAt);
}

export function setPendingChat(db: Database, token: string, chatId: number): void {
  db.query("UPDATE pending SET chat_id = ? WHERE token = ?").run(chatId, token);
}

export function getPending(db: Database, token: string): Pending | null {
  const r = db.query<{ token: string; job_id: number; action: "archive"; chat_id: number | null; created_at: number; resolved_at: number | null; outcome: string | null }, [string]>(
    "SELECT * FROM pending WHERE token = ?",
  ).get(token);
  return r ? { token: r.token, jobId: r.job_id, action: r.action, chatId: r.chat_id, createdAt: r.created_at, resolvedAt: r.resolved_at, outcome: r.outcome } : null;
}

export function resolvePending(db: Database, token: string, outcome: string, now: number): boolean {
  return db.query("UPDATE pending SET resolved_at = ?, outcome = ? WHERE token = ? AND resolved_at IS NULL").run(now, outcome, token).changes === 1;
}
