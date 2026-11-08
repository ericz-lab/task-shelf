/**
 * The tasks page: the overview of every scheduled task on this machine, this app's jobs with their
 * form, the detail of a selected row, and the assistant. State lives in the URL (?tab&f&q&sel&lang)
 * so a link reproduces the view. Times are shown in the browser's zone; schedules name their own.
 */
import { durationText, type Lang, scheduleText } from "../src/describe.ts";
import { applyTranslations, tr } from "./i18n.ts";

type Schedule = { kind: "manual" } | { kind: "at"; at: string; tz?: string } | { kind: "every"; everyMs: number; anchorMs?: number } | { kind: "cron"; expr: string; tz?: string };
interface Row {
  key: string; taskId: string | null; jobId: number | null; app: string; appTitle: { zh: string; en: string } | null; name: string; description: string;
  owner: "mine" | "system" | "app"; headless: boolean; machine: string; schedule: Schedule | null; zone: string | null; zoneDeclared: boolean;
  enabled: boolean; orphaned: boolean; running: boolean; triggers: number; nextRunAt: string | null; lastRunAt: string | null;
  lastStatus: "ok" | "error" | "skipped" | null; lastError: string | null; lastDurationMs: number | null; consecutiveErrors: number;
  target: { kind: string; text: string }; registered: boolean; syncError: string | null; archived: boolean;
}
interface Counts { total: number; enabled: number; failing: number; running: number; paused: number; mine: number; headless: number }
interface Run { id: number; taskId: string; startedAt: number; endedAt: number; status: "ok" | "error" | "skipped"; error?: string; output?: string; trigger: "schedule" | "manual" | "event" }
type JobSchedule = { kind: "cron"; expr: string; tz: string } | { kind: "every"; everyMs: number } | { kind: "at"; at: string; tz: string };
interface Job {
  id: number; name: string; description: string; kind: "command" | "http" | "agent"; command: string | null; cwd: string | null; httpMethod: string | null; httpUrl: string | null;
  httpBody: string | null; prompt: string | null; agentModel: string | null; schedule: JobSchedule; timeoutMs: number; enabled: boolean; spaceTaskId: string | null; archivedAt: number | null;
}
interface Change { at: number; actor: "page" | "assistant" | "system"; action: string; detail: string }
interface ActionResult { tool: string; ok: boolean; summary: string; error?: string }
interface ConfirmCard { token: string; name: string; state: "open" | "done" | "declined" | "failed"; error?: string }
interface Message { id: number; session: number; role: "user" | "assistant"; text: string; actions: ActionResult[]; confirm: ConfirmCard | null; createdAt: number }

const $ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s)!;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll<T>(s)];
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ } },
};
const browserZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();

const params = new URLSearchParams(location.search);
const S = {
  lang: (document.documentElement.lang.startsWith("zh") ? "zh" : "en") as Lang,
  tab: (["mine", "headless", "all"].includes(params.get("tab") ?? "") ? params.get("tab") : "all") as "mine" | "headless" | "all",
  filter: (["failing", "paused", "running"].includes(params.get("f") ?? "") ? params.get("f") : null) as null | "failing" | "paused" | "running",
  q: params.get("q") ?? "",
  sel: params.get("sel"),
  rows: [] as Row[],
  counts: null as Counts | null,
  nextUp: null as Row | null,
  machine: "",
  machineZone: "",
  writable: true,
  spaceError: null as string | null,
  loaded: false,
  loadError: "",
  session: 1,
  messages: [] as Message[],
  assistantOn: true,
  thinking: false,
  editing: null as Job | null,
};
const t = (k: string, v?: Record<string, string | number>) => tr(k, S.lang, v);
const locale = () => (S.lang === "zh" ? "zh-CN" : "en-US");

function writeUrl() {
  const p = new URLSearchParams();
  if (S.tab !== "all") p.set("tab", S.tab);
  if (S.filter) p.set("f", S.filter);
  if (S.q) p.set("q", S.q);
  if (S.sel) p.set("sel", S.sel);
  if (params.get("lang")) p.set("lang", S.lang);
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

// ---------------------------------------------------------------- API

class ApiError extends Error { constructor(readonly code: string, message: string) { super(message); } }

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"), headers: init?.body !== undefined ? { "content-type": "application/json" } : {}, body: init?.body !== undefined ? JSON.stringify(init.body) : undefined });
  } catch {
    throw new ApiError("network", t("err-network"));
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; code?: string; error?: string };
  if (!res.ok || body.ok === false) throw new ApiError(body.code ?? "error", body.error ?? `HTTP ${res.status}`);
  return body as T;
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const key = `err-${e.code}`;
    const known = tr(key, S.lang) !== key;
    return known ? t(key, { error: e.message }) : e.message;
  }
  return String((e as Error)?.message ?? e);
}

// ---------------------------------------------------------------- time

