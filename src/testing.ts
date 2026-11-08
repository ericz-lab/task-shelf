import { nextRuns } from "./schedule.ts";
import { type SpaceApi, type SpaceAppInfo, SpaceError, type SpaceRun, type SpaceTask, type TaskCreateBody } from "./space.ts";

/** An in-memory ai-space scheduler for tests: the routes this app uses, with their refusals. */
export interface FakeSpace extends SpaceApi {
  tasks: SpaceTask[];
  apps: SpaceAppInfo[];
  runsOf: Map<string, SpaceRun[]>;
  calls: string[];
  writable: boolean;
  /** Make the next call of this kind fail with this status. */
  failNext: Partial<Record<"create" | "patch" | "delete" | "run" | "list", number>>;
}

export function fakeSpace(o: { writable?: boolean; now?: () => number; tasks?: SpaceTask[]; apps?: SpaceAppInfo[] } = {}): FakeSpace {
  const now = o.now ?? Date.now;
  let n = 0;
  const fake: FakeSpace = {
    tasks: o.tasks ?? [],
    apps: o.apps ?? [],
    runsOf: new Map(),
    calls: [],
    writable: o.writable ?? true,
    failNext: {},
    canWrite: () => fake.writable,
    async listTasks() {
      fake.calls.push("list");
      if (take("list")) throw new SpaceError(0, "ai-space unreachable: connection refused");
      return structuredClone(fake.tasks);
    },
    async listApps() { return structuredClone(fake.apps); },
    async runs(id, limit) { return (fake.runsOf.get(id) ?? []).slice(0, limit); },
    async createTask(b: TaskCreateBody) {
      fake.calls.push(`create ${b.name}`);
      guard("create");
      if (fake.tasks.some((t) => t.app === b.app && t.name === b.name)) throw new SpaceError(400, `task ${b.app}/${b.name} already exists`);
      const next = nextRuns(b.schedule, now(), 1)[0];
      const task: SpaceTask = {
        id: `t${++n}`, app: b.app, name: b.name, description: b.description, source: "api", orphaned: false, enabled: b.enabled,
        schedule: b.schedule.kind === "every" ? { ...b.schedule, anchorMs: now() } : b.schedule, target: b.target, timeoutMs: b.timeoutMs, triggers: [],
        state: { consecutiveErrors: 0, ...(next !== undefined && b.enabled ? { nextRunAt: new Date(next).toISOString() } : {}) },
      };
      fake.tasks.push(task);
      return structuredClone(task);
    },
    async patchTask(id, patch) {
      fake.calls.push(`patch ${id} ${JSON.stringify(patch)}`);
      guard("patch");
      const t = fake.tasks.find((x) => x.id === id);
      if (!t) throw new SpaceError(404, `unknown task: ${id}`);
      if (patch.enabled !== undefined) t.enabled = patch.enabled;
      if (patch.schedule) t.schedule = patch.schedule;
      return structuredClone(t);
    },
    async deleteTask(id) {
      fake.calls.push(`delete ${id}`);
      guard("delete");
      const i = fake.tasks.findIndex((x) => x.id === id);
      if (i < 0) throw new SpaceError(404, `unknown task: ${id}`);
      if (fake.tasks[i]!.source === "manifest") throw new SpaceError(400, "manifest tasks are removed by deleting them from space.yaml and re-syncing");
      fake.tasks.splice(i, 1);
    },
    async runTask(id) {
      fake.calls.push(`run ${id}`);
      guard("run");
      const t = fake.tasks.find((x) => x.id === id);
      if (!t) throw new SpaceError(404, `unknown task: ${id}`);
      if (t.state.runningAt) return { started: false };
      t.state.runningAt = new Date(now()).toISOString();
      return { started: true };
    },
  };
  function take(kind: keyof FakeSpace["failNext"]): number | undefined {
    const s = fake.failNext[kind];
    delete fake.failNext[kind];
    return s;
  }
  function guard(kind: keyof FakeSpace["failNext"]): void {
    if (!fake.writable) throw new SpaceError(401, "unauthorized");
    const s = take(kind);
    if (s !== undefined) throw new SpaceError(s, `ai-space answered HTTP ${s}`);
  }
  return fake;
}

/** A manifest task of another app, as GET /api/tasks shows it. */
export function appTask(app: string, name: string, extra: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: `${app}-${name}`, app, name, source: "manifest", orphaned: false, enabled: true,
    schedule: { kind: "cron", expr: "15 */2 * * *" }, target: { kind: "http", method: "POST", url: `http://127.0.0.1:9000/jobs/${name}` },
    timeoutMs: 600_000, triggers: [], state: { consecutiveErrors: 0, lastStatus: "ok", lastRunAt: "2026-11-08T12:15:00.000Z", nextRunAt: "2026-11-08T14:15:00.000Z" },
    ...extra,
  };
}
