import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Assistant, readPlan, systemPrompt, userPrompt } from "./assistant.ts";
import { buildRows } from "./catalog.ts";
import { changesOf, getPending, listJobs, messages, openDatabase } from "./db.ts";
import { Shelf } from "./jobs.ts";
import type { ModelFn, ModelRequest } from "./space.ts";
import { appTask, fakeSpace } from "./testing.ts";

const NOW = Date.parse("2026-11-08T13:00:00.000Z");
const ZONE = "America/Los_Angeles";

/** A model that answers from a script, one answer per call, and records what it was asked. */
function scripted(answers: (string | ((req: ModelRequest) => string))[]) {
  const asked: ModelRequest[] = [];
  const model: ModelFn = async (req) => {
    asked.push(req);
    const a = answers.shift();
    if (a === undefined) return { ok: false, error: "no more answers" };
    return { ok: true, text: typeof a === "function" ? a(req) : a };
  };
  return { model, asked };
}

function setup(answers: (string | ((req: ModelRequest) => string))[]) {
  const db = openDatabase(":memory:");
  const space = fakeSpace({ now: () => NOW });
  space.tasks.push(appTask("theme-watch", "refresh"));
  space.apps = [{ name: "theme-watch", title: "Theme Watch", url: "https://theme-watch.example/" }];
  const shelf = new Shelf({ db, space, app: "task-shelf", dataDir: mkdtempSync(join(tmpdir(), "task-shelf-")), agentRuntime: "claude", now: () => NOW });
  const { model, asked } = scripted(answers);
  const rows = async () => buildRows({ tasks: await space.listTasks(), apps: space.apps, jobs: shelf.list(), app: "task-shelf", machine: "box", machineZone: ZONE });
  const assistant = new Assistant({ db, shelf, model, rows, runs: async (row, limit) => (row.taskId ? space.runs(row.taskId, limit) : []), machine: "box", now: () => NOW });
  return { db, space, shelf, assistant, asked };
}

const plan = (reply: string, actions: unknown[] = []) => JSON.stringify({ reply, actions });

describe("reading the model's answer", () => {
  test("JSON inside fences or chatter; unknown tools dropped; plain text kept as the reply", () => {
    expect(readPlan('```json\n{"reply":"ok","actions":[{"tool":"pause_job","args":{"ref":"a"}},{"tool":"rm_rf","args":{}}]}\n```')).toEqual({ reply: "ok", actions: [{ tool: "pause_job", args: { ref: "a" } }] });
    expect(readPlan('Sure! {"reply":"hi","actions":[]} hope that helps')).toEqual({ reply: "hi", actions: [] });
    expect(readPlan("just words")).toEqual({ reply: "just words", actions: [] });
    expect(readPlan('{"reply":"x","actions":[{"tool":"run_job","args":[1,2]}]}').actions).toEqual([{ tool: "run_job", args: {} }]);
  });

  test("the prompt carries the clock in the person's zone, this app's jobs and the read-only tasks", () => {
    const p = userPrompt({ rows: [], past: [], message: "hi", zone: "Asia/Shanghai", lang: "zh", now: NOW });
    expect(p).toContain("Now: 2026-11-08T21:00 Sun (Asia/Shanghai)");
    expect(p).toContain("Page language: Chinese");
    expect(systemPrompt("box")).toContain("Never invent a command");
  });
});