function relTime(iso: string | number | null): string {
  if (iso === null) return "";
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto", style: "short" });
  if (abs < 45_000) return diff >= 0 ? t("nextNow") : rtf.format(0, "second");
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
}

function absTime(iso: string | number | null, zone?: string): string {
  if (iso === null) return "";
  const d = new Date(typeof iso === "number" ? iso : Date.parse(iso));
  return new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(zone ? { timeZone: zone } : {}) }).format(d);
}

const clock = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)) : "");

// ---------------------------------------------------------------- rows

function appLabel(r: Row): string {
  if (r.owner === "mine") return t("ownerMine");
  if (r.app === "space") return t("ownerSystem");
  return r.appTitle ? r.appTitle[S.lang] : r.app;
}

function statusOf(r: Row): { cls: string; text: string } {
  if (r.archived) return { cls: "off", text: t("stArchived") };
  if (r.orphaned) return { cls: "off", text: t("stOrphaned") };
  if (!r.registered) return { cls: "err", text: t("stUnregistered") };
  if (r.running) return { cls: "live", text: t("stRunning") };
  if (!r.enabled) return { cls: "off", text: t("stPaused") };
  if (r.lastStatus === "error") return { cls: "err", text: r.consecutiveErrors > 1 ? t("stErrorN", { n: r.consecutiveErrors }) : t("stError") };
  if (r.lastStatus === "skipped") return { cls: "skip", text: t("stSkipped") };
  if (r.lastStatus === "ok") return { cls: "ok", text: t("stOk") };
  return { cls: "never", text: t("stNever") };
}

function scheduleCell(r: Row): string {
  if (!r.schedule) return "";
  const words = scheduleText(r.schedule.kind === "at" ? { ...r.schedule, tz: r.zone ?? undefined } : r.schedule, S.lang);
  const raw = r.schedule.kind === "cron" ? r.schedule.expr : "";
  const zone = r.zone ? (r.zoneDeclared ? r.zone : t("zoneMachine", { zone: r.zone })) : "";
  const trig = r.triggers ? ` · ${t("triggersN", { n: r.triggers })}` : "";
  const title = r.zone && !r.zoneDeclared ? ` title="${esc(t("zoneMachineTitle", { zone: r.zone }))}"` : "";
  return `<span class="sched-words">${esc(words)}${esc(trig)}</span><span class="mono sched-raw"${title}>${[raw, zone].filter(Boolean).map(esc).join(" · ")}</span>`;
}

function visibleRows(): Row[] {
  const q = S.q.trim().toLowerCase();
  return S.rows.filter((r) => {
    if (S.tab === "mine" && r.owner !== "mine") return false;
    if (S.tab === "headless" && !r.headless) return false;
    if (S.tab !== "mine" && r.archived) return false;
    if (S.filter === "failing" && !((r.enabled && r.lastStatus === "error") || (!r.registered && !r.archived))) return false;
    if (S.filter === "paused" && r.enabled) return false;
    if (S.filter === "running" && !r.running) return false;
    if (q && ![r.name, r.app, r.appTitle?.zh, r.appTitle?.en, r.description, r.target.text].some((x) => (x ?? "").toLowerCase().includes(q))) return false;
    return true;
  });
}

/** The last run's outcome, whatever the task's state now. */
function lastPill(r: Row): string {
  if (r.lastStatus === "error") return `<span class="pill err">${esc(r.consecutiveErrors > 1 ? t("stErrorN", { n: r.consecutiveErrors }) : t("stError"))}</span>`;
  if (r.lastStatus === "skipped") return `<span class="pill skip">${esc(t("stSkipped"))}</span>`;
  return `<span class="pill ok">${esc(t("stOk"))}</span>`;
}

