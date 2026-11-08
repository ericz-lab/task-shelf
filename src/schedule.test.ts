import { describe, expect, test } from "bun:test";
import { cronText, durationText, runDuration, scheduleText } from "./describe.ts";
import { ScheduleError, isZone, localInstants, nextRuns, parseDuration, parseInstant, parseSchedule, sameSchedule, toSpaceSchedule } from "./schedule.ts";

// 2026-11-08T13:00:00Z = 05:00 in Los Angeles (PST), 21:00 in Shanghai.
const NOW = Date.parse("2026-11-08T13:00:00.000Z");
const ctx = { zone: "America/Los_Angeles", now: NOW };
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as ScheduleError).code; } return "no error"; };

describe("zones", () => {
  test("IANA names and UTC are accepted; abbreviations and fixed offsets are not", () => {
    for (const z of ["UTC", "Asia/Shanghai", "America/Los_Angeles", "Europe/Berlin"]) expect(isZone(z)).toBe(true);
    for (const z of ["CST", "PST", "UTC-5", "Etc/GMT+5", "Mars/Olympus", "", 42]) expect(isZone(z)).toBe(false);
  });

  test("a cron without a zone takes the context zone; an unknown one is refused", () => {
    expect(parseSchedule({ kind: "cron", expr: "30 8 * * 1-5" }, ctx)).toEqual({ kind: "cron", expr: "30 8 * * 1-5", tz: "America/Los_Angeles" });
    expect(parseSchedule({ kind: "cron", expr: "0  3 * *  *", tz: "Asia/Shanghai" }, ctx)).toEqual({ kind: "cron", expr: "0 3 * * *", tz: "Asia/Shanghai" });
    expect(code(() => parseSchedule({ kind: "cron", expr: "0 3 * * *", tz: "CST" }, ctx))).toBe("bad-zone");
  });

  test("the same cron fires at the zone's wall clock, whatever the process zone", () => {
    const la = nextRuns({ kind: "cron", expr: "30 8 * * *", tz: "America/Los_Angeles" }, NOW, 1)[0]!;
    const sh = nextRuns({ kind: "cron", expr: "30 8 * * *", tz: "Asia/Shanghai" }, NOW, 1)[0]!;
    expect(new Date(la).toISOString()).toBe("2026-11-08T16:30:00.000Z");
    expect(new Date(sh).toISOString()).toBe("2026-11-09T00:30:00.000Z");
  });

  test("weekday crons skip the weekend in their own zone", () => {
    // Sunday 05:00 in Los Angeles: the next weekday 08:30 is Monday.
    const runs = nextRuns({ kind: "cron", expr: "30 8 * * 1-5", tz: "America/Los_Angeles" }, NOW, 2).map((ms) => new Date(ms).toISOString());
    expect(runs).toEqual(["2026-11-09T16:30:00.000Z", "2026-11-10T16:30:00.000Z"]);
  });
});

describe("cron", () => {
  test("five fields only, and croner must accept them", () => {
    expect(code(() => parseSchedule({ kind: "cron", expr: "0 3 * *", tz: "UTC" }, ctx))).toBe("bad-cron");
    expect(code(() => parseSchedule({ kind: "cron", expr: "0 0 3 * * *", tz: "UTC" }, ctx))).toBe("bad-cron");
    expect(code(() => parseSchedule({ kind: "cron", expr: "61 3 * * *", tz: "UTC" }, ctx))).toBe("bad-cron");
    expect(code(() => parseSchedule({ kind: "cron", tz: "UTC" }, ctx))).toBe("bad-cron");
  });
});

describe("intervals", () => {
  test("durations", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration(90_000)).toBe(90_000);
    expect(() => parseDuration("soon")).toThrow(ScheduleError);
    expect(() => parseDuration("-5m")).toThrow(ScheduleError);
  });

  test("at least a minute, at most a year", () => {
    expect(parseSchedule({ kind: "every", every: "15m" }, ctx)).toEqual({ kind: "every", everyMs: 900_000 });
    expect(code(() => parseSchedule({ kind: "every", every: "30s" }, ctx))).toBe("too-often");
    expect(code(() => parseSchedule({ kind: "every", every: "400d" }, ctx))).toBe("too-rare");
  });

  test("an interval runs right away, then every step (as ai-space anchors it)", () => {
    expect(nextRuns({ kind: "every", everyMs: 3_600_000 }, NOW, 3)).toEqual([NOW, NOW + 3_600_000, NOW + 7_200_000]);
    // A task ai-space anchored earlier: the next slot after now.
    expect(nextRuns({ kind: "every", everyMs: 3_600_000, anchorMs: NOW - 5_400_000 }, NOW, 1)).toEqual([NOW + 1_800_000]);
  });
});

