import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { createServer } from "./index.ts";
import { appTask, fakeSpace } from "./testing.ts";

const NOW = Date.parse("2026-11-08T13:00:00.000Z");
const space = fakeSpace({ now: () => NOW, tasks: [appTask("theme-watch", "refresh")], apps: [{ name: "theme-watch", title: "Theme Watch", url: "https://theme-watch.example/" }] });
const app = createServer({
  db: openDatabase(":memory:"), space, model: null, port: 0, web: false, app: "task-shelf", machine: "box", machineZone: "America/Los_Angeles",
  dataDir: mkdtempSync(join(tmpdir(), "task-shelf-")), now: () => NOW, log: () => {},
});
afterAll(() => app.stop());
const base = `http://127.0.0.1:${app.port}`;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("routes", () => {
  test("health and meta", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${base}/api/meta`)).json()).toMatchObject({ ok: true, app: "task-shelf", machine: "box", writable: true, assistant: false });
  });

  test("create a job, see it in the overview, pause and run it", async () => {
    const res = await post("/api/jobs", { name: "nightly", kind: "command", command: "echo hi", schedule: { kind: "cron", expr: "0 3 * * *" }, zone: "Asia/Shanghai" });
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: { id: number; schedule: { tz: string } } };
    expect(job.schedule.tz).toBe("Asia/Shanghai");
    const ov = (await (await fetch(`${base}/api/overview`)).json()) as { rows: { owner: string; name: string }[]; counts: { total: number; mine: number } };
    expect(ov.counts).toMatchObject({ total: 2, mine: 1 });
    expect(ov.rows.map((r) => `${r.owner}:${r.name}`)).toEqual(["mine:nightly", "app:refresh"]);
    expect((await (await post(`/api/jobs/${job.id}/pause`, {})).json()) as object).toMatchObject({ ok: true, job: { enabled: false } });
    expect((await (await post(`/api/jobs/${job.id}/run`, {})).json()) as object).toMatchObject({ ok: true, started: true });
  });

  test("errors come back with a code", async () => {
    const res = await post("/api/jobs", { name: "x", kind: "command", command: "true", schedule: { kind: "cron", expr: "0 3 * * *", tz: "PST" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "bad-zone" });
    expect((await post("/api/jobs/999/run", {})).status).toBe(404);
  });

  test("schedule preview", async () => {
    const r = (await (await post("/api/schedule/preview", { schedule: { kind: "cron", expr: "30 8 * * 1-5" }, zone: "America/Los_Angeles" })).json()) as { text: { zh: string }; next: string[] };
    expect(r.text.zh).toBe("工作日 08:30");
    expect(r.next[0]).toBe("2026-11-09T16:30:00.000Z");
  });

  test("writes from another site, or not as JSON, are refused", async () => {
    expect((await post("/api/jobs", { name: "evil", kind: "command", command: "true", schedule: { kind: "every", every: "1h" } }, { origin: "https://evil.example", host: "task-shelf.example" })).status).toBe(403);
    expect((await fetch(`${base}/api/jobs`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(403);
  });

  test("the assistant says when it has no model", async () => {
    const r = (await (await post("/api/assistant", { message: "hi", lang: "en" })).json()) as { messages: { text: string }[] };
    expect(r.messages[1]!.text).toContain("unavailable");
  });

  test("runs of another app's task are readable", async () => {
    space.runsOf.set("theme-watch-refresh", [{ id: 1, taskId: "theme-watch-refresh", startedAt: NOW - 1000, endedAt: NOW, status: "ok", trigger: "schedule" }]);
    const r = (await (await fetch(`${base}/api/rows/theme-watch-refresh/runs`)).json()) as { runs: unknown[] };
    expect(r.runs).toHaveLength(1);
  });
});