function rowHtml(r: Row): string {
  const st = statusOf(r);
  const mine = r.owner === "mine";
  const canAct = mine && S.writable && !r.archived;
  const next = r.nextRunAt ? `<span class="rel">${esc(relTime(r.nextRunAt))}</span><span class="abs mono">${esc(absTime(r.nextRunAt))}</span>` : `<span class="rel dim">${t("noNext")}</span>`;
  const last = r.running
    ? `<span class="pill live">${esc(t("stRunning"))}</span>`
    : r.lastRunAt
      ? `<span class="rel">${esc(relTime(r.lastRunAt))}</span><span class="last-line">${lastPill(r)}${r.lastDurationMs !== null ? `<span class="mono dim">${esc(durationText(r.lastDurationMs, S.lang))}</span>` : ""}</span>`
      : `<span class="rel dim">${esc(t("stNever"))}</span>`;
  const toggle = mine && !r.archived
    ? `<label class="switch"><input type="checkbox" data-act="toggle" data-id="${r.jobId}" ${r.enabled ? "checked" : ""} ${canAct && r.registered ? "" : "disabled"} aria-label="${esc(t("toggleAria", { name: r.name }))}"><span aria-hidden="true"></span></label>`
    : mine ? `<span class="lock">${esc(t("stArchived"))}</span>` : `<span class="lock" title="${esc(r.owner === "system" ? t("readOnlySystem") : t("readOnlyBy", { app: appLabel(r) }))}"><svg class="ic"><use href="#i-lock"/></svg><span>${esc(t("readOnly"))}</span></span>`;
  const actions = canAct && r.registered
    ? `<button type="button" class="btn btn-sm" data-act="run" data-id="${r.jobId}"><svg class="ic"><use href="#i-play"/></svg><span>${esc(t("runNow"))}</span></button><button type="button" class="btn btn-sm btn-ghost" data-act="edit" data-id="${r.jobId}">${esc(t("edit"))}</button>`
    : canAct && !r.registered ? `<button type="button" class="btn btn-sm" data-act="reconcile">${esc(t("reregister"))}</button>`
    : mine && r.archived && S.writable ? `<button type="button" class="btn btn-sm" data-act="restore" data-id="${r.jobId}">${esc(t("restore"))}</button>` : "";
  return `<div class="row ${st.cls}${S.sel === r.key ? " sel" : ""}${r.enabled && !r.orphaned ? "" : " muted"}" role="row" data-key="${esc(r.key)}" tabindex="0" aria-selected="${S.sel === r.key}">
    <div class="c-name" role="cell"><span class="dot ${st.cls}" title="${esc(st.text)}"></span><span class="nm"><b>${esc(r.name)}</b><span class="meta mono">${esc(appLabel(r))}${r.owner !== "mine" ? ` · ${esc(r.app)}` : ""}${r.headless ? ` · ${esc(t("headlessTag"))}` : ""}</span>${r.syncError && mine ? `<span class="warn">${esc(r.syncError)}</span>` : ""}</span></div>
    <div class="c-sched" role="cell">${scheduleCell(r)}</div>
    <div class="c-next" role="cell">${next}</div>
    <div class="c-last" role="cell">${last}</div>
    <div class="c-on" role="cell">${toggle}</div>
    <div class="c-act" role="cell">${actions}</div>
  </div>`;
}

function renderSummary() {
  const c = S.counts;
  const parts: string[] = [];
  if (c) {
    parts.push(`<span><b class="num">${c.total}</b> ${esc(t("sumTasks", { n: "" }).trim())}</span>`);
    parts.push(`<span><b class="num">${c.enabled}</b> ${esc(t("sumEnabled", { n: "" }).trim())}</span>`);
    if (c.failing) parts.push(`<span class="err"><b class="num">${c.failing}</b> ${esc(t("sumFailing", { n: "" }).trim())}</span>`);
    if (c.running) parts.push(`<span class="live"><b class="num">${c.running}</b> ${esc(t("sumRunning", { n: "" }).trim())}</span>`);
    if (S.nextUp) parts.push(`<span>${esc(t("sumNext", { time: clock(S.nextUp.nextRunAt), name: `${S.nextUp.owner === "mine" ? "" : `${S.nextUp.app}/`}${S.nextUp.name}` }))}</span>`);
    if (S.machine) parts.push(`<span class="mono dim">${esc(t("sumMachine", { name: S.machine }))}</span>`);
  }
  $("#sum").innerHTML = parts.join('<i class="sep" aria-hidden="true">·</i>');
  $("#ro-banner").hidden = S.writable;
}

function renderTabs() {
  const c = S.counts;
  const n = { mine: c?.mine ?? 0, headless: c?.headless ?? 0, all: c?.total ?? 0 };
  for (const b of $$("[data-tab]")) {
    const k = b.dataset.tab as keyof typeof n;
    b.setAttribute("aria-pressed", String(S.tab === k));
    $(".n", b).textContent = String(n[k]);
  }
  for (const b of $$("[data-f]")) b.setAttribute("aria-pressed", String(S.filter === b.dataset.f));
}

function renderList() {
  const list = $("#rows");
  const state = $("#list-state");
  if (!S.loaded) {
    state.dataset.state = "loading";
    state.innerHTML = Array.from({ length: 6 }, () => '<div class="skel"><i></i><i></i><i></i><i></i></div>').join("");
    list.innerHTML = "";
    return;
  }
  const rows = visibleRows();
  if (S.loadError || S.spaceError) {
    state.dataset.state = "error";
    state.innerHTML = `<p>${esc(t("errorList", { error: S.loadError || S.spaceError || "" }))}</p><button type="button" class="btn btn-sm" data-act="reload">${esc(t("retry"))}</button>`;
  } else if (!rows.length) {
    state.dataset.state = "empty";
    state.innerHTML = `<p>${esc(S.tab === "mine" && !S.q && !S.filter ? t("emptyMine") : t("emptyFilter"))}</p>${S.tab === "mine" && S.writable ? `<button type="button" class="btn btn-sm btn-primary" data-act="new">${esc(t("newJob"))}</button>` : ""}`;
  } else {
    state.dataset.state = "";
    state.innerHTML = "";
  }
  list.innerHTML = rows.map(rowHtml).join("");
}

