/**
 * Schedules in words, in Chinese and English. Shared by the page and the assistant's context, so it
 * has no dependencies. Common cron shapes get a sentence; anything else is shown as the expression.
 */
export type Lang = "zh" | "en";

type AnySchedule =
  | { kind: "manual" }
  | { kind: "at"; at: string; tz?: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

const WEEK_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEK_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function durationText(ms: number, lang: Lang): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return lang === "zh" ? `${Math.round(ms)} 毫秒` : `${Math.round(ms)} ms`;
  const units: [number, string, string][] = [[86_400_000, "天", "d"], [3_600_000, "小时", "h"], [60_000, "分钟", "m"], [1000, "秒", "s"]];
  const parts: string[] = [];
  let rest = Math.round(ms / 1000) * 1000;
  for (const [size, zh, en] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) { parts.push(lang === "zh" ? `${n} ${zh}` : `${n}${en}`); rest -= n * size; }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

const pad = (n: number) => String(n).padStart(2, "0");
const isNum = (s: string) => /^\d+$/.test(s);

function weekdays(field: string, lang: Lang): string | null {
  const names = lang === "zh" ? WEEK_ZH : WEEK_EN;
  if (field === "1-5") return lang === "zh" ? "工作日" : "Weekdays";
  if (field === "0,6" || field === "6,0") return lang === "zh" ? "周末" : "Weekends";
  if (field === "*") return null;
  const days: number[] = [];
  for (const part of field.split(",")) {
    const r = /^(\d)-(\d)$/.exec(part);
    if (r) { for (let d = Number(r[1]); d <= Number(r[2]); d++) days.push(d % 7); continue; }
    if (!/^\d$/.test(part)) return "";
    days.push(Number(part) % 7);
  }
  if (!days.length) return "";
  const list = days.map((d) => names[d]).join(lang === "zh" ? "、" : ", ");
  return lang === "zh" ? `每${list}` : `Every ${list}`;
}

/** A sentence for a 5-field cron, or null when the shape is not a common one. */
export function cronText(expr: string, lang: Lang): string | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  const zh = lang === "zh";
  const every = (s: string) => /^\*\/(\d+)$/.exec(s)?.[1];
  // */N * * * *
  if (every(mi) && h === "*" && dom === "*" && mon === "*" && dow === "*") return zh ? `每 ${every(mi)} 分钟` : `Every ${every(mi)} minutes`;
  if (mi === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*") return zh ? "每分钟" : "Every minute";
  if (mon !== "*") return null;
  if (isNum(mi) && h === "*" && dom === "*" && dow === "*") return zh ? `每小时第 ${Number(mi)} 分` : `Hourly at :${pad(Number(mi))}`;
  if (isNum(mi) && every(h) && dom === "*" && dow === "*") return zh ? `每 ${every(h)} 小时（第 ${Number(mi)} 分）` : `Every ${every(h)} hours at :${pad(Number(mi))}`;
  if (!isNum(mi)) return null;
  const hours = h.split(",");
  if (!hours.every(isNum)) return null;
  const times = hours.map((x) => `${pad(Number(x))}:${pad(Number(mi))}`).join(zh ? "、" : ", ");
  if (dom === "*" && dow === "*") return zh ? `每天 ${times}` : `Daily at ${times}`;
  if (dom === "*") {
    const w = weekdays(dow, lang);
    if (!w) return null;
    return zh ? `${w} ${times}` : `${w} at ${times}`;
  }
  if (isNum(dom) && dow === "*") return zh ? `每月 ${Number(dom)} 日 ${times}` : `Monthly on day ${Number(dom)} at ${times}`;
  return null;
}

/** The instant in a zone, as the page writes dates: "11月10日 09:00" / "Nov 10, 09:00". */
export function instantText(iso: string, tz: string | undefined, lang: Lang): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const parts = new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(tz ? { timeZone: tz } : {}) }).formatToParts(new Date(ms));
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? "0");
  const hm = `${pad(g("hour") % 24)}:${pad(g("minute"))}`;
  if (lang === "zh") return `${g("month")}月${g("day")}日 ${hm}`;
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][g("month") - 1]} ${g("day")}, ${hm}`;
}

/** The schedule in words; the zone is shown separately by the caller. */
export function scheduleText(s: AnySchedule, lang: Lang): string {
  switch (s.kind) {
    case "manual": return lang === "zh" ? "只按事件或手动" : "Events or by hand only";
    case "every": return lang === "zh" ? `每 ${durationText(s.everyMs, lang)}` : `Every ${durationText(s.everyMs, lang)}`;
    case "at": return lang === "zh" ? `一次 · ${instantText(s.at, s.tz, lang)}` : `Once · ${instantText(s.at, s.tz, lang)}`;
    case "cron": return cronText(s.expr, lang) ?? s.expr;
  }
}