describe("assistant actions", () => {
  test("create a job by chat: stored, registered in ai-space, logged as the assistant", async () => {
    const { assistant, space, db, asked } = setup([
      plan("好的，我来建一个每天凌晨 3 点的导出任务。", [{ tool: "create_job", args: { name: "nightly-export", kind: "command", command: "bun scripts/export.ts", schedule: { kind: "cron", expr: "0 3 * * *" } } }]),
    ]);
    const [user, answer] = await assistant.turn({ message: "每天凌晨3点运行 bun scripts/export.ts", zone: ZONE, lang: "zh" });
    expect(user!.role).toBe("user");
    expect(answer!.text).toContain("导出任务");
    expect(answer!.actions).toEqual([{ tool: "create_job", ok: true, jobId: 1, summary: "已创建 nightly-export · 每天 03:00 · America/Los_Angeles" }]);
    expect(space.tasks.find((t) => t.app === "task-shelf")).toMatchObject({ name: "nightly-export", schedule: { kind: "cron", expr: "0 3 * * *", tz: ZONE } });
    expect(changesOf(db, 1).map((c) => c.actor)).toEqual(["assistant"]);
    expect(asked[0]!.tag).toBe("assistant");
    expect(asked[0]!.prompt).toContain("theme-watch/refresh");
  });

  test("pause, resume, update and run; a failure shows on its chip", async () => {
    const { assistant, shelf, space } = setup([
      plan("暂停。", [{ tool: "pause_job", args: { ref: "ping" } }]),
      plan("改成每 2 小时并运行一次。", [{ tool: "update_job", args: { ref: "ping", schedule: { kind: "every", every: "2h" } } }, { tool: "run_job", args: { ref: "ping" } }]),
      plan("恢复。", [{ tool: "resume_job", args: { ref: "nope" } }]),
    ]);
    await shelf.create({ name: "ping", kind: "http", url: "https://example.test/ping", schedule: { kind: "every", every: "1h" } }, "page", ZONE);
    const t = () => space.tasks.find((x) => x.name === "ping")!;
    await assistant.turn({ message: "pause ping", zone: ZONE, lang: "en" });
    expect(t().enabled).toBe(false);
    const [, a2] = await assistant.turn({ message: "every 2h and run it", zone: ZONE, lang: "zh" });
    expect(t().schedule).toMatchObject({ kind: "every", everyMs: 7_200_000 });
    expect(a2!.actions.map((a) => [a.tool, a.ok])).toEqual([["update_job", true], ["run_job", true]]);
    const [, a3] = await assistant.turn({ message: "resume nope", zone: ZONE, lang: "en" });
    expect(a3!.actions[0]).toMatchObject({ tool: "resume_job", ok: false });
    expect(a3!.actions[0]!.error).toContain("not-found");
  });

  test("other apps' tasks cannot be changed through the assistant", async () => {
    const { assistant, space } = setup([plan("Pausing it.", [{ tool: "pause_job", args: { ref: "theme-watch/refresh" } }])]);
    const [, a] = await assistant.turn({ message: "pause theme-watch refresh", zone: ZONE, lang: "en" });
    expect(a!.actions[0]).toMatchObject({ ok: false });
    expect(space.tasks.find((x) => x.app === "theme-watch")!.enabled).toBe(true);
  });

  test("delete waits for the person's confirmation; cancel keeps the job, confirm archives it", async () => {
    const { assistant, shelf, space, db } = setup([
      plan("要删除 ping 吗？", [{ tool: "delete_job", args: { ref: "ping" } }]),
      plan("要删除 ping 吗？", [{ tool: "delete_job", args: { ref: "ping" } }]),
    ]);
    await shelf.create({ name: "ping", kind: "http", url: "https://example.test/ping", schedule: { kind: "every", every: "1h" } }, "page", ZONE);
    const [, ask] = await assistant.turn({ message: "删掉 ping", zone: ZONE, lang: "zh" });
    expect(ask!.confirm).toMatchObject({ name: "ping", state: "open", action: "archive" });
    expect(space.tasks.some((x) => x.name === "ping")).toBe(true);                    // nothing happened yet

    await assistant.confirm(ask!.confirm!.token, false, "zh");
    expect(space.tasks.some((x) => x.name === "ping")).toBe(true);
    expect(getPending(db, ask!.confirm!.token)!.outcome).toBe("declined");
    expect(messages(db, 1).find((m) => m.id === ask!.id)!.confirm!.state).toBe("declined");
    await expect(assistant.confirm(ask!.confirm!.token, true, "zh")).rejects.toThrow();   // a card is answered once

    const [, again] = await assistant.turn({ message: "还是删掉 ping", zone: ZONE, lang: "zh" });
    const [done] = await assistant.confirm(again!.confirm!.token, true, "zh");
    expect(done!.text).toContain("已删除 ping");
    expect(space.tasks.some((x) => x.name === "ping")).toBe(false);
    expect(listJobs(db, { archived: true }).map((j) => j.name)).toEqual(["ping"]);   // kept, restorable
  });

  test("reading runs goes back to the model for the answer", async () => {
    const { assistant, space, asked } = setup([
      plan("我看一下。", [{ tool: "get_runs", args: { ref: "theme-watch/refresh", limit: 2 } }]),
      (req) => plan(req.prompt.includes("HTTP 502") ? "上一次失败了：HTTP 502。" : "没看到。"),
    ]);
    space.runsOf.set("theme-watch-refresh", [{ id: 1, taskId: "theme-watch-refresh", startedAt: NOW - 60_000, endedAt: NOW - 50_000, status: "error", error: "HTTP 502", trigger: "schedule" }]);
    const [, a] = await assistant.turn({ message: "theme-watch refresh 最近怎么样？", zone: ZONE, lang: "zh" });
    expect(asked).toHaveLength(2);
    expect(a!.text).toBe("上一次失败了：HTTP 502。");
    expect(a!.actions.map((x) => x.tool)).toEqual(["get_runs"]);
  });

  test("a question answered from the list makes one call and no action", async () => {
    const { assistant, asked } = setup([plan("目前没有失败的任务。")]);
    const [, a] = await assistant.turn({ message: "有哪些任务在失败？", zone: ZONE, lang: "zh" });
    expect(asked).toHaveLength(1);
    expect(a!.actions).toEqual([]);
    expect(a!.text).toBe("目前没有失败的任务。");
  });

  test("a new conversation starts a new session and keeps the old one", async () => {
    const { assistant, db } = setup([plan("one"), plan("two")]);
    await assistant.turn({ message: "first", zone: ZONE, lang: "en" });
    const s = assistant.fresh();
    expect(s).toBe(2);
    await assistant.turn({ message: "second", zone: ZONE, lang: "en", session: s });
    expect(assistant.conversation().map((m) => m.text)).toEqual(["second", "two"]);
    expect(messages(db, 1).map((m) => m.text)).toEqual(["first", "one"]);
  });

  test("the model failing is said plainly", async () => {
    const { assistant } = setup([]);
    const [, a] = await assistant.turn({ message: "hi", zone: ZONE, lang: "en" });
    expect(a!.text).toBe("The model call failed: no more answers");
  });
});