// ---------------------------------------------------------------- detail

let detailFor = "";
async function renderDetail() {
  const box = $("#detail");
  const r = S.rows.find((x) => x.key === S.sel);
  if (!r) { box.hidden = true; box.innerHTML = ""; detailFor = ""; document.body.classList.remove("has-detail"); return; }
  box.hidden = false;
  document.body.classList.add("has-detail");
  const mine = r.owner === "mine";
  const canAct = mine && S.writable && !r.archived && r.registered;
  const src = mine ? t("dSourceMine", { id: r.taskId ?? "—" }) : r.owner === "system" ? t("dSourceSystem") : t("dSourceApp", { app: r.app });
  const zone = r.zone ? (r.zoneDeclared ? r.zone : t("zoneMachine", { zone: r.zone })) : "—";
  const btns = mine
    ? r.archived
      ? (S.writable ? `<button type="button" class="btn" data-act="restore" data-id="${r.jobId}">${esc(t("restore"))}</button>` : "")
      : `<button type="button" class="btn btn-primary" data-act="run" data-id="${r.jobId}" ${canAct ? "" : "disabled"}><svg class="ic"><use href="#i-play"/></svg><span>${esc(t("runNow"))}</span></button>
         <button type="button" class="btn" data-act="${r.enabled ? "pause" : "resume"}" data-id="${r.jobId}" ${canAct ? "" : "disabled"}>${esc(r.enabled ? t("pause") : t("resume"))}</button>
         <button type="button" class="btn" data-act="edit" data-id="${r.jobId}" ${S.writable ? "" : "disabled"}>${esc(t("edit"))}</button>
         <button type="button" class="btn btn-danger" data-act="delete" data-id="${r.jobId}" ${S.writable ? "" : "disabled"}>${esc(t("del"))}</button>`
    : `<span class="lock"><svg class="ic"><use href="#i-lock"/></svg><span>${esc(r.owner === "system" ? t("readOnlySystem") : t("readOnlyBy", { app: appLabel(r) }))}</span></span>`;
  const keep = detailFor === r.key ? $("#d-runs", box)?.innerHTML : "";
  box.innerHTML = `<header class="d-head"><div><h2>${esc(r.name)}</h2><p class="meta mono">${esc(appLabel(r))} · ${esc(r.app)} · ${esc(r.machine)}</p></div><div class="d-btns">${btns}<button type="button" class="btn btn-ghost btn-icon" data-act="close-detail" aria-label="${esc(t("close"))}"><svg class="ic"><use href="#i-x"/></svg></button></div></header>
    <dl class="d-grid">
      <div><dt>${esc(t("dDescription"))}</dt><dd>${r.description ? esc(r.description) : `<span class="dim">${esc(t("dNoDescription"))}</span>`}</dd></div>
      <div><dt>${esc(t("colSchedule"))}</dt><dd>${scheduleCell(r)}</dd></div>
      <div><dt>${esc(t("dZone"))}</dt><dd class="mono">${esc(zone)}</dd></div>
      <div><dt>${esc(t("dSource"))}</dt><dd>${esc(src)}</dd></div>
      <div class="wide"><dt>${esc(t("dTarget"))} · <span class="mono">${esc(r.target.kind)}</span></dt><dd><pre class="code">${esc(r.target.text)}</pre></dd></div>
      ${r.lastError ? `<div class="wide"><dt>${esc(t("stError"))}</dt><dd class="err-text">${esc(r.lastError)}</dd></div>` : ""}
    </dl>
    <section class="d-sec"><h3>${esc(t("dRuns"))}</h3><div id="d-runs" class="trace">${keep || `<p class="dim">${esc(t("loading"))}</p>`}</div></section>
    ${mine ? `<section class="d-sec"><h3>${esc(t("dChanges"))}</h3><ol id="d-changes" class="changes"></ol></section>` : ""}`;
  detailFor = r.key;
  const key = r.key;
  try {
    const { runs } = await api<{ runs: Run[] }>(`/api/rows/${encodeURIComponent(key)}/runs?limit=10`);
    if (S.sel !== key) return;
    $("#d-runs", box).innerHTML = runs.length ? runs.map(runHtml).join("") : `<p class="dim">${esc(t("dNoRuns"))}</p>`;
  } catch (e) {
    if (S.sel === key) $("#d-runs", box).innerHTML = `<p class="err-text">${esc(errText(e))}</p>`;
  }
  if (mine && r.jobId) {
    try {
      const { changes } = await api<{ changes: Change[] }>(`/api/jobs/${r.jobId}`);
      if (S.sel !== key) return;
      const el = $("#d-changes", box);
      if (el) el.innerHTML = changes.map((c) => `<li><span class="mono dim">${esc(absTime(c.at))}</span> <b>${esc(t(`ch${c.action[0]!.toUpperCase()}${c.action.slice(1)}`))}</b> <span class="dim">${esc(t(`actor${c.actor[0]!.toUpperCase()}${c.actor.slice(1)}`))}</span>${c.detail ? ` <span class="mono">${esc(c.detail)}</span>` : ""}</li>`).join("");
    } catch { /* the runs are enough */ }
  }
}

