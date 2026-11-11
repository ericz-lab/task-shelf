import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { createServer } from "./index.ts";
import { fakeSpace } from "./testing.ts";
import { readEntries, readTranscript, sessionOf } from "./transcript.ts";

const SID = "a997abf1-dfac-47b5-943a-fe02071d4dfc";
const line = (o: unknown) => JSON.stringify(o);
const SESSION = [
  line({ type: "queue-operation", content: "not a message" }),
  line({ type: "user", timestamp: "2026-11-10T17:00:02.265Z", message: { role: "user", content: "run the job" } }),
  line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "x" }] } }),
  line({ type: "assistant", timestamp: "2026-11-10T17:00:05.000Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la\necho done", description: "List the folder" } }] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.txt" }, { type: "image", source: { data: "AAAA" } }] }] } }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x/y.md" } }] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "no such file" }] } }),
  line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "a helper's words" }] } }),
  "not json",
  line({ type: "assistant", message: { content: [{ type: "text", text: "All done." }] } }),
].join("\n");

describe("a run's conversation", () => {
  test("the session is the one the output names on a line of its own", () => {
    expect(sessionOf(`09:00:00 run in /w (model opus)\nclaude-session: ${SID}\nreport`)).toBe(SID);
    expect(sessionOf(`see claude-session: ${SID}`)).toBeNull();
    expect(sessionOf("claude-session: ../../etc/passwd")).toBeNull();
    expect(sessionOf(undefined)).toBeNull();
  });

  test("messages and tool calls are kept; results join their call; the rest is left out", () => {
    const { entries, truncated } = readEntries(SESSION.split("\n"));
    expect(truncated).toBe(false);
    expect(entries).toEqual([
      { kind: "user", at: "2026-11-10T17:00:02.265Z", text: "run the job" },
      { kind: "tool", at: "2026-11-10T17:00:05.000Z", name: "Bash", title: "List the folder", input: "ls -la\necho done", result: "a.txt\n[image]" },
      { kind: "tool", name: "Read", title: "/x/y.md", input: JSON.stringify({ file_path: "/x/y.md" }, null, 2), result: "no such file", failed: true },
      { kind: "assistant", text: "All done." },
    ]);
  });

  test("long text and long sessions are bounded", () => {
    const many = Array.from({ length: 5 }, (_, i) => line({ type: "assistant", message: { content: [{ type: "text", text: `${i}`.repeat(50) }] } }));
    const r = readEntries(many, { entries: 3, text: 10, input: 10, result: 10, title: 10 });
    expect(r.entries.length).toBe(3);
    expect(r.truncated).toBe(true);
    expect((r.entries[0] as { text: string }).text).toBe("0000000000\n…(40 more chars)");
  });

  test("the route reads only the session a run of this app's job names", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "task-shelf-claude-"));
    mkdirSync(join(claudeDir, "projects", "-w-one"), { recursive: true });
    writeFileSync(join(claudeDir, "projects", "-w-one", `${SID}.jsonl`), SESSION);
    expect((await readTranscript(claudeDir, SID))?.entries.length).toBe(4);
    expect(await readTranscript(claudeDir, "00000000-0000-0000-0000-000000000000")).toBeNull();

    const NOW = Date.parse("2026-11-10T18:00:00.000Z");
    const space = fakeSpace({ now: () => NOW });
    const app = createServer({ db: openDatabase(":memory:"), space, model: null, port: 0, web: false, app: "task-shelf", machine: "box", machineZone: "UTC", dataDir: mkdtempSync(join(tmpdir(), "task-shelf-")), claudeDir, now: () => NOW, log: () => {} });
    try {
      const base = `http://127.0.0.1:${app.port}`;
      await fetch(`${base}/api/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "intake", kind: "command", command: "true", schedule: { kind: "cron", expr: "0 9 * * *" }, zone: "UTC" }) });
      const task = space.tasks[0]!.id;
      const gone = "11111111-2222-3333-4444-555555555555";
      space.runsOf.set(task, [
        { id: 3, taskId: task, startedAt: NOW - 3000, endedAt: NOW - 2000, status: "ok", trigger: "schedule", output: `run\nclaude-session: ${SID}\nreport` },
        { id: 2, taskId: task, startedAt: NOW - 6000, endedAt: NOW - 5000, status: "ok", trigger: "schedule", output: "plain output" },
        { id: 1, taskId: task, startedAt: NOW - 9000, endedAt: NOW - 8000, status: "ok", trigger: "schedule", output: `claude-session: ${gone}` },
      ]);
      const { rows } = (await (await fetch(`${base}/api/overview`)).json()) as { rows: { key: string }[] };
      const key = encodeURIComponent(rows[0]!.key);
      const { runs } = (await (await fetch(`${base}/api/rows/${key}/runs`)).json()) as { runs: { id: number; session?: string }[] };
      expect(runs.map((r) => r.session)).toEqual([SID, undefined, gone]);
      const tx = (n: number) => fetch(`${base}/api/rows/${key}/transcript?task=${task}&run=${n}`);
      const ok = (await (await tx(3)).json()) as { session: string; entries: unknown[]; truncated: boolean };
      expect(ok).toMatchObject({ ok: true, session: SID, truncated: false });
      expect(ok.entries.length).toBe(4);
      expect(await (await tx(2)).json()).toMatchObject({ ok: false, code: "no-transcript" });
      expect(await (await tx(1)).json()).toMatchObject({ ok: false, code: "transcript-gone" });
      expect((await tx(9)).status).toBe(404);
    } finally { app.stop(); }
  });
});
