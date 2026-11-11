/**
 * The tasks page: the jobs kept in this app with their
 * form, the detail of a selected row, and the assistant. State lives in the URL (?tab&f&q&sel&lang)
 * so a link reproduces the view. Times are shown in the browser's zone; schedules name their own.
 */
import { durationText, type Lang, runDuration, scheduleText } from "../src/describe.ts";
import { applyTranslations, tr } from "./i18n.ts";

type Schedule = { kind: "manual" } | { kind: "at"; at: string; tz?: string } | { kind: "every"; everyMs: number; anchorMs?: number } | { kind: "cron"; expr: string; tz?: string };
interface Row {
  key: string; taskId: string | null; jobId: number | null; app: string; appTitle: { zh: string; en: string } | null; name: string; description: string;
  owner: "mine" | "system" | "app"; headless: boolean; machine: string; timeoutMs: number | null; schedule: Schedule | null; zone: string | null; zoneDeclared: boolean;
  enabled: boolean; orphaned: boolean; running: boolean; triggers: number; nextRunAt: string | null; lastRunAt: string | null;
  lastStatus: "ok" | "error" | "skipped" | null; lastError: string | null; lastDurationMs: number | null; consecutiveErrors: number;
  target: { kind: string; text: string }; registered: boolean; syncError: string | null; archived: boolean;
  /** Added by the page: the peer this row came through ("" for this machine), and its key across machines. */
  via: string; uid: string;
}
/** One machine of the page: this one (via "") or a peer running Task Shelf. */
interface Machine { via: string; name: string; writable: boolean; error: string | null }
interface Counts { total: number; enabled: number; failing: number; running: number; paused: number; mine: number; headless: number }
interface Run { id: number; taskId: string; startedAt: number; endedAt: number; status: "ok" | "error" | "skipped"; error?: string; output?: string; trigger: "schedule" | "manual" | "event"; session?: string }
type TxEntry = { kind: "user" | "assistant"; at?: string; text: string } | { kind: "tool"; at?: string; name: string; title: string; input: string; result?: string; failed?: boolean };
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
  tab: (params.get("tab") === "archived" ? "archived" : "jobs") as "jobs" | "archived",
  filter: (["failing", "paused", "running"].includes(params.get("f") ?? "") ? params.get("f") : null) as null | "failing" | "paused" | "running",
  q: params.get("q") ?? "",
  /** The machine the list is narrowed to ("" for this machine), or null for all. */
  machine: params.get("m"),
  sel: params.get("sel"),
  rows: [] as Row[],
  counts: null as Counts | null,
  nextUp: null as Row | null,
  machines: [] as Machine[],
  writable: true,
  loaded: false,
  loadError: "",
  session: 1,
  messages: [] as Message[],
  assistantOn: true,
  thinking: false,
  editing: null as Job | null,
  editingVia: "",
  chatVia: store.get("task-shelf.chatVia") ?? "",
};
const t = (k: string, v?: Record<string, string | number>) => tr(k, S.lang, v);
const locale = () => (S.lang === "zh" ? "zh-CN" : "en-US");