describe("one-time runs", () => {
  test("an instant needs Z or an offset and is stored as UTC", () => {
    expect(parseSchedule({ kind: "at", at: "2026-11-10T09:00:00+08:00", tz: "Asia/Shanghai" }, ctx)).toEqual({ kind: "at", at: "2026-11-10T01:00:00.000Z", tz: "Asia/Shanghai" });
    expect(parseSchedule({ kind: "at", at: "2026-11-10T09:00-0800" }, ctx).kind).toBe("at");
    expect(code(() => parseInstant("2026-11-10T09:00:00"))).toBe("bad-at");
    expect(code(() => parseInstant("2026-02-30T09:00:00Z"))).toBe("bad-at");
  });

  test("a local time is read in its zone", () => {
    expect(parseSchedule({ kind: "at", local: "2026-11-10T09:00", tz: "America/Los_Angeles" }, ctx)).toEqual({ kind: "at", at: "2026-11-10T17:00:00.000Z", tz: "America/Los_Angeles" });
    expect(parseSchedule({ kind: "at", local: "2026-11-10T09:00" }, { ...ctx, zone: "Asia/Shanghai" })).toMatchObject({ at: "2026-11-10T01:00:00.000Z" });
  });

  test("a time the clock skips is refused, a repeated one needs an offset", () => {
    // 2027-03-14 02:30 does not exist in Los Angeles; 2027-11-07 01:30 happens twice.
    expect(localInstants("2027-03-14T02:30", "America/Los_Angeles")).toEqual([]);
    expect(localInstants("2027-11-07T01:30", "America/Los_Angeles").length).toBe(2);
    expect(code(() => parseSchedule({ kind: "at", local: "2027-03-14T02:30", tz: "America/Los_Angeles" }, ctx))).toBe("at-nonexistent");
    expect(code(() => parseSchedule({ kind: "at", local: "2027-11-07T01:30", tz: "America/Los_Angeles" }, ctx))).toBe("at-ambiguous");
    expect(parseSchedule({ kind: "at", at: "2027-11-07T01:30:00-07:00", tz: "America/Los_Angeles" }, ctx)).toMatchObject({ at: "2027-11-07T08:30:00.000Z" });
  });

  test("leap days and invalid calendar dates", () => {
    expect(localInstants("2028-02-29T12:00", "UTC")).toEqual([Date.parse("2028-02-29T12:00:00Z")]);
    expect(code(() => localInstants("2027-02-29T12:00", "UTC"))).toBe("bad-at");
    expect(code(() => localInstants("2027-13-01T12:00", "UTC"))).toBe("bad-at");
  });

  test("a past time is refused", () => {
    expect(code(() => parseSchedule({ kind: "at", at: "2026-11-08T12:59:00Z" }, ctx))).toBe("at-past");
  });
});

describe("ai-space shape", () => {
  test("round trip and comparison ignore the interval's anchor", () => {
    expect(toSpaceSchedule({ kind: "cron", expr: "0 3 * * *", tz: "UTC" })).toEqual({ kind: "cron", expr: "0 3 * * *", tz: "UTC" });
    expect(toSpaceSchedule({ kind: "at", at: "2026-11-10T01:00:00.000Z", tz: "Asia/Shanghai" })).toEqual({ kind: "at", at: "2026-11-10T01:00:00.000Z" });
    expect(sameSchedule({ kind: "every", everyMs: 60_000 }, { kind: "every", everyMs: 60_000, anchorMs: 123 })).toBe(true);
    expect(sameSchedule({ kind: "cron", expr: "0 3 * * *", tz: "UTC" }, { kind: "cron", expr: "0 3 * * *" })).toBe(false);
    expect(sameSchedule({ kind: "cron", expr: "0 3 * * *", tz: "UTC" }, undefined)).toBe(false);
  });

  test("bad kinds", () => {
    expect(code(() => parseSchedule({ kind: "weekly" }, ctx))).toBe("bad-kind");
    expect(code(() => parseSchedule(null, ctx))).toBe("bad-kind");
  });
});

describe("in words", () => {
  test("common cron shapes in both languages", () => {
    expect(cronText("30 8 * * 1-5", "zh")).toBe("工作日 08:30");
    expect(cronText("30 8 * * 1-5", "en")).toBe("Weekdays at 08:30");
    expect(cronText("0 3 * * *", "zh")).toBe("每天 03:00");
    expect(cronText("15 */2 * * *", "zh")).toBe("每 2 小时（第 15 分）");
    expect(cronText("*/10 * * * *", "en")).toBe("Every 10 minutes");
    expect(cronText("0 9 * * 1", "zh")).toBe("每周一 09:00");
    expect(cronText("0 9 1 * *", "en")).toBe("Monthly on day 1 at 09:00");
    expect(cronText("0 9 1 1 *", "en")).toBeNull();
    expect(scheduleText({ kind: "cron", expr: "0 9 1 1 *" }, "en")).toBe("0 9 1 1 *");
  });

  test("intervals and one-time runs", () => {
    expect(durationText(5_400_000, "zh")).toBe("1 小时 30 分钟");
    expect(runDuration(3)).toBe("3 ms");
    expect(runDuration(2_340)).toBe("2.3 s");
    expect(runDuration(41_400)).toBe("41 s");
    expect(runDuration(275_000)).toBe("4m 35s");
    expect(scheduleText({ kind: "every", everyMs: 1_800_000 }, "en")).toBe("Every 30m");
    expect(scheduleText({ kind: "at", at: "2026-11-10T01:00:00.000Z", tz: "Asia/Shanghai" }, "zh")).toBe("一次 · 11月10日 09:00");
  });
});
