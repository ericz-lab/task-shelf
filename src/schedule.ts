import { Cron } from "croner";

/**
 * When a job runs, as this app stores it. Follows ai-space docs/time.md: a calendar schedule always
 * names its IANA zone, a one-shot is a canonical UTC instant (and keeps the zone the person meant,
 * for display), an interval is plain milliseconds.
 */
export type JobSchedule =
  | { kind: "cron"; expr: string; tz: string }
  | { kind: "every"; everyMs: number }
  | { kind: "at"; at: string; tz: string };

/** ai-space's scheduler shape (src/space/scheduler/types.ts). */
export type SpaceSchedule =
  | { kind: "manual" }
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type ScheduleCode =
  | "bad-kind" | "bad-cron" | "bad-zone" | "bad-every" | "too-often" | "too-rare"
  | "bad-at" | "at-past" | "at-nonexistent" | "at-ambiguous";

/** A schedule the person has to fix; `code` is mapped to the page's language. */
export class ScheduleError extends Error {
  constructor(readonly code: ScheduleCode, message: string) { super(message); }
}

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Faster loops belong inside an app (ai-space docs/scheduler.md, non-goals). */
export const MIN_EVERY_MS = MINUTE;
export const MAX_EVERY_MS = 366 * DAY;

/** An IANA zone name (or UTC) this runtime knows; abbreviations and fixed offsets are refused. */
export function isZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  if (tz !== "UTC" && !tz.includes("/")) return false;
  if (/^Etc\/GMT[+-]/i.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function zoneOrThrow(tz: unknown): string {
  if (!isZone(tz)) throw new ScheduleError("bad-zone", `unknown time zone: ${String(tz)} (use an IANA name such as America/Los_Angeles, Asia/Shanghai or UTC)`);
  return tz;
}

const UNITS: Record<string, number> = { s: 1000, m: MINUTE, min: MINUTE, h: 3_600_000, d: DAY };

/** "30m", "6h", "1d", "90s", "1h30m", or milliseconds as a number. */
export function parseDuration(input: unknown): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) throw new ScheduleError("bad-every", `invalid duration: ${input}`);
    return Math.floor(input);
  }
  if (typeof input !== "string") throw new ScheduleError("bad-every", "duration must be like 30m, 6h or 1d");
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!s || !/^(\d+(\.\d+)?(s|m|min|h|d))+$/.test(s)) throw new ScheduleError("bad-every", `invalid duration: "${input}" (use 30m, 6h, 1d)`);
  let ms = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(min|s|m|h|d)/g)) ms += Number(m[1]) * UNITS[m[2]!]!;
  if (!(ms > 0)) throw new ScheduleError("bad-every", `invalid duration: "${input}"`);
  return Math.floor(ms);
}

/** A 5-field cron expression croner accepts, normalised to single spaces. */
export function checkCron(expr: unknown, tz: string): string {
  if (typeof expr !== "string") throw new ScheduleError("bad-cron", "cron expression is required");
  const norm = expr.trim().replace(/\s+/g, " ");
  if (norm.split(" ").length !== 5) throw new ScheduleError("bad-cron", `cron must have 5 fields (minute hour day month weekday): "${expr}"`);
  try {
    const next = new Cron(norm, { timezone: tz, catch: false }).nextRun();
    if (!next) throw new Error("it never fires");
  } catch (e) {
    throw new ScheduleError("bad-cron", `invalid cron expression "${expr}": ${(e as Error).message}`);
  }
  return norm;
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };

/** The wall-clock reading of an instant in a zone. */
export function wallClock(ms: number, tz: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute"), s: get("second") };
}