function writeUrl() {
  const p = new URLSearchParams();
  if (S.tab !== "jobs") p.set("tab", S.tab);
  if (S.filter) p.set("f", S.filter);
  if (S.q) p.set("q", S.q);
  if (S.machine !== null) p.set("m", S.machine);
  if (S.sel) p.set("sel", S.sel);
  if (params.get("lang")) p.set("lang", S.lang);
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

// ---------------------------------------------------------------- API

/** Where a machine's routes are: this machine's own, or forwarded to a peer through ai-space's bus. */
const on = (via: string, path: string) => (via ? `/api/m/${encodeURIComponent(via)}${path}` : path);
const multi = () => S.machines.length > 1;
const machineOf = (via: string) => S.machines.find((m) => m.via === via);
const writableOn = (via: string) => machineOf(via)?.writable ?? false;
const nameOf = (via: string) => machineOf(via)?.name ?? via;

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
  if (abs < 45_000) return diff >= 0 ? t("nextNow") : t("justNow");
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

/** A row's state as a kit class (ok, run, bad, off, none) and its word: a colour always comes with a word. */
function statusOf(r: Row): { cls: "ok" | "run" | "bad" | "off" | "none"; text: string } {
  if (r.archived) return { cls: "off", text: t("stArchived") };
  if (r.orphaned) return { cls: "off", text: t("stOrphaned") };
  if (!r.registered) return { cls: "bad", text: t("stUnregistered") };
  if (r.running) return { cls: "run", text: t("stRunning") };
  if (!r.enabled) return { cls: "off", text: t("stPaused") };
  if (r.lastStatus === "error") return { cls: "bad", text: r.consecutiveErrors > 1 ? t("stErrorN", { n: r.consecutiveErrors }) : t("stError") };
  if (r.lastStatus === "skipped") return { cls: "off", text: t("stSkipped") };
  if (r.lastStatus === "ok") return { cls: "ok", text: t("stOk") };
  return { cls: "none", text: t("stNever") };
}
const badge = (cls: string, text: string) => `<span class="sp-badge ${cls}">${esc(text)}</span>`;
const icon = (id: string) => `<svg class="ic" aria-hidden="true"><use href="#${id}"/></svg>`;

function scheduleCell(r: Row): string {
  if (!r.schedule) return "";
  const words = scheduleText(r.schedule.kind === "at" ? { ...r.schedule, tz: r.zone ?? undefined } : r.schedule, S.lang);
  const raw = r.schedule.kind === "cron" ? r.schedule.expr : "";
  const zone = r.zone ? (r.zoneDeclared ? r.zone : t("zoneMachine", { zone: r.zone })) : "";
  const trig = r.triggers ? ` · ${t("triggersN", { n: r.triggers })}` : "";
  const title = r.zone && !r.zoneDeclared ? ` title="${esc(t("zoneMachineTitle", { zone: r.zone }))}"` : "";
  return `<span class="sched-words">${esc(words)}${esc(trig)}</span><span class="mono sched-raw"${title}>${[raw, zone].filter(Boolean).map(esc).join(" · ")}</span>`;
}

/** The machine filter, when it names a machine the page knows. */
const machineFilter = () => (S.machine !== null && multi() && machineOf(S.machine) ? S.machine : null);
const inMachine = (r: Row) => { const m = machineFilter(); return m === null || r.via === m; };
const inScope = (r: Row, tab = S.tab) => (tab === "archived") === r.archived && inMachine(r);
const matches = (r: Row, f: typeof S.filter) =>
  f === "failing" ? (r.enabled && r.lastStatus === "error") || (!r.registered && !r.archived) : f === "paused" ? !r.enabled : f === "running" ? r.running : true;

function visibleRows(): Row[] {
  const q = S.q.trim().toLowerCase();
  return S.rows.filter((r) => {
    if (!inScope(r)) return false;
    if (!matches(r, S.filter)) return false;
    if (q && ![r.name, nameOf(r.via), r.app, r.appTitle?.zh, r.appTitle?.en, r.description, r.target.text].some((x) => (x ?? "").toLowerCase().includes(q))) return false;
    return true;
  });
}

/** The last run's outcome, whatever the task's state now. */
function lastPill(r: Row): string {
  if (r.lastStatus === "error") return badge("bad", r.consecutiveErrors > 1 ? t("stErrorN", { n: r.consecutiveErrors }) : t("stError"));
  if (r.lastStatus === "skipped") return badge("off", t("stSkipped"));
  return badge("ok", t("stOk"));
}

/** Under a task's name: its description; for a task this app does not own, whose it is first. */
function meta(r: Row): string {
  if (r.owner === "mine") return r.description;
  return [appLabel(r), r.headless ? t("headlessTag") : "", r.description].filter(Boolean).join(" · ");
}

function rowHtml(r: Row): string {
  const st = statusOf(r);
  const mine = r.owner === "mine";
  const writable = writableOn(r.via);
  const canAct = mine && writable && !r.archived;
  const via = ` data-via="${esc(r.via)}"`;
  const next = !r.enabled ? `<span class="rel dim">${esc(t("stPaused"))}</span>` : r.nextRunAt ? `<span class="rel">${esc(relTime(r.nextRunAt))}</span><span class="abs mono">${esc(absTime(r.nextRunAt))}</span>` : `<span class="rel dim">${t("noNext")}</span>`;
  const last = r.running
    ? badge("run", t("stRunning"))
    : r.lastRunAt
      ? `<span class="rel">${esc(relTime(r.lastRunAt))}</span><span class="last-line">${lastPill(r)}${r.lastDurationMs !== null ? `<span class="mono dim">${esc(runDuration(r.lastDurationMs))}</span>` : ""}</span>`
      : `<span class="rel dim">${esc(t("stNever"))}</span>`;
  const toggle = mine && !r.archived
    ? `<label class="sp-switch"><input type="checkbox" role="switch" data-act="toggle" data-id="${r.jobId}"${via} ${r.enabled ? "checked" : ""} ${canAct && r.registered ? "" : "disabled"} aria-label="${esc(t("toggleAria", { name: r.name }))}"><span class="sp-track" aria-hidden="true"></span></label>`
    : mine ? `<span class="lock">${esc(t("stArchived"))}</span>` : `<span class="lock" title="${esc(r.owner === "system" ? t("readOnlySystem") : t("readOnlyBy", { app: appLabel(r) }))}">${icon("i-lock")}<span>${esc(t("readOnly"))}</span></span>`;
  const actions = canAct && r.registered
    ? `<button type="button" class="sp-icon-btn" data-act="run" data-id="${r.jobId}"${via} title="${esc(t("runNow"))}" aria-label="${esc(t("runNow"))} ${esc(r.name)}">${icon("i-play")}</button><button type="button" class="sp-icon-btn" data-act="edit" data-id="${r.jobId}"${via} title="${esc(t("edit"))}" aria-label="${esc(t("edit"))} ${esc(r.name)}">${icon("i-edit")}</button>`
    : canAct && !r.registered ? `<button type="button" class="sp-btn sm" data-act="reconcile"${via}>${esc(t("reregister"))}</button>`
    : mine && r.archived && writable ? `<button type="button" class="sp-btn sm" data-act="restore" data-id="${r.jobId}"${via}>${esc(t("restore"))}</button>` : "";
  const dot = st.cls === "off" ? "" : ` ${st.cls}`;
  return `<tr class="row${r.enabled && !r.orphaned ? "" : " muted"}" data-key="${esc(r.uid)}" tabindex="0" aria-selected="${S.sel === r.uid}">
    <td class="c-name"><span class="sp-dot${dot}" title="${esc(st.text)}"></span><span class="nm"><span class="nm-line"><b>${esc(r.name)}</b>${multi() ? `<span class="sp-chip mono mach">${esc(nameOf(r.via))}</span>` : ""}</span>${meta(r) ? `<span class="meta" title="${esc(r.app)}">${esc(meta(r))}</span>` : ""}${r.syncError && mine ? `<span class="warn">${esc(r.syncError)}</span>` : ""}</span></td>
    <td class="c-sched">${scheduleCell(r)}</td>
    <td class="c-next"><span class="cell-label">${esc(t("colNext"))}</span>${next}</td>
    <td class="c-last"><span class="cell-label">${esc(t("colLast"))}</span>${last}</td>
    <td class="c-on">${toggle}</td>
    <td class="c-act">${actions}</td>
  </tr>`;
}

/** The heading: the view's name, then what the navigation and the filters do not show (enabled, next run, machine). */
function renderSummary() {
  const c = S.counts;
  $("#view-title").textContent = t(S.tab === "archived" ? "tabArchived" : "tabJobs");
  const parts: string[] = [];
  if (c) {
    parts.push(`<span class="sp-stat"><span class="sp-fig">${c.enabled}</span><span class="sp-unit">${esc(t("sumEnabled", { n: "" }).trim())}</span></span>`);
    if (S.nextUp) parts.push(`<span class="sum-next">${esc(t("sumNext", { time: clock(S.nextUp.nextRunAt), name: `${S.nextUp.owner === "mine" ? "" : `${S.nextUp.app}/`}${S.nextUp.name}` }))}</span>`);
    if (!multi() && S.machines[0]?.name) parts.push(`<span class="mono dim">${esc(t("sumMachine", { name: S.machines[0].name }))}</span>`);
  }
  $("#sum").innerHTML = parts.join("");
  const ro = S.machines.filter((m) => !m.writable && !m.error);
  $("#ro-banner").hidden = !ro.length;
  $("#ro-text").textContent = ro.length ? (multi() ? ro.map((m) => t("readOnlyOn", { name: m.name })).join(" ") : t("readOnlyBanner")) : "";
}

/** The left column (views, machines) and the status filters, with their counts. */
function renderTabs() {
  const n = { jobs: S.rows.filter((r) => inScope(r, "jobs")).length, archived: S.rows.filter((r) => inScope(r, "archived")).length };
  for (const b of $$("[data-tab]")) {
    const k = b.dataset.tab as keyof typeof n;
    b.setAttribute("aria-pressed", String(S.tab === k));
    $(".n", b).textContent = String(n[k]);
  }
  const scoped = S.rows.filter((r) => inScope(r));
  for (const b of $$("[data-f]")) {
    const f = (b.dataset.f || null) as typeof S.filter;
    b.setAttribute("aria-pressed", String(S.filter === f));
    const count = b.querySelector(".n");
    if (count) count.textContent = String(scoped.filter((r) => matches(r, f)).length);
  }
  const group = $("#machine-group");
  group.hidden = !multi();
  if (multi()) {
    const m = machineFilter();
    const item = (via: string | null, label: string, mono: boolean, error: string | null) =>
      `<li><button type="button" class="sp-nitem" data-machine="${via === null ? "*" : esc(via)}" aria-pressed="${m === via}"><span class="${mono ? "mono" : ""}">${esc(label)}</span>${error ? `<span class="sp-dot bad" title="${esc(error)}"></span>` : ""}</button></li>`;
    const html = item(null, t("navAll"), false, null) + S.machines.map((x) => item(x.via, x.name, true, x.error)).join("");
    const list = $("#machine-nav");
    if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
  }
}

function renderList() {
  const list = $("#rows");
  const state = $("#list-state");
  const foot = $("#list-foot");
  if (!S.loaded) {
    state.dataset.state = "loading";
    state.innerHTML = Array.from({ length: 5 }, () => '<div class="skel"><i class="sp-sk"></i><i class="sp-sk"></i><i class="sp-sk"></i><i class="sp-sk"></i></div>').join("");
    list.innerHTML = "";
    foot.hidden = true;
    return;
  }
  const rows = visibleRows();
  const down = S.machines.filter((m) => m.error);
  if (S.loadError || down.length) {
    state.dataset.state = "error";
    const msg = S.loadError ? t("errorList", { error: S.loadError }) : multi() ? down.map((m) => t("machinesDown", { names: m.name, error: m.error! })).join(" ") : t("errorList", { error: down[0]!.error! });
    state.innerHTML = `<div class="sp-banner bad">${icon("i-x")}<span class="grow">${esc(msg)}</span><button type="button" class="sp-btn sm" data-act="reload">${esc(t("retry"))}</button></div>`;
  } else if (!rows.length) {
    state.dataset.state = "empty";
    const plain = !S.q && !S.filter;
    state.innerHTML = `<div class="sp-state"><p>${esc(plain ? t(S.tab === "archived" ? "emptyArchived" : "emptyMine") : t("emptyFilter"))}</p>${S.tab === "jobs" && S.machines.some((m) => m.writable) ? `<button type="button" class="sp-btn" data-act="new">${icon("i-plus")}<span>${esc(t("newJob"))}</span></button>` : ""}</div>`;
  } else {
    state.dataset.state = "";
    state.innerHTML = "";
  }
  list.innerHTML = rows.map(rowHtml).join("");
  list.closest("table")!.hidden = !rows.length;
  foot.hidden = !rows.length;
  foot.textContent = t("shownOf", { n: rows.length, total: S.rows.filter((r) => inScope(r)).length });
}

// ---------------------------------------------------------------- detail

let detailFor = "";
async function renderDetail() {
  const box = $("#detail");
  const r = S.rows.find((x) => x.uid === S.sel);
  if (!r) { box.hidden = true; box.innerHTML = ""; detailFor = ""; document.body.classList.remove("has-detail"); return; }
  box.hidden = false;
  document.body.classList.add("has-detail");
  const mine = r.owner === "mine";
  const writable = writableOn(r.via);
  const canAct = mine && writable && !r.archived && r.registered;
  const via = ` data-via="${esc(r.via)}"`;
  const src = mine ? t("dSourceMine", { id: r.taskId ?? "—" }) : r.owner === "system" ? t("dSourceSystem") : t("dSourceApp", { app: r.app });
  const zone = r.zone ? (r.zoneDeclared ? r.zone : t("zoneMachine", { zone: r.zone })) : "—";
  const btns = mine
    ? r.archived
      ? (writable ? `<button type="button" class="sp-btn" data-act="restore" data-id="${r.jobId}"${via}>${esc(t("restore"))}</button>` : "")
      : `<button type="button" class="sp-btn" data-act="run" data-id="${r.jobId}"${via} ${canAct ? "" : "disabled"}>${icon("i-play")}<span>${esc(t("runNow"))}</span></button>
         <button type="button" class="sp-btn" data-act="${r.enabled ? "pause" : "resume"}" data-id="${r.jobId}"${via} ${canAct ? "" : "disabled"}>${icon(r.enabled ? "i-pause" : "i-play")}<span>${esc(r.enabled ? t("pause") : t("resume"))}</span></button>
         <button type="button" class="sp-btn" data-act="edit" data-id="${r.jobId}"${via} ${writable ? "" : "disabled"}>${icon("i-edit")}<span>${esc(t("edit"))}</span></button>
         <button type="button" class="sp-btn" data-act="delete" data-id="${r.jobId}"${via} ${writable ? "" : "disabled"}>${icon("i-trash")}<span>${esc(t("del"))}</span></button>`
    : `<span class="lock">${icon("i-lock")}<span>${esc(r.owner === "system" ? t("readOnlySystem") : t("readOnlyBy", { app: appLabel(r) }))}</span></span>`;
  const st = statusOf(r);
  const keep = detailFor === r.uid ? $("#d-runs", box)?.innerHTML : "";
  const words = r.schedule ? scheduleText(r.schedule.kind === "at" ? { ...r.schedule, tz: r.zone ?? undefined } : r.schedule, S.lang) : "—";
  const fact = (label: string, value: string, mono = false, title = "") => `<dt>${esc(label)}</dt><dd${mono ? ' class="mono"' : ""}${title ? ` title="${esc(title)}"` : ""}>${value}</dd>`;
  box.innerHTML = `<header class="d-head"><div class="d-title"><h2 class="sp-tt"><span class="sp-sq" aria-hidden="true"></span><span class="mono">${esc(r.name)}</span></h2>${st.cls === "none" ? "" : badge(st.cls, st.text)}</div><div class="d-btns">${btns}<button type="button" class="sp-icon-btn" data-act="close-detail" aria-label="${esc(t("close"))}" title="${esc(t("close"))}">${icon("i-x")}</button></div></header>
    ${r.description ? `<p class="d-desc">${esc(r.description)}</p>` : ""}
    <div class="d-grid">
      <pre class="sp-code${r.target.kind === "command" ? " cmd" : ""}" aria-label="${esc(t("dTarget"))}">${esc(r.target.text)}</pre>
      <dl class="sp-facts">
        ${fact(t("colSchedule"), esc(words) + (r.triggers ? ` · ${esc(t("triggersN", { n: r.triggers }))}` : ""))}
        ${r.schedule?.kind === "cron" ? fact("Cron", esc(r.schedule.expr), true) : ""}
        ${fact(t("dZone"), esc(zone), true, r.zone && !r.zoneDeclared ? t("zoneMachineTitle", { zone: r.zone }) : "")}
        ${r.timeoutMs ? fact(t("dTimeout"), esc(durationText(r.timeoutMs, S.lang)), true) : ""}
        ${multi() ? fact(t("fmMachine"), esc(nameOf(r.via)), true) : ""}
        ${fact(t("dSource"), esc(src))}
        ${fact(t("dKind"), esc(t(`kind_${r.target.kind}`)))}
      </dl>
    </div>
    ${r.lastError ? `<div class="sp-banner bad d-err">${icon("i-x")}<span class="grow"><b>${esc(t("stError"))}</b> <span class="mono">${esc(r.lastError)}</span></span></div>` : ""}
    <section class="d-sec"><h3 class="d-sec-h"><span>${esc(t("dRuns"))}</span><span class="sp-small sp-muted">${esc(t("dRunsLast", { n: 10 }))}</span></h3><div id="d-runs" class="runs">${keep || `<p class="dim">${esc(t("loading"))}</p>`}</div></section>
    ${mine ? `<section class="d-sec"><h3 class="d-sec-h"><span>${esc(t("dChanges"))}</span></h3><ol id="d-changes" class="changes"></ol></section>` : ""}`;
  detailFor = r.uid;
  const key = r.uid;
  try {
    const { runs } = await api<{ runs: Run[] }>(on(r.via, `/api/rows/${encodeURIComponent(r.key)}/runs?limit=10`));
    if (S.sel !== key) return;
    shownRuns = runs;
    drawRuns();
  } catch (e) {
    if (S.sel === key) $("#d-runs", box).innerHTML = `<p class="err-text">${esc(errText(e))}</p>`;
  }
  if (mine && r.jobId) {
    try {
      const { changes } = await api<{ changes: Change[] }>(on(r.via, `/api/jobs/${r.jobId}`));
      if (S.sel !== key) return;
      const el = $("#d-changes", box);
      if (el) el.innerHTML = changes.map((c) => `<li><span class="mono dim">${esc(absTime(c.at))}</span> <b>${esc(t(`ch${c.action[0]!.toUpperCase()}${c.action.slice(1)}`))}</b> <span class="dim">${esc(t(`actor${c.actor[0]!.toUpperCase()}${c.actor.slice(1)}`))}</span>${c.detail ? ` <span class="mono">${esc(c.detail)}</span>` : ""}</li>`).join("");
    } catch { /* the runs are enough */ }
  }
}

/** The selected task's runs as last read, and the one whose full output is open (`taskId:id`). */
let shownRuns: Run[] = [];
let openRun = "";
const runKey = (r: Run) => `${r.taskId}:${r.id}`;

/** Draw the runs as last read. */
function drawRuns() {
  const el = document.querySelector<HTMLElement>("#d-runs");
  if (!el) return;
  const longest = Math.max(1, ...shownRuns.map((x) => x.endedAt - x.startedAt));
  const html = shownRuns.length ? runsTable(shownRuns, longest) : `<p class="dim">${esc(t("dNoRuns"))}</p>`;
  el.innerHTML = html;
}

function runsTable(runs: Run[], longest: number): string {
  const head = ["rTime", "rTrigger", "rResult", "rDuration", "rOutput"].map((k) => `<th scope="col">${esc(t(k))}</th>`).join("");
  return `<table class="sp-table rt"><thead><tr>${head}</tr></thead><tbody>${runs.map((x) => runHtml(x, longest)).join("")}</tbody></table>`;
}

function runHtml(r: Run, longest: number): string {
  const cls = r.status === "ok" ? "ok" : r.status === "error" ? "bad" : "off";
  const first = (r.error || r.output || "").split("\n").find((l) => l.trim()) ?? "";
  const ms = Math.max(0, r.endedAt - r.startedAt);
  const pill = badge(cls, t(r.status === "ok" ? "stOk" : r.status === "error" ? "stError" : "stSkipped"));
  const key = runKey(r);
  const open = openRun === key;
  const row = `<tr class="run ${cls}${open ? " open" : ""}" data-act="run-open" data-run="${esc(key)}"><td class="t"><button type="button" class="run-tog" data-act="run-open" data-run="${esc(key)}" aria-expanded="${open}">${esc(absTime(r.startedAt))}</button></td><td class="k">${esc(t(r.trigger === "manual" ? "trManual" : r.trigger === "event" ? "trEvent" : "trSchedule"))}</td><td class="s">${pill}</td><td class="d"><span class="rbar"><span class="sp-meter${cls === "bad" ? " bad" : ""}" style="--v:${Math.max(2, Math.round((ms / longest) * 100))}%"><i></i></span><span class="dur">${esc(runDuration(ms))}</span></span></td><td class="out mono">${esc(first.slice(0, 240))}</td></tr>`;
  if (!open) return row;
  const full = [r.error, r.output].filter((x) => x && x.trim()).join("\n\n");
  const more = `${full ? `<pre class="sp-code">${esc(full)}</pre>` : `<p class="dim">${esc(t("rNoOutput"))}</p>`}${r.session ? `<div class="run-more-btns"><button type="button" class="sp-btn sm" data-act="transcript" data-run="${esc(key)}">${icon("i-chat")}<span>${esc(t("txOpen"))}</span></button></div>` : ""}`;
  return `${row}<tr class="run-more"><td colspan="5">${more}</td></tr>`;
}

// ---------------------------------------------------------------- a run's conversation

/** Show the Claude Code session a run named in its output (src/transcript.ts). */
async function openTranscript(key: string) {
  const run = shownRuns.find((x) => runKey(x) === key);
  const row = S.rows.find((x) => x.uid === S.sel);
  if (!run || !row) return;
  const dlg = $<HTMLDialogElement>("#tx-dialog");
  const body = $("#tx-body", dlg);
  $("#tx-sub", dlg).textContent = `${row.name} · ${absTime(run.startedAt)}`;
  body.innerHTML = `<p class="dim">${esc(t("loading"))}</p>`;
  if (!dlg.open) dlg.showModal();
  try {
    const d = await api<{ entries: TxEntry[]; truncated: boolean }>(on(row.via, `/api/rows/${encodeURIComponent(row.key)}/transcript?task=${encodeURIComponent(run.taskId)}&run=${run.id}`));
    body.innerHTML = (d.entries.length ? d.entries.map(entryHtml).join("") : `<p class="dim">${esc(t("txEmpty"))}</p>`) + (d.truncated ? `<p class="dim sp-small">${esc(t("txTruncated", { n: d.entries.length }))}</p>` : "");
  } catch (e) {
    body.innerHTML = `<p class="err-text">${esc(errText(e))}</p>`;
  }
  body.scrollTop = 0;
}

function entryHtml(e: TxEntry): string {
  if (e.kind !== "tool") return e.kind === "user" ? `<div class="sp-msg-me"><p>${esc(e.text)}</p></div>` : `<div class="msg"><p>${esc(e.text)}</p></div>`;
  return `<details class="tx-tool${e.failed ? " bad" : ""}"><summary><span class="mono name">${esc(e.name)}</span><span class="ttl">${esc(e.title)}</span>${e.failed ? badge("bad", t("stError")) : ""}</summary><pre class="sp-code">${esc(e.input)}</pre>${e.result ? `<pre class="sp-code">${esc(e.result)}</pre>` : ""}</details>`;
}

// ---------------------------------------------------------------- loading

let timer: ReturnType<typeof setTimeout> | null = null;
type Overview = { rows: Row[]; counts: Counts; nextUp: Row | null; machine: string; writable: boolean; spaceError: string | null };

/** Every machine's overview, read side by side; a machine that does not answer keeps its place with the error. */
async function load() {
  try {
    const m = await api<{ local: string; peers: string[] }>("/api/machines").catch(() => ({ local: "", peers: [] as string[] }));
    const vias = ["", ...m.peers];
    const got = await Promise.all(vias.map((via) => api<Overview>(on(via, "/api/overview")).then((d) => ({ via, d, e: null as string | null }), (e) => ({ via, d: null, e: errText(e) }))));
    if (!got[0]!.d) throw new Error(got[0]!.e ?? "");
    const machines: Machine[] = [];
    const rows: Row[] = [];
    const counts: Counts = { total: 0, enabled: 0, failing: 0, running: 0, paused: 0, mine: 0, headless: 0 };
    const nexts: Row[] = [];
    for (const g of got) {
      // A peer goes by the name this space gives it; this machine by its own.
      const name = g.via || g.d?.machine || m.local;
      machines.push({ via: g.via, name, writable: Boolean(g.d?.writable), error: g.e ?? g.d?.spaceError ?? null });
      if (!g.d) continue;
      for (const r of g.d.rows) rows.push({ ...r, via: g.via, uid: g.via ? `${g.via}:${r.key}` : r.key });
      for (const k of Object.keys(counts) as (keyof Counts)[]) counts[k] += g.d.counts[k] ?? 0;
      if (g.d.nextUp?.nextRunAt) nexts.push(g.d.nextUp);
    }
    nexts.sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!));
    Object.assign(S, { rows, counts, nextUp: nexts[0] ?? null, machines, writable: machines.some((x) => x.writable), loaded: true, loadError: "" });
    renderMachinePickers();
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
  el.className = `sp-toast show${err ? " err" : ""}`;
  setTimeout(() => { el.className = "sp-toast"; }, 3200);
}

