import type { Job } from "./db.ts";
import type { SpaceSchedule } from "./schedule.ts";
import type { RunStatus, SpaceAppInfo, SpaceTask } from "./space.ts";

/**
 * The overview: every scheduled task this machine's ai-space runs, each labelled with who owns it.
 *   - mine: this app's own jobs (editable here);
 *   - system: tasks ai-space contributes itself (`space/*`, every app's `backup`);
 *   - app: tasks other apps declare in their space.yaml (read-only here; their app manages them).
 * `headless` marks a task whose owner has no page of its own, the ones easy to lose sight of.
 */

export type Owner = "mine" | "system" | "app";

export interface Row {
  key: string;
  taskId: string | null;
  jobId: number | null;
  app: string;
  appTitle: { zh: string; en: string } | null;
  name: string;
  description: string;
  owner: Owner;
  headless: boolean;
  machine: string;
  schedule: SpaceSchedule | null;
  /** The zone a cron or one-shot is read in; null for an interval. */
  zone: string | null;
  /** False when a cron task names no zone and follows the ai-space process's zone. */
  zoneDeclared: boolean;
  enabled: boolean;
  orphaned: boolean;
  running: boolean;
  triggers: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: RunStatus | null;
  lastError: string | null;
  lastDurationMs: number | null;
  consecutiveErrors: number;
  target: { kind: string; text: string };
  timeoutMs: number | null;
  /** Mine only: false while the job has no task in ai-space (see syncError). */
  registered: boolean;
  syncError: string | null;
  archived: boolean;
}

export interface Counts { total: number; enabled: number; failing: number; running: number; paused: number; mine: number; headless: number; orphaned: number }

export function targetText(t: SpaceTask["target"] | undefined): { kind: string; text: string } {
  if (!t) return { kind: "", text: "" };
  switch (t.kind) {
    case "command": return { kind: "command", text: t.command };
    case "http": return { kind: "http", text: `${t.method} ${t.url}` };
    case "agent": return { kind: "agent", text: `${t.runtime}${t.model ? `/${t.model}` : ""} · ${t.prompt}` };
  }
}

function jobTarget(j: Job): { kind: string; text: string } {
  if (j.kind === "command") return { kind: "command", text: j.command ?? "" };
  if (j.kind === "http") return { kind: "http", text: `${j.httpMethod} ${j.httpUrl}` };
  return { kind: "agent", text: (j.prompt ?? "").split("\n")[0]!.slice(0, 200) };
}

export interface BuildInput {
  tasks: SpaceTask[];
  apps: SpaceAppInfo[];
  jobs: Job[];
  app: string;
  machine: string;
  /** The zone of the ai-space process this app shares the machine with (for cron tasks without one). */
  machineZone: string;
}

export function buildRows(i: BuildInput): Row[] {
  const appInfo = new Map(i.apps.filter((a) => !a.peer).map((a) => [a.name, a]));
  const byTask = new Map(i.jobs.filter((j) => j.spaceTaskId).map((j) => [j.spaceTaskId!, j]));
  const rows: Row[] = [];
  const seenJobs = new Set<number>();

  for (const t of i.tasks) {
    const mine = t.app === i.app && t.source === "api";
    const job = mine ? byTask.get(t.id) ?? i.jobs.find((j) => j.name === t.name && !j.archivedAt) : undefined;
    if (job) seenJobs.add(job.id);
    const system = t.app === "space" || t.name === "backup";
    const owner: Owner = mine ? "mine" : system ? "system" : "app";
    const info = appInfo.get(t.app);
    const zh = info?.i18n?.zh?.title;
    const cronZone = t.schedule.kind === "cron" ? t.schedule.tz : undefined;
    const zone = t.schedule.kind === "cron" ? cronZone ?? i.machineZone : t.schedule.kind === "at" ? job?.schedule.kind === "at" ? job.schedule.tz : null : null;
    rows.push({
      key: t.id,
      taskId: t.id,
      jobId: job?.id ?? null,
      app: t.app,
      appTitle: t.app === "space" ? { zh: "ai-space", en: "ai-space" } : info ? { zh: zh ?? info.title ?? t.app, en: info.title ?? t.app } : null,
      name: t.name,
      description: job?.description ?? t.description ?? "",
      owner,
      // An app without a page (no url), one that is gone, or ai-space's own work.
      headless: owner === "system" || (owner === "app" && !info?.url),
      machine: i.machine,
      schedule: t.schedule,
      zone,
      zoneDeclared: t.schedule.kind !== "cron" || Boolean(cronZone),
      enabled: t.enabled,
      orphaned: t.orphaned,
      running: Boolean(t.state.runningAt),
      triggers: t.triggers?.length ?? 0,
      nextRunAt: t.enabled && !t.orphaned ? t.state.nextRunAt ?? null : null,
      lastRunAt: t.state.lastRunAt ?? null,
      lastStatus: t.state.lastStatus ?? null,
      lastError: t.state.lastError ?? null,
      lastDurationMs: t.state.lastDurationMs ?? null,
      consecutiveErrors: t.state.consecutiveErrors ?? 0,
      target: job ? jobTarget(job) : targetText(t.target),
      timeoutMs: job?.timeoutMs ?? t.timeoutMs ?? null,
      registered: true,
      syncError: job?.syncError ?? null,
      archived: false,
    });
  }

  // Jobs ai-space does not have (a failed write, no operator credential) and archived ones.
  for (const j of i.jobs) {
    if (seenJobs.has(j.id)) continue;
    rows.push({
      key: `job:${j.id}`,
      taskId: null,
      jobId: j.id,
      app: i.app,
      appTitle: null,
      name: j.name,
      description: j.description,
      owner: "mine",
      headless: false,
      machine: i.machine,
      schedule: j.schedule.kind === "cron" ? { kind: "cron", expr: j.schedule.expr, tz: j.schedule.tz } : j.schedule.kind === "every" ? { kind: "every", everyMs: j.schedule.everyMs } : { kind: "at", at: j.schedule.at },
      zone: j.schedule.kind === "every" ? null : j.schedule.tz,
      zoneDeclared: true,
      enabled: j.enabled && !j.archivedAt,
      orphaned: false,
      running: false,
      triggers: 0,
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
      consecutiveErrors: 0,
      target: jobTarget(j),
      timeoutMs: j.timeoutMs,
      registered: false,
      syncError: j.archivedAt ? null : j.syncError ?? "not registered in ai-space",
      archived: Boolean(j.archivedAt),
    });
  }

  const rank: Record<Owner, number> = { mine: 0, app: 1, system: 2 };
  return rows.sort((a, b) => rank[a.owner] - rank[b.owner] || a.app.localeCompare(b.app) || a.name.localeCompare(b.name));
}

export function countRows(rows: Row[]): Counts {
  const live = rows.filter((r) => !r.orphaned && !r.archived);
  return {
    total: live.length,
    enabled: live.filter((r) => r.enabled).length,
    failing: live.filter((r) => r.enabled && r.lastStatus === "error").length,
    running: live.filter((r) => r.running).length,
    paused: live.filter((r) => !r.enabled).length,
    mine: live.filter((r) => r.owner === "mine").length,
    headless: live.filter((r) => r.headless).length,
    orphaned: rows.filter((r) => r.orphaned).length,
  };
}

/** The earliest next run among enabled tasks. */
export function nextUp(rows: Row[]): Row | null {
  let best: Row | null = null;
  for (const r of rows) if (r.nextRunAt && (!best || Date.parse(r.nextRunAt) < Date.parse(best.nextRunAt!))) best = r;
  return best;
}