/** Offset of a zone at an instant, in ms (wall clock minus UTC). */
export function zoneOffsetMs(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Every instant at which the zone's clock reads `local` (YYYY-MM-DDTHH:MM[:SS]): none for a time
 * a daylight-saving jump skips, two for one it repeats. Invalid calendar values throw.
 */
export function localInstants(local: string, tz: string): number[] {
  const m = LOCAL_RE.exec(local.trim());
  if (!m) throw new ScheduleError("bad-at", `local time must be YYYY-MM-DDTHH:MM: "${local}"`);
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(naive);
  if (mo < 1 || mo > 12 || back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1 || h > 23 || mi > 59 || s > 59) {
    throw new ScheduleError("bad-at", `not a calendar date and time: "${local}"`);
  }
  const offsets = new Set([naive - DAY, naive, naive + DAY].map((t) => zoneOffsetMs(t, tz)));
  const out = new Set<number>();
  for (const off of offsets) {
    const t = naive - off;
    const w = wallClock(t, tz);
    if (w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi && w.s === s) out.add(t);
  }
  return [...out].sort((a, b) => a - b);
}

/** An instant with `Z` or an explicit offset; zone-less text is refused (docs/time.md). */
export function parseInstant(text: string): number {
  const t = text.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/i.exec(t);
  if (!m) throw new ScheduleError("bad-at", `a one-time run needs a date-time with Z or an offset, or a local time with a zone: "${text}"`);
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
  const day = new Date(Date.UTC(y, mo - 1, d));
  // Date.parse would roll 2026-02-30 over into March: check the calendar part first.
  if (mo < 1 || mo > 12 || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw new ScheduleError("bad-at", `not a calendar date and time: "${text}"`);
  }
  const zone = m[8]!.toUpperCase() === "Z" ? "Z" : m[8]!.replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${m[7] ?? ""}${zone}`);
  if (!Number.isFinite(ms)) throw new ScheduleError("bad-at", `not a valid instant: "${text}"`);
  return ms;
}

export interface ScheduleContext {
  /** Zone to read a cron or local time in when the input names none (the page sends the browser's). */
  zone: string;
  now: number;
}

/**
 * Read a schedule from the page or the assistant:
 *   { kind: "cron", expr: "30 8 * * 1-5", tz?: "America/Los_Angeles" }
 *   { kind: "every", every: "30m" }            (or everyMs)
 *   { kind: "at", at: "2026-11-10T09:00:00-08:00" }  or  { kind: "at", local: "2026-11-10T09:00", tz? }
 * The result always names its zone; ctx.zone fills in a missing one.
 */
export function parseSchedule(input: unknown, ctx: ScheduleContext): JobSchedule {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ScheduleError("bad-kind", "schedule must be an object with kind cron, every or at");
  const s = input as Record<string, unknown>;
  switch (s.kind) {
    case "cron": {
      const tz = zoneOrThrow(s.tz ?? ctx.zone);
      return { kind: "cron", expr: checkCron(s.expr, tz), tz };
    }
    case "every": {
      const everyMs = parseDuration(s.everyMs ?? s.every);
      if (everyMs < MIN_EVERY_MS) throw new ScheduleError("too-often", "the shortest interval is 1 minute");
      if (everyMs > MAX_EVERY_MS) throw new ScheduleError("too-rare", "the longest interval is 366 days; use a calendar schedule");
      return { kind: "every", everyMs };
    }
    case "at": {
      const tz = zoneOrThrow(s.tz ?? ctx.zone);
      let ms: number;
      if (typeof s.at === "string" && s.at.trim()) ms = parseInstant(s.at);
      else if (typeof s.local === "string") {
        const hits = localInstants(s.local, tz);
        if (hits.length === 0) throw new ScheduleError("at-nonexistent", `${s.local} does not exist in ${tz} (the clock skips it)`);
        if (hits.length > 1) throw new ScheduleError("at-ambiguous", `${s.local} happens twice in ${tz}; give the offset`);
        ms = hits[0]!;
      } else throw new ScheduleError("bad-at", "a one-time run needs at (with offset) or local + tz");
      if (ms <= ctx.now) throw new ScheduleError("at-past", "that time has already passed");
      return { kind: "at", at: new Date(ms).toISOString(), tz };
    }
    default:
      throw new ScheduleError("bad-kind", "schedule.kind must be cron, every or at");
  }
}

export function toSpaceSchedule(s: JobSchedule): SpaceSchedule {
  switch (s.kind) {
    case "cron": return { kind: "cron", expr: s.expr, tz: s.tz };
    case "every": return { kind: "every", everyMs: s.everyMs };
    case "at": return { kind: "at", at: s.at };
  }
}

/** Whether ai-space's effective schedule is the one this job wants (the interval's anchor is ai-space's own). */
export function sameSchedule(job: JobSchedule, space: SpaceSchedule | undefined): boolean {
  if (!space) return false;
  const want = toSpaceSchedule(job);
  if (want.kind !== space.kind) return false;
  if (want.kind === "cron" && space.kind === "cron") return want.expr === space.expr.trim().replace(/\s+/g, " ") && want.tz === space.tz;
  if (want.kind === "every" && space.kind === "every") return want.everyMs === space.everyMs;
  if (want.kind === "at" && space.kind === "at") return Date.parse(want.at) === Date.parse(space.at);
  return false;
}

/**
 * The next `n` runs, as instants, the way ai-space's scheduler computes them: a cron in its zone, an
 * interval right away and then every step (a new interval task runs as soon as it is created), a
 * one-shot once.
 */
export function nextRuns(s: JobSchedule | SpaceSchedule, now: number, n = 3): number[] {
  switch (s.kind) {
    case "cron": {
      const cron = new Cron(s.expr, { timezone: s.tz || undefined, catch: false });
      return cron.nextRuns(n, new Date(now)).map((d) => d.getTime());
    }
    case "every": {
      const anchor = "anchorMs" in s && s.anchorMs !== undefined ? s.anchorMs : now;
      const first = anchor >= now ? anchor : anchor + (Math.floor((now - anchor) / s.everyMs) + 1) * s.everyMs;
      return Array.from({ length: n }, (_, i) => first + i * s.everyMs);
    }
    case "at": {
      const ms = Date.parse(s.at);
      return Number.isFinite(ms) && ms > now ? [ms] : [];
    }
    case "manual":
      return [];
  }
}