// ---------------------------------------------------------------- actions

async function act(kind: string, id: number, via: string) {
  const row = S.rows.find((r) => r.jobId === id && r.via === via);
  const name = row?.name ?? String(id);
  const job = (p: string) => on(via, `/api/jobs/${id}${p}`);
  try {
    if (kind === "run") {
      const r = await api<{ started: boolean }>(job("/run"), { body: {} });
      toast(r.started ? t("toastStarted", { name }) : t("toastBusy", { name }));
    } else if (kind === "pause" || kind === "resume") {
      await api(job(`/${kind}`), { body: {} });
      toast(t(kind === "pause" ? "toastPaused" : "toastResumed", { name }));
    } else if (kind === "restore") {
      await api(job("/restore"), { body: {} });
      toast(t("toastRestored", { name }));
    } else if (kind === "archive") {
      await api(job("/archive"), { body: {} });
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

/** The machine pickers: the new-job form's and the assistant's, shown when there is more than one machine. */
function renderMachinePickers() {
  const opts = (sel: string, list: Machine[]) => list.map((m) => `<option value="${esc(m.via)}"${m.via === sel ? " selected" : ""}>${esc(m.name)}</option>`).join("");
  const chat = $<HTMLSelectElement>("#as-machine");
  const reachable = S.machines.filter((m) => !m.error);
  // A remembered machine that is gone: back to this one, and its conversation.
  if (!reachable.some((m) => m.via === S.chatVia) && S.chatVia) { S.chatVia = ""; S.messages = []; void loadChat(); }
  chat.hidden = reachable.length < 2;
  const html = opts(S.chatVia, reachable);
  if (chat.dataset.html !== html) { chat.innerHTML = html; chat.dataset.html = html; }
}

function openForm(job: Job | null, via = "") {
  S.editing = job;
  S.editingVia = via;
  const writable = S.machines.filter((m) => m.writable && !m.error);
  const pick = $<HTMLSelectElement>("#jf-machine");
  pick.innerHTML = writable.map((m) => `<option value="${esc(m.via)}"${m.via === via ? " selected" : ""}>${esc(m.name)}</option>`).join("");
  $("#jf-machine-row").hidden = Boolean(job) || writable.length < 2;
  const f = $<HTMLFormElement>("#job-form");
  f.reset();
  $("#jf-title").textContent = job ? t("fmEdit", { name: multi() ? `${nameOf(via)} · ${job.name}` : job.name }) : t("fmNew");
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
    const via = S.editing ? S.editingVia : ($<HTMLSelectElement>("#jf-machine").value ?? "");
    const r = S.editing
      ? await api<{ job: Job }>(on(via, `/api/jobs/${S.editing.id}`), { method: "PATCH", body })
      : await api<{ job: Job }>(on(via, "/api/jobs"), { body });
    $<HTMLDialogElement>("#job-dialog").close();
    toast(t("toastSaved", { name: r.job.name }));
    await load();
    const row = S.rows.find((x) => x.jobId === r.job.id && x.via === via);
    if (row) { S.sel = row.uid; writeUrl(); render(); }
  } catch (e) {
    $("#jf-error").textContent = errText(e);
  } finally {
    btn.disabled = false;
    btn.textContent = t("fmSave");
  }
}

let deleting: { id: number; via: string } | null = null;
function openDelete(id: number, via: string) {
  const row = S.rows.find((r) => r.jobId === id && r.via === via);
  deleting = { id, via };
  $("#del-title").textContent = t("delTitle", { name: row?.name ?? "" });
  $<HTMLDialogElement>("#del-dialog").showModal();
}

// ---------------------------------------------------------------- the assistant

function chipHtml(a: ActionResult): string {
  return `<li class="act ${a.ok ? "ok" : "bad"}">${icon(a.ok ? "i-check" : "i-x")}<span>${esc(a.summary)}</span>${a.error ? `<span class="act-err">${esc(a.error)}</span>` : ""}</li>`;
}

function confirmHtml(m: Message): string {
  const c = m.confirm!;
  if (c.state === "open") {
    return `<div class="sp-draft confirm" data-token="${esc(c.token)}"><p>${esc(t("asConfirmQ", { name: c.name }))}</p><div class="confirm-btns"><button type="button" class="sp-btn-danger sm" data-act="confirm-yes">${esc(t("asConfirmYes"))}</button><button type="button" class="sp-btn sm" data-act="confirm-no">${esc(t("asConfirmNo"))}</button></div></div>`;
  }
  const label = c.state === "done" ? t("asConfirmDone") : c.state === "declined" ? t("asConfirmDeclined") : t("asConfirmFailed");
  return `<div class="sp-draft confirm closed ${c.state}"><p>${esc(t("asConfirmQ", { name: c.name }))}</p>${badge(c.state === "done" ? "ok" : c.state === "failed" ? "bad" : "off", label)}</div>`;
}

function renderChat() {
  const log = $("#as-log");
  const msgs = S.messages.map((m) => m.role === "user"
    ? `<div class="sp-msg-me"><span class="sp-sr">${esc(t("asYou"))}</span><p>${esc(m.text)}</p></div>`
    : `<div class="msg bot"><span class="sp-sr">${esc(t("asBot"))}</span><p>${esc(m.text)}</p>${m.actions.length ? `<ul class="acts">${m.actions.map(chipHtml).join("")}</ul>` : ""}${m.confirm ? confirmHtml(m) : ""}</div>`);
  const hello = `<div class="msg bot hello"><span class="sp-sr">${esc(t("asBot"))}</span><p>${esc(S.assistantOn ? t("asHello") : t("asUnavailable"))}</p></div>`;
  log.innerHTML = hello + msgs.join("") + (S.thinking ? `<div class="msg bot thinking"><span class="sp-sr">${esc(t("asBot"))}</span><p><span class="pulse"></span>${esc(t("asThinking"))}</p></div>` : "");
  const scroller = $("#as-scroll");
  scroller.scrollTop = scroller.scrollHeight;
  $<HTMLButtonElement>("#as-send").disabled = S.thinking || !S.assistantOn;
}

async function loadChat() {
  try {
    const d = await api<{ available: boolean; session: number; messages: Message[] }>(on(S.chatVia, "/api/assistant"));
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
    const d = await api<{ messages: Message[] }>(on(S.chatVia, "/api/assistant"), { body: { message: msg, zone: browserZone, lang: S.lang, session: S.session } });
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
    const d = await api<{ messages: Message[] }>(on(S.chatVia, "/api/assistant/confirm"), { body: { token, accept, lang: S.lang } });
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
for (const b of $$("[data-tab]")) b.addEventListener("click", () => { S.tab = b.dataset.tab as typeof S.tab; writeUrl(); render(); closeDrawers(); });
for (const b of $$("[data-f]")) b.addEventListener("click", () => { S.filter = (b.dataset.f || null) as typeof S.filter; writeUrl(); render(); });
$("#machine-nav").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-machine]");
  if (!b) return;
  S.machine = b.dataset.machine === "*" ? null : b.dataset.machine!;
  writeUrl(); render(); closeDrawers();
});

document.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (el) {
    const id = Number(el.dataset.id);
    const via = el.dataset.via ?? "";
    switch (el.dataset.act) {
      case "new": return openForm(null);
      case "edit": {
        try { const { job } = await api<{ job: Job }>(on(via, `/api/jobs/${id}`)); openForm(job, via); } catch (err) { toast(errText(err), true); }
        return;
      }
      case "run": case "pause": case "resume": case "restore": return act(el.dataset.act, id, via);
      case "delete": return openDelete(id, via);
      case "reconcile": try { await api(on(via, "/api/reconcile"), { body: {} }); toast(t("toastSynced")); } catch (err) { toast(errText(err), true); } return load();
      case "reload": S.loaded = false; render(); return load();
      case "close-detail": S.sel = null; writeUrl(); return render();
      case "close-dialog": return el.closest("dialog")?.close();
      case "run-open": {
        if (getSelection()?.toString()) return;   // picking text in a row is not a click on it
        openRun = openRun === el.dataset.run ? "" : el.dataset.run!;
        return drawRuns();
      }
      case "transcript": return openTranscript(el.dataset.run!);
      case "toggle": return;
      case "confirm-yes": case "confirm-no": {
        const card = el.closest<HTMLElement>("[data-token]");
        if (card) return answerConfirm(card.dataset.token!, el.dataset.act === "confirm-yes");
        return;
      }
      case "preset": return void send(el.textContent ?? "");
      case "as-open": openDrawer("sp-open-aside"); return $("#as-input").focus();
      case "nav-open": openDrawer("sp-open-nav"); return $("#q").focus();
      case "drawer-close": return closeDrawers();
      case "as-new": {
        try { const r = await api<{ session: number }>(on(S.chatVia, "/api/assistant/new"), { body: {} }); S.session = r.session; S.messages = []; renderChat(); } catch (err) { toast(errText(err), true); }
        return;
      }
    }
    return;
  }
  const row = (e.target as HTMLElement).closest<HTMLElement>(".row[data-key]");
  if (row && !(e.target as HTMLElement).closest("label, button, input")) { S.sel = S.sel === row.dataset.key ? null : row.dataset.key!; writeUrl(); render(); }
});

