import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { createServer } from "./index.ts";
import { callerAllowed, forwarder, machineFinder, readRemote } from "./remote.ts";
import { fakeSpace } from "./testing.ts";

const NOW = Date.parse("2026-11-08T13:00:00.000Z");

describe("readRemote", () => {
  test("only the page's routes, with their methods", () => {
    expect(readRemote({ method: "get", path: "/api/overview" })).toEqual({ method: "GET", path: "/api/overview" });
    expect(readRemote({ method: "POST", path: "/api/jobs/3/pause", body: {} })).toMatchObject({ method: "POST", path: "/api/jobs/3/pause" });
    expect(readRemote({ method: "GET", path: "/api/rows/t1/runs?limit=10" })?.path).toBe("/api/rows/t1/runs?limit=10");
    expect(readRemote({ method: "DELETE", path: "/api/jobs/3" })).toBeNull();
    expect(readRemote({ method: "POST", path: "/api/remote" })).toBeNull();
    expect(readRemote({ method: "GET", path: "/api/m/x/api/overview" })).toBeNull();
    expect(readRemote({ method: "GET", path: "/healthz" })).toBeNull();
    expect(readRemote({ method: "GET", path: "/api/../healthz" })).toBeNull();
    expect(readRemote("nope")).toBeNull();
  });

  test("callers: this app here or on another space", () => {
    expect(callerAllowed("seoul/task-shelf", "task-shelf")).toBe(true);
    expect(callerAllowed("task-shelf", "task-shelf")).toBe(true);
    expect(callerAllowed("seoul/hive", "task-shelf")).toBe(false);
    expect(callerAllowed("space", "task-shelf")).toBe(false);
    expect(callerAllowed(null, "task-shelf")).toBe(false);
  });
});

describe("machineFinder", () => {
  test("peers whose ai-space lists this app's ops, asked with the app token", async () => {
    const f = (async (_u: string, init: RequestInit) => (init.headers as Record<string, string>).authorization !== "Bearer t" ? new Response("{}", { status: 401 }) : Response.json({ ok: true, apps: [
      { app: "task-shelf", provides: [{ name: "ops" }] },
      { app: "task-shelf", peer: "thinkbook", provides: [{ name: "ops" }] },
      { app: "task-shelf", peer: "david", provides: [{ name: "ops" }] },
      { app: "task-shelf", peer: "old", provides: [] },
      { app: "hive", peer: "x", provides: [{ name: "ops" }] },
    ] })) as unknown as typeof fetch;
    expect(await machineFinder({ apiUrl: "http://s", app: "task-shelf", local: "seoul", token: "t", fetch: f })()).toEqual({ local: "seoul", peers: ["david", "thinkbook"], error: null });
  });

  test("ai-space down: this machine only, with the error", async () => {
    const f = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    expect(await machineFinder({ apiUrl: "http://s", app: "task-shelf", local: "seoul", token: "t", fetch: f })()).toMatchObject({ peers: [], error: "refused" });
  });
});

describe("one page over two machines", () => {
  const mk = (machine: string, extra: Partial<Parameters<typeof createServer>[0]> = {}) => createServer({
    db: openDatabase(":memory:"), space: fakeSpace({ now: () => NOW }), model: null, port: 0, web: false, app: "task-shelf", machine, machineZone: "UTC",
    dataDir: mkdtempSync(join(tmpdir(), "task-shelf-")), now: () => NOW, log: () => {}, ...extra,
  });
  const peer = mk("david");
  const peerBase = `http://127.0.0.1:${peer.port}`;
  // The bus between them: the hub's call arrives at the peer's /api/remote as `<hub>/task-shelf`.
  const bus = (async (_url: string, init: RequestInit) => fetch(`${peerBase}/api/remote`, { ...init, headers: { ...(init.headers as Record<string, string>), "x-space-caller": "seoul/task-shelf" } })) as unknown as typeof fetch;
  const hub = mk("seoul", {
    machines: async () => ({ local: "seoul", peers: ["david"], error: null }),
    forward: forwarder({ apiUrl: "http://space", app: "task-shelf", token: "t", fetch: bus }),
  });
  const base = `http://127.0.0.1:${hub.port}`;
  afterAll(() => { hub.stop(); peer.stop(); });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("the hub lists its machines", async () => {
    expect(await (await fetch(`${base}/api/machines`)).json()).toEqual({ ok: true, local: "seoul", peers: ["david"], error: null });
  });

  test("a job made on the hub's page for the peer lives on the peer", async () => {
    const res = await post("/api/m/david/api/jobs", { name: "ping", kind: "http", method: "GET", url: "https://example.com", schedule: { kind: "every", every: "1h" } });
    expect(res.status).toBe(201);
    const { job } = (await res.json()) as { job: { id: number } };
    const there = (await (await fetch(`${peerBase}/api/overview`)).json()) as { machine: string; rows: { name: string }[] };
    expect(there.rows.map((r) => r.name)).toEqual(["ping"]);
    const here = (await (await fetch(`${base}/api/overview`)).json()) as { rows: unknown[] };
    expect(here.rows).toEqual([]);
    const via = (await (await fetch(`${base}/api/m/david/api/overview`)).json()) as { machine: string; rows: { name: string }[] };
    expect(via.machine).toBe("david");
    expect((await (await post(`/api/m/david/api/jobs/${job.id}/pause`, {})).json()) as object).toMatchObject({ ok: true, job: { enabled: false } });
  });

  test("errors keep their code across machines", async () => {
    const res = await post("/api/m/david/api/jobs/999/run", {});
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "not-found" });
  });

  test("an unknown machine, a cross-site write and a route outside the page are refused", async () => {
    expect((await fetch(`${base}/api/m/nowhere/api/overview`)).status).toBe(404);
    expect((await post("/api/m/david/api/jobs", {}, { origin: "https://evil.example", host: "task-shelf.example" })).status).toBe(403);
    expect((await fetch(`${base}/api/m/david/healthz`)).status).toBe(404);
  });

  test("ops answers only this app", async () => {
    const call = (caller: string) => fetch(`${peerBase}/api/remote`, { method: "POST", headers: { "content-type": "application/json", "x-space-caller": caller }, body: JSON.stringify({ method: "GET", path: "/api/meta" }) });
    expect((await call("seoul/task-shelf")).status).toBe(200);
    expect((await call("seoul/hive")).status).toBe(403);
    expect((await fetch(`${peerBase}/api/remote`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
  });
});
