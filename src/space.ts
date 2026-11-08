import type { SpaceSchedule } from "./schedule.ts";

/**
 * What this app asks ai-space for (docs/scheduler.md, docs/model.md):
 *   - reads: every task on this machine, a task's runs, the app registry (app token);
 *   - writes: create, change, run and remove this app's own tasks (operator token, see config.ts);
 *   - model calls for the assistant (app token; the manifest's tier for the tag picks the model).
 * The page never sees either token.
 */

export type SpaceTarget =
  | { kind: "http"; method: string; url: string; headers?: Record<string, string>; body?: unknown; model?: string }
  | { kind: "command"; command: string; cwd?: string; env?: Record<string, string>; model?: string }
  | { kind: "agent"; runtime: string; prompt: string; cwd?: string; model?: string; permissionMode?: string; tools?: string[] };

export type RunStatus = "ok" | "error" | "skipped";

export interface SpaceTask {
  id: string;
  app: string;
  name: string;
  description?: string;
  source: "manifest" | "api";
  orphaned: boolean;
  enabled: boolean;
  schedule: SpaceSchedule;
  target: SpaceTarget;
  timeoutMs: number;
  triggers?: { event: string }[];
  state: {
    nextRunAt?: string;
    runningAt?: string;
    lastRunAt?: string;
    lastStatus?: RunStatus;
    lastError?: string;
    lastDurationMs?: number;
    consecutiveErrors: number;
    pending?: { events: number; dueAt?: string };
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface SpaceRun {
  id: number;
  taskId: string;
  startedAt: number;
  endedAt: number;
  status: RunStatus;
  error?: string;
  output?: string;
  trigger: "schedule" | "manual" | "event";
  eventIds?: number[];
}

export interface SpaceAppInfo {
  name: string;
  title?: string;
  i18n?: Record<string, { title?: string }>;
  url?: string;
  status?: string;
  peer?: string;
}

export interface TaskCreateBody {
  app: string;
  name: string;
  description?: string;
  schedule: SpaceSchedule;
  target: SpaceTarget;
  timeoutMs: number;
  enabled: boolean;
}

export interface SpaceApi {
  listTasks(): Promise<SpaceTask[]>;
  listApps(): Promise<SpaceAppInfo[]>;
  runs(taskId: string, limit: number): Promise<SpaceRun[]>;
  /** False when no operator credential was found: the page then lists but cannot change anything. */
  canWrite(): boolean;
  createTask(body: TaskCreateBody): Promise<SpaceTask>;
  patchTask(id: string, patch: { enabled?: boolean; schedule?: SpaceSchedule }): Promise<SpaceTask>;
  deleteTask(id: string): Promise<void>;
  /** started false: the task is already running (ai-space answers 409). */
  runTask(id: string): Promise<{ started: boolean }>;
}

/** An error ai-space answered with, or could not be reached for. */
export class SpaceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function httpSpace(opts: { apiUrl: string; appToken: string; operatorToken: string; fetch?: typeof fetch }): SpaceApi {
  const f = opts.fetch ?? fetch;
  const call = async <T>(method: string, path: string, token: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; data: T }> => {
    let res: Response;
    try {
      res = await f(`${opts.apiUrl}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new SpaceError(0, `ai-space unreachable: ${(e as Error).message}`);
    }
    const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
    if (!res.ok && !okStatuses.includes(res.status)) throw new SpaceError(res.status, data?.error ?? `ai-space answered HTTP ${res.status}`);
    return { status: res.status, data };
  };
  const write = () => {
    if (!opts.operatorToken) throw new SpaceError(403, "no operator credential: this app can list tasks but not change them");
    return opts.operatorToken;
  };
  return {
    listTasks: async () => (await call<{ tasks: SpaceTask[] }>("GET", "/api/tasks", opts.appToken)).data.tasks ?? [],
    listApps: async () => (await call<{ apps: SpaceAppInfo[] }>("GET", "/api/apps?all=1", opts.appToken)).data.apps ?? [],
    runs: async (id, limit) => (await call<{ runs: SpaceRun[] }>("GET", `/api/tasks/${encodeURIComponent(id)}/runs?limit=${limit}`, opts.appToken)).data.runs ?? [],
    canWrite: () => Boolean(opts.operatorToken),
    createTask: async (body) => (await call<{ task: SpaceTask }>("POST", "/api/tasks", write(), body)).data.task,
    patchTask: async (id, patch) => (await call<{ task: SpaceTask }>("PATCH", `/api/tasks/${encodeURIComponent(id)}`, write(), patch)).data.task,
    deleteTask: async (id) => { await call("DELETE", `/api/tasks/${encodeURIComponent(id)}`, write()); },
    runTask: async (id) => {
      const r = await call<{ started?: boolean }>("POST", `/api/tasks/${encodeURIComponent(id)}/run`, write(), undefined, [409]);
      return { started: r.status !== 409 && r.data.started !== false };
    },
  };
}

// ---------------------------------------------------------------- model

export type ModelResult = { ok: true; text: string } | { ok: false; error: string };
export interface ModelRequest { system: string; prompt: string; tag: string; timeoutMs?: number }
export type ModelFn = (req: ModelRequest) => Promise<ModelResult>;

/** One model call through ai-space (POST /api/model/run), as biz-ideas makes them. No model is named: the manifest's tier for the tag decides. */
export function modelClient(opts: { apiUrl: string; token: string; fetch?: typeof fetch }): ModelFn | null {
  if (!opts.apiUrl || !opts.token) return null;
  const f = opts.fetch ?? fetch;
  return async (req) => {
    const timeoutMs = req.timeoutMs ?? 120_000;
    try {
      const res = await f(`${opts.apiUrl}/api/model/run`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
        body: JSON.stringify({ system: req.system, prompt: req.prompt, tag: req.tag, mode: "slim", timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs + 30_000),
        timeout: false,
      } as RequestInit);
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string };
      if (!res.ok || !out.ok) return { ok: false, error: out.error ?? `model service answered HTTP ${res.status}` };
      return { ok: true, text: (out.text ?? "").trim() };
    } catch (e) {
      return { ok: false, error: (e as Error).name === "TimeoutError" ? `no answer from the model within ${Math.round(timeoutMs / 1000)}s` : `model service unreachable: ${(e as Error).message}` };
    }
  };
}