/** The left column below 960px and the assistant below 1200px are drawers: classes on body (docs/ui-kit.md). */
function openDrawer(cls: "sp-open-nav" | "sp-open-aside") {
  document.body.classList.remove("sp-open-nav", "sp-open-aside");
  document.body.classList.add(cls, "sp-sheet-open");
}
function closeDrawers() {
  document.body.classList.remove("sp-open-nav", "sp-open-aside", "sp-sheet-open");
}
for (const q of ["(min-width: 1200px)", "(min-width: 960px)"]) matchMedia(q).addEventListener("change", (e) => { if (e.matches) closeDrawers(); });
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.act === "toggle") void act(el.checked ? "resume" : "pause", Number(el.dataset.id), el.dataset.via ?? "");
});
document.addEventListener("keydown", (e) => {
  const row = (e.target as HTMLElement).closest?.<HTMLElement>(".row[data-key]");
  if (row && (e.key === "Enter" || e.key === " ") && e.target === row) { e.preventDefault(); S.sel = S.sel === row.dataset.key ? null : row.dataset.key!; writeUrl(); render(); }
  if (e.key === "/" && !(e.target as HTMLElement).closest("input, textarea, select")) { e.preventDefault(); if (!matchMedia("(min-width: 960px)").matches) openDrawer("sp-open-nav"); $("#q").focus(); }
  if (e.key === "Escape" && document.body.classList.contains("sp-sheet-open") && !document.querySelector("dialog[open]")) closeDrawers();
});