function runHtml(r: Run): string {
  const cls = r.status === "ok" ? "ok" : r.status === "error" ? "err" : "skip";
  const first = (r.error || r.output || "").split("\n").find((l) => l.trim()) ?? "";
  return `<div class="run ${cls}"><span class="dot ${cls}"></span><span class="mono">${esc(absTime(r.startedAt))}</span><span class="tag">${esc(t(r.trigger === "manual" ? "trManual" : r.trigger === "event" ? "trEvent" : "trSchedule"))}</span><span class="pill ${cls}">${esc(t(r.status === "ok" ? "stOk" : r.status === "error" ? "stError" : "stSkipped"))}</span><span class="mono dim">${esc(durationText(r.endedAt - r.startedAt, S.lang))}</span>${first ? `<code class="out" title="${esc((r.error || r.output || "").slice(0, 2000))}">${esc(first.slice(0, 240))}</code>` : ""}</div>`;
}

// ---------------------------------------------------------------- loading

let timer: ReturnType<typeof setTimeout> | null = null;
async function load() {
  try {
    const d = await api<{ rows: Row[]; counts: Counts; nextUp: Row | null; machine: string; machineZone: string; writable: boolean; spaceError: string | null }>("/api/overview");
    Object.assign(S, { rows: d.rows, counts: d.counts, nextUp: d.nextUp, machine: d.machine, machineZone: d.machineZone, writable: d.writable, spaceError: d.spaceError, loaded: true, loadError: "" });
  } catch (e) {
    S.loaded = true;
    S.loadError = errText(e);
  }
  render();
  if (timer) clearTimeout(timer);
  timer = setTimeout(load, S.rows.some((r) => r.running) ? 4000 : 20_000);
}

function render() {
  renderSummary();
  renderTabs();
  renderList();
  void renderDetail();
}

function toast(text: string, err = false) {
  const el = $("#toast");
  el.textContent = text;
  el.className = `toast show${err ? " err" : ""}`;
  setTimeout(() => { el.className = "toast"; }, 3200);
}

// ---------------------------------------------------------------- actions

async function act(kind: string, id: number) {
  const row = S.rows.find((r) => r.jobId === id);
  const name = row?.name ?? String(id);
  try {
    if (kind === "run") {
      const r = await api<{ started: boolean }>(`/api/jobs/${id}/run`, { body: {} });
      toast(r.started ? t("toastStarted", { name }) : t("toastBusy", { name }));
    } else if (kind === "pause" || kind === "resume") {
      await api(`/api/jobs/${id}/${kind}`, { body: {} });
      toast(t(kind === "pause" ? "toastPaused" : "toastResumed", { name }));
    } else if (kind === "restore") {
      await api(`/api/jobs/${id}/restore`, { body: {} });
      toast(t("toastRestored", { name }));
    } else if (kind === "archive") {
      await api(`/api/jobs/${id}/archive`, { body: {} });
      toast(t("toastArchived", { name }));
    }
  } catch (e) {
    toast(errText(e), true);
  }
  await load();
}

// ---------------------------------------------------------------- the job form

