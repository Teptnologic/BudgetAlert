import { describe, it, expect } from "vitest";
import { computeStatus, alertsToFire } from "../src/core/engine";
import { periodStart, type Calendar } from "../src/core/period";

describe("computeStatus", () => {
  it("computes remaining and pct", () => {
    const s = computeStatus(500, 125, "USD");
    expect(s.remaining).toBe(375);
    expect(s.pct).toBe(25);
  });

  it("handles overspend", () => {
    const s = computeStatus(100, 130, "USD");
    expect(s.remaining).toBe(-30);
    expect(s.pct).toBe(130);
  });

  it("avoids divide-by-zero with no budget", () => {
    expect(computeStatus(0, 50, "USD").pct).toBe(0);
  });
});

describe("alertsToFire", () => {
  it("fires nothing below the warn threshold", () => {
    expect(alertsToFire(50, 80, 100, new Set())).toEqual([]);
  });

  it("fires warn once crossing 80%", () => {
    expect(alertsToFire(85, 80, 100, new Set())).toEqual(["warn"]);
  });

  it("does not re-fire an already-sent warn", () => {
    expect(alertsToFire(85, 80, 100, new Set(["warn"]))).toEqual([]);
  });

  it("fires both when jumping straight past 100%", () => {
    expect(alertsToFire(120, 80, 100, new Set())).toEqual(["warn", "alert"]);
  });

  it("fires only alert when warn already sent", () => {
    expect(alertsToFire(120, 80, 100, new Set(["warn"]))).toEqual(["alert"]);
  });
});

describe("periodStart", () => {
  // Periods are computed in the configured zone (US Pacific) with weeks
  // beginning Sunday, so these assert local calendar boundaries, not UTC ones.
  const PT: Calendar = { timeZone: "America/Los_Angeles", weekStartsOn: 0 };
  const localDay = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: PT.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  it("monthly returns the first of the local month", () => {
    expect(localDay(periodStart("monthly", new Date("2026-07-19T17:00:00Z"), PT))).toBe("2026-07-01");
  });

  it("weekly returns the Sunday", () => {
    // 2026-07-19 is a Sunday, so it is itself the start of the week.
    expect(localDay(periodStart("weekly", new Date("2026-07-19T17:00:00Z"), PT))).toBe("2026-07-19");
  });

  it("weekly mid-week rolls back to the preceding Sunday", () => {
    expect(localDay(periodStart("weekly", new Date("2026-07-22T17:00:00Z"), PT))).toBe("2026-07-19");
  });

  it("weekly on a Saturday stays in the week that began Sunday", () => {
    expect(localDay(periodStart("weekly", new Date("2026-07-25T23:00:00Z"), PT))).toBe("2026-07-19");
  });
});