for (const seg of $$("[data-seg]")) for (const b of $$("button", seg)) b.addEventListener("click", () => { setSeg(seg.dataset.seg!, b.dataset.v!); preview(); });
$("#job-form").addEventListener("input", (e) => { if ((e.target as HTMLElement).closest("[data-pane='when']")) preview(); });
$("#job-form").addEventListener("change", (e) => { if ((e.target as HTMLElement).closest("[data-pane='when']")) preview(); });
$("#job-form").addEventListener("submit", submitForm);
$("#jf-cancel").addEventListener("click", () => $<HTMLDialogElement>("#job-dialog").close());
$("#del-cancel").addEventListener("click", () => $<HTMLDialogElement>("#del-dialog").close());
$("#del-ok").addEventListener("click", async () => {
  $<HTMLDialogElement>("#del-dialog").close();
  if (deleting !== null) { const { id, via } = deleting; deleting = null; if (S.rows.find((r) => r.jobId === id && r.via === via)?.uid === S.sel) S.sel = null; await act("archive", id, via); }
});
/** The composer is one line and grows with what is typed, up to its max height. */
function fitComposer() {
  const i = $<HTMLTextAreaElement>("#as-input");
  i.style.height = "";
  if (i.value) i.style.height = `${Math.min(i.scrollHeight + 2, 120)}px`;
  i.style.overflowY = i.scrollHeight > 120 ? "auto" : "hidden";
}
$("#as-input").addEventListener("input", fitComposer);
$("#as-machine").addEventListener("change", (e) => {
  S.chatVia = (e.target as HTMLSelectElement).value;
  store.set("task-shelf.chatVia", S.chatVia || null);
  S.messages = [];
  void loadChat();
});
$("#as-form").addEventListener("submit", (e) => { e.preventDefault(); const i = $<HTMLTextAreaElement>("#as-input"); const v = i.value; i.value = ""; fitComposer(); void send(v); });
$("#as-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $<HTMLFormElement>("#as-form").requestSubmit(); } });

applyTranslations(document, S.lang);
for (const b of $$("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === S.lang));
themeLabel();
render();
renderChat();
void load();
void loadChat();
