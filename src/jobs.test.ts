import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRows, countRows, nextUp } from "./catalog.ts";
import { changesOf, keptRuns, listJobs, openDatabase } from "./db.ts";
import { JobError, Shelf } from "./jobs.ts";
import { appTask, fakeSpace } from "./testing.ts";

const NOW = Date.parse("2026-11-08T13:00:00.000Z");
const ZONE = "America/Los_Angeles";

function setup(o: { writable?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const space = fakeSpace({ now: () => NOW, writable: o.writable });
  const dataDir = mkdtempSync(join(tmpdir(), "task-shelf-"));
  const shelf = new Shelf({ db, space, app: "task-shelf", dataDir, agentRuntime: "claude", now: () => NOW });
  return { db, space, shelf, dataDir };
}

const nightly = { name: "nightly-export", description: "Export notes", kind: "command", command: "bun scripts/export.ts", schedule: { kind: "cron", expr: "0 3 * * *" } };
const errCode = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as JobError).code; } return "no error"; };

describe("job store", () => {
  test("a new job is stored and becomes an ai-space task of this app", async () => {
    const { shelf, space, db } = setup();
    const job = await shelf.create(nightly, "page", ZONE);
    expect(job).toMatchObject({ name: "nightly-export", kind: "command", enabled: true, timeoutMs: 600_000, schedule: { kind: "cron", expr: "0 3 * * *", tz: ZONE } });
    expect(space.tasks).toHaveLength(1);
    expect(space.tasks[0]).toMatchObject({ app: "task-shelf", name: "nightly-export", source: "api", schedule: { kind: "cron", expr: "0 3 * * *", tz: ZONE }, target: { kind: "command", command: "bun scripts/export.ts" } });
    expect(job.spaceTaskId).toBe(space.tasks[0]!.id);
    expect(changesOf(db, job.id).map((c) => [c.actor, c.action])).toEqual([["page", "create"]]);
  });

  test("validation: names, kinds, targets, timeouts", async () => {
    const { shelf, space } = setup();
    expect(await errCode(shelf.create({ ...nightly, name: "Nightly Export" }, "page", ZONE))).toBe("bad-name");
    expect(await errCode(shelf.create({ ...nightly, name: "backup" }, "page", ZONE))).toBe("reserved-name");
    expect(await errCode(shelf.create({ ...nightly, kind: "python" }, "page", ZONE))).toBe("bad-kind");
    expect(await errCode(shelf.create({ ...nightly, command: "  " }, "page", ZONE))).toBe("bad-command");
    expect(await errCode(shelf.create({ ...nightly, cwd: "relative/dir" }, "page", ZONE))).toBe("bad-cwd");
    expect(await errCode(shelf.create({ name: "ping", kind: "http", url: "ftp://x", schedule: { kind: "every", every: "1h" } }, "page", ZONE))).toBe("bad-url");
    expect(await errCode(shelf.create({ name: "ping", kind: "http", url: "https://u:p@x.test/", schedule: { kind: "every", every: "1h" } }, "page", ZONE))).toBe("bad-url");
    expect(await errCode(shelf.create({ name: "ping", kind: "http", method: "GET", url: "https://x.test/", body: { a: 1 }, schedule: { kind: "every", every: "1h" } }, "page", ZONE))).toBe("bad-body");
    expect(await errCode(shelf.create({ name: "think", kind: "agent", prompt: "", schedule: { kind: "every", every: "1h" } }, "page", ZONE))).toBe("bad-prompt");
    expect(await errCode(shelf.create({ ...nightly, timeout: "2s" }, "page", ZONE))).toBe("bad-timeout");
    expect(await errCode(shelf.create({ ...nightly, schedule: { kind: "cron", expr: "0 3 * * *", tz: "PST" } }, "page", ZONE))).toBe("bad-zone");
    expect(space.tasks).toHaveLength(0);
    await shelf.create(nightly, "page", ZONE);
    expect(await errCode(shelf.create(nightly, "page", ZONE))).toBe("name-taken");
  });

  test("http and agent targets", async () => {
    const { shelf, space, dataDir } = setup();
    await shelf.create({ name: "ping", kind: "http", method: "post", url: "http://127.0.0.1:9045/jobs/refresh", body: '{"full":true}', schedule: { kind: "every", every: "30m" } }, "page", ZONE);
    expect(space.tasks[0]!.target).toEqual({ kind: "http", method: "POST", url: "http://127.0.0.1:9045/jobs/refresh", body: { full: true } });
    await shelf.create({ name: "digest", kind: "agent", prompt: "Summarise yesterday's notes.", model: "claude/junior", schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" } }, "page", ZONE);
    expect(space.tasks[1]!.target).toEqual({ kind: "agent", runtime: "claude", model: "junior", prompt: join(dataDir, "prompts", "digest.md"), cwd: dataDir });
    expect(await Bun.file(join(dataDir, "prompts", "digest.md")).text()).toBe("Summarise yesterday's notes.\n");
  });

  test("nothing is stored when ai-space refuses the task", async () => {
    const { shelf, space, db } = setup();
    space.failNext.create = 500;
    expect(await errCode(shelf.create(nightly, "page", ZONE))).toBe("space");
    expect(listJobs(db)).toHaveLength(0);
  });

  test("without an operator credential nothing can be changed", async () => {
    const { shelf } = setup({ writable: false });
    expect(await errCode(shelf.create(nightly, "page", ZONE))).toBe("read-only");
  });

  test("schedule and on/off change in place; anything else replaces the task and keeps its runs", async () => {
    const { shelf, space, db } = setup();
    const job = await shelf.create(nightly, "page", ZONE);
    const first = space.tasks[0]!.id;
    await shelf.update(job.id, { schedule: { kind: "cron", expr: "30 4 * * *", tz: "UTC" } }, "page", ZONE);
    expect(space.tasks[0]!.id).toBe(first);
    expect(space.tasks[0]!.schedule).toEqual({ kind: "cron", expr: "30 4 * * *", tz: "UTC" });

    space.runsOf.set(first, [{ id: 7, taskId: first, startedAt: NOW - 1000, endedAt: NOW, status: "ok", trigger: "schedule", output: "done" }]);
    const changed = await shelf.update("nightly-export", { command: "bun scripts/export.ts --all", timeout: "20m" }, "assistant", ZONE);
    expect(space.tasks).toHaveLength(1);
    expect(space.tasks[0]!.id).not.toBe(first);
    expect(space.tasks[0]!.target).toEqual({ kind: "command", command: "bun scripts/export.ts --all" });
    expect(space.tasks[0]!.timeoutMs).toBe(1_200_000);
    expect(changed.spaceTaskId).toBe(space.tasks[0]!.id);
    expect(keptRuns(db, job.id).map((r) => r.id)).toEqual([7]);
    expect(changesOf(db, job.id).map((c) => `${c.actor}:${c.action}:${c.detail}`)[0]).toBe("assistant:update:command, timeoutMs");
  });

  test("a failed replacement puts the previous task back", async () => {
    const { shelf, space } = setup();
    const job = await shelf.create(nightly, "page", ZONE);
    let creates = 0;
    const create = space.createTask;
    space.createTask = async (b) => { if (creates++ === 0) throw new (await import("./space.ts")).SpaceError(500, "boom"); return create(b); };
    expect(await errCode(shelf.update(job.id, { command: "bun other.ts" }, "page", ZONE))).toBe("space");
    expect(space.tasks).toHaveLength(1);
    expect(space.tasks[0]!.target).toEqual({ kind: "command", command: "bun scripts/export.ts" });
    expect(shelf.find(job.id).command).toBe("bun scripts/export.ts");
  });

  test("pause, resume and run now", async () => {
    const { shelf, space } = setup();
    const job = await shelf.create(nightly, "page", ZONE);
    expect((await shelf.setEnabled(job.id, false, "page")).enabled).toBe(false);
    expect(space.tasks[0]!.enabled).toBe(false);
    expect((await shelf.setEnabled(job.id, true, "page")).enabled).toBe(true);
    expect((await shelf.runNow(job.id, "page")).started).toBe(true);
    expect((await shelf.runNow(job.id, "page")).started).toBe(false);
  });

  test("archive takes the task out of ai-space, keeps the job and its runs, and restore brings it back", async () => {
    const { shelf, space, db } = setup();
    const job = await shelf.create(nightly, "page", ZONE);
    space.runsOf.set(job.spaceTaskId!, [{ id: 3, taskId: job.spaceTaskId!, startedAt: NOW - 5000, endedAt: NOW - 4000, status: "error", error: "exit 1", trigger: "schedule" }]);
    const archived = await shelf.archive(job.id, "page");
    expect(archived.archivedAt).toBe(NOW);
    expect(space.tasks).toHaveLength(0);
    expect(listJobs(db, { archived: true }).map((j) => j.name)).toEqual(["nightly-export"]);
    expect(keptRuns(db, job.id)).toHaveLength(1);
    expect(await errCode(shelf.runNow(job.id, "page"))).toBe("archived");
    const back = await shelf.restore(job.id, "page");
    expect(back.archivedAt).toBeNull();
    expect(space.tasks[0]).toMatchObject({ name: "nightly-export", enabled: true });
  });

  test("reconcile registers a missing task, repairs drift and leaves unknown tasks alone", async () => {
    const { shelf, space } = setup();
    const a = await shelf.create(nightly, "page", ZONE);
    await shelf.create({ name: "ping", kind: "http", url: "https://example.test/ping", schedule: { kind: "every", every: "1h" } }, "page", ZONE);
    space.tasks = space.tasks.filter((t) => t.id !== a.spaceTaskId);                 // lost
    space.tasks[0]!.enabled = false;                                                  // drifted
    space.tasks.push({ ...appTask("task-shelf", "left-over"), source: "api" });       // not ours any more
    const r = await shelf.reconcile();
    expect(r.created).toEqual(["nightly-export"]);
    expect(r.fixed).toEqual(["ping"]);
    expect(r.strays).toEqual(["left-over"]);
    expect(space.tasks.map((t) => t.name).sort()).toEqual(["left-over", "nightly-export", "ping"]);
    expect(space.tasks.find((t) => t.name === "ping")!.enabled).toBe(true);
  });
});

describe("overview", () => {
  test("rows say who owns each task, whether it has a page and which zone it runs in", async () => {
    const { shelf, space } = setup();
    await shelf.create(nightly, "page", ZONE);
    space.tasks.push(
      appTask("theme-watch", "refresh"),
      appTask("feed", "ingest", { state: { consecutiveErrors: 3, lastStatus: "error", lastError: "HTTP 502", lastRunAt: "2026-11-08T12:00:00.000Z", nextRunAt: "2026-11-08T13:05:00.000Z" } }),
      appTask("space", "backup-verify", { schedule: { kind: "cron", expr: "0 5 * * 1" } }),
      appTask("theme-watch", "backup"),
      appTask("feed", "backup"),
    );
    space.apps = [{ name: "theme-watch", title: "Theme Watch", url: "https://theme-watch.example/", i18n: { zh: { title: "主题观察台" } } }, { name: "feed", title: "Feed" }];
    const rows = buildRows({ tasks: await space.listTasks(), apps: space.apps, jobs: shelf.list(), app: "task-shelf", machine: "box", machineZone: "America/Los_Angeles" });
    const by = (k: string) => rows.find((r) => `${r.app}/${r.name}` === k)!;
    expect(by("task-shelf/nightly-export")).toMatchObject({ owner: "mine", headless: false, zone: ZONE, zoneDeclared: true, registered: true });
    expect(by("theme-watch/refresh")).toMatchObject({ owner: "app", headless: false, appTitle: { zh: "主题观察台", en: "Theme Watch" }, zone: "America/Los_Angeles", zoneDeclared: false });
    expect(by("feed/ingest")).toMatchObject({ owner: "app", headless: true, lastStatus: "error", consecutiveErrors: 3 });
    expect(by("space/backup-verify")).toMatchObject({ owner: "system", headless: false });
    // A backup task has a page when the app it backs up has one.
    expect(by("theme-watch/backup")).toMatchObject({ owner: "system", headless: false });
    expect(by("feed/backup")).toMatchObject({ owner: "system", headless: true });
    expect(rows[0]!.owner).toBe("mine");
    expect(countRows(rows)).toMatchObject({ total: 6, failing: 1, mine: 1, headless: 2 });
    expect(nextUp(rows)!.name).toBe("ingest");
  });

  test("a job ai-space does not have shows as not registered", async () => {
    const { shelf, space } = setup();
    await shelf.create(nightly, "page", ZONE);
    space.tasks = [];
    const rows = buildRows({ tasks: [], apps: [], jobs: shelf.list(), app: "task-shelf", machine: "box", machineZone: "UTC" });
    expect(rows[0]).toMatchObject({ owner: "mine", registered: false, taskId: null, syncError: "not registered in ai-space" });
  });
});
