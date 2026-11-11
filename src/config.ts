import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const env = (k: string, d = "") => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => { const v = env(k); const n = Number(v); return v !== "" && Number.isFinite(n) ? n : d; };

/** The zone this server process runs in; shown as "machine zone" for cron tasks that declare none. */
export const serverZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const config = {
  port: num("PORT", 9145),
  /** This app's name in ai-space; its own jobs are the ai-space tasks under this app. */
  app: env("SPACE_APP", "task-shelf"),
  /** What this space calls itself; every row is labelled with it. */
  machine: env("SPACE_NAME"),
  spaceApiUrl: env("SPACE_API_URL", "http://127.0.0.1:8700").replace(/\/$/, ""),
  /** Reads (tasks, runs, apps) and model calls go with the app's own token. */
  spaceAppToken: env("SPACE_APP_TOKEN"),
  dataDir: resolve(env("SPACE_APP_DATA_DIR", "data")),
  /** Runtime for agent jobs (an ai-space runtime with the `agent` capability). */
  agentRuntime: env("SHELF_AGENT_RUNTIME", "claude"),
  /** Zone for new jobs when neither the person nor the page gives one (docs/time.md: documented default). */
  defaultZone: env("SHELF_DEFAULT_TZ", "UTC"),
  assistantTimeoutMs: num("SHELF_ASSISTANT_TIMEOUT_MS", 120_000),
  /** Claude Code's folder on this machine: where the session a run names is read from (src/transcript.ts). */
  claudeDir: env("CLAUDE_CONFIG_DIR") || join(homedir(), ".claude"),
};

/**
 * Creating, changing and running this app's tasks needs the operator credential: ai-space's task
 * write routes take no app token. `SPACE_API_TOKEN` when set, else the file ai-space keeps for
 * local callers under SPACE_AUTH=builtin (`<workspace>/run/operator-token`; reading it is the local
 * permission, ai-space src/space/auth/operator-token.ts). The token stays in this process and is
 * only ever sent to ai-space for tasks of this app.
 */
export async function operatorToken(e: Record<string, string | undefined> = process.env): Promise<string> {
  const direct = (e.SPACE_API_TOKEN ?? "").trim();
  if (direct) return direct;
  const file = (e.SHELF_OPERATOR_TOKEN_FILE ?? "").trim() || (e.SPACE_APP_DATA_DIR ? resolve(dirname(dirname(resolve(e.SPACE_APP_DATA_DIR))), "run", "operator-token") : "");
  if (!file) return "";
  const f = Bun.file(file);
  return (await f.exists()) ? (await f.text()).trim() : "";
}

/** SQLite file: `DATABASE_URL` (sqlite:///abs/path) from ai-space, else data/main.db. */
export function databasePath(e: Record<string, string | undefined> = process.env): string {
  const url = (e.DATABASE_URL ?? "").trim();
  if (url === ":memory:") return url;
  if (url) {
    const m = /^sqlite:\/\/(.*)$/.exec(url);
    if (!m) throw new Error(`DATABASE_URL must be sqlite:///path, got ${url}`);
    return m[1]!.startsWith("/") ? m[1]! : resolve(m[1]!);
  }
  return resolve(e.SPACE_APP_DATA_DIR ?? "data", "main.db");
}