const ZONES: string[] = (() => {
  try { return ["UTC", ...(Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone").filter((z) => z.includes("/"))]; } catch { return ["UTC", browserZone]; }
})();

function fillZones(sel: HTMLSelectElement, value: string) {
  const list = ZONES.includes(value) ? ZONES : [value, ...ZONES];
  sel.innerHTML = list.map((z) => `<option value="${esc(z)}"${z === value ? " selected" : ""}>${esc(z)}</option>`).join("");
}

function localInput(iso: string, zone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

function setSeg(group: string, value: string) {
  for (const b of $$(`[data-seg="${group}"] button`)) b.setAttribute("aria-pressed", String(b.dataset.v === value));
  for (const p of $$(`[data-pane="${group}"]`)) p.hidden = p.dataset.v !== value;
}
const segValue = (group: string) => $$(`[data-seg="${group}"] button`).find((b) => b.getAttribute("aria-pressed") === "true")?.dataset.v ?? "";

function openForm(job: Job | null) {
  S.editing = job;
  const f = $<HTMLFormElement>("#job-form");
  f.reset();
  $("#jf-title").textContent = job ? t("fmEdit", { name: job.name }) : t("fmNew");
  $("#jf-error").textContent = "";
  $("#jf-editnote").hidden = !job;
  const v = (n: string, val: string) => { (f.elements.namedItem(n) as HTMLInputElement).value = val; };
  v("name", job?.name ?? "");
  v("description", job?.description ?? "");
  v("command", job?.command ?? "");
  v("cwd", job?.cwd ?? "");
  v("method", job?.httpMethod ?? "POST");
  v("url", job?.httpUrl ?? "");
  v("body", job?.httpBody ?? "");
  v("prompt", job?.prompt ?? "");
  v("model", job?.agentModel ?? "");
  v("timeout", job ? durationInput(job.timeoutMs) : "10m");
  (f.elements.namedItem("enabled") as HTMLInputElement).checked = job?.enabled ?? true;
  setSeg("kind", job?.kind ?? "command");
  const s = job?.schedule;
  const zone = s && s.kind !== "every" ? s.tz : browserZone;
  fillZones(f.elements.namedItem("cronTz") as HTMLSelectElement, zone);
  fillZones(f.elements.namedItem("atTz") as HTMLSelectElement, zone);
  v("expr", s?.kind === "cron" ? s.expr : "0 9 * * *");
  v("every", s?.kind === "every" ? durationInput(s.everyMs) : "1h");
  v("atLocal", s?.kind === "at" ? localInput(s.at, s.tz) : "");
  setSeg("when", s?.kind ?? "cron");
  $<HTMLDialogElement>("#job-dialog").showModal();
  preview();
}

function durationInput(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function formSchedule(f: HTMLFormElement): { schedule: unknown; zone: string } {
  const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value.trim();
  const when = segValue("when");
  if (when === "every") return { schedule: { kind: "every", every: val("every") }, zone: browserZone };
  if (when === "at") return { schedule: { kind: "at", local: val("atLocal"), tz: val("atTz") }, zone: val("atTz") };
  return { schedule: { kind: "cron", expr: val("expr"), tz: val("cronTz") }, zone: val("cronTz") };
}

let previewSeq = 0;
let previewTimer: ReturnType<typeof setTimeout> | null = null;
function preview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const f = $<HTMLFormElement>("#job-form");
    const out = $("#jf-preview");
    const seq = ++previewSeq;
    const { schedule, zone } = formSchedule(f);
    try {
      const r = await api<{ schedule: JobSchedule; text: { zh: string; en: string }; next: string[] }>("/api/schedule/preview", { body: { schedule, zone } });
      if (seq !== previewSeq) return;
      const tz = r.schedule.kind === "every" ? undefined : r.schedule.tz;
      const list = r.next.map((x) => absTime(x, tz)).join(S.lang === "zh" ? "，" : ", ");
      out.className = "preview";
      out.textContent = r.schedule.kind === "every" ? t("fmPreviewEvery", { text: r.text[S.lang] }) : r.schedule.kind === "at" ? t("fmPreviewOnce", { list: `${list} · ${tz}` }) : `${r.text[S.lang]} · ${t("fmPreview", { list: `${list} (${tz})` })}`;
    } catch (e) {
      if (seq !== previewSeq) return;
      out.className = "preview err-text";
      out.textContent = errText(e);
    }
  }, 250);
}

async function submitForm(ev: Event) {
  ev.preventDefault();
  const f = $<HTMLFormElement>("#job-form");
  const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value;
  const kind = segValue("kind");
  const { schedule, zone } = formSchedule(f);
  const body: Record<string, unknown> = {
    name: val("name").trim(), description: val("description"), kind, schedule, zone, timeout: val("timeout").trim() || "10m",
    enabled: (f.elements.namedItem("enabled") as HTMLInputElement).checked,
  };
  if (kind === "command") Object.assign(body, { command: val("command"), cwd: val("cwd") });
  if (kind === "http") Object.assign(body, { method: val("method"), url: val("url"), body: val("body") || null });
  if (kind === "agent") Object.assign(body, { prompt: val("prompt"), model: val("model").trim() || null });
  const btn = $<HTMLButtonElement>("#jf-save");
  btn.disabled = true;
  btn.textContent = t("fmSaving");
  try {
    const r = S.editing
      ? await api<{ job: Job }>(`/api/jobs/${S.editing.id}`, { method: "PATCH", body })
      : await api<{ job: Job }>("/api/jobs", { body });
    $<HTMLDialogElement>("#job-dialog").close();
    toast(t("toastSaved", { name: r.job.name }));
    await load();
    const row = S.rows.find((x) => x.jobId === r.job.id);
    if (row) { S.sel = row.key; writeUrl(); render(); }
  } catch (e) {
    $("#jf-error").textContent = errText(e);
  } finally {
    btn.disabled = false;
    btn.textContent = t("fmSave");
  }
}

let deleting: number | null = null;
function openDelete(id: number) {
  const row = S.rows.find((r) => r.jobId === id);
  deleting = id;
  $("#del-title").textContent = t("delTitle", { name: row?.name ?? "" });
  $<HTMLDialogElement>("#del-dialog").showModal();
}

// ---------------------------------------------------------------- the assistant

function chipHtml(a: ActionResult): string {
  return `<li class="chip ${a.ok ? "ok" : "err"}"><svg class="ic"><use href="#${a.ok ? "i-check" : "i-x"}"/></svg><span>${esc(a.summary)}</span>${a.error ? `<span class="chip-err">${esc(a.error)}</span>` : ""}</li>`;
}

function confirmHtml(m: Message): string {
  const c = m.confirm!;
  if (c.state === "open") {
    return `<div class="confirm" data-token="${esc(c.token)}"><p>${esc(t("asConfirmQ", { name: c.name }))}</p><div class="confirm-btns"><button type="button" class="btn btn-danger btn-sm" data-act="confirm-yes">${esc(t("asConfirmYes"))}</button><button type="button" class="btn btn-sm" data-act="confirm-no">${esc(t("asConfirmNo"))}</button></div></div>`;
  }
  const label = c.state === "done" ? t("asConfirmDone") : c.state === "declined" ? t("asConfirmDeclined") : t("asConfirmFailed");
  return `<div class="confirm closed ${c.state}"><p>${esc(t("asConfirmQ", { name: c.name }))}</p><span class="pill ${c.state === "done" ? "ok" : c.state === "failed" ? "err" : "skip"}">${esc(label)}</span></div>`;
}

function renderChat() {
  const log = $("#as-log");
  const msgs = S.messages.map((m) => m.role === "user"
    ? `<div class="msg me"><span class="who">${esc(t("asYou"))}</span><p>${esc(m.text)}</p></div>`
    : `<div class="msg bot"><span class="who">${esc(t("asBot"))}</span><p>${esc(m.text)}</p>${m.actions.length ? `<ul class="chips">${m.actions.map(chipHtml).join("")}</ul>` : ""}${m.confirm ? confirmHtml(m) : ""}</div>`);
  const hello = `<div class="msg bot hello"><span class="who">${esc(t("asBot"))}</span><p>${esc(S.assistantOn ? t("asHello") : t("asUnavailable"))}</p></div>`;
  log.innerHTML = hello + msgs.join("") + (S.thinking ? `<div class="msg bot thinking"><span class="who">${esc(t("asBot"))}</span><p><span class="pulse"></span>${esc(t("asThinking"))}</p></div>` : "");
  log.scrollTop = log.scrollHeight;
  $<HTMLButtonElement>("#as-send").disabled = S.thinking || !S.assistantOn;
}

async function loadChat() {
  try {
    const d = await api<{ available: boolean; session: number; messages: Message[] }>("/api/assistant");
    S.assistantOn = d.available;
    S.session = d.session;
    S.messages = d.messages;
  } catch { /* the page still works */ }
  renderChat();
}

async function send(text: string) {
  const msg = text.trim();
  if (!msg || S.thinking) return;
  S.thinking = true;
  S.messages.push({ id: -1, session: S.session, role: "user", text: msg, actions: [], confirm: null, createdAt: Date.now() });
  renderChat();
  try {
    const d = await api<{ messages: Message[] }>("/api/assistant", { body: { message: msg, zone: browserZone, lang: S.lang, session: S.session } });
    S.messages = S.messages.filter((m) => m.id !== -1).concat(d.messages);
  } catch (e) {
    S.messages = S.messages.filter((m) => m.id !== -1);
    toast(errText(e), true);
  }
  S.thinking = false;
  renderChat();
  await load();
}

async function answerConfirm(token: string, accept: boolean) {
  try {
    const d = await api<{ messages: Message[] }>("/api/assistant/confirm", { body: { token, accept, lang: S.lang } });
    for (const m of S.messages) if (m.confirm?.token === token) m.confirm = { ...m.confirm, state: accept ? "done" : "declined" };
    S.messages.push(...d.messages);
    await loadChat();
  } catch (e) {
    toast(errText(e), true);
  }
  await load();
}

// ---------------------------------------------------------------- language and theme

const root = document.documentElement;
function applyLang() {
  root.lang = S.lang === "zh" ? "zh-CN" : "en";
  applyTranslations(document, S.lang);
  for (const b of $$("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === S.lang));
  themeLabel();
  render();
  renderChat();
}

function themeLabel() {
  const mode = root.dataset.mode ?? "system";
  const b = $("#theme");
  const label = t(mode === "light" ? "themeLight" : mode === "dark" ? "themeDark" : "themeSystem");
  b.setAttribute("aria-label", label);
  b.title = label;
}

function cycleTheme() {
  const mode = root.dataset.mode ?? "system";
  const next = mode === "system" ? "light" : mode === "light" ? "dark" : "system";
  root.dataset.mode = next;
  if (next === "system") { delete root.dataset.theme; store.set("task-shelf.theme", null); } else { root.dataset.theme = next; store.set("task-shelf.theme", next); }
  themeLabel();
}

// ---------------------------------------------------------------- wiring

for (const b of $$("[data-lang]")) b.addEventListener("click", () => { S.lang = b.dataset.lang as Lang; store.set("task-shelf.lang", S.lang); writeUrl(); applyLang(); });
$("#theme").addEventListener("click", cycleTheme);
$<HTMLInputElement>("#q").value = S.q;
$("#q").addEventListener("input", (e) => { S.q = (e.target as HTMLInputElement).value; writeUrl(); renderList(); });
for (const b of $$("[data-tab]")) b.addEventListener("click", () => { S.tab = b.dataset.tab as typeof S.tab; writeUrl(); render(); });
for (const b of $$("[data-f]")) b.addEventListener("click", () => { S.filter = S.filter === b.dataset.f ? null : (b.dataset.f as typeof S.filter); writeUrl(); render(); });

document.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (el) {
    const id = Number(el.dataset.id);
    switch (el.dataset.act) {
      case "new": return openForm(null);
      case "edit": {
        try { const { job } = await api<{ job: Job }>(`/api/jobs/${id}`); openForm(job); } catch (err) { toast(errText(err), true); }
        return;
      }
      case "run": case "pause": case "resume": case "restore": return act(el.dataset.act, id);
      case "delete": return openDelete(id);
      case "reconcile": try { await api("/api/reconcile", { body: {} }); toast(t("toastSynced")); } catch (err) { toast(errText(err), true); } return load();
      case "reload": S.loaded = false; render(); return load();
      case "close-detail": S.sel = null; writeUrl(); return render();
      case "close-dialog": return el.closest("dialog")?.close();
      case "toggle": return;
      case "confirm-yes": case "confirm-no": {
        const card = el.closest<HTMLElement>("[data-token]");
        if (card) return answerConfirm(card.dataset.token!, el.dataset.act === "confirm-yes");
        return;
      }
      case "preset": return void send(el.textContent ?? "");
      case "as-open": document.body.classList.add("as-open"); return $("#as-input").focus();
      case "as-close": return document.body.classList.remove("as-open");
      case "as-new": {
        try { const r = await api<{ session: number }>("/api/assistant/new", { body: {} }); S.session = r.session; S.messages = []; renderChat(); } catch (err) { toast(errText(err), true); }
        return;
      }
    }
    return;
  }
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row[data-key]");
  if (row && !(e.target as HTMLElement).closest("label, button, input")) { S.sel = S.sel === row.dataset.key ? null : row.dataset.key!; writeUrl(); render(); }
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.act === "toggle") void act(el.checked ? "resume" : "pause", Number(el.dataset.id));
});
document.addEventListener("keydown", (e) => {
  const row = (e.target as HTMLElement).closest?.<HTMLElement>(".row[data-key]");
  if (row && (e.key === "Enter" || e.key === " ") && e.target === row) { e.preventDefault(); S.sel = S.sel === row.dataset.key ? null : row.dataset.key!; writeUrl(); render(); }
  if (e.key === "/" && !(e.target as HTMLElement).closest("input, textarea, select")) { e.preventDefault(); $("#q").focus(); }
});

for (const seg of $$("[data-seg]")) for (const b of $$("button", seg)) b.addEventListener("click", () => { setSeg(seg.dataset.seg!, b.dataset.v!); preview(); });
$("#job-form").addEventListener("input", (e) => { if ((e.target as HTMLElement).closest("[data-pane='when']")) preview(); });
$("#job-form").addEventListener("change", (e) => { if ((e.target as HTMLElement).closest("[data-pane='when']")) preview(); });
$("#job-form").addEventListener("submit", submitForm);
$("#jf-cancel").addEventListener("click", () => $<HTMLDialogElement>("#job-dialog").close());
$("#del-cancel").addEventListener("click", () => $<HTMLDialogElement>("#del-dialog").close());
$("#del-ok").addEventListener("click", async () => {
  $<HTMLDialogElement>("#del-dialog").close();
  if (deleting !== null) { const id = deleting; deleting = null; if (S.rows.find((r) => r.jobId === id)?.key === S.sel) S.sel = null; await act("archive", id); }
});
$("#as-form").addEventListener("submit", (e) => { e.preventDefault(); const i = $<HTMLTextAreaElement>("#as-input"); const v = i.value; i.value = ""; void send(v); });
$("#as-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $<HTMLFormElement>("#as-form").requestSubmit(); } });

applyTranslations(document, S.lang);
for (const b of $$("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === S.lang));
themeLabel();
render();
renderChat();
void load();
void loadChat();
