import { expect, test } from "bun:test";
import { FULL_MS, LIVE_MS, nextRead } from "./refresh.ts";

test("a hidden page reads nothing", () => {
  expect(nextRead({ now: 0, lastFull: 0, live: ["mac"], hidden: true })).toBeNull();
});

test("with nothing running every machine is read once per full period", () => {
  expect(nextRead({ now: 1000, lastFull: 1000, live: [], hidden: false })).toEqual({ wait: FULL_MS, only: null });
  expect(nextRead({ now: 9000, lastFull: 1000, live: [], hidden: false })).toEqual({ wait: FULL_MS - 8000, only: null });
});

test("while a task runs only its machines are read quickly", () => {
  expect(nextRead({ now: 0, lastFull: 0, live: ["mac", "", "mac"], hidden: false })).toEqual({ wait: LIVE_MS, only: ["mac", ""] });
});

test("a quick read close to the full one becomes the full one", () => {
  expect(nextRead({ now: FULL_MS - LIVE_MS, lastFull: 0, live: ["mac"], hidden: false })).toEqual({ wait: LIVE_MS, only: null });
  expect(nextRead({ now: FULL_MS + 500, lastFull: 0, live: ["mac"], hidden: false })).toEqual({ wait: 0, only: null });
});
